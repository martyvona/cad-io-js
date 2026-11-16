// The edges' contract: each model edge sampled once in 3D, every face that uses it given the same samples in its
// (u, v), so faces meshed apart meet exactly along their edges (the samples' 3D points shared, each face's mesh2d.h
// boundary built from them). The spacing is guaranteed, not sampled: over each span the curve's derivBound bounds the
// chord's deviation ((b - a)^2 max |C''| / 8), its length ((b - a) max |C'|) and its tangent's turn, so the
// deflection, spacing and angle limits hold whatever the curve does between samples. That is C(t)'s deviation: with
// the vertices' points exact at the ends, an end span strays up to the deflection plus the vertex's gap from its
// curve. A span whose length bound is under 10 x the part's tolerance is kept as it is (near a zero-speed point the
// curve doesn't report, the angle would refine without end). A split the mesher asks for (mesh2d.h's SplitWanted)
// resamples that edge alone, for all its faces at once.
//
// Pseudo-edges: a face on a periodic surface whose loops wind round the period (a band's two circles, a hemisphere's
// equator) needs a cut no model edge gives to make it a domain. It gets one: a pseudo-edge along the iso-line of the
// period's direction, sampled once at the face's spacing and used on both sides like a seam, from one winding loop to
// the other (or to the pole, where a loop winds alone towards one). The cut is at the period's start unless a sample
// of the face's loops is within the tolerance of that line in 3D (a vertex, a loop crossing there) or a loop that
// doesn't wind (a hole) spans it, and then at the middle of the widest gap between all the loops' samples' values in
// that direction (taken modulo the period, points at a pole left out); either only where every winding loop crosses
// it once away from a pole (a vertex off its curve can take a loop back across; a loop through a pole crosses the
// whole pole line there), else the next widest gap's. Each loop gets a sample where the cut crosses it.
// Pseudo-edges are numbered after the model's edges.
#pragma once

#include <cstdint>
#include <limits>
#include <memory>
#include <vector>

#include "cad_geom/model.h"
#include "cad_geom/result.h"
#include "cad_geom/surface.h"
#include "cad_geom/tolerance.h"
#include "cad_geom/vec.h"

