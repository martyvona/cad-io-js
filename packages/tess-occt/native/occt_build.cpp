// The native builder (docs/brep-model.md, phase 7): a part's cad-brep buffer (cad_brep.h) as OCCT shapes, built through
// OCCT's public API (Geom, BRep_Builder), for the wrapper to heal and mesh as it does what its STEP reader makes.
// Provenance (docs/licensing.md): written from ISO 10303-42's parameterizations (as cad-brep's evaluators implement
// them, packages/cad-brep/src/geometry.ts) and OCCT's API documentation (its headers); what OCCT's STEP translator
// does to the geometry before healing follows the translator (decision 15: this package is LGPL as OCCT is), so healing
// gets what it gets from a STEP file:
//   - B-splines: repeated knots merged; a curve's end multiplicities above degree + 1 cut, with the poles beyond;
//     knots in periodic form taken as periodic; a curve said closed that is, of degree 2 or more, made periodic; a
//     surface put in periodic form where closed (ShapeAlgo's ConvertToPeriodic).
//   - Parameterizations where OCCT's differ from Part 42's, all affine (Geom_*.hxx): a line's parameter is distance
//     (Part 42's is in units of its vector's magnitude); an ellipse's x axis must be its major one (Part 42 allows
//     either: swapped, the parameter shifts by pi/2); a cone's v runs along the generatrix, v cos(a) along the axis
//     (Geom_ConicalSurface.hxx's formula); a parabola is O + u^2/(4F) X + u Y (Part 42's C + a(t^2 x + 2t y): u = 2at).
//     Edges take their vertices' parameters by projection onto OCCT's curve, so they need no mapping.
//   - An edge running against its curve (same_sense false) is built along the curve from its end to its start and
//     used reversed; a loop's coedges are its edges oriented by the coedge, the wire reversed when the loop's sense
//     is; a face against its surface (same_sense false) is built with its wires reversed, then reversed itself, so its
//     outer wire runs counter-clockwise about the face's normal as Part 42 has it.
//   - Tolerances: a vertex's the model's, else 1e-7, edges and faces 1e-7 (as the STEP translator builds; healing
//     raises them where a vertex lies off its edges); the part's uncertainty is healing's tolerance (as the STEP
//     reader's): with shapes built at it, healing splits a ring on a closed B-spline between two circles into two empty
//     faces.
//   - What this step doesn't build yet (p-curves, degenerate edges, vertex and poly loops, edges without a 3D curve,
//     surfaces other than elementary and B-spline, curves other than lines, conics, B-splines and polylines, items
//     other than solids and sheets) fails the part with an error naming it (decision 13); faces on Part 42's swept
//     surfaces, which OCCT's API has no counterpart for, are dropped with a warning.

#include "occt_build.h"

#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <GeomAPI_ProjectPointOnCurve.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Geom_Circle.hxx>
#include <Geom_ConicalSurface.hxx>
#include <Geom_CylindricalSurface.hxx>
#include <Geom_Ellipse.hxx>
#include <Geom_Hyperbola.hxx>
#include <Geom_Line.hxx>
#include <Geom_Parabola.hxx>
#include <Geom_Plane.hxx>
#include <Geom_SphericalSurface.hxx>
#include <Geom_ToroidalSurface.hxx>
#include <NCollection_Array1.hxx>
#include <NCollection_Array2.hxx>
#include <ShapeAlgo.hxx>
#include <ShapeAlgo_AlgoContainer.hxx>
#include <Standard_Failure.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>
#include <TopoDS_Vertex.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Ax2.hxx>
#include <gp_Ax3.hxx>

#include <cmath>
#include <map>
#include <string>
#include <vector>

#include "cad_brep.h"

