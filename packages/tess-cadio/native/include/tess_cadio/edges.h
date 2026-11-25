// The edges' contract: each model edge sampled once in 3D, every face that uses it given the same samples in its
// (u, v), so faces meshed apart meet exactly along their edges (the samples' 3D points shared, each face's mesh2d.h
// boundary built from them). The spacing is guaranteed, not sampled: over each span the curve's derivBound bounds the
// chord's deviation ((b - a)^2 max |C''| / 8), its length ((b - a) max |C'|) and its tangent's turn, so the
// deflection, spacing and angle limits hold whatever the curve does between samples. That is C(t)'s deviation: with
// the vertices' points exact at the ends, an end span strays up to the deflection plus the vertex's gap from its
// curve. A span whose length bound is within the refinement floor (criteria.h) is kept as it is (near a zero-speed
// point the curve doesn't report, the angle would refine without end). A split the mesher asks for (mesh2d.h's
// SplitWanted) resamples that edge alone, for all its faces at once, never on a span whose chord is within the floor.
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
#include <functional>
#include <limits>
#include <memory>
#include <string>
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
   * Called as the construction goes, if set: (done, total, face) over the model's edges sampled and then their uses
   * placed, `face` the use's face row (-1 for an edge); and as split() (respace's too) places a use again: (the use,
   * the model's uses, its face row).
   */
  std::function<void(int, int, int)> progress;
  /**
   * Whether a use without a p-curve gets one projected from its edge's 3D curve (cad-geom's projectCurve, within
   * 0.05 x the deflection of its feet where the curve allows, else at the edge's tolerance), else is sampled by
   * inversion (as it is where neither projection is ok).
   */
  bool projectMissingPcurves = true;
  /**
   * For tests, if set: in place of cad-geom's localFoot where a use without a p-curve is traced sample by sample,
   * (face row, point, the sample before's (u, v), foot out, its distance out), true where it converged.
   */
  std::function<bool(int, Vec3, Vec2, Vec2&, double&)> localFootForTests;
  /**
   * The model's analysis buffer (cad-brep's cad_analysis.h), if given: 8-byte aligned, of this model, kept alive
   * while the EdgeMesh is. An edge or vertex whose tolerance healing grew past repair (toleranceError) is met as
   * any other, its faces' records saying how far (FaceBoundary::offSurface). Not given, or not an analysis: nothing.
   */
  const uint8_t* analysis = nullptr;
  size_t analysisSize = 0;
  /**
   * With an analysis: a use whose p-curve healing made (pcurveFrom healed) placed as a projected one, at its trace's
   * tolerance (a trace row's tol) or else its edge's (its inside samples at their points' feet, its ends at its
   * vertices'). Off by default: it mends some healed faces and turns others (the bicycle's #2763, bug25287 #2134).
   */
  bool placeHealedPcurves = false;
};

/**
 * A loose curve's polylines (a model's curve item: a wireframe's or geometric set's curve, no face's edge): its points
 * over its whole domain, every span within `o`'s deflection, angle and spacing by the same bounds as an edge's, none
 * refined below the refinement floor at part tolerance `tol` (criteria.h); a periodic curve's (its ends one point) in
 * at least 3 spans. A composite's segments each a polyline of its own, in order, each run in the composite's sense (as
 * OCCT's STEP translator makes a composite's edges: a discontinuous joint drawn as no chord). `status` the worst of
 * them: a curve or segment left out where it can't be made (makeCurve's status) or is unbounded (Status::unsupported:
 * a line or parabola, not trimmed), the others still given; Status::noConvergence where a span ran out of refinement,
 * its points given.
 */
std::vector<std::vector<Vec3>> sampleLooseCurve(const cadgeom::Model& m, int curve, const EdgeOptions& o, double tol,
  Status& status);

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
  /** The spans kept empty for poles' rings (EdgeMesh::cutRings): parameter ranges, low to high; split drops a point
   * inside one. */
  std::vector<cadgeom::Range> rings;
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

