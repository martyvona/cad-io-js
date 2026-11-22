// The oracle's contract: a part's exact measures (edge lengths, face perimeters and areas, integrals over faces) from
// its B-rep model by integration over the exact geometry, never from a mesh, so it can judge any tessellator,
// including ours. It shares cad-geom's core with tess-cadio, never tess-cadio's code. Every value is an Estimate
// whose error is the quadrature's a posteriori estimate; a face's measure also carries flags, which say why it may be
// wrong although it was computed. Rely on a measure only where trusted() says so.
//
// The methods, by surface (docs/own-tessellator.md's oracle; docs/backends.md's area oracle):
// - planes, cylinders, cones, spheres, tori: Green's theorem in (u, v) with the area element's antiderivative in
//   closed form, area = oint P(v) du, the boundary the 3D edge curves mapped by the surface's closed-form inverse
//   (no projection, so independent of the face API's p-curves);
// - extrusions and revolutions: the same with H(u, v) closed in the profile (an extrusion's area element doesn't
//   depend on v, a revolution's on u), the boundary the face API's loops (given p-curves, else its projection);
// - B-splines, offsets, rectangular trims: the same with H numeric (an inner integral along the direction that isn't
//   periodic), the boundary the face API's loops; in bands of that direction where the surface isn't sound across
//   the face (flagCells).
#pragma once

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

#include "cad_geom/result.h"
#include "cad_geom/vec.h"