namespace
{
// Not built yet: fails the part (decision 13).
struct Unbuilt
{
  std::string what;
};

struct Reader
{
  cbr_view v[CBR_COLUMN_COUNT];
  const double*  f64(cbr_column c) const { return CBR_F64(v[c]); }
  const int32_t* i32(cbr_column c) const { return CBR_I32(v[c]); }
  const uint8_t* u8(cbr_column c) const { return CBR_U8(v[c]); }
  int            rows(cbr_column c, int width = 1) const { return (int)(v[c].count / width); }
};

gp_Pnt pnt(const double* p) { return gp_Pnt(p[0], p[1], p[2]); }
gp_Dir dir(const double* p) { return gp_Dir(p[0], p[1], p[2]); }
// A Part 42 placement as 9 reals: origin, axis, x direction.
gp_Ax2 ax2(const double* p) { return gp_Ax2(pnt(p), dir(p + 3), dir(p + 6)); }
gp_Ax3 ax3(const double* p) { return gp_Ax3(pnt(p), dir(p + 3), dir(p + 6)); }

const char* curveKindName(int k)
{
  static const char* names[] = {"?", "line", "circle", "ellipse", "hyperbola", "parabola", "B-spline", "polyline",
                                "trimmed curve", "composite curve", "offset curve"};
  return k >= 0 && k <= 10 ? names[k] : "?";
}
const char* surfaceKindName(int k)
{
  static const char* names[] = {"?", "plane", "cylinder", "cone", "sphere", "torus", "B-spline surface",
                                "extrusion", "surface of revolution", "offset surface", "rectangular trimmed surface",
                                "surface curve swept surface", "fixed reference swept surface"};
  return k >= 0 && k <= 12 ? names[k] : "?";
}

// A knot vector as OCCT takes it: knots strictly increasing, a repeated knot's multiplicities summed.
struct Knots
{
  std::vector<double> k;
  std::vector<int>    m;
};
Knots knots(const double* k, const int32_t* m, int n)
{
  Knots out;
  for (int i = 0; i < n; ++i)
    if (out.k.empty() || k[i] - out.k.back() > Epsilon(std::abs(out.k.back())))
    {
      out.k.push_back(k[i]);
      out.m.push_back(m[i]);
    }
    else
      out.m.back() += m[i];
  return out;
}
// Periodic form: the multiplicities don't sum to poles + degree + 1, the end ones are equal, and the rest with one of
// them sum to the poles.
bool periodicKnots(const Knots& k, int poles, int degree)
{
  int sum = 0;
  for (int x : k.m)
    sum += x;
  return sum != poles + degree + 1 && k.m.front() == k.m.back() && sum - k.m.front() == poles;
}

struct Builder
{
  Reader                                r;
  BuiltPart&                            out;
  double                                tol;
  std::map<int, occ::handle<Geom_Curve>>   curves;
  std::vector<TopoDS_Vertex>            vertices;
  std::map<int, TopoDS_Edge>            edges; // as the model's edge runs, start to end
  std::map<int, TopoDS_Face>            faces;

  Builder(BuiltPart& o) : out(o) {}

