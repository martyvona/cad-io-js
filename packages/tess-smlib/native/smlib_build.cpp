// The builder: a part's cad-brep buffer (cad_brep.h) as SMLib B-reps, through SMLib's flattened B-rep tables
// (SmBrepData) and SmBrep::MakeTopologyFromData, which links the topology, makes each coedge's (u, v) trim from its 3D
// edge and the face's surface, and heals. Written from docs/brep-reference.md (the model) and SMLib's headers and
// documentation (third_party/usd-brep: source/SMLib/inc, .agents/skills/smlib-brep-model).
//
// What SMLib needs that the model doesn't say, and how it's made here:
//   - Each B-rep is one shell (or one face item) in SMLib's open-sheet form: one region (the infinite one) holding one
//     shell with both sides (faceuses) of every face. A mesh needs no regions, and the form takes faces whatever their
//     orientation: a closed shell whose faces disagree is still one valid sheet. Face rows ride as user index 1 (row +
//     1) so triangles name their faces.
//   - Geometry is SMLib's own kinds where it has them. SMLib's parameterizations differ from Part 42's (angles in
//     degrees; analytic surfaces also carry a NURBS (u, v) that faces' domains are in), so nothing is passed in
//     parameters: an edge's interval comes from its vertices on SMLib's curve (in closed form for lines and conics,
//     each conic built over its edge's angles; by SMLib's projection for others), and a face's domain from its
//     boundary in Part 42's (u, v) of the surface, in closed form, which SMLib's analytic surfaces take as their STEP
//     domain and convert. P-curves are not passed: SMLib makes the trims.
//   - Each edge owns its curve and each face its surface (SMLib's rule), so shared rows are built once per use.
//   - SMLib's edge runs from the start of its interval to its end; an edge running against its curve (sameSense
//     false) is given its vertices the other way round.
//   - A face's loops: its outer loop first (SMLib takes the first as outer), vertex loops last.
//   - Radial order: each edge's uses as mated pairs, alternating in orientation, starting with a use along the edge.
//
// Not built (each said in a warning, the face or item left out): Part 42's curve-swept surfaces; edges between two
// vertices without a 3D curve; composite and offset edge curves; internal and external coedges; unbounded loose curves
// and surfaces. docs/backends.md has SMLib's quirks behind the rest of what is done here.

#include "smlib_build.h"

#include "SmApiGeneral.h"
#include "SmBSplineCurve.h"
#include "SmBSplineSurface.h"
#include "SmBrep.h"
#include "SmBrepData.h"
#include "SmCircle.h"
#include "SmCone.h"
#include "SmContext.h"
#include "SmCylinder.h"
#include "SmEdge.h"
#include "SmEllipse.h"
#include "SmAttribute.h"
#include "SmFace.h"
#include "SmFaceuse.h"
#include "SmRegion.h"
#include "SmShell.h"
#include "SmLine.h"
#include "SmPlane.h"
#include "SmSphere.h"
#include "SmSurfOfExtrusion.h"
#include "SmSurfOfRevolution.h"
#include "SmTorus.h"

#include "cad_brep.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <functional>
#include <map>
#include <unordered_map>