namespace cadoracle {

using cadgeom::Estimate;
using cadgeom::Status;
using cadgeom::Vec3;

/** Why a computed measure may still be wrong: bits of FaceMeasure::flags. */
enum Flag : uint32_t {
  /** The loops' signed integral came out negative (loops against the face's sense): the absolute value reported. */
  flagOrientation = 1u << 0,
  /**
   * A sphere's area past a hemisphere (or a revolution's closed by two poles, past half of it): its loops bound the
   * face and its complement alike, and the area is known modulo the whole surface's, so a loop the other way round
   * gives the complement; the smaller side is the likelier face.
   */
  flagSphereSide = 1u << 1,
  /** A face in no shell (a face item): nothing fixes which side of the surface its loops bound. */
  flagLoose = 1u << 2,
  /**
   * A loop winds a period the method has no term for: a torus loop round its minor circle (the face then spans a
   * seam no loop runs along), a loop winding a revolution's angle with no pole on the face's side.
   */
  flagWinds = 1u << 3,
  /** No edge loops: area 0 reported (a face bounded by nothing: a whole sphere, an unbounded plane). */
  flagNoLoops = 1u << 4,
  /**
   * A loop's point farther from the surface than kOffSurface of the loops' size (an edge that isn't on its face: a
   * file's topology error; on a free-form face, a coedge's ends on the surface that far from its edge's vertices: a
   * p-curve or projection not reaching them).
   */
  flagOffSurface = 1u << 5,
  /**
   * The loops in (u, v) come (in part) from the face API's projection, not from given or healed p-curves: said, not
   * refused (trusted() counts the projection's error in FaceMeasure::boundary as it counts a p-curve's).
   */
  flagProjectedBoundary = 1u << 6,
  /**
   * A free-form face's integral taken in bands of its inner direction: the surface wasn't sound across the face's
   * strips (an offset folding, a singular evaluation), so each band's inner integral starts at its own row.
   */
  flagCells = 1u << 7,
};

/** A loop's point this far from the surface, relative to the loops' size (their box's diagonal), flags the face. */
constexpr double kOffSurface = 1e-2;

/** How a face's area was computed. */
enum class Method : uint8_t { none, closedForm, extrusion, revolution, freeForm };

struct FaceMeasure {
  /** In the model's units squared (millimetres^2); status unsupported, with `why`, where the oracle can't. */
  Estimate area;
  /** Every edge of every edge loop, a seam twice (as OCCT's and the corpus checks' perimeters count). */
  Estimate perimeter;
  Method method = Method::none;
  /** Flag bits. */
  uint32_t flags = 0;
  /**
   * The largest distance of a loop's point from the surface, over the loops' size (closed forms; free-form faces: of
   * a coedge's ends on the surface from its edge's vertices); else NaN.
   */
  double offSurface = 0;
  /**
   * How far the area can be off for its loops' p-curves not being their edges' curves (mm^2): the sum over the edge
   * loops' uses of the deviation of the use's p-curve as the face API takes it, max |S(p(t)) - C(t)| over the edge's
   * range (a given p-curve's measured as the face API measures a projection's; a healed one's the analysis's; a
   * projected one's the projection's error), times its edge's length: the boundary on the surface moves at most that
   * far. 0 where the area is integrated along the edges' 3D curves (closed forms) or an edge has none (its p-curve is
   * the boundary); NaN where a deviation couldn't be had (a projection not made). Included in area.error (the error
   * reported with the area: the quadrature's plus this) where it's known; where it's NaN, area.error is the
   * quadrature's alone and trusted() refuses the face.
   */
  double boundary = 0;
  /** Where the area is unsupported or failed: why, a short phrase (static storage). */
  const char* why = "";
};

/**
 * A measure to rely on: computed (status ok), no flags but projectedBoundary, its boundary's error known, and its error
 * (the boundary's included) within `relative` of its value. The type says only that much: an untrusted measure is
 * still a value or not, which false doesn't tell; what users see is the value and its error, the flags no estimate
 * covers (sphereSide, loose, orientation, winds, noLoops) said beside them.
 */
inline bool trusted(const FaceMeasure& m, double relative = 1e-6) {
  return m.area.status == Status::ok && (m.flags & ~flagProjectedBoundary) == 0 && std::isfinite(m.boundary)
    && m.area.error <= relative * m.area.value;
}

/**
 * An integrand over a face, for faceIntegral: `components` reals at a point p of the surface with its area vector
 * n = S_u x S_v (turned by the face's sense, so it points out of the material on a solid's face; |n| du dv is the area
 * element), written to out[0 .. components). Area is |n|; volume about a point c (the divergence theorem) is
 * (p - c) . n / 3; centroids and moments are polynomials in p times n's components.
 */
struct Integrand {
  int components = 1;
  std::function<void(Vec3 p, Vec3 n, double* out)> f;
  /**
   * Per component, the size of f's value per unit area (|f| / |n|) its absolute tolerance is set from: relTol times
   * that times the face's size squared. A component that is zero on a face but for rounding (a volume's on a plane
   * through c) can't meet a tolerance relative to itself. Empty: each component's largest |f| near the face, at its
   * boundary points moved by up to its size along each axis, with n a unit vector along each axis.
   */
  std::vector<double> scale;
};

struct Options {
  /** The quadrature's relative tolerance on each edge's and loop's integral. */
  double relTol = 1e-10;
  /**
   * classify and shellSide (debugging, corpus checks): a second usable ray must agree with the first, else the point
   * is unknown ("rays disagree"), which shows a fault in the line's search or the faces' classification.
   */
  bool checkSecondRay = false;
  /**
   * The model's analysis buffer (cad-brep's analysis-layout.ts; viewed, not copied, as the model: it must outlive the
   * oracle), or none: its coedges' deviations where healing made their p-curves (pcurveFrom healed), which
   * FaceMeasure::boundary takes instead of measuring them. The caller pairs it with its model (its hash).
   */
  const uint8_t* analysis = nullptr;
  size_t analysisSize = 0;
};

/**
 * A line's contact with a face (Oracle::rayFace): a crossing of the face (inside its loops, |d . n| at least
 * cadgeom::kLineMargin), a crossing on its boundary (within the face's tolerance of its loops: an edge or a vertex,
 * which the neighbouring face may or may not see too), a tangency (the line within tol of the surface there, or too
 * near to tell, reaching into the face), or an overlap (the line lying in the face's surface over a stretch).
 */
struct FaceHit {
  enum Kind : uint8_t { crossing, boundary, tangency, overlap };
  Kind kind = crossing;
  /** The line's parameter, and the t it covers (a crossing's t alone). */
  double t = 0;
  cadgeom::Range span;
  /** Where on the surface (an overlap's: its start's), and d . n there (unit n, the surface's own, not the face's). */
  cadgeom::Vec2 uv;
  Vec3 point;
  double cosine = 0;
};

/** A line against a face: its hits sorted by t; noConvergence where the search's budget ran out (hits found given). */
struct RayFace {
  Status status = Status::unsupported;
  std::vector<FaceHit> hits;
  /** Whether a parity count may use it: status ok and every hit a crossing of the face. */
  bool clean() const {
    if (status != Status::ok) return false;
    for (const FaceHit& h : hits)
      if (h.kind != FaceHit::crossing) return false;
    return true;
  }
};

/** Why a ray was set aside: indexes of PointClass::rejected. */
enum Rejected : int {
  rejectedBoundary, rejectedTangency, rejectedOverlap, rejectedBudget, rejectedNear, rejectedKinds
};

/**
 * A point against a closed shell by parity: the rays tried from it, in a fixed set of directions, and the first whose
 * every hit is a crossing of a face of the shell (the second too with Options::checkSecondRay) counted. on: the point
 * within the tolerance of the shell (a crossing that near on every ray). unknown: no usable ray, or two disagreeing.
 */
struct PointClass {
  enum Side : uint8_t { inside, outside, on, unknown };
  Side side = unknown;
  /** Why unknown or on (static storage). */
  const char* why = "";
  /** The deciding ray: the point plus t times dir (a unit vector), t in [0, length], and its crossings. */
  Vec3 dir;
  double length = 0;
  int crossings = 0;
  /** Rays tried, and those set aside by why (Rejected). */
  int tried = 0;
  int rejected[rejectedKinds] = {};
  /** A second ray counted and agreeing (Options::checkSecondRay). */
  bool checked = false;
};

/**
 * Which side of closed shell `shell` a point just outside face `face` lies on, the point at a point well inside the
 * face moved eps along the face's normal (its sense applied): outside, the face's normal points out of the shell;
 * inside, into it (a void's faces, rightly, face into the void, so a void shell's are inside); unknown where it can't
 * be told (no point well inside the face, no offset clear of the other faces, or the point unknown).
 */
struct ShellSide {
  enum Side : uint8_t { outside, inside, unknown };
  Side side = unknown;
  const char* why = "";
  /** The point on the face, the point moved eps off it, and that point's classification. */
  Vec3 from, point;
  double eps = 0;
  PointClass classified;
};

class Oracle {
public:
  /**
   * The oracle of the model in `size` bytes at `buf` (cad-brep's buffer, 8-byte aligned; viewed, not copied: it must
   * outlive the oracle). ok() is false where it isn't a model.
   */
  Oracle(const uint8_t* buf, size_t size, Options options = {});
  ~Oracle();
  Oracle(const Oracle&) = delete;
  Oracle& operator=(const Oracle&) = delete;
  bool ok() const;