  occ::handle<Geom_Curve> curve(int k)
  {
    auto it = curves.find(k);
    if (it != curves.end())
      return it->second;
    if (r.u8(CBR_CURVE_DIM)[k] != 3)
      throw Unbuilt{"an edge whose curve is 2D"};
    const int     kind = r.u8(CBR_CURVE_KIND)[k];
    const double* re   = r.f64(CBR_POOL_CURVE_REAL) + r.i32(CBR_CURVE_REAL)[k];
    const int32_t* in  = r.i32(CBR_POOL_CURVE_INT) + r.i32(CBR_CURVE_INT)[k];
    occ::handle<Geom_Curve> c;
    switch (kind)
    {
      case CBR_CURVE_LINE:
        c = new Geom_Line(pnt(re), dir(re + 3));
        break;
      case CBR_CURVE_CIRCLE:
        c = new Geom_Circle(ax2(re), re[9]);
        break;
      case CBR_CURVE_ELLIPSE:
      {
        gp_Ax2 a = ax2(re);
        double s1 = re[9], s2 = re[10];
        // OCCT's x axis is the major one.
        if (s1 < s2)
        {
          a = gp_Ax2(a.Location(), a.Direction(), a.YDirection());
          std::swap(s1, s2);
        }
        c = new Geom_Ellipse(a, s1, s2);
        break;
      }
      case CBR_CURVE_HYPERBOLA:
        c = new Geom_Hyperbola(ax2(re), re[9], re[10]);
        break;
      case CBR_CURVE_PARABOLA:
        c = new Geom_Parabola(ax2(re), re[9]);
        break;
      case CBR_CURVE_BSPLINE:
      {
        const int degree = in[0], n = in[1], nk = in[2], rational = in[3];
        Knots     k = knots(re, in + 7, nk);
        // An end knot's multiplicity above degree + 1 cut to it, the poles it carried beyond dropped.
        int       lead = 0, trail = 0;
        for (size_t i = 0; i < k.m.size(); ++i)
          if (k.m[i] > degree + 1)
          {
            if (i == 0)
              lead = k.m[i] - degree - 1;
            if (i + 1 == k.m.size())
              trail = k.m[i] - degree - 1;
            k.m[i] = degree + 1;
          }
        const int np = n - lead - trail;
        if (np <= 0)
          throw Unbuilt{"a B-spline curve with no poles left"};
        NCollection_Array1<gp_Pnt> poles(1, np);
        NCollection_Array1<double> weights(1, np);
        for (int i = 0; i < np; ++i)
        {
          poles(i + 1) = pnt(re + nk + 3 * (i + lead));
          weights(i + 1) = rational ? re[nk + 3 * n + i + lead] : 1.0;
        }
        const bool periodic = periodicKnots(k, n, degree);
        NCollection_Array1<double> kv(1, (int)k.k.size());
        NCollection_Array1<int>    mv(1, (int)k.m.size());
        for (size_t i = 0; i < k.k.size(); ++i)
        {
          kv((int)i + 1) = k.k[i];
          mv((int)i + 1) = k.m[i];
        }
        occ::handle<Geom_BSplineCurve> bs = rational
          ? new Geom_BSplineCurve(poles, weights, kv, mv, degree, periodic)
          : new Geom_BSplineCurve(poles, kv, mv, degree, periodic);
        // Said closed and closed: periodic.
        if (in[4] == CBR_LOGICAL_TRUE && degree > 1 && bs->IsClosed())
          bs->SetPeriodic();
        c = bs;
        break;
      }
      case CBR_CURVE_POLYLINE:
      {
        // Degree 1 through its points, a knot per point (Part 42: segment i for parameters i - 1 to i).
        const int                  n = in[0];
        NCollection_Array1<gp_Pnt> poles(1, n);
        NCollection_Array1<double> knots(1, n);
        NCollection_Array1<int>    mults(1, n);
        for (int i = 0; i < n; ++i)
        {
          poles(i + 1) = pnt(re + 3 * i);
          knots(i + 1) = i;
          mults(i + 1) = i == 0 || i == n - 1 ? 2 : 1;
        }
        c = new Geom_BSplineCurve(poles, knots, mults, 1);
        break;
      }
      default:
        throw Unbuilt{std::string("a ") + curveKindName(kind)};
    }
    curves.emplace(k, c);
    return c;
  }