namespace tesscadio {

using cadgeom::Status;
using cadgeom::Vec2;
using cadgeom::Vec3;

/**
 * The face's surface as tess-cadio meshes it: cad-geom's, as it closes in fact (cadgeom::closeInFact at the face's
 * tolerance, `tols.face`: cad-geom's tolerance.h, the face API's rule): a direction closed in fact periodic, its
 * boundary's (u, v) then running past the seam as on a cylinder, collapsed sides pole lines. Null where makeSurface
 * gives none (`status` its reason).
 */
std::unique_ptr<cadgeom::Surface> closedSurface(const cadgeom::Model& m, const cadgeom::Tolerances& tols, int face,
  Status& status);

struct EdgeOptions {
  /** The largest distance a chord between consecutive samples may stray from the curve, in model units (mm). */
  double deflection = 0.1;
  /**
   * The most (radians) the curve's tangent may turn across a span, between any two of its points, as the faces'
   * corner normals may (on an arc, twice the chord's angle to its tangents); 0 for none. Bounded by the span's max
   * |C''| against |C'| at its middle; a span the curve reports singular (a cusp) is split down to the deflection
   * alone.
   */
  double angle = 0;
  /** The largest 3D length of a span (an upper bound on its arc length), whatever the faces say. */
  double maxSpacing = std::numeric_limits<double>::infinity();
  /**
   * Whether a use without a p-curve gets one projected from its edge's 3D curve (cad-geom's projectCurve, at the
   * edge's tolerance), else is sampled by inversion (as it is where the projection isn't ok).
   */
  bool projectMissingPcurves = true;
};

/**
 * Each model edge's samples, in the edge's start-to-end order: parameters on its curve and 3D points. The first and
 * last points are the edge's vertices' points (exactly, so edges meeting at a vertex share one point), the others
 * the curve's at their parameters. A closed edge (start == end) runs its whole range, its first and last the one
 * vertex, with at least 3 spans.
 */
struct EdgeSamples {
  Status status = Status::unsupported;
  std::vector<double> t;
  std::vector<Vec3> points;
};

/**
 * A coedge's samples in its face's (u, v), in the coedge's direction of travel (its edge's samples reversed where
 * it runs against its edge): `uv[i]` stands for the edge's sample `index[i]`. Through the coedge's p-curve at the
 * same parameters where it has one and it lands on the edge's points (within 100 x the tolerance inside the edge),
 * else by inverting each 3D point onto the surface, seeded by the p-curve's (u, v) or the previous sample's (a p-curve
 * parameterized otherwise than its curve, against Part 42, only seeds). Along a periodic direction the (u, v) are
 * continuous (unwrapped: a p-curve crossing u = 2 pi keeps going past it). A seam's two uses each have their own
 * (u, v), one copy of the edge's samples on each side.
 * A use by inversion or a projected p-curve that passes through a pole between its ends (a meridian over a sphere's
 * pole) has its sample there twice, at the free coordinate on each side (index repeats it), the face's boundary
 * running along the pole line between them.
 */
struct CoedgeSamples {
  Status status = Status::unsupported;
  std::vector<Vec2> uv;
  std::vector<int32_t> index;
  /** Whether through a p-curve (false: by inversion). */
  bool fromPcurve = false;
  /** Whether that p-curve was projected (the model gives the use none): through poles as inversion's are. */
  bool projected = false;
  /** The largest 3D distance between the surface at uv[i] and the edge's point, for diagnostics (the gap). */
  double gap = 0;
};

/** A boundary point of a face in (u, v). */
struct BoundaryPoint {
  /**
   * edgeSample: a model edge's; pseudoSample: a pseudo-edge's (a cut, not a model edge: never reported as one);
   * poleLine: on a pole line (in 3D the pole itself; edge and sample -1); vertexPoint: a vertex loop's point inside
   * the face (-1, -1).
   */
  enum Kind : uint8_t { edgeSample, pseudoSample, poleLine, vertexPoint } kind = edgeSample;
  Vec2 uv;
  /** The edge (model or pseudo) and its sample. */
  int32_t edgeIndex = -1, sample = -1;
  Vec3 point;
};

/**
 * A face's loops in (u, v), ready for mesh2d.h's Domain2 (outer counterclockwise: a face whose sameSense is false has
 * its loops reversed). Each loop's coedges' samples in order, the junction of consecutive coedges once (the end of
 * the one before), each coedge shifted by whole periods to start where the last ended. Where a loop jumps along a
 * pole line (a sphere's v = pi / 2, a cone's apex: the canonical model has no degenerate edges, rule 7), the jump runs
 * the way that keeps the face on its side and is filled with pole-line points, as many per period as the face's
 * loops have samples, at least 16, all at the pole in 3D; a vertex loop at a pole is the pole line across the
 * period. Winding loops are joined by their cut (above) into one. A seam use found by inversion (no p-curve) has its
 * side from its neighbours (the junction that isn't at a pole), checked against its direction and the face's sense;
 * where they don't decide it or disagree, the status is Status::singular (the loops as placed). Internal coedges
 * (slits, embedded curves) come as interior chains, a vertex loop not at a pole as a chain of one point; external
 * coedges are left out. A face with no edge loops (none, or vertex loops only) is its surface's natural extent where
 * it closes: periodic in one direction with poles at both ends of the other (a sphere), one loop along both pole
 * lines and the two copies of a pseudo-edge from pole to pole; periodic both ways with no singularity (a torus), one
 * loop of the two copies each of a closed pseudo-edge along each direction, meeting at one corner; the cuts half a
 * period from its vertex loops' points. Otherwise, or a face winding round both periods, Status::unsupported.
 */
struct FaceBoundary {
  Status status = Status::unsupported;
  /**
   * A loop runs against the face's sense: a projected seam use's side, by its direction and the face's sense, has
   * the loop's other points on its other side (a face turned while its loop isn't). Meshed as the face's sense has
   * it; which of the two is right is healing's to settle.
   */
  bool againstSense = false;
  std::vector<std::vector<BoundaryPoint>> loops;
  /** Interior constraint chains: each a run of points to join pairwise (or a single point to keep). */
  std::vector<std::vector<BoundaryPoint>> interior;
};

/**
 * A split asked for: the edge's (model or pseudo) span between samples `span` and `span + 1`, at `fraction` of it in
 * parameter, clamped to [0.1, 0.9] so no sample lands nearer than a tenth of the span to another.
 */
struct SplitRequest {
  int32_t edge;
  int32_t span;
  double fraction = 0.5;
};

/**
 * A model's edges sampled (all at construction), and its faces' boundaries from them. The model must outlive it.
 * Problems are statuses per edge, coedge and face, never throws: an edge with no curve (p-curves only) is sampled
 * through its first use's p-curve on that face's surface, the bound then that of the composition; an edge with no
 * range takes one from its vertices by inversion (a closed edge on a periodic curve, the whole period); an edge or
 * face that can't be made has its status say why and no samples.
 */
class EdgeMesh {
public:
  /**
   * `faceSpacing[f]` the largest 3D span on an edge of face f (the surfaces' lane's say: how narrow a curved face's
   * triangles must be next to its boundary), infinity for none; an edge's spacing the least over its faces and
   * `options.maxSpacing`. Empty: no limits from the faces.
   */
  EdgeMesh(const cadgeom::Model& model, const EdgeOptions& options, const std::vector<double>& faceSpacing = {});
  ~EdgeMesh();
  EdgeMesh(const EdgeMesh&) = delete;
  EdgeMesh& operator=(const EdgeMesh&) = delete;

  /** The model's edges, then the pseudo-edges. */
  int edgeCount() const;
  bool isPseudo(int e) const;
  const EdgeSamples& edge(int e) const;
  const CoedgeSamples& coedge(int c) const;
  /** Face f's boundary from the current samples (made each call: after split(), the new samples). */
  FaceBoundary face(int f) const;

  /**
   * The valid requests applied, the bad ones (no such edge or span, a fraction not finite) ignored: Status::ok if
   * there were none, else Status::invalidModel. Each request adds one sample inside its span (several on one span
   * each at its own fraction of the span as it was, those within a tenth of the span of one another once); existing
   * samples are kept, so other edges' indices stand and only the touched edges' later indices move. The touched
   * edges' coedges are redone.
   */
  Status split(const std::vector<SplitRequest>& requests);

private:
  struct Impl;
  Impl* impl_;
};

} // namespace tesscadio