/**
 * The uses without p-curves whose edges have 3D curves, by how they were sampled: through a projection within 0.05
 * x the deflection of their feet, through one at the edge's tolerance (the curve farther off its surface than
 * that), or by inversion (no projection ok).
 */
struct ProjectionCounts {
  int withinMesh = 0, atEdgeTolerance = 0, byInversion = 0;
  /** Of those placed, how many lay far off their surface (past offSurfaceLimit), on their feet's p-curve. */
  int farOff = 0;
};

/**
 * A use with no p-curve (or one parameterized otherwise) has its inside samples' (u, v) by a local foot continued
 * from the sample before; the global search only at its ends, at a pole, and where the local step fails or jumps.
 */
struct TraceCounts {
  int local = 0, global = 0;
};
/**
 * The uses whose given p-curve is used (on the edge's points within 100 x the tolerance): how many, and how many of
 * them landed farther than the tolerance from a sample's 3D point, their inside samples polished onto it.
 */
struct GivenPcurveCounts {
  int used = 0, offTolerance = 0;
};

/** A sample whose local foot failed, found by the global search instead: its use, edge parameter, distance, why. */
struct TraceFallback {
  int32_t coedge;
  double t, distance;
  const char* why;
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
  /** Why, where the status isn't ok: a short cause for diagnostics (the first found), else empty. */
  std::string cause;
  /**
   * A loop runs against the face's sense: a projected seam use's side, by its direction and the face's sense, has
   * the loop's other points on its other side (a face turned while its loop isn't). Meshed as the face's sense has
   * it (the face ok, no cause); which of the two is right is healing's to settle.
   */
  bool againstSense = false;
  /**
   * Its edge loops, two or more, are all holes, none winding round a period: the first loop is its surface's natural
   * extent (as a face without edge loops has), their outer loop.
   */
  bool holesOnly = false;
  /**
   * Boundary folds repaired: a point whose (u, v) made a convex corner with its loop's neighbours while its 3D point
   * turns the other way about the surface's normal there (an ear on it would face against the surface: vertices off
   * their surface past its range's edge, their feet clamped), its (u, v) moved onto their (u, v) chord, at its share
   * of their 3D distance, where the surface there is within the face's tolerance of its 3D point (which is kept).
   */
  int foldsRepaired = 0;
  /**
   * How far its edges lie off its surface, the worst by its multiple of `offSurfaceWithin`: a use's curve from the
   * surface where it is placed (a given p-curve's points, a projection's feet), or the tolerance healing grew an edge
   * or vertex to past repair (with an analysis), within max(the deflection, the tolerance healing started from);
   * else within max(the deflection, the face's tolerance). The face is meshed however far (its triangles following
   * the edge); its record says it. Its edge or vertex (rows), or -1.
   */
  double offSurface = 0, offSurfaceWithin = 0;
  int32_t offSurfaceEdge = -1, offSurfaceVertex = -1;
  std::vector<std::vector<BoundaryPoint>> loops;
  /** Interior constraint chains: each a run of points to join pairwise (or a single point to keep). */
  std::vector<std::vector<BoundaryPoint>> interior;
};

/**
 * A split asked for: the edge's (model or pseudo) span between samples `span` and `span + 1`, at `fraction` of it in
 * parameter, clamped to [0.1, 0.9] so no sample lands nearer than a tenth of the span to another. `exact`: a sample
 * the caller needs at that very parameter (where a crease inside a face meets its boundary), fraction in (0, 1)
 * unclamped and kept whatever the span's length; one within 1e-9 of the span of a sample is that sample.
 */
struct SplitRequest {
  int32_t edge;
  int32_t span;
  double fraction = 0.5;
  bool exact = false;
};

/**
 * A pole's ring on an edge (a model edge or a cut's pseudo-edge) incident to the pole: the edge's parameter at its
 * nearest approach to the pole (its vertex there, or where the curve passes within the tolerance) and where the
 * ring crosses it. Between them the edge is one straight span (the pole-ring rule: straight within the deflection).
 */