  // A surface, made anew for each face (as the STEP translator makes them): a p-curve is kept per edge and surface, so
  // two faces on one surface sharing an edge (a hole's two halves on one cylinder) would share the edge's p-curve,
  // and healing turns one of them into the rest of the cylinder. Null for one OCCT's API can't hold (a swept surface:
  // its faces dropped).
  occ::handle<Geom_Surface> surface(int k)
  {
    const int      kind = r.u8(CBR_SURFACE_KIND)[k];
    const double*  re   = r.f64(CBR_POOL_SURFACE_REAL) + r.i32(CBR_SURFACE_REAL)[k];
    const int32_t* in   = r.i32(CBR_POOL_SURFACE_INT) + r.i32(CBR_SURFACE_INT)[k];
    occ::handle<Geom_Surface> s;
    switch (kind)
    {
      case CBR_SURFACE_PLANE:
        s = new Geom_Plane(ax3(re));
        break;
      case CBR_SURFACE_CYLINDER:
        s = new Geom_CylindricalSurface(ax3(re), re[9]);
        break;
      case CBR_SURFACE_CONE:
        s = new Geom_ConicalSurface(ax3(re), re[10], re[9]);
        break;
      case CBR_SURFACE_SPHERE:
        s = new Geom_SphericalSurface(ax3(re), re[9]);
        break;
      case CBR_SURFACE_TORUS:
        if (in[0])
          throw Unbuilt{"a degenerate torus"};
        s = new Geom_ToroidalSurface(ax3(re), re[9], re[10]);
        break;
      case CBR_SURFACE_BSPLINE:
      {
        const int ud = in[0], vd = in[1], nu = in[2], nv = in[3], ku = in[4], kv = in[5], rational = in[6];
        NCollection_Array2<gp_Pnt> poles(1, nu, 1, nv);
        NCollection_Array2<double> weights(1, nu, 1, nv);
        const Knots U = knots(re, in + 11, ku), V = knots(re + ku, in + 11 + ku, kv);
        NCollection_Array1<double> uk(1, (int)U.k.size()), vk(1, (int)V.k.size());
        NCollection_Array1<int>    um(1, (int)U.m.size()), vm(1, (int)V.m.size());
        for (size_t i = 0; i < U.k.size(); ++i) { uk((int)i + 1) = U.k[i]; um((int)i + 1) = U.m[i]; }
        for (size_t i = 0; i < V.k.size(); ++i) { vk((int)i + 1) = V.k[i]; vm((int)i + 1) = V.m[i]; }
        const bool    uPeriodic = periodicKnots(U, nu, ud), vPeriodic = periodicKnots(V, nv, vd);
        const double* p = re + ku + kv;
        for (int i = 0; i < nu; ++i)
          for (int j = 0; j < nv; ++j)
            poles(i + 1, j + 1) = pnt(p + 3 * (i * nv + j));
        if (rational)
        {
          const double* w = p + 3 * nu * nv;
          for (int i = 0; i < nu; ++i)
            for (int j = 0; j < nv; ++j)
              weights(i + 1, j + 1) = w[i * nv + j];
          s = new Geom_BSplineSurface(poles, weights, uk, vk, um, vm, ud, vd, uPeriodic, vPeriodic);
        }
        else
          s = new Geom_BSplineSurface(poles, uk, vk, um, vm, ud, vd, uPeriodic, vPeriodic);
        // In periodic form where closed (as the STEP translator puts a B-spline face's surface): healing adds the
        // missing seam only on a periodic surface, and splits a ring between two circles on a closed one into two
        // empty faces.
        if (occ::handle<Geom_Surface> ps = ShapeAlgo::AlgoContainer()->ConvertToPeriodic(s); !ps.IsNull())
          s = ps;
        break;
      }
      case CBR_SURFACE_CURVE_SWEPT:
      case CBR_SURFACE_FIXED_REFERENCE_SWEPT:
        return s;
      default:
        throw Unbuilt{std::string("a ") + surfaceKindName(kind)};
    }
    return s;
  }

  // A parameter of a point on a curve, by projection.
  double param(const occ::handle<Geom_Curve>& c, const gp_Pnt& p)
  {
    GeomAPI_ProjectPointOnCurve proj(p, c);
    if (proj.NbPoints() == 0)
      throw Unbuilt{"a vertex that doesn't project onto its edge's curve"};
    return proj.LowerDistanceParameter();
  }

  TopoDS_Edge edge(int e)
  {
    auto it = edges.find(e);
    if (it != edges.end())
      return it->second;
    if (r.u8(CBR_EDGE_FLAGS)[e] & CBR_EDGE_DEGENERATE)
      throw Unbuilt{"a degenerate edge"};
    const int ci = r.i32(CBR_EDGE_CURVE)[e], si = r.i32(CBR_EDGE_START)[e], ei = r.i32(CBR_EDGE_END)[e];
    if (ci < 0)
      throw Unbuilt{"an edge without a 3D curve"};
    if (si < 0 || ei < 0)
      throw Unbuilt{"an edge without a vertex"};
    occ::handle<Geom_Curve> c = curve(ci);
    const bool same = r.u8(CBR_EDGE_SAME_SENSE)[e] != 0;
    // Along the curve: from the start to the end, or from the end to the start against it.
    const int     a = same ? si : ei, b = same ? ei : si;
    TopoDS_Vertex va = vertices[a], vb = vertices[b];
    double        ta = param(c, BRep_Tool::Pnt(va)), tb = param(c, BRep_Tool::Pnt(vb));
    if (c->IsPeriodic())
    {
      const double period = c->Period();
      // A closed edge (one vertex) goes all the way round; otherwise the end is after the start.
      if (a == b)
        tb = ta + period;
      else
        while (tb <= ta)
          tb += period;
    }
    else if (a == b)
    {
      // A closed non-periodic curve (a closed B-spline): its whole range.
      ta = c->FirstParameter();
      tb = c->LastParameter();
    }
    if (!(tb > ta))
      throw Unbuilt{"an edge whose vertices are in the wrong order on its curve"};
    BRep_Builder bb;
    TopoDS_Edge  ed;
    bb.MakeEdge(ed, c, tol);
    bb.Add(ed, va.Oriented(TopAbs_FORWARD));
    bb.Add(ed, vb.Oriented(TopAbs_REVERSED));
    bb.Range(ed, ta, tb);
    TopoDS_Edge used = same ? ed : TopoDS::Edge(ed.Reversed());
    edges.emplace(e, used);
    const double id = r.f64(CBR_EDGE_ID)[e];
    if (std::isfinite(id))
      out.edgeIds.emplace(ed.TShape().get(), (int)id);
    return used;
  }