  /**
   * The edge's length between its start and end (its curve's parameters as the face API takes them: its range, else
   * its vertices inverted onto its curve). Unsupported for an edge with no 3D curve; 0 for a degenerate one.
   */
  Estimate edgeLength(int edge);
  /** The face's area, perimeter and flags. */
  FaceMeasure face(int face);
  /**
   * The integral of g over the face, one Estimate per component (each component's status unsupported on surfaces the
   * oracle doesn't measure), by the face's method with the area element's antiderivative numeric.
   */
  std::vector<Estimate> faceIntegral(int face, const Integrand& g);
  /**
   * The line o + t d, t in tr (finite), against the face: cad-geom's intersectLine on its surface (as the face API
   * closes it in fact) at the face API's tolerance for the face, each contact classified against its loops by the face
   * API (a tangency at that tolerance widened by half its span, so one reaching into the face isn't left out); a
   * contact outside the face dropped. unsupported where the face has no surface or loops.
   */
  RayFace rayFace(int face, Vec3 o, Vec3 d, cadgeom::Range tr);
  /** A point against a closed shell (row of the shell table), by parity (PointClass). */
  PointClass classify(int shell, Vec3 p);
  /**
   * ShellSide for a closed shell's face (rows of the shell and face tables), eps the offset along its normal (where
   * that offset meets another face, halved up to four times, not below 10 times the face's tolerance; negative,
   * against the normal).
   */
  ShellSide shellSide(int shell, int face, double eps);
  /**
   * The closed shells of body `body` (a row of the body table) nested: per shell of the body, in order, the index
   * (among them) of the smallest shell holding it, -1 for none, -2 where it can't be told (a point on it unknown
   * against another); an open shell -2. A point of each face-bearing shell, well inside one of its faces, classified
   * against each other closed shell.
   */
  std::vector<int> nesting(int body);

  struct Impl;

private:
  std::unique_ptr<Impl> impl_;
};

} // namespace cadoracle