struct RingCut {
  int32_t edge;
  double approach, crossing;
  /**
   * The crossing inserted where it is, even within the refinement floor of the approach's sample (a ring whose reach
   * is under the part's tolerance), which would otherwise be that sample and the cut not made. Set for all of a
   * ring's cuts or none (poles.h's ringCuts), so a ring is cut into every one of its edges or into none.
   */
  bool exact = false;
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
  /**
   * Edge e's point at parameter t on the curve it's sampled on (its 3D curve, or its first use's p-curve through the
   * surface): between samples, for a caller that judges the curve itself (a pole's ring, against its chords).
   */
  cadgeom::Vec3 point(int e, double t) const;
  const CoedgeSamples& coedge(int c) const;
  /** How the uses the model gives no p-curve were sampled (EdgeOptions::projectMissingPcurves). */
  const ProjectionCounts& projections() const;
  /** The uses with given p-curves (GivenPcurveCounts), as the samples now stand. */
  GivenPcurveCounts givenPcurves() const;
  /** The uses traced sample by sample (TraceCounts), each sample counted once however often it's redone. */
  const TraceCounts& traces() const;
  /** Those samples whose local foot failed, in the order found. */
  const std::vector<TraceFallback>& traceFallbacks() const;
  /** Face f's boundary from the current samples (made each call: after split(), the new samples). */
  FaceBoundary face(int f) const;

  /**
   * The valid requests applied, the bad ones (no such edge or span, a fraction not finite) ignored: Status::ok if
   * there were none, else Status::invalidModel. Each request adds one sample inside its span (several on one span
   * each at its own fraction of the span as it was, those within a tenth of the span of one another once); existing
   * samples are kept, so other edges' indices stand and only the touched edges' later indices move. The touched
   * edges' coedges are redone. A request whose sample would fall inside a ring's span (cutRings), on a span whose
   * chord is within the refinement floor (criteria.h), or on one with no width in parameter (a billionth of the
   * edge's range: its end vertex off the curve's end), is dropped.
   */
  Status split(const std::vector<SplitRequest>& requests);
  /**
   * Whether split() drops every point in edge e's span `span` for its end: an end span with no point within 0.9 of
   * the way from the edge's end past the reach that drops a sample near an end (min(tol, d / 10)). PartMesher
   * freezes it, as one within the refinement floor.
   */
  bool endSpanFrozen(int e, int span) const;

  /**
   * The faces' spacing given after the edges were sampled (their criteria, made from the boxes these samples give):
   * every edge's spans, a pseudo-edge's too, split until none is longer in 3D (its length, not its chord) than the
   * least of its faces' spacing,
   * through split(), so the samples there are kept and the new ones' uses found as split's are (each p-curve at its
   * parameter, a use with none continued locally). The edges are sampled once, refined only. Then a loop left with
   * fewer than three points (two one-chord edges between the same vertices: a lens whose chords coincide) gets a
   * sample at each of those edges' middles, so it bounds a polygon.
   */
  Status respace(const std::vector<double>& faceSpacing);

  /**
   * Each cut applied to its edge, once for every face using it (the samples are the edge's, its coedges redone): a
   * sample at the approach and one at the crossing (an existing sample within a millionth of a span, or within the
   * refinement floor of it in 3D, used instead, so a vertex at the pole stays the sample there), the samples strictly
   * between them removed, and the span between them kept empty from then on: split() drops a request inside it, so the
   * refinement rounds never refill a ring.
   * A cut from the approach of a ring already on the edge (within a millionth of the edge's range), its crossing
   * inside that ring, shrinks it instead: a sample at the new crossing, the span from there to the old one an
   * ordinary span. Bad cuts (no such edge, parameters not finite or outside
   * the edge's samples, approach equal to crossing) are ignored: Status::invalidModel if there were any, else
   * Status::ok. Other edges' indices stand.
   */
  Status cutRings(const std::vector<RingCut>& cuts);
  /**
   * Edge e's samples as saved earlier (a copy of edge(e)), its uses placed again: for undoing a change the caller
   * judged worse (PartMesher's ring shrinks). An index out of range is ignored.
   */
  void restore(int e, const EdgeSamples& saved);

private:
  struct Impl;
  Impl* impl_;
};

} // namespace tesscadio