  // A face; null when dropped (its surface one OCCT can't hold).
  TopoDS_Face face(int f)
  {
    auto it = faces.find(f);
    if (it != faces.end())
      return it->second;
    const int                 si = r.i32(CBR_FACE_SURFACE)[f];
    occ::handle<Geom_Surface> s  = surface(si);
    const double              id = r.f64(CBR_FACE_ID)[f];
    if (s.IsNull())
    {
      out.warnings.push_back("face #" + std::to_string((long long)id) + ": its surface (a "
                             + surfaceKindName(r.u8(CBR_SURFACE_KIND)[si])
                             + ") has no counterpart in OCCT; left out (as OCCT's STEP reader leaves it out)");
      faces.emplace(f, TopoDS_Face());
      return TopoDS_Face();
    }
    const bool   same = r.u8(CBR_FACE_SAME_SENSE)[f] != 0;
    BRep_Builder bb;
    TopoDS_Face  fc;
    bb.MakeFace(fc, s, tol);
    const int first = r.i32(CBR_FACE_FIRST_LOOP)[f], count = r.i32(CBR_FACE_LOOP_COUNT)[f];
    if (count == 0)
      throw Unbuilt{"a face bounded by its surface's extent"};
    for (int l = first; l < first + count; ++l)
    {
      if (r.u8(CBR_LOOP_KIND)[l] != CBR_LOOP_EDGE)
        throw Unbuilt{r.u8(CBR_LOOP_KIND)[l] == CBR_LOOP_VERTEX ? "a vertex loop" : "a poly loop"};
      TopoDS_Wire w;
      bb.MakeWire(w);
      const int c0 = r.i32(CBR_LOOP_FIRST)[l], cn = r.i32(CBR_LOOP_COUNT)[l];
      for (int c = c0; c < c0 + cn; ++c)
      {
        const int o = r.u8(CBR_COEDGE_ORIENTATION)[c];
        if (o == CBR_ORIENTATION_INTERNAL || o == CBR_ORIENTATION_EXTERNAL)
          throw Unbuilt{"an internal or external coedge"};
        if (r.i32(CBR_COEDGE_PCURVE)[c] >= 0)
        {
          // P-curves come with step (b); healing makes them meanwhile, as it does for most STEP files.
        }
        TopoDS_Edge e = edge(r.i32(CBR_COEDGE_EDGE)[c]);
        bb.Add(w, o == CBR_ORIENTATION_REVERSED ? e.Reversed() : e);
      }
      // The loop's sense, and against a reversed face the other way round (the face is reversed below).
      const bool reverse = (r.u8(CBR_LOOP_SENSE)[l] == 0) != !same;
      w.Closed(true);
      bb.Add(fc, reverse ? w.Reversed() : w);
    }
    if (!same)
      fc.Reverse();
    if (std::isfinite(id))
      out.faceIds.emplace(fc.TShape().get(), (int)id);
    faces.emplace(f, fc);
    return fc;
  }

