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
  /** The loops in (u, v) come from the face API's projection, not from given or healed p-curves. */
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
  /** Where the area is unsupported or failed: why, a short phrase (static storage). */
  const char* why = "";
};

/**
 * A measure to rely on: computed (status ok), no flags, and its error within `relative` of its value. The type says
 * only that much: an untrusted measure is still a value or not, which false doesn't tell.
 */
inline bool trusted(const FaceMeasure& m, double relative = 1e-6) {
  return m.area.status == Status::ok && m.flags == 0 && m.area.error <= relative * m.area.value;
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

  struct Impl;

private:
  std::unique_ptr<Impl> impl_;
};

} // namespace cadoracle