namespace {

const double PI = 3.14159265358979323846;
const double DEG = 180.0 / PI;

struct V3
{
  double x = 0, y = 0, z = 0;
};
V3 operator-(V3 a, V3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
V3 operator+(V3 a, V3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
V3 operator*(double s, V3 a) { return {s * a.x, s * a.y, s * a.z}; }
double dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
V3 cross(V3 a, V3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
double norm(V3 a) { return std::sqrt(dot(a, a)); }
SmPoint3d sp(V3 a) { return SmPoint3d(a.x, a.y, a.z); }
SmVector3d sv(V3 a) { return SmVector3d(a.x, a.y, a.z); }
V3 v3(const SmVector3d& a) { return {a.x, a.y, a.z}; }

// A placement: origin, axis, x direction (Part 42's axis2_placement_3d as the model stores it); y = axis x x.
struct Frame
{
  V3 o, z, x, y;
};
Frame frame(const double* r)
{
  Frame f;
  f.o = {r[0], r[1], r[2]};
  f.z = {r[3], r[4], r[5]};
  f.x = {r[6], r[7], r[8]};
  f.y = cross(f.z, f.x);
  return f;
}
SmAxis2Placement placement(const Frame& f) { return SmAxis2Placement(sp(f.o), sv(f.x), sv(f.y)); }

// The model's columns.
struct Model
{
  cbr_view v[CBR_COLUMN_COUNT];
  uint32_t rows(int c, int width = 1) const { return v[c].count / width; }
  const double* curveReal(int i) const { return CBR_F64(v[CBR_POOL_CURVE_REAL]) + CBR_I32(v[CBR_CURVE_REAL])[i]; }
  const int32_t* curveInt(int i) const { return CBR_I32(v[CBR_POOL_CURVE_INT]) + CBR_I32(v[CBR_CURVE_INT])[i]; }
  int curveKind(int i) const { return CBR_U8(v[CBR_CURVE_KIND])[i]; }
  int curveDim(int i) const { return CBR_U8(v[CBR_CURVE_DIM])[i]; }
  const double* surfaceReal(int i) const
  {
    return CBR_F64(v[CBR_POOL_SURFACE_REAL]) + CBR_I32(v[CBR_SURFACE_REAL])[i];
  }
  const int32_t* surfaceInt(int i) const { return CBR_I32(v[CBR_POOL_SURFACE_INT]) + CBR_I32(v[CBR_SURFACE_INT])[i]; }
  int surfaceKind(int i) const { return CBR_U8(v[CBR_SURFACE_KIND])[i]; }
  V3 vertex(int i) const
  {
    const double* p = CBR_F64(v[CBR_VERTEX_POINT]) + 3 * i;
    return {p[0], p[1], p[2]};
  }
  double vertexTol(int i) const { return CBR_F64(v[CBR_VERTEX_TOLERANCE])[i]; }
  int edgeCurve(int e) const { return CBR_I32(v[CBR_EDGE_CURVE])[e]; }
  int edgeStart(int e) const { return CBR_I32(v[CBR_EDGE_START])[e]; }
  int edgeEnd(int e) const { return CBR_I32(v[CBR_EDGE_END])[e]; }
  bool edgeSameSense(int e) const { return CBR_U8(v[CBR_EDGE_SAME_SENSE])[e] != 0; }
  // An edge of no length (a pole, an apex): flagged so, or without a 3D curve from a vertex to itself.
  bool edgeDegenerate(int e) const
  {
    return (CBR_U8(v[CBR_EDGE_FLAGS])[e] & CBR_EDGE_DEGENERATE) != 0
      || (edgeCurve(e) < 0 && edgeStart(e) >= 0 && edgeStart(e) == edgeEnd(e));
  }
  int coedgeEdge(int c) const { return CBR_I32(v[CBR_COEDGE_EDGE])[c]; }
  int coedgeOrientation(int c) const { return CBR_U8(v[CBR_COEDGE_ORIENTATION])[c]; }
  int loopKind(int l) const { return CBR_U8(v[CBR_LOOP_KIND])[l]; }
  int loopBound(int l) const { return CBR_U8(v[CBR_LOOP_BOUND])[l]; }
  bool loopSense(int l) const { return CBR_U8(v[CBR_LOOP_SENSE])[l] != 0; }
  int loopFirst(int l) const { return CBR_I32(v[CBR_LOOP_FIRST])[l]; }
  int loopCount(int l) const { return CBR_I32(v[CBR_LOOP_COUNT])[l]; }
  int loopCorner(int l, int k) const { return CBR_I32(v[CBR_POOL_LOOP_INT])[loopFirst(l) + k]; }
  int faceSurface(int f) const { return CBR_I32(v[CBR_FACE_SURFACE])[f]; }
  bool faceSameSense(int f) const { return CBR_U8(v[CBR_FACE_SAME_SENSE])[f] != 0; }
  int faceFirstLoop(int f) const { return CBR_I32(v[CBR_FACE_FIRST_LOOP])[f]; }
  int faceLoopCount(int f) const { return CBR_I32(v[CBR_FACE_LOOP_COUNT])[f]; }
  double faceId(int f) const { return CBR_F64(v[CBR_FACE_ID])[f]; }
  int shellFirst(int s) const { return CBR_I32(v[CBR_SHELL_FIRST])[s]; }
  int shellCount(int s) const { return CBR_I32(v[CBR_SHELL_COUNT])[s]; }
  int shellKind(int s) const { return CBR_U8(v[CBR_SHELL_KIND])[s]; }
  int faceUseFace(int u) const { return CBR_I32(v[CBR_FACE_USE_FACE])[u]; }
  int bodyKind(int b) const { return CBR_U8(v[CBR_BODY_KIND])[b]; }
  int bodyFirst(int b) const { return CBR_I32(v[CBR_BODY_FIRST])[b]; }
  int bodyCount(int b) const { return CBR_I32(v[CBR_BODY_COUNT])[b]; }
  int memberRef(int m) const { return CBR_I32(v[CBR_MEMBER_REF])[m]; }
  int itemKind(int i) const { return CBR_U8(v[CBR_ITEM_KIND])[i]; }
  int itemRef(int i) const { return CBR_I32(v[CBR_ITEM_REF])[i]; }
  int itemTransform(int i) const { return CBR_I32(v[CBR_ITEM_TRANSFORM])[i]; }
  const double* itemReal(int o) const { return CBR_F64(v[CBR_POOL_ITEM_REAL]) + o; }
};

const char* curveKindName(int k)
{
  static const char* names[] = {"?", "line", "circle", "ellipse", "hyperbola", "parabola", "bspline", "polyline",
    "trimmed", "composite", "offset"};
  return k >= 1 && k <= 10 ? names[k] : "?";
}
const char* surfaceKindName(int k)
{
  static const char* names[] = {"?", "plane", "cylinder", "cone", "sphere", "torus", "bspline", "extrusion",
    "revolution", "offset", "rectangularTrimmed", "curveSwept", "fixedReferenceSwept"};
  return k >= 1 && k <= 12 ? names[k] : "?";
}

// A 3D curve as SMLib's, for one edge: the curve, and the edge's interval on it, from its start vertex (in SMLib's
// direction) to its end.
struct EdgeGeom
{
  SmCurve* curve = nullptr;
  SmExtent1d interval;
  // The interval runs from the end vertex to the start: an edge whose vertices lie the other way along its curve
  // (files have them), built from its end to its start.
  bool swapped = false;
  std::string error;
};

class Builder
{
public:
  Builder(const Model& m, const SmContext& ctx, double zoneTol, const BuildOptions& opt, BuiltPart& out)
    : m(m), ctx(ctx), zoneTol(zoneTol), heal(opt.heal), lin(opt.linearDeflection), ang(opt.angularDeflection), out(out)
  {
  }

  void build();

private:
  const Model& m;
  const SmContext& ctx;
  double zoneTol;
  bool heal;
  double lin, ang;
  BuiltPart& out;
  std::map<std::string, int> warned;

  void warn(const std::string& s)
  {
    if (warned[s]++ == 0) out.warnings.push_back(s);
  }

  // The basis of a trimmed curve, followed down; -1 past a reference out of range.
  int baseCurve(int c) const
  {
    for (int depth = 0; c >= 0 && depth < 32 && m.curveKind(c) == CBR_CURVE_TRIMMED; depth++) c = m.curveInt(c)[0];
    return c;
  }

  // The angle of p about a frame's axis, from its x direction, in radians.
  static double angle(const Frame& f, V3 p)
  {
    V3 d = p - f.o;
    return std::atan2(dot(d, f.y), dot(d, f.x));
  }

  // An ellipse's (or circle's) parameter of p: Part 42's, where p = o + a cos t x + b sin t y.
  static double conicParam(const Frame& f, double a, double b, V3 p)
  {
    V3 d = p - f.o;
    return std::atan2(dot(d, f.y) / b, dot(d, f.x) / a);
  }

  // Degrees [a0, a1], a1 > a0, from radians t0 and t1 (t1 the end, closed when the edge is closed), kept inside
  // SMLib's [-360, 360].
  static SmExtent1d degrees(double t0, double t1, bool closed)
  {
    double a0 = t0 * DEG, a1 = t1 * DEG;
    if (closed) a1 = a0 + 360;
    while (a1 <= a0 + 1e-9) a1 += 360;
    while (a1 - a0 > 360 + 1e-9) a1 -= 360;
    if (a1 > 360) { a0 -= 360; a1 -= 360; }
    return SmExtent1d(a0, a1);
  }

  EdgeGeom edgeGeom(int e, int v0, int v1)
  {
    EdgeGeom g;
    int c = baseCurve(m.edgeCurve(e));
    if (c < 0) { g.error = "edges without a 3D curve"; return g; }
    if (v0 < 0 || v1 < 0) { g.error = "edges without vertices"; return g; }
    return span(c, m.vertex(v0), m.vertex(v1), v0 == v1);
  }

  // A curve row (not trimmed) as SMLib's from p0 to p1 (points on it; once round from p0 where closed).
  EdgeGeom span(int c, V3 p0, V3 p1, bool closed)
  {
    EdgeGeom g;
    const double* r = m.curveReal(c);
    const int32_t* n = m.curveInt(c);
    switch (m.curveKind(c)) {
    case CBR_CURVE_LINE: {
      V3 o = {r[0], r[1], r[2]}, d = {r[3], r[4], r[5]};
      // SMLib's line: o + s d over the edge's [s0, s1], s distance (d made a unit vector: SMLib takes it as one).
      double len = norm(d);
      if (!(len > 0)) { g.error = "lines of no direction"; return g; }
      d = (1 / len) * d;
      double s0 = dot(p0 - o, d), s1 = dot(p1 - o, d);
      // An edge whose vertices lie the other way along its line (files have them): the line turned round.
      if (s1 < s0 - zoneTol) { d = -1.0 * d; s0 = -s0; s1 = -s1; }
      if (!(s1 > s0)) { g.error = "line edges of no length"; return g; }
      SmLine* l = nullptr;
      if (SmLine::CreateCanonical(ctx, sp(o), sv(d), l) != SM_SUCCESS || !l) {
        g.error = "lines SMLib refused";
        return g;
      }
      g.curve = l;
      g.interval = SmExtent1d(s0, s1);
      return g;
    }
    case CBR_CURVE_CIRCLE:
    case CBR_CURVE_ELLIPSE: {
      Frame f = frame(r);
      double a = r[9], b = m.curveKind(c) == CBR_CURVE_CIRCLE ? r[9] : r[10];
      SmExtent1d deg = degrees(conicParam(f, a, b, p0), conicParam(f, a, b, p1), closed);
      if (m.curveKind(c) == CBR_CURVE_CIRCLE) {
        SmCircle* k = nullptr;
        if (SmCircle::CreateCanonical(ctx, placement(f), a, k, &deg) != SM_SUCCESS || !k) {
          g.error = "circles SMLib refused";
          return g;
        }
        g.curve = k;
      } else {
        SmEllipse* k = nullptr;
        if (SmEllipse::CreateCanonical(ctx, placement(f), a, b, k, &deg) != SM_SUCCESS || !k) {
          g.error = "ellipses SMLib refused";
          return g;
        }
        g.curve = k;
      }
      g.interval = g.curve->GetNaturalInterval();
      return g;
    }
    case CBR_CURVE_BSPLINE:
    case CBR_CURVE_POLYLINE: {
      SmBSplineCurve* k = bsplineCurve(c);
      if (!k) { g.error = std::string(curveKindName(m.curveKind(c))) + " curves SMLib refused"; return g; }
      SmExtent1d nat = k->GetNaturalInterval();
      double t0, t1, period = periodOf(c);
      if (!drop(k, nat, p0, t0) || (!closed && !drop(k, nat, p1, t1))) {
        delete k;
        g.error = "B-spline edges whose vertices SMLib can't place on their curve";
        return g;
      }
      if (closed) {
        // Once round from the vertex: the curve's whole range where the vertex is at its seam (or it isn't
        // periodic), else a period from the vertex on the curve extended.
        bool atSeam = std::fabs(t0 - nat.GetMin()) <= 1e-9 * (nat.GetMax() - nat.GetMin())
          || std::fabs(t0 - nat.GetMax()) <= 1e-9 * (nat.GetMax() - nat.GetMin());
        if (atSeam || !(period > 0)) { g.curve = k; g.interval = nat; return g; }
        t1 = t0 + period;
      } else if (!(t1 > t0)) {
        // Across a periodic curve's seam: on the curve extended by a period. (A vertex at the seam reads as the
        // range's start or end: its end, then.)
        // (Only on a closed curve; elsewhere the vertices lie the other way along it.)
        SmVector3d c0[1], c1[1];
        k->Evaluate(nat.GetMin(), 0, FALSE, c0);
        k->Evaluate(nat.GetMax(), 0, FALSE, c1);
        bool closedCurve = period > 0 || norm(v3(c0[0]) - v3(c1[0])) <= zoneTol;
        if (closedCurve && std::fabs(t1 - nat.GetMin()) <= 1e-9 * (nat.GetMax() - nat.GetMin())) t1 = nat.GetMax();
        else if (period > 0) t1 += period;
        if (!(t1 > t0)) {
          if (!(t0 > t1)) {
            delete k;
            g.error = "B-spline edges of no length";
            return g;
          }
          std::swap(t0, t1);
          g.swapped = true;
        }
      }
      if (t1 > nat.GetMax() + 1e-9 * (nat.GetMax() - nat.GetMin())) {
        delete k;
        SmExtent1d trim(t0, t1);
        k = bsplineCurve(c, &trim);
        if (!k) { g.error = "B-spline edges across a seam SMLib refused"; return g; }
      }
      g.curve = k;
      g.interval = SmExtent1d(t0, t1);
      return g;
    }
    case CBR_CURVE_HYPERBOLA:
    case CBR_CURVE_PARABOLA: {
      // The arc between the vertices as a rational quadratic Bezier (SMLib has neither conic): its ends, and the
      // meeting point of their tangents, weighted cosh of half the parameter span (a parabola's 1).
      // Part 42: C + a cosh t x + b sinh t y; C + f t^2 x + 2 f t y.
      Frame f = frame(r);
      bool hyp = m.curveKind(c) == CBR_CURVE_HYPERBOLA;
      double a = r[9], b = hyp ? r[10] : 0;
      if (!(a > 0) || (hyp && !(b > 0))) { g.error = "conics of no size"; return g; }
      auto param = [&](V3 p) { double y = dot(p - f.o, f.y); return hyp ? std::asinh(y / b) : y / (2 * a); };
      double t0 = param(p0), t1 = param(p1);
      if (!(t1 > t0)) {
        g.error = "hyperbola and parabola edges whose vertices aren't in order on their curve";
        return g;
      }
      double mid = 0.5 * (t0 + t1), h = 0.5 * (t1 - t0), w = hyp ? std::cosh(h) : 1;
      auto at = [&](double x, double y) { return sp(f.o + x * f.x + y * f.y); };
      SmTArray<SmPoint3d> poles;
      if (hyp) {
        poles.Add(at(a * std::cosh(t0), b * std::sinh(t0)));
        poles.Add(at(a * std::cosh(mid) / w, b * std::sinh(mid) / w));
        poles.Add(at(a * std::cosh(t1), b * std::sinh(t1)));
      } else {
        poles.Add(at(a * t0 * t0, 2 * a * t0));
        poles.Add(at(a * t0 * t1, a * (t0 + t1)));
        poles.Add(at(a * t1 * t1, 2 * a * t1));
      }
      SmTArray<ULONG> mults;
      mults.Add(3); mults.Add(3);
      SmTArray<double> knots, weights;
      knots.Add(0); knots.Add(1);
      weights.Add(1); weights.Add(w); weights.Add(1);
      SmBSplineCurve* k = nullptr;
      if (SmBSplineCurve::CreateCanonical(ctx, 3, 2, poles, SM_CF_UNSPECIFIED, mults, knots, SM_KT_UNSPECIFIED,
            hyp ? &weights : nullptr, nullptr, k) != SM_SUCCESS || !k) {
        g.error = "hyperbola and parabola arcs SMLib refused";
        return g;
      }
      g.curve = k;
      g.interval = k->GetNaturalInterval();
      return g;
    }
    default:
      g.error = std::string(curveKindName(m.curveKind(c))) + " edge curves";
      return g;
    }
  }

  // A curve-bounded face's boundary segment (an edge without vertices) by its curve's own bounds: its ends in the
  // direction of its curve as the model has it (a trimmed curve's from its first trim to its second), whether it's one
  // closed curve, and whether SMLib's edge, which runs along the basis, runs against that (a trimmed curve against
  // its basis). False for curves without bounds of their own (lines, composites, ...).
  bool segment(int e, V3& a, V3& b, bool& closed, bool& against)
  {
    int c = m.edgeCurve(e);
    if (c < 0) return false;
    const double* r = m.curveReal(c);
    const int32_t* n = m.curveInt(c);
    against = false;
    closed = false;
    switch (m.curveKind(c)) {
    case CBR_CURVE_CIRCLE:
    case CBR_CURVE_ELLIPSE:
      curvePoint(c, 0, a);
      b = a;
      closed = true;
      return true;
    case CBR_CURVE_BSPLINE:
    case CBR_CURVE_POLYLINE: {
      SmBSplineCurve* k = bsplineCurve(c);
      if (!k) return false;
      SmExtent1d iv = k->GetNaturalInterval();
      SmVector3d p0[1], p1[1];
      k->Evaluate(iv.GetMin(), 0, FALSE, p0);
      k->Evaluate(iv.GetMax(), 0, FALSE, p1);
      delete k;
      a = v3(p0[0]);
      b = v3(p1[0]);
      closed = norm(b - a) <= zoneTol;
      return true;
    }
    case CBR_CURVE_TRIMMED: {
      int base = baseCurve(c);
      if (base < 0) return false;
      V3 p[2];
      for (int j = 0; j < 2; j++) {
        const double* q = r + 2 + 3 * j;
        if (!std::isnan(q[0])) p[j] = {q[0], q[1], q[2]};
        else if (std::isnan(r[j])) return false;
        else if (!curvePoint(base, r[j], p[j])) {
          // A B-spline basis at the parameter (its own: SMLib's B-spline has the model's).
          int bk = m.curveKind(base);
          if (bk != CBR_CURVE_BSPLINE && bk != CBR_CURVE_POLYLINE) return false;
          SmBSplineCurve* k = bsplineCurve(base);
          if (!k) return false;
          SmVector3d pd[1];
          k->Evaluate(r[j], 0, FALSE, pd);
          delete k;
          p[j] = v3(pd[0]);
        }
      }
      a = p[0];
      b = p[1];
      against = n[1] == 0;
      closed = norm(b - a) <= zoneTol;
      return true;
    }
    }
    return false;
  }

  // A straight edge from a to b (a poly loop's side).
  EdgeGeom lineGeom(V3 a, V3 b)
  {
    EdgeGeom g;
    V3 d = b - a;
    double len = norm(d);
    SmLine* l = nullptr;
    if (!(len > 0) || SmLine::CreateCanonical(ctx, sp(a), sv((1 / len) * d), l) != SM_SUCCESS || !l) {
      g.error = "poly loop sides of no length";
      return g;
    }
    g.curve = l;
    g.interval = SmExtent1d(0, len);
    return g;
  }

  bool drop(SmCurve* k, const SmExtent1d& nat, V3 p, double& t)
  {
    SmBoolean ok = FALSE;
    double dist = 0;
    if (k->DropPoint(nat, sp(p), nullptr, zoneTol, nullptr, ok, t, dist) != SM_SUCCESS || !ok) return false;
    return true;
  }

  // A B-spline row in periodic form (unclamped, its last `degree` poles its first): its period, else 0.
  double periodOf(int c) const
  {
    if (m.curveKind(c) != CBR_CURVE_BSPLINE) return 0;
    const double* r = m.curveReal(c);
    const int32_t* n = m.curveInt(c);
    int p = n[0], np = n[1], nk = n[2];
    std::vector<double> U;
    for (int i = 0; i < nk; i++) for (int j = 0; j < n[7 + i]; j++) U.push_back(r[i]);
    if ((int)U.size() != np + p + 1 || n[7] != 1 || n[7 + nk - 1] != 1 || np <= p) return 0;
    const double* P = r + nk;
    double size = 0;
    for (int i = 0; i < np; i++)
      size = std::max(size, std::fabs(P[3 * i]) + std::fabs(P[3 * i + 1]) + std::fabs(P[3 * i + 2]));
    for (int i = 0; i < p; i++)
      for (int k = 0; k < 3; k++)
        if (std::fabs(P[3 * (np - p + i) + k] - P[3 * i + k]) > 1e-9 * std::max(size, 1.0)) return 0;
    return U[np] - U[p];
  }

  // A B-spline (or polyline) row as SMLib's; given a trim, over it, the curve extended by a period first where it's
  // periodic (periodOf), so a trim may run past its seam.
  SmBSplineCurve* bsplineCurve(int c, const SmExtent1d* trim = nullptr)
  {
    const double* r = m.curveReal(c);
    const int32_t* n = m.curveInt(c);
    SmTArray<SmPoint3d> poles;
    SmTArray<ULONG> mults;
    SmTArray<double> knots, weights;
    int degree;
    bool rational = false;
    if (m.curveKind(c) == CBR_CURVE_POLYLINE) {
      int np = n[0];
      degree = 1;
      for (int i = 0; i < np; i++) poles.Add(SmPoint3d(r[3 * i], r[3 * i + 1], r[3 * i + 2]));
      for (int i = 0; i < np; i++) { knots.Add(i); mults.Add(i == 0 || i == np - 1 ? 2 : 1); }
    } else {
      degree = n[0];
      int np = n[1], nk = n[2];
      rational = n[3] != 0;
      std::vector<double> U;
      for (int i = 0; i < nk; i++) for (int j = 0; j < n[7 + i]; j++) U.push_back(r[i]);
      std::vector<int> ix(np);
      for (int i = 0; i < np; i++) ix[i] = i;
      double period = trim ? periodOf(c) : 0;
      if (period > 0) {
        // One more period, as the periodic form repeats: pole k + n - p is pole k, knot k + n - p knot k plus the
        // period (Piegl and Tiller).
        for (int i = 0; i < np - degree; i++) {
          ix.push_back(degree + i);
          U.push_back(U[2 * degree + 1 + i] + period);
        }
      }
      for (size_t i = 0; i < U.size(); i++) {
        if (i > 0 && U[i] == U[i - 1]) mults[mults.GetSize() - 1]++;
        else { knots.Add(U[i]); mults.Add(1); }
      }
      for (int i : ix) poles.Add(SmPoint3d(r[nk + 3 * i], r[nk + 3 * i + 1], r[nk + 3 * i + 2]));
      if (rational) for (int i : ix) weights.Add(r[nk + 3 * np + i]);
    }
    SmBSplineCurve* k = nullptr;
    if (SmBSplineCurve::CreateCanonical(ctx, 3, degree, poles, SM_CF_UNSPECIFIED, mults, knots, SM_KT_UNSPECIFIED,
          rational ? &weights : nullptr, trim, k) != SM_SUCCESS) return nullptr;
    return k;
  }

  // A face's surface as SMLib's, over the face's extent (Part 42's (u, v) box of its boundary points), with the face's
  // NURBS domain on it; whether SMLib's normal is the model's surface's.
  struct FaceGeom
  {
    SmSurface* surface = nullptr;
    SmExtent2d domain;
    bool flipped = false;
    std::string error;
  };

  // Part 42's (u, v) on an elementary surface of p, u in radians in (-pi, pi], v as the kind has it.
  void params(int kind, const double* r, V3 p, double& u, double& v) const
  {
    Frame f = frame(r);
    V3 d = p - f.o;
    double dx = dot(d, f.x), dy = dot(d, f.y), dz = dot(d, f.z);
    switch (kind) {
    case CBR_SURFACE_PLANE: u = dx; v = dy; return;
    case CBR_SURFACE_CYLINDER:
    case CBR_SURFACE_CONE: u = std::atan2(dy, dx); v = dz; return;
    case CBR_SURFACE_SPHERE: {
      u = std::atan2(dy, dx);
      double len = norm(d);
      v = len > 0 ? std::asin(std::max(-1.0, std::min(1.0, dz / len))) : 0;
      return;
    }
    case CBR_SURFACE_TORUS: {
      u = std::atan2(dy, dx);
      double rho = std::sqrt(dx * dx + dy * dy) - r[9];
      v = std::atan2(dz, rho);
      return;
    }
    }
    u = v = 0;
  }

  // Part 42's normal (S_u x S_v, not unit) of an elementary surface at p, a point on it.
  static V3 normal(int kind, const double* r, V3 p)
  {
    Frame f = frame(r);
    V3 d = p - f.o;
    V3 rho = dot(d, f.x) * f.x + dot(d, f.y) * f.y;
    double len = norm(rho);
    V3 radial = len > 0 ? (1 / len) * rho : f.x;
    switch (kind) {
    case CBR_SURFACE_PLANE: return f.z;
    case CBR_SURFACE_CYLINDER: return radial;
    case CBR_SURFACE_CONE: {
      // (R + v tan a)(cos u x + sin u y - tan a z): past the apex, where the radius is negative, the point lies
      // across the axis from its u, so the normal still points away from the axis, its part along the axis turned.
      double t = std::tan(r[10]), s = r[9] + dot(d, f.z) * t;
      return radial + (s < 0 ? t : -t) * f.z;
    }
    case CBR_SURFACE_SPHERE: return d;
    case CBR_SURFACE_TORUS: return d + (-r[9]) * radial;
    }
    return f.z;
  }

  // SMLib's unit normal on a surface at the point nearest p in a domain.
  static bool normalNear(const SmSurface* k, const SmExtent2d& domain, V3 p, V3& n)
  {
    SmBoolean ok = FALSE, multi = FALSE;
    SmPoint2d uv;
    double gap = 0;
    if (k->DropPoint(sp(p), domain, nullptr, ok, uv, gap, multi) != SM_SUCCESS || !ok) return false;
    SmVector3d nk;
    if (k->EvaluateNormal(uv, FALSE, FALSE, nk) != SM_SUCCESS) return false;
    n = v3(nk);
    return norm(n) > 0;
  }

  // Whether SMLib's normal opposes the model's surface's, by a majority of boundary points.
  bool opposes(SmSurface* k, const SmExtent2d& domain, int kind, const double* r,
    const std::vector<std::vector<V3>>& loops)
  {
    int votes = 0, n = 0;
    for (auto& pts : loops) for (size_t i = 0; i < pts.size() && n < 16; i += 1 + pts.size() / 4) {
      V3 nk;
      if (!normalNear(k, domain, pts[i], nk)) continue;
      double c = dot(nk, normal(kind, r, pts[i]));
      if (c == 0) continue;
      votes += c < 0 ? 1 : -1;
      n++;
    }
    return votes > 0;
  }

  // The face's boundary points: its vertices and points along its edges.
  void boundary(int f, std::vector<std::vector<V3>>& loops)
  {
    for (int l = m.faceFirstLoop(f); l < m.faceFirstLoop(f) + m.faceLoopCount(f); l++) {
      std::vector<V3> pts;
      if (m.loopKind(l) == CBR_LOOP_VERTEX) pts.push_back(m.vertex(m.loopFirst(l)));
      else if (m.loopKind(l) == CBR_LOOP_POLY) {
        for (int k = 0; k < m.loopCount(l); k++) pts.push_back(m.vertex(m.loopCorner(l, k)));
      } else {
        for (int k = 0; k < m.loopCount(l); k++) {
          int c = m.loopFirst(l) + k, e = m.coedgeEdge(c);
          bool fwd = m.coedgeOrientation(c) != CBR_ORIENTATION_REVERSED;
          int v0 = m.edgeStart(e), v1 = m.edgeEnd(e);
          if (v0 < 0) {
            // A segment: sampled between its own bounds, along SMLib's edge.
            V3 a, b;
            bool closed, against;
            if (!segment(e, a, b, closed, against)) continue;
            EdgeGeom g = against ? span(baseCurve(m.edgeCurve(e)), b, a, closed)
                                 : span(baseCurve(m.edgeCurve(e)), a, b, closed);
            if (!g.curve) continue;
            // (In the coedge's direction: SMLib's edge runs along the basis.)
            bool back = against == fwd;
            for (int i = 0; i <= 24; i++) {
              SmVector3d pd[1];
              double s = (back ? 24 - i : i) / 24.0;
              g.curve->Evaluate(g.interval.GetMin() + s * (g.interval.GetMax() - g.interval.GetMin()), 0, FALSE, pd);
              pts.push_back(v3(pd[0]));
            }
            delete g.curve;
            continue;
          }
          // Sample along SMLib's curve for this edge, in the loop's direction.
          bool along = fwd == m.edgeSameSense(e);
          EdgeGeom g = edgeGeom(e, m.edgeSameSense(e) ? v0 : v1, m.edgeSameSense(e) ? v1 : v0);
          const int N = 24;
          for (int i = 0; i < N; i++) {
            double s = (double)i / N;
            if (along == g.swapped) s = 1 - s;
            if (g.curve) {
              SmVector3d pd[1];
              double t = g.interval.GetMin() + s * (g.interval.GetMax() - g.interval.GetMin());
              g.curve->Evaluate(t, 0, FALSE, pd);
              pts.push_back(v3(pd[0]));
            } else pts.push_back(m.vertex(i == 0 ? (fwd ? v0 : v1) : (fwd ? v1 : v0)));
          }
          delete g.curve;
        }
      }
      loops.push_back(pts);
    }
  }

  // The (u, v) box of boundary points on an elementary surface (Part 42's, radians): u unwrapped along each loop and
  // each loop moved by whole turns onto the first where periodic; false without points.
  bool box(int kind, const double* r, const std::vector<std::vector<V3>>& loops, double& u0, double& u1, double& v0,
    double& v1) const
  {
    u0 = INFINITY, u1 = -INFINITY, v0 = INFINITY, v1 = -INFINITY;
    bool periodicU = kind != CBR_SURFACE_PLANE, periodicV = kind == CBR_SURFACE_TORUS;
    double ref = NAN, vref = NAN;
    for (auto& pts : loops) {
      if (pts.empty()) continue;
      double lu0 = INFINITY, lu1 = -INFINITY, lv0 = INFINITY, lv1 = -INFINITY, pu = NAN, pv = NAN;
      for (V3 p : pts) {
        double u, v;
        params(kind, r, p, u, v);
        if (periodicU && !std::isnan(pu)) u += 2 * PI * std::round((pu - u) / (2 * PI));
        if (periodicV && !std::isnan(pv)) v += 2 * PI * std::round((pv - v) / (2 * PI));
        pu = u;
        pv = v;
        lu0 = std::min(lu0, u); lu1 = std::max(lu1, u); lv0 = std::min(lv0, v); lv1 = std::max(lv1, v);
      }
      if (periodicU) {
        if (std::isnan(ref)) ref = lu0;
        double shift = 2 * PI * std::round((ref - lu0) / (2 * PI));
        lu0 += shift; lu1 += shift;
      }
      if (periodicV) {
        if (std::isnan(vref)) vref = lv0;
        double shift = 2 * PI * std::round((vref - lv0) / (2 * PI));
        lv0 += shift; lv1 += shift;
      }
      u0 = std::min(u0, lu0); u1 = std::max(u1, lu1); v0 = std::min(v0, lv0); v1 = std::max(v1, lv1);
    }
    return u1 >= u0 && v1 >= v0;
  }

  // An elementary surface (kind, reals r as the model stores them) as SMLib's over a box of Part 42's (u, v): u0..u1
  // and v0..v1 (radians for angles; for a periodic direction only the start matters, the span a whole turn). Natural
  // (no box): the surface's whole extent where it has one.
  FaceGeom elementary(int kind, const double* r, bool natural, double u0, double u1, double v0, double v1,
    const std::vector<std::vector<V3>>& loops)
  {
    FaceGeom g;
    Frame fr = frame(r);
    auto pad = [](double a, double b, double& lo, double& hi) {
      double m = 0.01 * (b - a) + 1e-6 * std::max(1.0, std::max(std::fabs(a), std::fabs(b)));
      lo = a - m; hi = b + m;
    };
    // A periodic direction spans a whole turn from the boundary's least value, in degrees inside [-360, 360]. (Spans
    // fitted to the boundary make SMLib's healer abort on some parts.)
    // SMLib's tessellator subdivides the whole of a face's surface domain down to the chord height, so on a surface
    // very large for the deflection (a torus of 300 m bounding a face of 3 cm took 5.6 GB) the turns are fitted to
    // the boundary instead: where the pieces round (2 pi over the angle a chord of that height spans, multiplied
    // where both directions turn) pass 20,000. Only there: fitted spans make SMLib's healer spoil more faces, and
    // abort on some (in SmSurfOfRevolution::MakeNurbWithSweepParams, on tori; not reproduced alone).
    auto pieces = [&](double radius) {
      return radius > 0 && lin > 0 && lin < radius ? PI / std::sqrt(2 * lin / radius) : 1.0;
    };
    double cost = 1;
    switch (kind) {
    case CBR_SURFACE_CYLINDER: cost = pieces(r[9]); break;
    case CBR_SURFACE_CONE:
      cost = pieces(std::max(std::fabs(r[9] + v0 * std::tan(r[10])), std::fabs(r[9] + v1 * std::tan(r[10]))));
      break;
    case CBR_SURFACE_SPHERE: cost = pieces(r[9]) * pieces(r[9]) / 2; break;
    case CBR_SURFACE_TORUS: cost = pieces(r[9] + r[10]) * pieces(r[10]); break;
    }
    bool fit = !natural && cost > 20000;
    auto turnU = [](double a, double b, double& lo, double& hi) {
      double padDeg = 0.02 * (b - a) * DEG + 1e-3;
      lo = a * DEG - padDeg; hi = b * DEG + padDeg;
      while (hi > 360) { lo -= 360; hi -= 360; }
      while (lo < -360) { lo += 360; hi += 360; }
    };
    auto turn = [&](double a, double b, double& lo, double& hi) {
      if (fit && (b - a) * DEG < 300) { turnU(a, b, lo, hi); return; }
      lo = a * DEG;
      while (lo > 0) lo -= 360;
      // (A start a rounding error above -360 is refused: 0 then.)
      while (lo < -360 + 1e-6) lo += 360;
      hi = lo + 360;
    };
    if (natural && (kind == CBR_SURFACE_PLANE || kind == CBR_SURFACE_CYLINDER || kind == CBR_SURFACE_CONE)) {
      g.error = std::string(surfaceKindName(kind)) + " faces without bounds";
      return g;
    }
    double su0 = 0, su1 = 0, sv0 = 0, sv1 = 0;
    switch (kind) {
    case CBR_SURFACE_PLANE: {
      pad(u0, u1, su0, su1); pad(v0, v1, sv0, sv1);
      SmPlane* p = nullptr;
      if (SmPlane::CreateCanonical(ctx, placement(fr), p) == SM_SUCCESS) g.surface = p;
      break;
    }
    case CBR_SURFACE_CYLINDER: {
      turn(u0, u1, su0, su1); pad(v0, v1, sv0, sv1);
      SmCylinder* p = nullptr;
      if (!(r[9] > 0)) break;
      if (SmCylinder::CreateCanonical(ctx, placement(fr), r[9], p) == SM_SUCCESS) g.surface = p;
      break;
    }
    case CBR_SURFACE_CONE: {
      // A finite cone from v0 to v1 (SMLib's unbounded cones don't keep their surface under a shifted domain), its v
      // from 0 there; clipped at the apex where the boundary reaches it.
      turn(u0, u1, su0, su1); pad(v0, v1, sv0, sv1);
      double t = std::tan(r[10]), rb = r[9] + sv0 * t, rt = r[9] + sv1 * t;
      // (A face past the apex, on the cone's other nappe, where Part 42's radius is negative: the same points at
      // the radius's size, half a turn round.)
      if (rb < 0 && rt < 0) { rb = -rb; rt = -rt; }
      else if (t > 0 && rb < 0) { sv0 = -r[9] / t; rb = 0; }
      else if (t < 0 && rt < 0) { sv1 = -r[9] / t; rt = 0; }
      Frame cf = fr;
      cf.o = fr.o + sv0 * fr.z;
      double h = sv1 - sv0;
      SmCone* p = nullptr;
      if (h > 0 && SmCone::CreateCanonical(ctx, placement(cf), rb, rt, h, p) == SM_SUCCESS) g.surface = p;
      sv0 = 0;
      sv1 = h;
      break;
    }
    case CBR_SURFACE_SPHERE: {
      if (natural) u0 = 0;
      turn(u0, u1, su0, su1);
      sv0 = -90;
      sv1 = 90;
      SmSphere* p = nullptr;
      if (r[9] > 0 && SmSphere::CreateCanonical(ctx, placement(fr), r[9], p) == SM_SUCCESS) g.surface = p;
      break;
    }
    case CBR_SURFACE_TORUS: {
      if (natural) u0 = v0 = 0;
      turn(u0, u1, su0, su1); turn(v0, v1, sv0, sv1);
      SmTorus* p = nullptr;
      if (r[9] > r[10] && r[10] > 0 && SmTorus::CreateCanonical(ctx, placement(fr), r[9], r[10], p) == SM_SUCCESS)
        g.surface = p;
      else if (r[10] > 0 && r[9] >= 0 && !(r[9] > r[10])) return spindle(r, loops);
      break;
    }
    default:
      g.error = std::string(surfaceKindName(kind)) + " surfaces";
      return g;
    }
    if (!g.surface) { g.error = std::string(surfaceKindName(kind)) + " surfaces SMLib refused"; return g; }
    SmExtent2d step(su0, sv0, su1, sv1);
    if (g.surface->AdjustSTEPUVDomain(step) != SM_SUCCESS
      || g.surface->ConvertDomainFromSTEPToNURBS(step, g.domain) != SM_SUCCESS) {
      g.error = std::string(surfaceKindName(kind)) + " faces whose domain SMLib refused";
      delete g.surface;
      g.surface = nullptr;
      return g;
    }
    g.flipped = opposes(g.surface, g.domain, kind, r, loops);
    return g;
  }

  // Whether SMLib's normal opposes S_u x S_v of a swept surface whose one direction is `across` at p (an extrusion's
  // direction; a revolution's rotation there): the model's normal is along x across for extrusions (S_u the curve's
  // tangent, S_v the direction), across x along for revolutions (S_u the rotation, S_v the curve's tangent), with
  // SMLib's other derivative as the curve's tangent (its direction as the model's curve runs).
  bool sweptOpposes(const SmSurface* k, const SmExtent2d& domain, V3 p, V3 across, bool extrusion)
  {
    SmBoolean ok = FALSE, multi = FALSE;
    SmPoint2d uv;
    double gap = 0;
    if (k->DropPoint(sp(p), domain, nullptr, ok, uv, gap, multi) != SM_SUCCESS || !ok) return false;
    SmVector3d d[4];
    if (k->Evaluate(uv, 1, 1, FALSE, FALSE, FALSE, d) != SM_SUCCESS) return false;
    V3 su = v3(d[2]), sv = v3(d[1]), n = cross(su, sv);
    double cu = std::fabs(dot(su, across)) / (norm(su) * norm(across) + 1e-300);
    double cv = std::fabs(dot(sv, across)) / (norm(sv) * norm(across) + 1e-300);
    V3 along = cu < cv ? su : sv;
    if (dot(along, along) == 0) return false;
    V3 ours = extrusion ? cross(along, across) : cross(across, along);
    return dot(n, ours) < 0;
  }

  // A 3D curve row as an exact SMLib B-spline, over its natural range where bounded, else over the parameters (Part
  // 42's) t0..t1; conics start at angle t0 (a whole turn). Null where SMLib can't make it exact.
  SmBSplineCurve* generator(int c, double t0, double t1)
  {
    c = baseCurve(c);
    if (c < 0) return nullptr;
    const double* r = m.curveReal(c);
    switch (m.curveKind(c)) {
    case CBR_CURVE_BSPLINE:
    case CBR_CURVE_POLYLINE: return bsplineCurve(c);
    case CBR_CURVE_LINE: {
      V3 o = {r[0], r[1], r[2]}, d = {r[3], r[4], r[5]};
      double mag = r[6];
      SmTArray<SmPoint3d> poles;
      poles.Add(sp(o + (t0 * mag) * d));
      poles.Add(sp(o + (t1 * mag) * d));
      SmTArray<ULONG> mults;
      mults.Add(2); mults.Add(2);
      SmTArray<double> knots;
      knots.Add(t0); knots.Add(t1);
      SmBSplineCurve* k = nullptr;
      if (!(t1 > t0) || SmBSplineCurve::CreateCanonical(ctx, 3, 1, poles, SM_CF_POLYLINE_FORM, mults, knots,
            SM_KT_UNSPECIFIED, nullptr, nullptr, k) != SM_SUCCESS) return nullptr;
      return k;
    }
    case CBR_CURVE_CIRCLE:
    case CBR_CURVE_ELLIPSE: {
      Frame f = frame(r);
      double a = r[9], b = m.curveKind(c) == CBR_CURVE_CIRCLE ? r[9] : r[10];
      SmExtent1d deg = degrees(t0, t0, true);
      SmCurve* k = nullptr;
      if (m.curveKind(c) == CBR_CURVE_CIRCLE) {
        SmCircle* q = nullptr;
        if (SmCircle::CreateCanonical(ctx, placement(f), a, q, &deg) == SM_SUCCESS) k = q;
      } else {
        SmEllipse* q = nullptr;
        if (SmEllipse::CreateCanonical(ctx, placement(f), a, b, q, &deg) == SM_SUCCESS) k = q;
      }
      if (!k) return nullptr;
      SmBSplineCurve* bs = nullptr;
      k->MakeExactBSplineIfPossible(bs);
      delete k;
      return bs;
    }
    }
    return nullptr;
  }

  // The surface a B-spline makes turned a whole turn about an axis (through a, along ax), as SMLib's, for a face with
  // these boundary points: the curve turned first to the boundary's least angle, so the face doesn't cross SMLib's
  // seam, and a periodic curve (row cb, or -1) with its own seam moved off the face. Takes the curve.
  FaceGeom revolved(SmBSplineCurve* k, V3 a, V3 ax, const std::vector<std::vector<V3>>& loops, bool natural, int cb)
  {
    FaceGeom g;
    // The curve's own angle about the axis (at its middle), and the boundary's least angle from it.
    V3 ref;
    {
      SmExtent1d iv = k->GetNaturalInterval();
      SmVector3d pd[1];
      k->Evaluate(0.5 * (iv.GetMin() + iv.GetMax()), 0, FALSE, pd);
      V3 q = v3(pd[0]) - a;
      ref = q + (-dot(q, ax)) * ax;
    }
    if (!(norm(ref) > 0)) ref = std::fabs(ax.x) < 0.9 ? cross(ax, V3{1, 0, 0}) : cross(ax, V3{0, 1, 0});
    ref = (1 / norm(ref)) * ref;
    V3 refY = cross(ax, ref);
    // A periodic B-spline's seam moved off the face, as for extrusions: each boundary point turned back into the
    // curve's half-plane, then placed on the curve.
    double period = cb >= 0 ? periodOf(cb) : 0;
    if (period > 0 && !natural) {
      SmExtent1d nat = k->GetNaturalInterval();
      double tlo = INFINITY, thi = -INFINITY;
      for (auto& pts : loops) {
        double prev = NAN;
        for (V3 p : pts) {
          V3 q = p - a;
          double h = dot(q, ax);
          V3 radial = q + (-h) * ax;
          double t, rr = norm(radial);
          if (!drop(k, nat, a + h * ax + rr * ref, t)) continue;
          if (!std::isnan(prev)) t += period * std::round((prev - t) / period);
          prev = t;
          tlo = std::min(tlo, t);
          thi = std::max(thi, t);
        }
      }
      if (thi - tlo < period * (1 - 1e-6)) {
        double s0 = tlo - 0.01 * (period - (thi - tlo));
        SmExtent1d trim(s0, s0 + period);
        SmBSplineCurve* moved = bsplineCurve(cb, &trim);
        if (moved) { delete k; k = moved; }
      }
    }
    double lo = 0;
    if (!natural) {
      lo = INFINITY;
      for (auto& pts : loops) {
        double prev = NAN;
        for (V3 p : pts) {
          V3 q = p - a;
          double t = std::atan2(dot(q, refY), dot(q, ref));
          if (!std::isnan(prev)) t += 2 * PI * std::round((prev - t) / (2 * PI));
          prev = t;
          lo = std::min(lo, t);
        }
      }
      if (!std::isfinite(lo)) lo = 0;
    }
    if (lo != 0) {
      // Rotate the curve by lo about the axis: p -> a + R (p - a).
      auto rot = [&](V3 v) {
        double cs = std::cos(lo), sn = std::sin(lo);
        return cs * v + sn * cross(ax, v) + ((1 - cs) * dot(ax, v)) * ax;
      };
      V3 X = rot({1, 0, 0}), Y = rot({0, 1, 0});
      V3 o = a + (-1.0) * rot(a);
      k->Transform(SmAxis2Placement(sp(o), sv(X), sv(Y)));
    }
    SmSurfOfRevolution* e = nullptr;
    if (SmSurfOfRevolution::CreateCanonical(ctx, k, sp(a), sv(ax), e) != SM_SUCCESS || !e) {
      delete k;
      g.error = "revolutions SMLib refused";
      return g;
    }
    // (The surface owns the curve now.)
    g.surface = e;
    g.domain = e->GetNaturalUVDomain();
    for (auto& pts : loops) if (!pts.empty()) {
      V3 q = pts[0] - a;
      g.flipped = sweptOpposes(e, g.domain, pts[0], cross(ax, q), false);
      break;
    }
    return g;
  }

  // A face on a spindle torus (major radius R not above the minor r, which SMLib's torus refuses): the tube's circle
  // crosses the axis, and a face lies on the part outside the crossings (the signed radius R + r cos v positive) or
  // between them (negative: Part 42's point is then across the axis from its u). Built as the revolution of that part's
  // arc over the boundary's v range.
  FaceGeom spindle(const double* r, const std::vector<std::vector<V3>>& loops)
  {
    FaceGeom g;
    Frame f = frame(r);
    double R = r[9], rr = r[10];
    // Each boundary point's v on its part: the part by which fits (a vote), v unwrapped along each loop.
    int outerVotes = 0, n = 0;
    for (auto& pts : loops) for (V3 p : pts) {
      V3 d = p - f.o;
      double rho = std::sqrt(dot(d, f.x) * dot(d, f.x) + dot(d, f.y) * dot(d, f.y)), z = dot(d, f.z);
      double eo = std::fabs((rho - R) * (rho - R) + z * z - rr * rr);
      double ei = std::fabs((rho + R) * (rho + R) + z * z - rr * rr);
      if (eo != ei) outerVotes += eo < ei ? 1 : -1;
      n++;
    }
    if (!n) { g.error = "spindle tori without bounds"; return g; }
    bool outer = outerVotes >= 0;
    double v0 = INFINITY, v1 = -INFINITY;
    for (auto& pts : loops) {
      double prev = NAN;
      for (V3 p : pts) {
        V3 d = p - f.o;
        double rho = std::sqrt(dot(d, f.x) * dot(d, f.x) + dot(d, f.y) * dot(d, f.y)), z = dot(d, f.z);
        double v = std::atan2(z, (outer ? rho : -rho) - R);
        // (The inner part lies about v = pi.)
        if (!outer && v < 0) v += 2 * PI;
        if (!std::isnan(prev)) v += 2 * PI * std::round((prev - v) / (2 * PI));
        prev = v;
        v0 = std::min(v0, v); v1 = std::max(v1, v);
      }
    }
    // The part's own range, between the crossings at cos v = -R / r.
    double vc = std::acos(std::max(-1.0, std::min(1.0, -R / rr)));
    double lo = outer ? -vc : vc, hi = outer ? vc : 2 * PI - vc, pad = 0.01 * (v1 - v0) + 1e-6;
    v0 = std::max(v0 - pad, lo); v1 = std::min(v1 + pad, hi);
    if (!(v1 > v0)) { g.error = "spindle torus faces of no extent"; return g; }
    // The tube's circle in the half-plane of the x direction: its angle is v.
    Frame cf;
    cf.o = f.o + R * f.x;
    cf.x = f.x;
    cf.y = f.z;
    cf.z = cross(cf.x, cf.y);
    SmExtent1d deg(v0 * DEG, v1 * DEG);
    SmCircle* c = nullptr;
    SmBSplineCurve* k = nullptr;
    if (SmCircle::CreateCanonical(ctx, placement(cf), rr, c, &deg) == SM_SUCCESS && c) {
      c->MakeExactBSplineIfPossible(k);
      delete c;
    }
    if (!k) { g.error = "spindle tori SMLib refused"; return g; }
    return revolved(k, f.o, f.z, loops, false, -1);
  }

  // A surface row as SMLib's for a face with these boundary points (none: the surface's own extent, a natural-bounds
  // face or a loose surface), with the face's domain on it and whether SMLib's normal opposes the model's.
  FaceGeom surfaceGeom(int s, const std::vector<std::vector<V3>>& loops, int depth = 0)
  {
    FaceGeom g;
    if (s < 0 || depth > 8) { g.error = "surfaces referring to themselves"; return g; }
    int kind = m.surfaceKind(s);
    const double* r = m.surfaceReal(s);
    const int32_t* n = m.surfaceInt(s);
    bool natural = true;
    for (auto& pts : loops) if (!pts.empty()) natural = false;
    switch (kind) {
    case CBR_SURFACE_BSPLINE:
      g.surface = bsplineSurface(s);
      if (!g.surface) { g.error = "B-spline surfaces SMLib refused"; return g; }
      g.domain = g.surface->GetNaturalUVDomain();
      return g;
    case CBR_SURFACE_RECTANGULAR_TRIMMED: {
      if (!natural) return surfaceGeom(n[0], loops, depth + 1);
      // Natural bounds: the trims.
      int b = n[0], bk = b >= 0 ? m.surfaceKind(b) : 0;
      double u0 = std::min(r[0], r[1]), u1 = std::max(r[0], r[1]), v0 = std::min(r[2], r[3]),
        v1 = std::max(r[2], r[3]);
      if (bk == CBR_SURFACE_BSPLINE) {
        g = surfaceGeom(b, loops, depth + 1);
        if (g.surface) g.domain = SmExtent2d(u0, v0, u1, v1);
        return g;
      }
      if (bk >= CBR_SURFACE_PLANE && bk <= CBR_SURFACE_TORUS) {
        // A trimmed whole turn keeps its start; a partial one its range (planes and v directions as given).
        g = elementary(bk, m.surfaceReal(b), false, u0, u1, v0, v1, loops);
        if (g.surface && bk != CBR_SURFACE_PLANE) {
          // The span: the trims' (elementary() gave whole turns from u0).
          SmExtent2d step(u0 * DEG, bk == CBR_SURFACE_CYLINDER || bk == CBR_SURFACE_CONE ? v0 : v0 * DEG,
            u1 * DEG, bk == CBR_SURFACE_CYLINDER || bk == CBR_SURFACE_CONE ? v1 : v1 * DEG);
          if (bk != CBR_SURFACE_CONE && g.surface->AdjustSTEPUVDomain(step) == SM_SUCCESS)
            g.surface->ConvertDomainFromSTEPToNURBS(step, g.domain);
        }
        return g;
      }
      g.error = std::string("natural-bounds faces on trimmed ") + surfaceKindName(bk) + " surfaces";
      return g;
    }
    case CBR_SURFACE_OFFSET: {
      int b = n[0], bk = b >= 0 ? m.surfaceKind(b) : 0;
      double d = r[0];
      if (bk >= CBR_SURFACE_PLANE && bk <= CBR_SURFACE_TORUS) {
        // Offsets of elementary surfaces are elementary: Part 42's normal there is the basis's.
        const double* br = m.surfaceReal(b);
        std::vector<double> q(br, br + 11);
        Frame f = frame(br);
        switch (bk) {
        case CBR_SURFACE_PLANE: { V3 o = f.o + d * f.z; q[0] = o.x; q[1] = o.y; q[2] = o.z; break; }
        case CBR_SURFACE_CYLINDER: case CBR_SURFACE_SPHERE: q[9] += d; break;
        case CBR_SURFACE_CONE: q[9] += d / std::cos(br[10]); break;
        case CBR_SURFACE_TORUS: q[10] += d; break;
        }
        double u0, u1, v0, v1;
        if (natural) return elementary(bk, q.data(), true, 0, 0, 0, 0, loops);
        if (!box(bk, q.data(), loops, u0, u1, v0, v1)) { g.error = "faces with no boundary points"; return g; }
        return elementary(bk, q.data(), false, u0, u1, v0, v1, loops);
      }
      // Other bases: SMLib's offset of SMLib's basis, along its normal (turned where SMLib's opposes the model's).
      FaceGeom basis = surfaceGeom(b, {}, depth + 1);
      if (!basis.surface) return basis;
      SmSurface* off = nullptr;
      SmStatus st = basis.surface->CreateOffsetSurface(ctx, basis.flipped ? -d : d, SmApproxTol3d(zoneTol), off);
      delete basis.surface;
      if (st != SM_SUCCESS || !off) {
        g.error = "offsets of " + std::string(surfaceKindName(bk)) + " surfaces SMLib refused";
        return g;
      }
      g.surface = off;
      g.domain = off->GetNaturalUVDomain();
      g.flipped = basis.flipped;
      return g;
    }
    case CBR_SURFACE_EXTRUSION: {
      // Part 42's S(u, v) = C(u) + v m d. SMLib's extrusion is of a B-spline over a vector: the curve moved to the
      // boundary's least v and extruded to its greatest.
      V3 dir = {r[0], r[1], r[2]};
      if (natural) { g.error = "extrusions without bounds"; return g; }
      int c = n[0], cb = baseCurve(c);
      if (cb < 0) { g.error = "extrusions of curves referring to themselves"; return g; }
      // The curve's range: lines bounded by the boundary (in the plane of the line and the direction), conics a whole
      // turn from the boundary's least angle (projected along the direction onto the conic's plane).
      double t0 = 0, t1 = 0;
      int ck = m.curveKind(cb);
      const double* cr = m.curveReal(cb);
      if (ck == CBR_CURVE_LINE) {
        V3 o = {cr[0], cr[1], cr[2]}, L = {cr[3], cr[4], cr[5]};
        double mag = cr[6];
        // p - o = s L + w d: least squares in s.
        double ll = dot(L, L), ld = dot(L, dir), dd = dot(dir, dir), det = ll * dd - ld * ld;
        if (!(std::fabs(det) > 1e-12)) { g.error = "extrusions of lines along themselves"; return g; }
        t0 = INFINITY, t1 = -INFINITY;
        for (auto& pts : loops) for (V3 p : pts) {
          V3 q = p - o;
          double sl = (dd * dot(q, L) - ld * dot(q, dir)) / det / mag;
          t0 = std::min(t0, sl); t1 = std::max(t1, sl);
        }
        double pad = 0.01 * (t1 - t0) + 1e-6;
        t0 -= pad; t1 += pad;
      } else if (ck == CBR_CURVE_CIRCLE || ck == CBR_CURVE_ELLIPSE) {
        Frame f = frame(cr);
        double a = cr[9], b = ck == CBR_CURVE_CIRCLE ? cr[9] : cr[10], dz = dot(dir, f.z);
        if (!(std::fabs(dz) > 1e-12)) { g.error = "extrusions of conics within their plane"; return g; }
        double lo = INFINITY, prev = NAN;
        for (auto& pts : loops) {
          prev = NAN;
          for (V3 p : pts) {
            V3 q = p + (-dot(p - f.o, f.z) / dz) * dir;
            double t = conicParam(f, a, b, q);
            if (!std::isnan(prev)) t += 2 * PI * std::round((prev - t) / (2 * PI));
            prev = t;
            lo = std::min(lo, t);
          }
        }
        t0 = lo;
      }
      SmBSplineCurve* k = generator(c, t0, t1);
      if (!k) { g.error = std::string("extrusions of ") + curveKindName(ck) + " curves"; return g; }
      // A periodic B-spline's seam moved off the face: the curve over a period from just before the boundary's least
      // parameter (each point taken along the direction to the curve's plane).
      double period = periodOf(cb);
      if (period > 0) {
        SmExtent1d nat = k->GetNaturalInterval();
        SmVector3d c0[1];
        k->Evaluate(nat.GetMin(), 0, FALSE, c0);
        V3 du = (1 / norm(dir)) * dir;
        double lo = INFINITY, hi = -INFINITY;
        for (auto& pts : loops) {
          double prev = NAN;
          for (V3 p : pts) {
            double t;
            if (!drop(k, nat, p + (-dot(p - v3(c0[0]), du)) * du, t)) continue;
            if (!std::isnan(prev)) t += period * std::round((prev - t) / period);
            prev = t;
            lo = std::min(lo, t);
            hi = std::max(hi, t);
          }
        }
        if (hi - lo < period * (1 - 1e-6)) {
          double s0 = lo - 0.01 * (period - (hi - lo));
          SmExtent1d trim(s0, s0 + period);
          SmBSplineCurve* moved = bsplineCurve(cb, &trim);
          if (moved) { delete k; k = moved; }
        }
      }
      // The boundary's v range: along the direction, less the curve's own extent along it (its poles bound it).
      SmTArray<SmPoint3d> cps;
      double c0 = INFINITY, c1 = -INFINITY, p0 = INFINITY, p1 = -INFINITY;
      SmVector3d du = sv(dir);
      du.Unitize();
      V3 u = v3(du);
      {
        SmExtent1d iv = k->GetNaturalInterval();
        for (int i = 0; i <= 64; i++) {
          SmVector3d pd[1];
          k->Evaluate(iv.GetMin() + (iv.GetMax() - iv.GetMin()) * i / 64, 0, FALSE, pd);
          double x = dot(v3(pd[0]), u);
          c0 = std::min(c0, x); c1 = std::max(c1, x);
        }
      }
      for (auto& pts : loops) for (V3 p : pts) { double x = dot(p, u); p0 = std::min(p0, x); p1 = std::max(p1, x); }
      double w0 = p0 - c1, w1 = p1 - c0, pad = 0.01 * (w1 - w0) + 1e-6;
      w0 -= pad; w1 += pad;
      SmAxis2Placement shift(sp((w0)*u), SmVector3d(1, 0, 0), SmVector3d(0, 1, 0));
      k->Transform(shift);
      SmSurfOfExtrusion* e = nullptr;
      if (SmSurfOfExtrusion::CreateCanonical(ctx, k, sv((w1 - w0) * u), e) != SM_SUCCESS || !e) {
        delete k;
        g.error = "extrusions SMLib refused";
        return g;
      }
      // (The surface owns the curve now.) Made finite, its STEP v from 0 to 1 along the vector (SMLib's extrusions
      // are infinite, and its exact areas of faces on them wrong).
      g.surface = e;
      {
        SmExtent2d step(e->GetSTEPUVDomain().GetUMin(), 0, e->GetSTEPUVDomain().GetUMax(), 1);
        if (e->AdjustSTEPUVDomain(step) != SM_SUCCESS || e->ConvertDomainFromSTEPToNURBS(step, g.domain) != SM_SUCCESS)
          g.domain = e->GetNaturalUVDomain();
      }
      for (auto& pts : loops) if (!pts.empty()) { g.flipped = sweptOpposes(e, g.domain, pts[0], dir, true); break; }
      return g;
    }
    case CBR_SURFACE_REVOLUTION: {
      // Part 42's S(u, v): C(v) turned by u about the axis. SMLib's revolution turns a B-spline a whole turn from where
      // it lies: the curve turned to the boundary's least angle, so the face doesn't cross SMLib's seam.
      V3 a = {r[0], r[1], r[2]}, ax = {r[3], r[4], r[5]};
      int c = n[0], cb = baseCurve(c);
      if (cb < 0) { g.error = "revolutions of curves referring to themselves"; return g; }
      int ck = m.curveKind(cb);
      const double* cr = m.curveReal(cb);
      double t0 = 0, t1 = 0;
      if (ck == CBR_CURVE_LINE) {
        // The line's range: each boundary point turned into the line's half-plane, nearest along the line.
        V3 o = {cr[0], cr[1], cr[2]}, L = {cr[3], cr[4], cr[5]};
        double mag = cr[6];
        if (natural) { g.error = "revolutions of lines without bounds"; return g; }
        t0 = INFINITY, t1 = -INFINITY;
        // In (radius, height) about the axis, where the line is when it lies in a half-plane through the axis (a
        // cone's or cylinder's generatrix): each boundary point nearest along the line, by least squares.
        V3 qo = o - a;
        double ho = dot(qo, ax), hl = dot(L, ax);
        V3 radial = qo + (-ho) * ax;
        if (!(norm(radial) > 1e-12)) radial = L + (-hl) * ax;
        double rn = norm(radial);
        if (rn > 0) radial = (1 / rn) * radial;
        double ro = dot(qo, radial), rl = dot(L, radial), den = rl * rl + hl * hl;
        if (!(den > 0)) { g.error = "revolutions of lines of no direction"; return g; }
        for (auto& pts : loops) for (V3 p : pts) {
          V3 q = p - a;
          double h = dot(q, ax), rr = norm(q + (-h) * ax);
          double sl = ((rr - ro) * rl + (h - ho) * hl) / den / mag;
          t0 = std::min(t0, sl); t1 = std::max(t1, sl);
        }
        double pad = 0.01 * (t1 - t0) + 1e-6;
        t0 -= pad; t1 += pad;
      } else if (ck == CBR_CURVE_CIRCLE || ck == CBR_CURVE_ELLIPSE) {
        t0 = 0;
      }
      SmBSplineCurve* k = generator(c, t0, t1);
      if (!k) { g.error = std::string("revolutions of ") + curveKindName(ck) + " curves"; return g; }
      return revolved(k, a, ax, loops, natural, cb);
    }
    }
    if (kind < CBR_SURFACE_PLANE || kind > CBR_SURFACE_TORUS) {
      g.error = std::string(surfaceKindName(kind)) + " surfaces";
      return g;
    }
    if (natural) return elementary(kind, r, true, 0, 0, 0, 0, loops);
    std::vector<double> turned;
    if (kind == CBR_SURFACE_SPHERE && sphereAxis(r, loops, turned)) r = turned.data();
    double u0, u1, v0, v1;
    if (!box(kind, r, loops, u0, u1, v0, v1)) { g.error = "faces with no boundary points"; return g; }
    return elementary(kind, r, false, u0, u1, v0, v1, loops);
  }

  // A sphere whose face's boundary passes a pole (SMLib can't trim across one: the hemispheres of trj4_s1-ai-214.stp,
  // bounded by circles about an axis square to the sphere's) is built about another axis, which a sphere allows: the
  // one of the frame's three and the loops' own (their planes' normals) whose poles the boundary stays farthest from,
  // loops lying on one latitude not counted (a small circle about a pole is no trouble). False to keep the model's.
  bool sphereAxis(const double* r, const std::vector<std::vector<V3>>& loops, std::vector<double>& out) const
  {
    Frame f = frame(r);
    auto clear = [&](V3 axis) {
      double least = PI / 2;
      for (auto& pts : loops) {
        double lo = INFINITY, hi = -INFINITY;
        for (V3 p : pts) {
          V3 d = p - f.o;
          double len = norm(d);
          if (!(len > 0)) continue;
          double lat = std::asin(std::max(-1.0, std::min(1.0, dot(d, axis) / len)));
          lo = std::min(lo, lat); hi = std::max(hi, lat);
        }
        if (hi - lo < 1e-6) continue;
        least = std::min(least, PI / 2 - std::max(std::fabs(lo), std::fabs(hi)));
      }
      return least;
    };
    double best = clear(f.z);
    if (best > 0.05) return false;
    V3 axis = f.z;
    std::vector<V3> candidates{f.x, f.y};
    for (auto& pts : loops) {
      // (A loop's plane: Newell's normal of its points.)
      V3 n{0, 0, 0};
      for (size_t i = 0; i < pts.size(); i++) {
        V3 a = pts[i], b = pts[(i + 1) % pts.size()];
        n = n + V3{(a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)};
      }
      if (norm(n) > 0) candidates.push_back((1 / norm(n)) * n);
    }
    for (V3 c : candidates) {
      double s = clear(c);
      if (s > best + 1e-9) { best = s; axis = c; }
    }
    if (dot(axis, f.z) == 1) return false;
    V3 x = std::fabs(dot(axis, f.x)) < 0.9 ? f.x : f.y;
    x = x + (-dot(x, axis)) * axis;
    x = (1 / norm(x)) * x;
    out.assign(r, r + 11);
    out[3] = axis.x; out[4] = axis.y; out[5] = axis.z;
    out[6] = x.x; out[7] = x.y; out[8] = x.z;
    return true;
  }

  // Which way a loop's points run about SMLib's normal of the surface, in its (u, v): 1 counter-clockwise, -1
  // clockwise, 0 where that can't be told (points SMLib can't place, no area). Steps of over half the domain between
  // consecutive points are taken as crossings of a seam.
  static int winding(const SmSurface* k, const SmExtent2d& domain, const std::vector<V3>& pts)
  {
    std::vector<SmPoint2d> uv;
    for (V3 p : pts) {
      SmBoolean ok = FALSE, multi = FALSE;
      SmPoint2d q;
      double gap = 0;
      if (k->DropPoint(sp(p), domain, nullptr, ok, q, gap, multi) != SM_SUCCESS || !ok) continue;
      uv.push_back(q);
    }
    if (uv.size() < 3) return 0;
    double du = domain.GetUMax() - domain.GetUMin(), dv = domain.GetVMax() - domain.GetVMin();
    for (size_t i = 1; i < uv.size(); i++) {
      if (du > 0) uv[i].x += du * std::round((uv[i - 1].x - uv[i].x) / du * 0.999);
      if (dv > 0) uv[i].y += dv * std::round((uv[i - 1].y - uv[i].y) / dv * 0.999);
    }
    // (A loop that goes round the surface doesn't close in (u, v): no winding.)
    if (std::fabs(uv.back().x - uv[0].x) > 0.5 * du || std::fabs(uv.back().y - uv[0].y) > 0.5 * dv) return 0;
    double area = 0, scale = 0;
    for (size_t i = 0; i < uv.size(); i++) {
      const SmPoint2d &a = uv[i], &b = uv[(i + 1) % uv.size()];
      area += a.x * b.y - b.x * a.y;
      scale += std::fabs(a.x * b.y) + std::fabs(b.x * a.y);
    }
    if (!(std::fabs(area) > 1e-9 * scale)) return 0;
    // SMLib's normal against S_u x S_v, by differences at the first point.
    SmVector3d p0[1], pu[1], pv[1], n;
    double hu = 1e-4 * du * (uv[0].x + 1e-4 * du > domain.GetUMax() ? -1 : 1);
    double hv = 1e-4 * dv * (uv[0].y + 1e-4 * dv > domain.GetVMax() ? -1 : 1);
    SmPoint2d at(std::min(std::max(uv[0].x, domain.GetUMin()), domain.GetUMax()),
      std::min(std::max(uv[0].y, domain.GetVMin()), domain.GetVMax()));
    // (The first point moved back into the domain where unwrapping can't have moved it: it is the reference.)
    if (k->Evaluate(at, 0, 0, FALSE, FALSE, FALSE, p0) != SM_SUCCESS
      || k->Evaluate(SmPoint2d(at.x + hu, at.y), 0, 0, FALSE, FALSE, FALSE, pu) != SM_SUCCESS
      || k->Evaluate(SmPoint2d(at.x, at.y + hv), 0, 0, FALSE, FALSE, FALSE, pv) != SM_SUCCESS
      || k->EvaluateNormal(at, FALSE, FALSE, n) != SM_SUCCESS) return 0;
    double c = dot(cross(v3(pu[0]) - v3(p0[0]), v3(pv[0]) - v3(p0[0])), v3(n)) * hu * hv;
    if (c == 0) return 0;
    return (area > 0) == (c > 0) ? 1 : -1;
  }

  // A face's surface (as surfaceGeom), each loop's extent (the diagonal of its boundary points' box), and for each loop
  // of segments (edges without vertices, whose direction nothing fixes) its winding as its coedges run.
  // apex: set to a cone's apex where the face must reach it though no loop does (below).
  FaceGeom faceGeom(int f, std::vector<double>& extents, std::vector<int>& windings, bool& atApex, V3& apex)
  {
    std::vector<std::vector<V3>> loops;
    boundary(f, loops);
    for (auto& pts : loops) {
      V3 lo{INFINITY, INFINITY, INFINITY}, hi{-INFINITY, -INFINITY, -INFINITY};
      for (V3 p : pts) {
        lo = {std::min(lo.x, p.x), std::min(lo.y, p.y), std::min(lo.z, p.z)};
        hi = {std::max(hi.x, p.x), std::max(hi.y, p.y), std::max(hi.z, p.z)};
      }
      extents.push_back(pts.empty() ? 0 : norm(hi - lo));
    }
    // A cone face whose one loop goes once round the axis without touching the apex: it is closed by the apex itself
    // (a chamfer's cone cut off by planes; STEP needs no vertex loop there). The apex joins the boundary, so the
    // surface built reaches it, and the caller gives SMLib a vertex loop there: without one SMLib's exact area of
    // the face is wrong.
    atApex = false;
    int s = m.faceSurface(f);
    if (s >= 0 && m.surfaceKind(s) == CBR_SURFACE_CONE && loops.size() == 1 && loops[0].size() > 2) {
      const double* r = m.surfaceReal(s);
      Frame fr = frame(r);
      double t = std::tan(r[10]), turned = 0, pu = NAN;
      apex = fr.o + (-r[9] / t) * fr.z;
      bool touches = false;
      for (size_t i = 0; i <= loops[0].size(); i++) {
        V3 p = loops[0][i % loops[0].size()];
        if (norm(p - apex) <= zoneTol) touches = true;
        double u, v;
        params(CBR_SURFACE_CONE, r, p, u, v);
        if (!std::isnan(pu)) turned += u - pu - 2 * PI * std::round((u - pu) / (2 * PI));
        pu = u;
      }
      if (!touches && std::fabs(std::fabs(turned) - 2 * PI) < 0.5) {
        atApex = true;
        loops.push_back({apex});
      }
    }
    FaceGeom g = surfaceGeom(m.faceSurface(f), loops);
    for (int l = m.faceFirstLoop(f), i = 0; l < m.faceFirstLoop(f) + m.faceLoopCount(f); l++, i++) {
      bool segments = m.loopKind(l) == CBR_LOOP_EDGE && m.loopCount(l) > 0
        && m.edgeStart(m.coedgeEdge(m.loopFirst(l))) < 0;
      windings.push_back(g.surface && segments ? winding(g.surface, g.domain, loops[i]) : 0);
    }
    return g;
  }

  SmBSplineSurface* bsplineSurface(int s)
  {
    const double* r = m.surfaceReal(s);
    const int32_t* n = m.surfaceInt(s);
    int du = n[0], dv = n[1], nu = n[2], nv = n[3], ku = n[4], kv = n[5];
    bool rational = n[6] != 0;
    SmTArray<SmPoint3d> poles;
    SmTArray<ULONG> mu, mv;
    SmTArray<double> uk, vk, w;
    for (int i = 0; i < ku; i++) { uk.Add(r[i]); mu.Add(n[11 + i]); }
    for (int i = 0; i < kv; i++) { vk.Add(r[ku + i]); mv.Add(n[11 + ku + i]); }
    const double* p = r + ku + kv;
    for (int i = 0; i < nu * nv; i++) poles.Add(SmPoint3d(p[3 * i], p[3 * i + 1], p[3 * i + 2]));
    if (rational) for (int i = 0; i < nu * nv; i++) w.Add(p[3 * nu * nv + i]);
    SmBSplineSurface* k = nullptr;
    if (SmBSplineSurface::CreateCanonical(ctx, du, dv, poles, SM_SF_UNSPECIFIED, mu, mv, uk, vk, SM_KT_UNSPECIFIED,
          rational ? &w : nullptr, nullptr, k) != SM_SUCCESS) return nullptr;
    return k;
  }

  // Points along a curve's interval, ends included: split where the chord's midpoint is more than the linear deflection
  // from the curve or the tangent turns by more than the angular one, from 8 pieces (so closed curves start round).
  void sampleCurve(const SmCurve* k, const SmExtent1d& iv, std::vector<double>& pts)
  {
    auto at = [&](double t, V3& p, V3& d) {
      SmVector3d pd[2];
      k->Evaluate(t, 1, FALSE, pd);
      p = v3(pd[0]);
      d = v3(pd[1]);
    };
    std::vector<double> ts;
    std::function<void(double, double, V3, V3, V3, V3, int)> split = [&](double a, double b, V3 pa, V3 da, V3 pb,
      V3 db, int depth) {
      double mid = 0.5 * (a + b);
      V3 pm, dm;
      at(mid, pm, dm);
      double dev = norm(pm - 0.5 * (pa + pb)), na = norm(da), nb = norm(db);
      double turn = na > 0 && nb > 0 ? std::acos(std::max(-1.0, std::min(1.0, dot(da, db) / (na * nb)))) : 0;
      if (depth < 16 && (dev > lin || turn > ang)) {
        split(a, mid, pa, da, pm, dm, depth + 1);
        split(mid, b, pm, dm, pb, db, depth + 1);
      } else ts.push_back(b);
    };
    double t0 = iv.GetMin(), t1 = iv.GetMax();
    ts.push_back(t0);
    for (int i = 0; i < 8; i++) {
      double a = t0 + (t1 - t0) * i / 8, b = t0 + (t1 - t0) * (i + 1) / 8;
      V3 pa, da, pb, db;
      at(a, pa, da);
      at(b, pb, db);
      split(a, b, pa, da, pb, db, 0);
    }
    for (double t : ts) {
      V3 p, d;
      at(t, p, d);
      pts.insert(pts.end(), {p.x, p.y, p.z});
    }
  }

  // Part 42's point at parameter t on an elementary 3D curve (lines and conics), or none.
  bool curvePoint(int c, double t, V3& p) const
  {
    const double* r = m.curveReal(c);
    switch (m.curveKind(c)) {
    case CBR_CURVE_LINE: p = V3{r[0], r[1], r[2]} + (t * r[6]) * V3{r[3], r[4], r[5]}; return true;
    case CBR_CURVE_CIRCLE:
    case CBR_CURVE_ELLIPSE: {
      Frame f = frame(r);
      double a = r[9], b = m.curveKind(c) == CBR_CURVE_CIRCLE ? r[9] : r[10];
      p = f.o + (a * std::cos(t)) * f.x + (b * std::sin(t)) * f.y;
      return true;
    }
    }
    return false;
  }

  // A loose curve (a curve item, or a composite's segment) as polylines, each with id.
  void curveItem(int c, double id, const std::vector<double>& tr, int depth = 0)
  {
    if (c < 0 || depth > 8) { warn("curve items referring to themselves (left out)"); return; }
    const double* r = m.curveReal(c);
    const int32_t* n = m.curveInt(c);
    EdgeGeom g;
    switch (m.curveKind(c)) {
    case CBR_CURVE_COMPOSITE:
      for (int k = 0; k < n[0]; k++) curveItem(n[3 + 3 * k], id, tr, depth + 1);
      return;
    case CBR_CURVE_BSPLINE:
    case CBR_CURVE_POLYLINE: {
      SmBSplineCurve* k = bsplineCurve(c);
      if (k) { g.curve = k; g.interval = k->GetNaturalInterval(); }
      else g.error = "B-spline curves SMLib refused";
      break;
    }
    case CBR_CURVE_CIRCLE:
    case CBR_CURVE_ELLIPSE: {
      V3 p;
      curvePoint(c, 0, p);
      g = span(c, p, p, true);
      break;
    }
    case CBR_CURVE_TRIMMED: {
      // Between its trims: the points where given, else at the parameters (the basis's own parameter for
      // B-splines, Part 42's for lines and conics).
      int b = baseCurve(c);
      if (b < 0) { warn("trimmed curves referring to themselves (left out)"); return; }
      V3 p[2];
      bool ok[2];
      for (int j = 0; j < 2; j++) {
        const double* q = r + 2 + 3 * j;
        ok[j] = !std::isnan(q[0]);
        if (ok[j]) p[j] = {q[0], q[1], q[2]};
        else ok[j] = !std::isnan(r[j]) && curvePoint(b, r[j], p[j]);
      }
      int bk = m.curveKind(b);
      if ((bk == CBR_CURVE_BSPLINE || bk == CBR_CURVE_POLYLINE) && !std::isnan(r[0]) && !std::isnan(r[1])) {
        SmBSplineCurve* k = bsplineCurve(b);
        if (k) { g.curve = k; g.interval = SmExtent1d(std::min(r[0], r[1]), std::max(r[0], r[1])); }
        break;
      }
      if (!ok[0] || !ok[1]) { warn("trimmed curves without trims SMLib can place (left out)"); return; }
      // Part 42's trimmed curve runs from trim 1 to trim 2 along the basis when sense_agreement, against it
      // otherwise; SMLib's spans run along the basis.
      g = n[1] ? span(b, p[0], p[1], false) : span(b, p[1], p[0], false);
      break;
    }
    default:
      warn(std::string(curveKindName(m.curveKind(c))) + " curve items (left out: unbounded or not built)");
      return;
    }
    if (!g.curve) { warn(g.error + " (curve items left out)"); return; }
    BuiltPart::Polyline pl{id, {}, tr};
    sampleCurve(g.curve, g.interval, pl.points);
    delete g.curve;
    out.curves.push_back(std::move(pl));
  }

public:
  // Faces, each in a sheet of its own.
  void buildEach(const std::vector<int>& faces, const std::vector<double>& transform)
  {
    for (int f : faces)
      if (f >= 0 && f < (int)m.rows(CBR_FACE_SURFACE)) buildSheet({f}, transform);
  }

private:
  // An item, at a transform (its own composed onto an instance's).
  void buildItem(int i, const std::vector<double>& outer, int depth);
  // The placed item being built, and how many have been.
  int group = 0, groups = 0;

  // One SMLib B-rep from faces (rows), in the open-sheet form.
  void buildSheet(const std::vector<int>& faces, const std::vector<double>& transform);

  // One face on a surface's own extent (a face of no loops; a loose surface, face -1) as its own SMLib B-rep.
  void buildNatural(int surface, int face, const std::vector<double>& transform);
};

// A coedge as SMLib takes it: the edge row, whether SMLib's edge use runs along SMLib's edge (from its interval's
// start), in the traversal order of the face's surface-normal side.
struct Use
{
  // The model's edge row, or for a poly loop's side -2 - its index in the sheet's sides.
  int edge;
  bool along;
};

void Builder::buildSheet(const std::vector<int>& faceRows, const std::vector<double>& transform)
{
  SmBrepData* bd = new (ctx) SmBrepData(FALSE, SM_DS_STEP);
  SmObjDelete cleanData(bd);
  bd->m_sZoneTol3d = zoneTol;
  bd->SetHealerVersion(heal ? SM_HEALER_VERSION - 2 : SM_HEALER_VERSION);

  // Faces, their loops and uses, before any SMLib table: a face whose geometry fails is left out.
  struct FaceOut
  {
    int row;
    FaceGeom geom;
    std::vector<std::vector<Use>> loops; // outer first
    std::vector<int> vertexLoops;        // vertex rows
  };
  std::vector<FaceOut> fs;
  // Poly loops' sides, by their corners (vertex rows, the lesser first): shared by the loops using both corners.
  std::vector<std::pair<int, int>> sides;
  std::map<std::pair<int, int>, int> sideOf;
  // Curve-bounded faces' segments (edges without vertices): their ends as vertex keys, along SMLib's edge, and
  // whether that runs against the model's edge. Keys -2 - k are vertices made at the joins, at synth[k].
  struct Segment
  {
    int s, t;
    bool against;
  };
  std::unordered_map<int, Segment> segments;
  std::vector<V3> synth;
  auto point = [&](int key) { return key >= 0 ? m.vertex(key) : synth[-2 - key]; };
  for (int f : faceRows) {
    if (m.faceLoopCount(f) == 0) { buildNatural(m.faceSurface(f), f, transform); continue; }
    FaceOut fo;
    fo.row = f;
    std::vector<double> extents;
    std::vector<int> windings;
    bool atApex = false;
    V3 apex;
    fo.geom = faceGeom(f, extents, windings, atApex, apex);
    if (!fo.geom.surface) { warn(fo.geom.error + " (faces left out)"); continue; }
    // Edge-use direction on SMLib's surface-normal side: the model's loops run counter-clockwise about the face's
    // normal, SMLib's primary side's about the surface's.
    bool keep = m.faceSameSense(f) != fo.geom.flipped;
    std::vector<std::vector<Use>> loops;
    std::vector<double> loopExtent;
    std::vector<int> loopWinding;
    int outer = -1;
    bool bad = false;
    for (int l = m.faceFirstLoop(f); l < m.faceFirstLoop(f) + m.faceLoopCount(f); l++) {
      if (m.loopKind(l) == CBR_LOOP_VERTEX) { fo.vertexLoops.push_back(m.loopFirst(l)); continue; }
      std::vector<Use> uses;
      if (m.loopKind(l) == CBR_LOOP_POLY) {
        for (int k = 0; k < m.loopCount(l); k++) {
          int a = m.loopCorner(l, k), b = m.loopCorner(l, (k + 1) % m.loopCount(l));
          if (a == b) continue;
          auto key = std::make_pair(std::min(a, b), std::max(a, b));
          auto it = sideOf.find(key);
          if (it == sideOf.end()) {
            it = sideOf.emplace(key, (int)sides.size()).first;
            sides.push_back(key);
          }
          uses.push_back({-2 - it->second, a == key.first});
        }
      }
      // A loop of segments: consecutive ones joined at a vertex made midway between their ends (the consumer's to
      // join: docs/brep-reference.md), one alone closed on itself.
      if (m.loopKind(l) == CBR_LOOP_EDGE) {
        int n = m.loopCount(l), without = 0;
        for (int k = 0; k < n; k++) if (m.edgeStart(m.coedgeEdge(m.loopFirst(l) + k)) < 0) without++;
        if (without && without < n) {
          warn("loops mixing edges with and without vertices (faces left out)");
          bad = true;
          break;
        }
        if (without) {
          std::vector<V3> S(n), E(n), A(n), B(n);
          std::vector<char> fwd(n), against(n), closed(n);
          bool ok = true;
          for (int k = 0; k < n && ok; k++) {
            int c = m.loopFirst(l) + k, e = m.coedgeEdge(c);
            bool cl, ag;
            ok = segment(e, A[k], B[k], cl, ag);
            fwd[k] = m.coedgeOrientation(c) != CBR_ORIENTATION_REVERSED;
            against[k] = ag;
            closed[k] = cl;
            S[k] = fwd[k] ? A[k] : B[k];
            E[k] = fwd[k] ? B[k] : A[k];
          }
          if (!ok) {
            warn("curve-bounded faces' segments on curves without bounds of their own (faces left out)");
            bad = true;
            break;
          }
          std::vector<int> J(n);
          for (int k = 0; k < n; k++) {
            J[k] = -2 - (int)synth.size();
            synth.push_back(n == 1 ? S[0] : 0.5 * (E[k] + S[(k + 1) % n]));
          }
          for (int k = 0; k < n; k++) {
            int e = m.coedgeEdge(m.loopFirst(l) + k);
            if (segments.count(e)) continue;
            int from = J[(k + n - 1) % n], to = J[k];
            int cs = fwd[k] ? from : to, ct = fwd[k] ? to : from;
            segments[e] = against[k] ? Segment{ct, cs, true} : Segment{cs, ct, false};
          }
        }
      }
      // Degenerate edges are left out (their neighbours meet at the vertex); a loop of nothing else is a vertex loop.
      int degenerate = -1;
      for (int k = 0; m.loopKind(l) == CBR_LOOP_EDGE && k < m.loopCount(l); k++) {
        int c = m.loopFirst(l) + k, e = m.coedgeEdge(c), o = m.coedgeOrientation(c);
        if (m.edgeDegenerate(e)) { degenerate = m.edgeStart(e); continue; }
        if (o != CBR_ORIENTATION_FORWARD && o != CBR_ORIENTATION_REVERSED) {
          warn("internal and external coedges (left out)");
          continue;
        }
        bool fwd = o == CBR_ORIENTATION_FORWARD;
        auto seg = segments.find(e);
        uses.push_back({e, (fwd == m.edgeSameSense(e)) != (seg != segments.end() && seg->second.against)});
      }
      if (uses.empty() && degenerate >= 0) { fo.vertexLoops.push_back(degenerate); continue; }
      // A loop of segments runs whichever way its file has it: turned below, once the outer loop is known, by its
      // winding where that can be told.
      int w = windings[l - m.faceFirstLoop(f)];
      bool dir = m.loopSense(l) == keep;
      if (!dir && w == 0) {
        std::reverse(uses.begin(), uses.end());
        for (auto& u : uses) u.along = !u.along;
      }
      if (m.loopBound(l) == CBR_BOUND_OUTER && outer < 0) outer = (int)loops.size();
      loopWinding.push_back(w);
      loopExtent.push_back(extents[l - m.faceFirstLoop(f)]);
      loops.push_back(uses);
    }
    if (bad || loops.empty()) {
      delete fo.geom.surface;
      // Only vertex loops: the whole of a closed surface (a ball, a ring), the vertex a point on it.
      int sk = m.surfaceKind(m.faceSurface(f));
      if (!bad && (sk == CBR_SURFACE_SPHERE || sk == CBR_SURFACE_TORUS)) buildNatural(m.faceSurface(f), f, transform);
      else if (!bad) warn("faces with only vertex loops on surfaces that aren't closed (left out)");
      continue;
    }
    if (atApex) {
      fo.vertexLoops.push_back(-2 - (int)synth.size());
      synth.push_back(apex);
    }
    // The outer loop first (SMLib takes the first as outer): the marked one, unless another reaches farther (files
    // mark holes outer; a face with none marked takes the farthest-reaching).
    int widest = (int)(std::max_element(loopExtent.begin(), loopExtent.end()) - loopExtent.begin());
    if (outer < 0 || loopExtent[outer] < loopExtent[widest] * (1 - 1e-9)) outer = widest;
    // SMLib's outer loop runs counter-clockwise about its surface's normal, the others clockwise.
    for (size_t i = 0; i < loops.size(); i++) {
      if (loopWinding[i] == 0 || (loopWinding[i] > 0) == ((int)i == outer)) continue;
      std::reverse(loops[i].begin(), loops[i].end());
      for (auto& u : loops[i]) u.along = !u.along;
    }
    if (outer > 0) std::swap(loops[0], loops[outer]);
    fo.loops = loops;
    fs.push_back(std::move(fo));
  }
  if (fs.empty()) return;

  // Edges and vertices, SMLib's rows by the model's.
  std::unordered_map<int, int> edgeRow, vertexRow;
  std::vector<int> edges, vertices;
  std::vector<EdgeGeom> geoms;
  // An SMLib edge's ends (vertex rows): from the start of its interval to its end.
  auto ends = [&](int e, int& s, int& t) {
    if (e <= -2) { s = sides[-2 - e].first; t = sides[-2 - e].second; return; }
    auto seg = segments.find(e);
    if (seg != segments.end()) { s = seg->second.s; t = seg->second.t; return; }
    s = m.edgeStart(e), t = m.edgeEnd(e);
    if (!m.edgeSameSense(e)) std::swap(s, t);
  };
  auto vertexOf = [&](int v) {
    auto it = vertexRow.find(v);
    if (it != vertexRow.end()) return it->second;
    vertexRow[v] = (int)vertices.size();
    vertices.push_back(v);
    return (int)vertices.size() - 1;
  };
  // Faces whose edges SMLib can't take are left out with their edges.
  std::vector<FaceOut> kept;
  for (auto& fo : fs) {
    bool ok = true;
    for (auto& loop : fo.loops) for (auto& u : loop) {
      if (edgeRow.count(u.edge)) continue;
      int e = u.edge, s, t;
      ends(e, s, t);
      EdgeGeom g = e <= -2 ? lineGeom(m.vertex(s), m.vertex(t))
        : segments.count(e) ? span(baseCurve(m.edgeCurve(e)), point(s), point(t), s == t) : edgeGeom(e, s, t);
      if (!g.curve) { warn(g.error + " (faces left out)"); ok = false; break; }
      edgeRow[e] = (int)edges.size();
      edges.push_back(e);
      geoms.push_back(g);
    }
    if (ok) kept.push_back(std::move(fo));
    else delete fo.geom.surface;
  }
  // Edges made for faces left out stay unused: drop their uses' faces only (their curves are freed below).
  std::vector<int> edgeUsed(edges.size(), 0);
  for (auto& fo : kept) for (auto& loop : fo.loops) for (auto& u : loop) edgeUsed[edgeRow[u.edge]] = 1;
  {
    std::vector<int> newEdges;
    std::vector<EdgeGeom> newGeoms;
    std::unordered_map<int, int> newRow;
    for (size_t i = 0; i < edges.size(); i++) {
      if (!edgeUsed[i]) { delete geoms[i].curve; continue; }
      newRow[edges[i]] = (int)newEdges.size();
      newEdges.push_back(edges[i]);
      newGeoms.push_back(geoms[i]);
    }
    edges.swap(newEdges);
    geoms.swap(newGeoms);
    edgeRow.swap(newRow);
  }
  if (kept.empty()) return;

  SmTArray<SmRegionData>& regions = bd->m_vRegions;
  SmTArray<SmShellData>& shells = bd->m_vShells;
  SmTArray<SmFaceuseData>& faceuses = bd->m_vFaceuses;
  SmTArray<SmFaceData>& faces = bd->m_vFaces;
  SmTArray<SmLoopData>& loops = bd->m_vLoops;
  SmTArray<SmEUData>& eus = bd->m_vEdgeuses;
  SmTArray<SmEdgeData>& edgeData = bd->m_vEdges;
  SmTArray<SmVertexData>& vertexData = bd->m_vVertices;

  bd->m_lStartRegion = 0;
  bd->m_lNumRegions = 1;
  regions.SetSize(1);
  regions[0].ReSet();
  regions[0].m_lStartShell = 0;
  regions[0].m_lNumShells = 1;
  regions[0].m_bIsVoidFlag = TRUE;
  regions[0].m_lFlags = regions[0].m_lUserIndex1 = regions[0].m_lUserIndex2 = 0;
  shells.SetSize(1);
  shells[0].ReSet();
  shells[0].m_lShellType = 0;
  shells[0].m_lFaceuseStart = 0;
  shells[0].m_lNumFaceuses = (ULONG)(2 * kept.size());
  shells[0].m_lFlags = shells[0].m_lUserIndex1 = shells[0].m_lUserIndex2 = 0;

  ULONG nf = (ULONG)kept.size();
  faceuses.SetSize(2 * nf);
  faces.SetSize(nf);
  ULONG nl = 0, ne = 0;
  for (auto& fo : kept) {
    nl += (ULONG)(fo.loops.size() + fo.vertexLoops.size());
    for (auto& l : fo.loops) ne += (ULONG)l.size();
  }
  loops.SetSize(nl);
  eus.SetSize(ne);
  // Each SMLib edge's uses (EU rows), for the radial links.
  std::vector<std::vector<ULONG>> edgeUses(edges.size());
  ULONG li = 0, ei = 0;
  for (ULONG i = 0; i < nf; i++) {
    FaceOut& fo = kept[i];
    for (int side = 0; side < 2; side++) {
      SmFaceuseData& u = faceuses[i + side * nf];
      u.ReSet();
      u.m_lFace = i;
      u.m_bOrientation = side == 0 ? TRUE : FALSE;
      u.m_lFlags = u.m_lUserIndex1 = u.m_lUserIndex2 = 0;
    }
    SmFaceData& fd = faces[i];
    fd.ReSet();
    fd.m_sZoneTol3d = zoneTol;
    fd.m_lSurface = i;
    fd.m_lStartLoop = li;
    fd.m_lNumLoops = (ULONG)(fo.loops.size() + fo.vertexLoops.size());
    fd.m_vUVDomain = fo.geom.domain;
    fd.m_bRectangularTrim = FALSE;
    fd.m_lFlags = fd.m_lUserIndex2 = 0;
    fd.m_lUserIndex1 = (ULONG)fo.row + 1;
    bd->m_vSurfaces.Add(fo.geom.surface);
    for (auto& loop : fo.loops) {
      SmLoopData& ld = loops[li];
      ld.ReSet();
      ld.m_lLoopType = 0;
      ld.m_lStartEU = ei;
      ld.m_lNumEU = (ULONG)loop.size();
      ld.m_lFlags = ld.m_lUserIndex1 = ld.m_lUserIndex2 = 0;
      for (auto& u : loop) {
        SmEUData& d = eus[ei];
        d.ReSet();
        d.m_lEUType = 0;
        d.m_lEdge = (ULONG)edgeRow[u.edge];
        d.m_lLoop = li;
        d.m_bOrientation = u.along != geoms[edgeRow[u.edge]].swapped ? TRUE : FALSE;
        d.m_lUVCurve = SM_NO_OBJECT;
        d.m_lFlags = d.m_lUserIndex1 = d.m_lUserIndex2 = 0;
        d.m_lMateFlags = d.m_lMateUserIndex1 = d.m_lMateUserIndex2 = 0;
        edgeUses[d.m_lEdge].push_back(ei);
        ei++;
      }
      li++;
    }
    for (int v : fo.vertexLoops) {
      SmLoopData& ld = loops[li++];
      ld.ReSet();
      ld.m_lLoopType = 1;
      ld.m_lVertex = (ULONG)vertexOf(v);
      ld.m_lNumEU = 0;
      ld.m_lFlags = ld.m_lUserIndex1 = ld.m_lUserIndex2 = 0;
    }
  }
  // Radial rings: [first along, its mate, then each further use with the member whose orientation alternates].
  // A member is coded i (record i's first edgeuse, the one m_bOrientation describes) or -i-1 (its mate).
  edgeData.SetSize((ULONG)edges.size());
  for (size_t k = 0; k < edges.size(); k++) {
    std::vector<long> ring;
    bool want = true;
    for (ULONG r : edgeUses[k]) {
      bool o = eus[r].m_bOrientation == TRUE;
      long first = o == want ? (long)r : -(long)r - 1, second = o == want ? -(long)r - 1 : (long)r;
      ring.push_back(first);
      ring.push_back(second);
    }
    for (size_t j = 0; j < ring.size(); j++) {
      long cur = ring[j], next = ring[(j + 1) % ring.size()];
      if (cur >= 0) eus[cur].m_lNextEU = next;
      else eus[-cur - 1].m_lMateNextEU = next;
    }
    int e = edges[k], s, t;
    ends(e, s, t);
    if (geoms[k].swapped) std::swap(s, t);
    SmEdgeData& ed = edgeData[(ULONG)k];
    ed.ReSet();
    ed.m_sZoneTol3d = zoneTol;
    ed.m_lCurve = (ULONG)k;
    ed.m_lStartVertex = (ULONG)vertexOf(s);
    ed.m_lEndVertex = (ULONG)vertexOf(t);
    ed.m_lPrimEU = ring.empty() ? 0 : ring[0];
    ed.m_vInterval = geoms[k].interval;
    ed.m_lFlags = ed.m_lUserIndex2 = 0;
    ed.m_lUserIndex1 = e >= 0 ? (ULONG)e + 1 : 0;
    bd->m_v3DCurves.Add(geoms[k].curve);
  }
  vertexData.SetSize((ULONG)vertices.size());
  for (size_t k = 0; k < vertices.size(); k++) {
    SmVertexData& vd = vertexData[(ULONG)k];
    vd.ReSet();
    double tol = vertices[k] >= 0 ? m.vertexTol(vertices[k]) : NAN;
    vd.m_sZoneTol3d = std::isnan(tol) ? zoneTol : std::max(tol, zoneTol);
    vd.m_vPoint = sp(point(vertices[k]));
    vd.m_lFlags = vd.m_lUserIndex1 = vd.m_lUserIndex2 = 0;
  }
  // Vertices off their edges' curve ends: their tolerance raised to the gap.
  for (size_t k = 0; k < edges.size(); k++) {
    SmVector3d pd[1];
    for (int end = 0; end < 2; end++) {
      double t = end == 0 ? geoms[k].interval.GetMin() : geoms[k].interval.GetMax();
      geoms[k].curve->Evaluate(t, 0, FALSE, pd);
      SmVertexData& vd = vertexData[end == 0 ? edgeData[(ULONG)k].m_lStartVertex : edgeData[(ULONG)k].m_lEndVertex];
      double gap = norm(v3(pd[0]) - v3(vd.m_vPoint));
      if (gap > vd.m_sZoneTol3d) vd.m_sZoneTol3d = gap * 1.01;
    }
  }

  SmBrep* brep = new (ctx) SmBrep();
  SmTArray<SmAttribute*> attrs;
  SmStatus st = brep->MakeTopologyFromData(bd, attrs, TRUE, FALSE, TRUE, FALSE, FALSE, heal ? TRUE : FALSE);
  if (st != SM_SUCCESS) {
    warn("shells SMLib couldn't build (status " + std::to_string((int)st) + ")");
    delete brep;
    return;
  }
  // Which faces to turn over: the model's sense against SMLib's surface as built, then by the tessellator's rule.
  BuiltBrep built;
  built.brep = brep;
  built.transform = transform;
  std::unordered_map<int, const FaceOut*> byRow;
  for (auto& fo : kept) byRow[fo.row] = &fo;
  for (auto& fo : kept) built.rows.push_back(fo.row);
  SmTArray<SmFace*> smFaces;
  brep->GetFaces(smFaces);
  for (ULONG i = 0; i < smFaces.GetSize(); i++)
  {
    auto it = byRow.find((int)smFaces[i]->GetUserIndex1() - 1);
    if (it == byRow.end()) continue;
    const FaceOut& fo = *it->second;
    bool rev = fo.geom.flipped == m.faceSameSense(fo.row);
    // The tessellator turns over the polygons of a face whose upward side bounds a region other than the infinite
    // one (healing makes closed sheets solids: SmTess::OutputToPolyBrep).
    SmFaceuse* up = smFaces[i]->GetUpwardFaceuse();
    if (up && up->GetShell() && up->GetShell()->GetRegion() != brep->GetInfiniteRegion()) rev = !rev;
    if (rev) built.reverse.insert(smFaces[i]);
  }
  // Each edge tagged with its row and kind for the mesh's edges (SM_AI_EDGE_ID, carried onto the poly edges: the
  // tessellator meshes a copy of the B-rep, so poly edges' own pointers to edge uses are left dangling).
  SmTArray<SmEdge*> smEdges;
  brep->GetEdges(smEdges);
  for (ULONG i = 0; i < smEdges.GetSize(); i++)
  {
    SmEdge* e = smEdges[i];
    long kind = e->IsSeam() ? EDGE_SEAM : e->IsLamina() ? EDGE_FREE : EDGE_SHARED;
    e->AddAttribute(new (ctx) SmLongAttribute(SM_AI_EDGE_ID, (long)e->GetUserIndex1() * 4 + kind));
  }
  built.group = group;
  out.breps.push_back(std::move(built));
}

void Builder::buildNatural(int surface, int face, const std::vector<double>& transform)
{
  FaceGeom g = surfaceGeom(surface, {});
  if (!g.surface) {
    warn(g.error + (face >= 0 ? " (faces without loops left out)" : " (loose surfaces left out)"));
    return;
  }
  SmBrep* brep = new (ctx) SmBrep();
  SmFace* f = nullptr;
  if (brep->CreateFaceFromSurface(g.surface, g.domain, f) != SM_SUCCESS || !f) {
    warn("natural-bounds faces SMLib couldn't make (left out)");
    delete brep;
    return;
  }
  f->SetUserIndex1(face >= 0 ? (ULONG)face + 1 : 0);
  BuiltBrep built;
  built.brep = brep;
  built.transform = transform;
  if (face >= 0) built.rows.push_back(face);
  // A loose surface faces along its own normal.
  if (g.flipped == (face < 0 || m.faceSameSense(face))) built.reverse.insert(f);
  built.group = group;
  out.breps.push_back(std::move(built));
}

// The transform b after a (each 12 reals, column-major, or empty for none).
static std::vector<double> compose(const std::vector<double>& a, const std::vector<double>& b)
{
  if (a.size() != 12) return b;
  if (b.size() != 12) return a;
  std::vector<double> c(12);
  for (int col = 0; col < 4; col++)
    for (int r = 0; r < 3; r++)
      c[col * 3 + r] = b[r] * a[col * 3] + b[3 + r] * a[col * 3 + 1] + b[6 + r] * a[col * 3 + 2]
        + (col == 3 ? b[9 + r] : 0);
  return c;
}

void Builder::buildItem(int i, const std::vector<double>& outer, int depth)
{
  group = ++groups;
  std::vector<double> own;
  if (m.itemTransform(i) >= 0) own.assign(m.itemReal(m.itemTransform(i)), m.itemReal(m.itemTransform(i)) + 12);
  std::vector<double> tr = compose(own, outer);
  double id = CBR_F64(m.v[CBR_ITEM_ID])[i];
  switch (m.itemKind(i)) {
  case CBR_ITEM_BODY: {
    int b = m.itemRef(i);
    for (int k = m.bodyFirst(b); k < m.bodyFirst(b) + m.bodyCount(b); k++) {
      int ref = m.memberRef(k);
      if (m.bodyKind(b) == CBR_BODY_WIRE) {
        // A wire's edges: each between its vertices on its curve.
        int s = m.edgeStart(ref), t = m.edgeEnd(ref);
        if (!m.edgeSameSense(ref)) std::swap(s, t);
        EdgeGeom g = edgeGeom(ref, s, t);
        if (!g.curve) { warn(g.error + " (wire edges left out)"); continue; }
        BuiltPart::Polyline pl{CBR_F64(m.v[CBR_EDGE_ID])[ref], {}, tr};
        sampleCurve(g.curve, g.interval, pl.points);
        delete g.curve;
        out.curves.push_back(std::move(pl));
        continue;
      }
      std::vector<int> faces;
      for (int u = m.shellFirst(ref); u < m.shellFirst(ref) + m.shellCount(ref); u++) faces.push_back(m.faceUseFace(u));
      // (A closed shell a group of its own: never joined to another shell along an edge they share, which would make
      // it no longer closed. Open shells sharing edges are one surface the file split.)
      int open = group;
      if (m.shellKind(ref) == CBR_SHELL_CLOSED) group = ++groups;
      buildSheet(faces, tr);
      group = open;
    }
    break;
  }
  case CBR_ITEM_FACE: buildSheet({m.itemRef(i)}, tr); break;
  case CBR_ITEM_SURFACE: buildNatural(m.itemRef(i), -1, tr); break;
  case CBR_ITEM_CURVE: curveItem(m.itemRef(i), CBR_F64(m.v[CBR_CURVE_ID])[m.itemRef(i)], tr); break;
  case CBR_ITEM_POINT: {
    const double* p = m.itemReal(m.itemRef(i));
    out.points.push_back({id, {p[0], p[1], p[2]}, tr});
    break;
  }
  case CBR_ITEM_INSTANCE:
    if (depth > 16 || m.itemRef(i) >= i) { warn("instances not of an earlier item (left out)"); break; }
    buildItem(m.itemRef(i), tr, depth + 1);
    break;
  }
}

void Builder::build()
{
  int nItems = (int)m.rows(CBR_ITEM_KIND);
  for (int i = 0; i < nItems; i++) buildItem(i, {}, 0);
}

} // namespace

BuiltPart::~BuiltPart()
{
  for (auto& b : breps) delete b.brep;
}

// The part's row ids and zone tolerance, into out; false if the buffer isn't a model.
static bool openPart(const uint8_t* buf, size_t len, Model& m, BuiltPart& out, double& tol)
{
  if (cbr_open(buf, len, m.v) != 0) {
    out.error = "not a cad-brep buffer of this version";
    return false;
  }
  const double unit = CBR_F64(m.v[CBR_PART_UNIT])[0], uncertainty = CBR_F64(m.v[CBR_PART_UNCERTAINTY])[0];
  int nf = (int)m.rows(CBR_FACE_SURFACE);
  out.faceIds.resize(nf);
  for (int f = 0; f < nf; f++) out.faceIds[f] = m.faceId(f);
  int ne = (int)m.rows(CBR_EDGE_CURVE);
  out.edgeIds.resize(ne);
  for (int e = 0; e < ne; e++) out.edgeIds[e] = CBR_F64(m.v[CBR_EDGE_ID])[e];
  out.edgeFaces.assign(ne, {});
  for (int f = 0; f < nf; f++)
    for (int l = m.faceFirstLoop(f); l < m.faceFirstLoop(f) + m.faceLoopCount(f); l++)
    {
      if (m.loopKind(l) != CBR_LOOP_EDGE) continue;
      for (int k = 0; k < m.loopCount(l); k++)
      {
        int e = m.coedgeEdge(m.loopFirst(l) + k);
        if (e >= 0 && e < ne) out.edgeFaces[e].push_back(f);
      }
    }
  // The part's uncertainty as SMLib's zone tolerance; without one, 1e-5 of SMLib's default in millimetres.
  tol = std::isnan(uncertainty) || !(uncertainty > 0) ? 1e-5 / unit : uncertainty;
  return true;
}

// A model's lengths times s, in place (the buffer a writable copy): what the builder reads for faces. Parameters keep
// their values (a line's magnitude and an extrusion's scale with the lengths) but a rectangular trim's on a plane and
// along a cylinder or cone, which are lengths. Not scaled: 2D curves, which the builder doesn't read.
static void scaleModel(Model& m, double s)
{
  auto f64 = [&](int c) { return const_cast<double*>(CBR_F64(m.v[c])); };
  auto times = [&](double* p, size_t n) { for (size_t i = 0; i < n; i++) p[i] *= s; };
  f64(CBR_PART_UNIT)[0] /= s;
  f64(CBR_PART_UNCERTAINTY)[0] *= s;
  times(f64(CBR_VERTEX_POINT), m.v[CBR_VERTEX_POINT].count);
  times(f64(CBR_VERTEX_TOLERANCE), m.v[CBR_VERTEX_TOLERANCE].count);
  times(f64(CBR_EDGE_TOLERANCE), m.v[CBR_EDGE_TOLERANCE].count);
  times(f64(CBR_FACE_TOLERANCE), m.v[CBR_FACE_TOLERANCE].count);
  // (Rows may share a pool entry: each scaled once.)
  std::unordered_set<int32_t> done;
  for (int i = 0; i < (int)m.rows(CBR_CURVE_KIND); i++)
  {
    if (m.curveDim(i) != 3 || !done.insert(CBR_I32(m.v[CBR_CURVE_REAL])[i]).second) continue;
    double* r = const_cast<double*>(m.curveReal(i));
    const int32_t* n = m.curveInt(i);
    switch (m.curveKind(i))
    {
    case CBR_CURVE_LINE: times(r, 3); r[6] *= s; break;
    case CBR_CURVE_CIRCLE:
    case CBR_CURVE_PARABOLA: times(r, 3); r[9] *= s; break;
    case CBR_CURVE_ELLIPSE:
    case CBR_CURVE_HYPERBOLA: times(r, 3); times(r + 9, 2); break;
    case CBR_CURVE_BSPLINE: times(r + n[2], 3 * (size_t)n[1]); break;
    case CBR_CURVE_POLYLINE: times(r, 3 * (size_t)n[0]); break;
    case CBR_CURVE_TRIMMED: times(r + 2, 6); break;
    case CBR_CURVE_OFFSET: r[0] *= s; break;
    }
  }
  done.clear();
  for (int i = 0; i < (int)m.rows(CBR_SURFACE_KIND); i++)
  {
    if (!done.insert(CBR_I32(m.v[CBR_SURFACE_REAL])[i]).second) continue;
    double* r = const_cast<double*>(m.surfaceReal(i));
    const int32_t* n = m.surfaceInt(i);
    switch (m.surfaceKind(i))
    {
    case CBR_SURFACE_PLANE: times(r, 3); break;
    case CBR_SURFACE_CYLINDER:
    case CBR_SURFACE_CONE:
    case CBR_SURFACE_SPHERE: times(r, 3); r[9] *= s; break;
    case CBR_SURFACE_TORUS: times(r, 3); times(r + 9, 2); break;
    case CBR_SURFACE_BSPLINE: times(r + n[4] + n[5], 3 * (size_t)n[2] * (size_t)n[3]); break;
    case CBR_SURFACE_EXTRUSION: r[3] *= s; break;
    case CBR_SURFACE_REVOLUTION: times(r, 3); break;
    case CBR_SURFACE_OFFSET: r[0] *= s; break;
    case CBR_SURFACE_RECTANGULAR_TRIMMED: {
      int basis = m.surfaceKind(n[0]);
      if (basis == CBR_SURFACE_PLANE) times(r, 4);
      else if (basis == CBR_SURFACE_CYLINDER || basis == CBR_SURFACE_CONE) times(r + 2, 2);
      break;
    }
    }
  }
  done.clear();
  double* ir = const_cast<double*>(m.itemReal(0));
  for (int i = 0; i < (int)m.rows(CBR_ITEM_KIND); i++)
  {
    if (m.itemKind(i) == CBR_ITEM_POINT && done.insert(m.itemRef(i)).second) times(ir + m.itemRef(i), 3);
    int t = m.itemTransform(i);
    if (t >= 0 && done.insert(t + 9).second) times(ir + t + 9, 3);
  }
}

// A copy of a part's buffer with its lengths times scale, opened as m; false if it isn't a model. (Doubles: the
// columns are 8-byte aligned.)
static bool scaledCopy(const uint8_t* buf, size_t len, double scale, std::vector<double>& copy, Model& m)
{
  copy.assign((len + 7) / 8, 0.0);
  std::memcpy(copy.data(), buf, len);
  if (cbr_open(reinterpret_cast<const uint8_t*>(copy.data()), len, m.v) != 0) return false;
  scaleModel(m, scale);
  return true;
}

// After a build at a scale: each B-rep's scale.
static void scaledBack(BuiltPart& out, double scale)
{
  for (auto& b : out.breps) b.scale = scale;
}

void buildFaces(const uint8_t* buf, size_t len, const std::vector<int>& faces, const std::vector<double>& transform,
  const BuildOptions& options, double scale, BuiltPart& out)
{
  Model m;
  double tol;
  std::vector<double> copy;
  if (scale != 1 && !scaledCopy(buf, len, scale, copy, m)) return;
  if (!openPart(scale != 1 ? reinterpret_cast<const uint8_t*>(copy.data()) : buf, len, m, out, tol)) return;
  BuildOptions opt = options;
  opt.linearDeflection *= scale;
  std::vector<double> back = transform;
  if (scale != 1)
  {
    if (back.size() != 12) back = {1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0};
    for (int i = 0; i < 9; i++) back[i] /= scale;
  }
  Builder(m, *SmApiGetOrCreateContext(), tol, opt, out).buildEach(faces, back);
  scaledBack(out, scale);
}

void buildPart(const uint8_t* buf, size_t len, const BuildOptions& options, double scale, BuiltPart& out)
{
  Model m;
  double tol;
  std::vector<double> copy;
  if (scale != 1 && !scaledCopy(buf, len, scale, copy, m)) return;
  if (!openPart(scale != 1 ? reinterpret_cast<const uint8_t*>(copy.data()) : buf, len, m, out, tol)) return;
  BuildOptions opt = options;
  opt.linearDeflection *= scale;
  Builder(m, *SmApiGetOrCreateContext(), tol, opt, out).build();
  scaledBack(out, scale);
  if (scale == 1) return;
  // The items' transforms (their translations scaled with the model) made to bring the meshes back to the part's size.
  auto back = [&](std::vector<double>& t) {
    if (t.size() != 12) t = {1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0};
    for (double& x : t) x /= scale;
  };
  for (auto& b : out.breps) back(b.transform);
  for (auto& c : out.curves) back(c.transform);
  for (auto& c : out.points) back(c.transform);
}