  TopoDS_Shell shell(int k)
  {
    BRep_Builder bb;
    TopoDS_Shell sh;
    bb.MakeShell(sh);
    const int first = r.i32(CBR_SHELL_FIRST)[k], count = r.i32(CBR_SHELL_COUNT)[k];
    for (int j = first; j < first + count; ++j)
    {
      TopoDS_Face f = face(r.i32(CBR_FACE_USE_FACE)[j]);
      if (f.IsNull())
        continue;
      bb.Add(sh, r.u8(CBR_FACE_USE_SENSE)[j] ? f : TopoDS::Face(f.Reversed()));
    }
    sh.Closed(r.u8(CBR_SHELL_KIND)[k] == CBR_SHELL_CLOSED);
    return sh;
  }

  TopoDS_Shape body(int k)
  {
    BRep_Builder bb;
    const int    kind = r.u8(CBR_BODY_KIND)[k];
    const int    first = r.i32(CBR_BODY_FIRST)[k], count = r.i32(CBR_BODY_COUNT)[k];
    if (kind == CBR_BODY_SOLID)
    {
      TopoDS_Solid so;
      bb.MakeSolid(so);
      for (int j = first; j < first + count; ++j)
      {
        TopoDS_Shell sh = shell(r.i32(CBR_MEMBER_REF)[j]);
        bb.Add(so, r.u8(CBR_MEMBER_SENSE)[j] ? sh : TopoDS::Shell(sh.Reversed()));
      }
      return so;
    }
    if (kind == CBR_BODY_SHEET)
    {
      TopoDS_Compound c;
      bb.MakeCompound(c);
      for (int j = first; j < first + count; ++j)
      {
        TopoDS_Shell sh = shell(r.i32(CBR_MEMBER_REF)[j]);
        bb.Add(c, r.u8(CBR_MEMBER_SENSE)[j] ? sh : TopoDS::Shell(sh.Reversed()));
      }
      return c;
    }
    throw Unbuilt{"a wire body"};
  }
};
} // namespace

BuiltPart buildPart(const uint8_t* buf, size_t len)
{
  BuiltPart out;
  Builder   b(out);
  if (cbr_open(buf, len, b.r.v) != 0)
  {
    out.error = "not a cad-brep buffer";
    return out;
  }
  const double unc = b.r.rows(CBR_PART_UNCERTAINTY) ? b.r.f64(CBR_PART_UNCERTAINTY)[0] : NAN;
  // Built at 1e-7, as the STEP translator builds; the uncertainty (else NaN) is healing's.
  b.tol = 1e-7;
  out.unit = b.r.rows(CBR_PART_UNIT) ? b.r.f64(CBR_PART_UNIT)[0] : 1.0;
  out.uncertainty = std::isfinite(unc) && unc > 0 ? unc : NAN;
  try
  {
    BRep_Builder bb;
    const int    nv = b.r.rows(CBR_VERTEX_POINT, 3);
    for (int i = 0; i < nv; ++i)
    {
      TopoDS_Vertex v;
      const double  t = b.r.f64(CBR_VERTEX_TOLERANCE)[i];
      bb.MakeVertex(v, pnt(b.r.f64(CBR_VERTEX_POINT) + 3 * i), std::isfinite(t) ? t : b.tol);
      b.vertices.push_back(v);
    }
    TopoDS_Compound all;
    bb.MakeCompound(all);
    const int ni = b.r.rows(CBR_ITEM_KIND);
    for (int i = 0; i < ni; ++i)
    {
      const int kind = b.r.u8(CBR_ITEM_KIND)[i], ref = b.r.i32(CBR_ITEM_REF)[i];
      if (b.r.i32(CBR_ITEM_TRANSFORM)[i] >= 0)
        throw Unbuilt{"an item with a transform"};
      if (kind != CBR_ITEM_BODY)
        throw Unbuilt{kind == CBR_ITEM_FACE ? "a face item" : kind == CBR_ITEM_SURFACE ? "a surface item"
                      : kind == CBR_ITEM_CURVE ? "a curve item" : kind == CBR_ITEM_POINT ? "a point item"
                      : "an instance item"};
      bb.Add(all, b.body(ref));
    }
    out.shape = all;
  }
  catch (const Unbuilt& u)
  {
    out.error = "not built yet: " + u.what;
  }
  catch (const Standard_Failure& e)
  {
    out.error = std::string("OCCT: ") + e.what();
  }
  return out;
}
