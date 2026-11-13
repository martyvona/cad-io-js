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
//     either: x then x ^ z, as the translator turns it, and the parameter shifts by pi/2); a cone's v runs along the
//     generatrix, v cos(a) along the axis (Geom_ConicalSurface.hxx's formula); a parabola is O + u^2/(4F) X + u Y
//     (Part 42's C + a(t^2 x + 2t y): u = 2at).
//     Edges take their vertices' parameters by projection onto OCCT's curve, so they need no mapping; p-curves are
//     converted as the translator converts them (a cone's v by GeomConvert_Units).
//   - An edge running against its curve (same_sense false) is built along the curve from its end to its start and
//     used reversed; a loop's coedges are its edges oriented by the coedge, the wire reversed when the loop's sense
//     is; a face against its surface (same_sense false) is built with its wires reversed, then reversed itself, so its
//     outer wire runs counter-clockwise about the face's normal as Part 42 has it.
//   - Edges, loops and p-curves as the translator makes them (edge(), edgeLoop(), vertexLoop(), polyLoop()); the
//     model's degenerate edges (from formats that have them) left out, healing adding its own where a wire needs one,
//     as it does for the same model written as STEP.
//   - Tolerances: a vertex's the model's, else 1e-7, edges and faces 1e-7, vertices raised to their distances from
//     their edges' curves (as the STEP translator builds); the part's uncertainty is healing's tolerance and the
//     translator's precision (as the STEP reader's): with shapes built at it, healing splits a ring on a closed
//     B-spline between two circles into two empty faces.
//   - Parameters where the translator doesn't convert them (trims on parabolas; p-curves and trims on extrusions,
//     revolutions, offset and trimmed surfaces) mapped from Part 42's to OCCT's (curveParam, surfaceParams), as
//     decision 3 has backends do.
//   - Items: each built alone, then moved by its transform (a similarity: OCCT holds no other), an instance sharing
//     the shapes of the item it places.
//   - What the builder doesn't build yet (composite curves as edges' curves) fails the part with an error naming it
//     (decision 13); faces on Part 42's swept surfaces, which OCCT's API has no counterpart for, are dropped with a
//     warning.

#include "occt_build.h"

#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <BRepLib_MakeEdge.hxx>
#include <DESTEP_Parameters.hxx>
#include <ElCLib.hxx>
#include <Geom2d_BSplineCurve.hxx>
#include <Geom2d_Circle.hxx>
#include <Geom2d_Ellipse.hxx>
#include <Geom2d_Hyperbola.hxx>
#include <Geom2d_Line.hxx>
#include <Geom2d_Parabola.hxx>
#include <Geom2d_OffsetCurve.hxx>
#include <Geom2d_TrimmedCurve.hxx>
#include <Geom2dConvert.hxx>
#include <Geom_OffsetCurve.hxx>
#include <Geom_OffsetSurface.hxx>
#include <Geom_RectangularTrimmedSurface.hxx>
#include <Geom_SurfaceOfLinearExtrusion.hxx>
#include <Geom_SurfaceOfRevolution.hxx>
#include <gp_Ax1.hxx>
#include <gp_GTrsf2d.hxx>
#include <TopLoc_Location.hxx>
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
#include <GeomConvert_Units.hxx>
#include <gp_Ax2.hxx>
#include <gp_Ax22d.hxx>
#include <gp_Ax3.hxx>
#include <gp_Lin.hxx>
#include <gp_Vec.hxx>
#include <gp_Vec2d.hxx>
#include <NCollection_Array1.hxx>
#include <NCollection_Array2.hxx>
#include <Precision.hxx>
#include <ShapeAlgo.hxx>
#include <ShapeAlgo_AlgoContainer.hxx>
#include <ShapeAlgo_ToolContainer.hxx>
#include <ShapeAnalysis_Curve.hxx>
#include <ShapeAnalysis_Edge.hxx>
#include <ShapeAnalysis_Surface.hxx>
#include <ShapeBuild_Edge.hxx>
#include <ShapeExtend_WireData.hxx>
#include <ShapeFix_EdgeProjAux.hxx>
#include <ShapeBuild_ReShape.hxx>
#include <ShapeFix_Wire.hxx>
#include <TopExp_Explorer.hxx>
#include <Geom_BoundedSurface.hxx>
#include <Standard_Failure.hxx>
#include <StepToTopoDS_GeometricTool.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Iterator.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>
#include <TopoDS_Vertex.hxx>
#include <TopoDS_Wire.hxx>
#include <XSAlgo_ShapeProcessor.hxx>

#include <array>
#include <cmath>
#include <cstring>
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
  const double*   f64(cbr_column c) const { return CBR_F64(v[c]); }
  const int32_t*  i32(cbr_column c) const { return CBR_I32(v[c]); }
  const uint32_t* u32(cbr_column c) const { return CBR_U32(v[c]); }
  const uint8_t*  u8(cbr_column c) const { return CBR_U8(v[c]); }
  int             rows(cbr_column c, int width = 1) const { return (int)(v[c].count / width); }
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
// "a B-spline", "an extrusion".
std::string withArticle(const char* name)
{
  return std::string(std::strchr("aeiou", name[0]) ? "an " : "a ") + name;
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

// A B-spline curve's data as OCCT's STEP reader takes it: knots merged; an end knot's multiplicity above degree + 1
// cut to it, the poles it carried beyond dropped; knots in periodic form taken as periodic.
struct BSplineCurve
{
  int                        degree = 0, n = 0;
  bool                       rational = false, periodic = false, closed = false;
  std::vector<double>        poles, weights; // n x dim, n
  NCollection_Array1<double> k;
  NCollection_Array1<int>    m;
};
BSplineCurve bsplineCurve(const double* re, const int32_t* in, int dim)
{
  BSplineCurve b;
  b.degree = in[0];
  const int n = in[1], nk = in[2];
  b.rational = in[3] != 0;
  b.closed   = in[4] == CBR_LOGICAL_TRUE;
  Knots k    = knots(re, in + 7, nk);
  int   lead = 0, trail = 0;
  for (size_t i = 0; i < k.m.size(); ++i)
    if (k.m[i] > b.degree + 1)
    {
      if (i == 0)
        lead = k.m[i] - b.degree - 1;
      if (i + 1 == k.m.size())
        trail = k.m[i] - b.degree - 1;
      k.m[i] = b.degree + 1;
    }
  b.n = n - lead - trail;
  if (b.n <= 0)
    throw Unbuilt{"a B-spline curve with no poles left"};
  for (int i = lead; i < n - trail; ++i)
  {
    b.poles.insert(b.poles.end(), re + nk + dim * i, re + nk + dim * (i + 1));
    b.weights.push_back(b.rational ? re[nk + dim * n + i] : 1.0);
  }
  b.periodic = periodicKnots(k, n, b.degree);
  b.k.Resize(1, (int)k.k.size(), false);
  b.m.Resize(1, (int)k.m.size(), false);
  for (size_t i = 0; i < k.k.size(); ++i)
  {
    b.k((int)i + 1) = k.k[i];
    b.m((int)i + 1) = k.m[i];
  }
  return b;
}

gp_Pnt2d pnt2(const double* p) { return gp_Pnt2d(p[0], p[1]); }
// A Part 42 2D placement as 4 reals: origin, x direction (y is x turned +90 degrees).
gp_Ax22d ax22(const double* p) { return gp_Ax22d(pnt2(p), gp_Dir2d(p[2], p[3]), true); }

struct Builder
{
  Reader                                r;
  BuiltPart&                            out;
  double                                tol;
  std::map<int, occ::handle<Geom_Curve>>   curves;
  std::vector<TopoDS_Vertex>            vertices;
  std::map<int, TopoDS_Edge>            edges; // as the model's edge runs, start to end
  std::map<int, TopoDS_Face>            faces;
  // Poly loops' edges, by their corners' vertex rows (an edge under both orders).
  std::map<std::pair<int, int>, TopoDS_Edge> polyEdges;
  // The translator's precision: the part's uncertainty, else the reader's default.
  double precision = DESTEP_Parameters().ReadPrecisionVal;

  Builder(BuiltPart& o) : out(o) {}

  // Part 42's parameter on a curve as OCCT's: t' = f t + shift (a line's times its magnitude, an ellipse's shifted by
  // pi/2 where OCCT swaps its axes, a parabola's times 2 a; a trimmed curve its basis's); false where not affine.
  bool curveParam(int k, double& f, double& shift)
  {
    f = 1.;
    shift = 0.;
    const int     kind = r.u8(CBR_CURVE_KIND)[k], d = r.u8(CBR_CURVE_DIM)[k];
    const double* re = r.f64(CBR_POOL_CURVE_REAL) + r.i32(CBR_CURVE_REAL)[k];
    const int     p = d == 3 ? 9 : 4; // a placement's reals
    switch (kind)
    {
      case CBR_CURVE_LINE:
        f = re[2 * d];
        return true;
      case CBR_CURVE_ELLIPSE:
        if (re[p] < re[p + 1])
          shift = 0.5 * M_PI;
        return true;
      case CBR_CURVE_PARABOLA:
        f = 2. * re[p];
        return true;
      case CBR_CURVE_TRIMMED:
        return curveParam(r.i32(CBR_POOL_CURVE_INT)[r.i32(CBR_CURVE_INT)[k]], f, shift);
      case CBR_CURVE_COMPOSITE:
        return false;
      default:
        return true;
    }
  }

  // Part 42's (u, v) on a surface as OCCT's: u' = fu u + su, v' = fv v + sv (a cone's v over cos a; an extrusion's u
  // its curve's and v times its magnitude; a revolution's v its curve's; an offset or trimmed surface its basis's).
  bool surfaceParams(int k, double& fu, double& su, double& fv, double& sv)
  {
    fu = fv = 1.;
    su = sv = 0.;
    const int      kind = r.u8(CBR_SURFACE_KIND)[k];
    const double*  re = r.f64(CBR_POOL_SURFACE_REAL) + r.i32(CBR_SURFACE_REAL)[k];
    const int32_t* in = r.i32(CBR_POOL_SURFACE_INT) + r.i32(CBR_SURFACE_INT)[k];
    switch (kind)
    {
      case CBR_SURFACE_CONE:
        fv = 1. / std::cos(re[10]);
        return true;
      case CBR_SURFACE_EXTRUSION:
        fv = re[3];
        return curveParam(in[0], fu, su);
      case CBR_SURFACE_REVOLUTION:
        return curveParam(in[0], fv, sv);
      case CBR_SURFACE_OFFSET:
      case CBR_SURFACE_RECTANGULAR_TRIMMED:
        return surfaceParams(in[0], fu, su, fv, sv);
      default:
        return true;
    }
  }

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
        // OCCT's x axis is the major one: x as x ^ z (y's opposite), as the translator turns it, so Part 42's t is
        // OCCT's t + pi/2 (curveParam).
        if (s1 < s2)
        {
          a.SetXDirection(a.XDirection() ^ a.Direction());
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
        const BSplineCurve b = bsplineCurve(re, in, 3);
        NCollection_Array1<gp_Pnt> poles(1, b.n);
        NCollection_Array1<double> weights(1, b.n);
        for (int i = 0; i < b.n; ++i)
        {
          poles(i + 1) = pnt(&b.poles[3 * i]);
          weights(i + 1) = b.weights[i];
        }
        occ::handle<Geom_BSplineCurve> bs = b.rational
          ? new Geom_BSplineCurve(poles, weights, b.k, b.m, b.degree, b.periodic)
          : new Geom_BSplineCurve(poles, b.k, b.m, b.degree, b.periodic);
        // Said closed and closed: periodic.
        if (b.closed && b.degree > 1 && bs->IsClosed())
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
      case CBR_CURVE_TRIMMED:
        c = trimmed(k, re, in);
        break;
      case CBR_CURVE_OFFSET:
        // C + d (T x V) / |T x V|, V the reference direction: Part 42's and OCCT's alike.
        c = new Geom_OffsetCurve(curve(in[0]), re[0], dir(re + 1));
        break;
      default:
        throw Unbuilt{withArticle(curveKindName(kind))};
    }
    curves.emplace(k, c);
    return c;
  }

  // A trimmed curve as OCCT's STEP translator makes one (StepToGeom::MakeTrimmedCurve): each trim by its parameter
  // where the master representation says so (or says nothing), by its point projected where cartesian, else by
  // whichever it has; a parameter mapped to OCCT's on the basis curve (a line's times its magnitude, an ellipse's
  // shifted by pi/2 where OCCT swaps its axes, a parabola's times 2 a: Part 42's t is OCCT's u / 2a, which the
  // translator doesn't convert); clamped to a bounded basis curve; equal trims round a periodic or closed one.
  occ::handle<Geom_Curve> trimmed(int k, const double* re, const int32_t* in)
  {
    const int               bi    = in[0];
    occ::handle<Geom_Curve> basis = curve(bi);
    const int               bkind = r.u8(CBR_CURVE_KIND)[bi];
    const double*           bre   = r.f64(CBR_POOL_CURVE_REAL) + r.i32(CBR_CURVE_REAL)[bi];
    double                  fact = 1., shift = 0.;
    if (bkind == CBR_CURVE_LINE)
      fact = bre[6];
    else if (bkind == CBR_CURVE_ELLIPSE && bre[9] < bre[10])
      shift = 0.5 * M_PI;
    else if (bkind == CBR_CURVE_PARABOLA)
      fact = 2. * bre[9];
    const int master = in[2]; // TRIM_PREFERENCES: 0 unspecified, 1 parameter, 2 cartesian
    auto      trim = [&](int j, double& t) {
      const double  param = re[j];
      const double* point = re + 2 + 3 * j;
      const bool    hasParam = std::isfinite(param), hasPoint = std::isfinite(point[0]);
      auto          project = [&] {
        ShapeAnalysis_Curve sac;
        gp_Pnt              proj;
        sac.Project(basis, pnt(point), Precision::Confusion(), proj, t);
      };
      if (master == 1 && hasParam)
        t = shift + fact * param;
      else if (master == 2 && hasPoint)
        project();
      else if (hasParam)
        t = shift + fact * param;
      else if (hasPoint)
        project();
      else
        throw Unbuilt{"a trimmed curve without a trim"};
    };
    double t1 = 0, t2 = 0;
    trim(0, t1);
    trim(1, t2);
    const double cf = basis->FirstParameter(), cl = basis->LastParameter();
    if (!basis->IsPeriodic())
    {
      t1 = std::min(std::max(t1, cf), cl);
      t2 = std::min(std::max(t2, cf), cl);
    }
    if (std::abs(t1 - t2) < Precision::PConfusion())
    {
      if (basis->IsPeriodic())
        ElCLib::AdjustPeriodic(cf, cl, Precision::PConfusion(), t1, t2);
      else if (basis->IsClosed())
      {
        if (std::abs(t1 - cf) < Precision::PConfusion())
          t2 += cl;
        else
          t1 -= cl;
      }
      else
        throw Unbuilt{"a trimmed curve of no length"};
    }
    (void)k;
    return in[1] ? occ::handle<Geom_Curve>(new Geom_TrimmedCurve(basis, t1, t2, true))
                 : occ::handle<Geom_Curve>(new Geom_TrimmedCurve(basis, t2, t1, false));
  }

  // A curve item as OCCT's STEP translator makes one of a geometric set's: an edge over the curve's whole range (none
  // where that fails: an unbounded one); a composite curve its segments' edges, each with the composite's id.
  void curveItem(int k, uint32_t id, TopoDS_Compound& all)
  {
    BRep_Builder bb;
    std::vector<std::pair<occ::handle<Geom_Curve>, bool>> segments;
    if (r.u8(CBR_CURVE_KIND)[k] == CBR_CURVE_COMPOSITE)
    {
      const int32_t* in = r.i32(CBR_POOL_CURVE_INT) + r.i32(CBR_CURVE_INT)[k];
      for (int j = 0; j < in[0]; ++j)
        segments.emplace_back(curve(in[2 + 3 * j]), in[3 + 3 * j] != 0);
    }
    else
      segments.emplace_back(curve(k), true);
    for (const auto& [c, sense] : segments)
    {
      BRepBuilderAPI_MakeEdge me(c, c->FirstParameter(), c->LastParameter());
      if (!me.IsDone())
      {
        out.warnings.push_back("curve #" + std::to_string(id)
                               + ": no edge along it (unbounded?); left out (as OCCT's STEP reader leaves it out)");
        continue;
      }
      TopoDS_Edge e = me.Edge();
      if (id)
        out.edgeIds.emplace(e.TShape().get(), id);
      bb.Add(all, sense ? e : e.Reversed());
    }
  }


  // A p-curve: a 2D curve in its surface's (u, v), Part 42's parameterizations as OCCT's 2D counterparts (as curve()
  // maps the 3D ones), then as OCCT's STEP translator takes it (GeomConvert_Units::DegreeToRadian with unit factors:
  // a cone's v along the generatrix, conics on surfaces other than planes as B-splines).
  occ::handle<Geom2d_Curve> curve2d(int k, const occ::handle<Geom_Surface>& surface, int si)
  {
    return mapped(plain2d(k), surface, si);
  }

  // A 2D curve as OCCT's counterpart, unconverted.
  occ::handle<Geom2d_Curve> plain2d(int k)
  {
    if (r.u8(CBR_CURVE_DIM)[k] != 2)
      throw Unbuilt{"a p-curve that isn't 2D"};
    const int      kind = r.u8(CBR_CURVE_KIND)[k];
    const double*  re   = r.f64(CBR_POOL_CURVE_REAL) + r.i32(CBR_CURVE_REAL)[k];
    const int32_t* in   = r.i32(CBR_POOL_CURVE_INT) + r.i32(CBR_CURVE_INT)[k];
    occ::handle<Geom2d_Curve> c;
    switch (kind)
    {
      case CBR_CURVE_LINE:
        c = new Geom2d_Line(pnt2(re), gp_Dir2d(re[2], re[3]));
        break;
      case CBR_CURVE_CIRCLE:
        c = new Geom2d_Circle(ax22(re), re[4]);
        break;
      case CBR_CURVE_ELLIPSE:
      {
        gp_Ax22d a  = ax22(re);
        double   s1 = re[4], s2 = re[5];
        // OCCT's x axis is the major one: y's opposite as x (as in 3D), so Part 42's t is OCCT's t + pi/2.
        if (s1 < s2)
        {
          a = gp_Ax22d(a.Location(), a.YDirection().Reversed(), true);
          std::swap(s1, s2);
        }
        c = new Geom2d_Ellipse(a, s1, s2);
        break;
      }
      case CBR_CURVE_HYPERBOLA:
        c = new Geom2d_Hyperbola(ax22(re), re[4], re[5]);
        break;
      case CBR_CURVE_PARABOLA:
        c = new Geom2d_Parabola(ax22(re), re[4]);
        break;
      case CBR_CURVE_BSPLINE:
      {
        const BSplineCurve b = bsplineCurve(re, in, 2);
        NCollection_Array1<gp_Pnt2d> poles(1, b.n);
        NCollection_Array1<double>   weights(1, b.n);
        for (int i = 0; i < b.n; ++i)
        {
          poles(i + 1) = pnt2(&b.poles[2 * i]);
          weights(i + 1) = b.weights[i];
        }
        occ::handle<Geom2d_BSplineCurve> bs = b.rational
          ? new Geom2d_BSplineCurve(poles, weights, b.k, b.m, b.degree, b.periodic)
          : new Geom2d_BSplineCurve(poles, b.k, b.m, b.degree, b.periodic);
        if (b.closed && b.degree > 1 && bs->IsClosed())
          bs->SetPeriodic();
        c = bs;
        break;
      }
      case CBR_CURVE_POLYLINE:
      {
        const int                    n = in[0];
        NCollection_Array1<gp_Pnt2d> poles(1, n);
        NCollection_Array1<double>   kn(1, n);
        NCollection_Array1<int>      mults(1, n);
        for (int i = 0; i < n; ++i)
        {
          poles(i + 1) = pnt2(re + 2 * i);
          kn(i + 1) = i;
          mults(i + 1) = i == 0 || i == n - 1 ? 2 : 1;
        }
        c = new Geom2d_BSplineCurve(poles, kn, mults, 1);
        break;
      }
      case CBR_CURVE_TRIMMED:
      {
        // As the translator makes a trimmed p-curve: a B-spline basis as it is, another trimmed (Part 42's
        // parameters as OCCT's) and as a B-spline.
        occ::handle<Geom2d_Curve> basis = plain2d(in[0]);
        if (basis->IsKind(STANDARD_TYPE(Geom2d_BSplineCurve)))
        {
          c = basis;
          break;
        }
        double f, shift;
        curveParam(in[0], f, shift);
        if (!std::isfinite(re[0]) || !std::isfinite(re[1]))
          throw Unbuilt{"a trimmed p-curve trimmed by points"};
        double t1 = shift + f * re[0], t2 = shift + f * re[1];
        if (!in[1])
          std::swap(t1, t2);
        c = Geom2dConvert::CurveToBSplineCurve(new Geom2d_TrimmedCurve(basis, t1, t2, in[1] != 0));
        break;
      }
      case CBR_CURVE_OFFSET:
        // C + d N, N the tangent turned -90 degrees: Part 42's and OCCT's alike.
        c = new Geom2d_OffsetCurve(plain2d(in[0]), re[0]);
        break;
      default:
        throw Unbuilt{std::string("a p-curve that is ") + withArticle(curveKindName(kind))};
    }
    return c;
  }

  // A p-curve in OCCT's (u, v) on its surface: as the translator converts it (GeomConvert_Units::DegreeToRadian:
  // a cone's v; conics on surfaces other than planes as B-splines), then where the translator doesn't convert
  // (extrusions, revolutions, offset and trimmed surfaces), Part 42's (u, v) mapped to OCCT's (surfaceParams).
  occ::handle<Geom2d_Curve> mapped(const occ::handle<Geom2d_Curve>& c0, const occ::handle<Geom_Surface>& surface,
                                   int si)
  {
    occ::handle<Geom2d_Curve> c = GeomConvert_Units::DegreeToRadian(c0, surface, 1.0, 1.0);
    const int kind = r.u8(CBR_SURFACE_KIND)[si];
    if (kind != CBR_SURFACE_EXTRUSION && kind != CBR_SURFACE_REVOLUTION && kind != CBR_SURFACE_OFFSET
        && kind != CBR_SURFACE_RECTANGULAR_TRIMMED)
      return c;
    double fu, su, fv, sv;
    if (!surfaceParams(si, fu, su, fv, sv))
      throw Unbuilt{"a p-curve on a surface whose curve has no affine parameterization"};
    if (fu == 1. && su == 0. && fv == 1. && sv == 0.)
      return c;
    gp_GTrsf2d t;
    t.SetValue(1, 1, fu);
    t.SetValue(2, 2, fv);
    t.SetTranslationPart(gp_XY(su, sv));
    if (auto l = occ::down_cast<Geom2d_Line>(c))
    {
      // (A line stays one; its parameter's speed changes, which the edge's range on the face absorbs.)
      gp_XY o = l->Location().XY(), d = l->Direction().XY();
      t.Transforms(o);
      d.SetCoord(fu * d.X(), fv * d.Y());
      return new Geom2d_Line(gp_Pnt2d(o), gp_Dir2d(d));
    }
    occ::handle<Geom2d_BSplineCurve> b = Geom2dConvert::CurveToBSplineCurve(c);
    for (int i = 1; i <= b->NbPoles(); ++i)
    {
      gp_XY q = b->Pole(i).XY();
      t.Transforms(q);
      b->SetPole(i, gp_Pnt2d(q));
    }
    return b;
  }

  // A surface, made anew for each face (as the STEP translator makes them): a p-curve is kept per edge and surface, so
  // two faces on one surface sharing an edge (a hole's two halves on one cylinder) would share the edge's p-curve,
  // and healing turns one of them into the rest of the cylinder. Null for one OCCT's API can't hold (a swept surface:
  // its faces dropped).
  occ::handle<Geom_Surface> surface(int k, bool periodic = true)
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
        // (A degenerate torus as a plain one, select_outer aside, as the translator reads it: its parameters reach
        // each point of either part once, so a face's loops settle which part it's on; face() warns of one without.)
        s = new Geom_ToroidalSurface(ax3(re), re[9], re[10]);
        break;
      case CBR_SURFACE_EXTRUSION:
        s = new Geom_SurfaceOfLinearExtrusion(curve(in[0]), dir(re));
        break;
      case CBR_SURFACE_REVOLUTION:
        s = new Geom_SurfaceOfRevolution(curve(in[0]), gp_Ax1(pnt(re), dir(re + 3)));
        break;
      case CBR_SURFACE_OFFSET:
      {
        occ::handle<Geom_Surface> basis = surface(in[0], false);
        if (basis.IsNull())
          return basis;
        s = new Geom_OffsetSurface(basis, re[0]);
        break;
      }
      case CBR_SURFACE_RECTANGULAR_TRIMMED:
      {
        occ::handle<Geom_Surface> basis = surface(in[0], false);
        if (basis.IsNull())
          return basis;
        double fu, su, fv, sv;
        if (!surfaceParams(in[0], fu, su, fv, sv))
          throw Unbuilt{"a trimmed surface whose basis's curve has no affine parameterization"};
        s = new Geom_RectangularTrimmedSurface(basis, fu * re[0] + su, fu * re[1] + su, fv * re[2] + sv,
                                               fv * re[3] + sv, in[1] != 0, in[2] != 0);
        break;
      }
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
        if (!periodic)
          break;
        if (occ::handle<Geom_Surface> ps = ShapeAlgo::AlgoContainer()->ConvertToPeriodic(s); !ps.IsNull())
          s = ps;
        break;
      }
      case CBR_SURFACE_CURVE_SWEPT:
      case CBR_SURFACE_FIXED_REFERENCE_SWEPT:
        return s;
      default:
        throw Unbuilt{withArticle(surfaceKindName(kind))};
    }
    return s;
  }

  // An edge as OCCT's STEP translator makes one: its vertices' parameters by projection onto its curve, put in order
  // and within a bounded curve's ends (StepToTopoDS_GeometricTool::UpdateParam3d), the vertices' tolerances raised to
  // their distances from it, a line off its vertices by the same distance at both ends moved through them; then
  // BRepLib_MakeEdge, and the translator's ways round its failures. Null for an edge it leaves out (no length, one
  // vertex). Two vertices at one point (within 1e-7) are one, as the translator merges them.
  TopoDS_Edge edge(int e)
  {
    auto it = edges.find(e);
    if (it != edges.end())
      return it->second;
    const int ci = r.i32(CBR_EDGE_CURVE)[e], si = r.i32(CBR_EDGE_START)[e], ei = r.i32(CBR_EDGE_END)[e];
    const uint32_t id = r.u32(CBR_EDGE_ID)[e];
    const std::string what = "edge #" + std::to_string(id);
    BRep_Builder bb;
    // A degenerate edge (at a pole or an apex) left out: healing makes OCCT's own where the wire needs it (one made
    // here, given its coedge's p-curve and range, leaves BRepCheck unable to analyse the face).
    if (r.u8(CBR_EDGE_FLAGS)[e] & CBR_EDGE_DEGENERATE)
    {
      edges.emplace(e, TopoDS_Edge());
      return TopoDS_Edge();
    }
    if (si < 0 || ei < 0)
      throw Unbuilt{"an edge without a vertex"};
    if (ci < 0)
    {
      // Its p-curves alone (STEP's PCURVE as an edge's geometry): a bare edge between its vertices, as the translator
      // makes one; its faces give it its p-curves, and healing its 3D curve.
      const bool same = r.u8(CBR_EDGE_SAME_SENSE)[e] != 0;
      const int  a = same ? si : ei, b = same ? ei : si;
      TopoDS_Edge ed;
      bb.MakeEdge(ed);
      bb.Add(ed, vertices[a].Oriented(TopAbs_FORWARD));
      bb.Add(ed, vertices[b].Oriented(TopAbs_REVERSED));
      TopoDS_Edge used = same ? ed : TopoDS::Edge(ed.Reversed());
      edges.emplace(e, used);
      if (id)
        out.edgeIds.emplace(ed.TShape().get(), id);
      return used;
    }
    occ::handle<Geom_Curve> c = curve(ci);
    const bool same = r.u8(CBR_EDGE_SAME_SENSE)[e] != 0;
    // Along the curve: from the start to the end, or from the end to the start against it.
    const int a = same ? si : ei, b = same ? ei : si;
    // The points as the model has them (the vertices may have been merged).
    const gp_Pnt pa = pnt(r.f64(CBR_VERTEX_POINT) + 3 * a), pb = pnt(r.f64(CBR_VERTEX_POINT) + 3 * b);
    if (a != b && !vertices[a].IsSame(vertices[b])
        && BRep_Tool::Pnt(vertices[a]).Distance(BRep_Tool::Pnt(vertices[b])) <= Precision::Confusion())
      vertices[b] = vertices[a];
    TopoDS_Vertex       va = vertices[a], vb = vertices[b];
    ShapeAnalysis_Curve sac;
    gp_Pnt              proj;
    double              u1 = 0, u2 = 0;
    sac.Project(c, pa, precision, proj, u1, false);
    sac.Project(c, pb, precision, proj, u2, false);
    StepToTopoDS_GeometricTool::UpdateParam3d(c, u1, u2, precision);
    const gp_Pnt qa = BRep_Tool::Pnt(va), qb = BRep_Tool::Pnt(vb);
    double       da = c->Value(u1).Distance(qa), db = c->Value(u2).Distance(qb);
    if ((da > precision || db > precision) && std::abs(da - db) < precision
        && std::abs(u2 - u1 - pa.Distance(pb)) < Precision::Confusion() && c->IsKind(STANDARD_TYPE(Geom_Line)))
    {
      // A line beside its vertices by the same distance at both ends: moved through them.
      gp_Lin l = occ::down_cast<Geom_Line>(c)->Lin();
      l.SetLocation(pa.XYZ() - l.Position().Direction().XYZ() * u1);
      c = new Geom_Line(l);
      out.warnings.push_back(what + ": its line moved through its vertices (as OCCT's STEP reader moves it)");
    }
    bb.UpdateVertex(va, 1.000001 * da);
    bb.UpdateVertex(vb, 1.000001 * db);
    // Without BRepLib_MakeEdge: the curve, its vertices and their parameters as they are.
    auto direct = [&](const occ::handle<Geom_Curve>& cc, const TopoDS_Vertex& v1, const TopoDS_Vertex& v2, double t1,
                      double t2) {
      TopoDS_Edge ed;
      bb.MakeEdge(ed, cc, Precision::Confusion());
      bb.Add(ed, v1.Oriented(TopAbs_FORWARD));
      bb.Add(ed, v2.Oriented(TopAbs_REVERSED));
      bb.UpdateVertex(TopoDS::Vertex(v1.Oriented(TopAbs_FORWARD)), t1, ed, 0.);
      bb.UpdateVertex(TopoDS::Vertex(v2.Oriented(TopAbs_REVERSED)), t2, ed, 0.);
      return ed;
    };
    TopoDS_Edge      ed;
    BRepLib_MakeEdge me(c, va, vb, u1, u2);
    if (me.IsDone())
    {
      ed = me.Edge();
      bb.Range(ed, u1, u2);
    }
    else if (me.Error() == BRepLib_DifferentPointsOnClosedCurve)
    {
      if (c->IsClosed())
      {
        // A closed edge with two vertices: one, at both ends.
        vertices[b] = va;
        me.Init(c, va, TopoDS::Vertex(va.Reversed()), u1, u2);
        ed = me.IsDone() ? me.Edge() : direct(c, va, va, u1, u2);
      }
      else if (!va.IsSame(vb))
      {
        // No length: a line between its vertices.
        out.warnings.push_back(what + ": of no length along its curve; a line between its vertices (as OCCT's STEP "
                               "reader makes it)");
        const gp_Pnt p1 = BRep_Tool::Pnt(va), p2 = BRep_Tool::Pnt(vb);
        ed = direct(new Geom_Line(p1, gp_Dir(gp_Vec(p1, p2))), va, vb, 0., p1.Distance(p2));
      }
      else
      {
        out.warnings.push_back(what + ": of no length, at one vertex; left out (as OCCT's STEP reader leaves it out)");
        edges.emplace(e, TopoDS_Edge());
        return TopoDS_Edge();
      }
    }
    else
      ed = direct(c, va, vb, u1, u2);
    TopoDS_Edge used = same ? ed : TopoDS::Edge(ed.Reversed());
    edges.emplace(e, used);
    if (id)
      out.edgeIds.emplace(ed.TShape().get(), id);
    return used;
  }

  // A face; null when dropped (its surface one OCCT can't hold). Its loops as OCCT's STEP translator makes them
  // (decision 15): edge loops with the model's p-curves (none on planes), poly loops as lines with their p-curves,
  // vertex loops as natural bounds or a degenerate edge, by the surface; no loops, no wires (healing adds the natural
  // bounds).
  TopoDS_Face face(int f)
  {
    auto it = faces.find(f);
    if (it != faces.end())
      return it->second;
    const int                 si = r.i32(CBR_FACE_SURFACE)[f];
    occ::handle<Geom_Surface> s  = surface(si);
    const uint32_t            id = r.u32(CBR_FACE_ID)[f];
    const std::string         what = "face #" + std::to_string(id);
    if (s.IsNull())
    {
      out.warnings.push_back(what + ": its surface (" + withArticle(surfaceKindName(r.u8(CBR_SURFACE_KIND)[si]))
                             + ") has no counterpart in OCCT; left out (as OCCT's STEP reader leaves it out)");
      faces.emplace(f, TopoDS_Face());
      return TopoDS_Face();
    }
    const int first0 = r.i32(CBR_FACE_FIRST_LOOP)[f], count0 = r.i32(CBR_FACE_LOOP_COUNT)[f];
    for (int l = first0; l < first0 + count0; ++l)
      if (r.u8(CBR_LOOP_KIND)[l] == CBR_LOOP_EDGE && r.i32(CBR_LOOP_COUNT)[l] > 0
          && r.i32(CBR_EDGE_START)[r.i32(CBR_COEDGE_EDGE)[r.i32(CBR_LOOP_FIRST)[l]]] < 0)
      {
        TopoDS_Face fc = curveBounded(f, s);
        if (id)
          out.faceIds.emplace(fc.TShape().get(), id);
        faces.emplace(f, fc);
        return fc;
      }
    const bool   same = r.u8(CBR_FACE_SAME_SENSE)[f] != 0;
    const bool   isPlane = s->IsKind(STANDARD_TYPE(Geom_Plane));
    BRep_Builder bb;
    TopoDS_Face  fc;
    bb.MakeFace(fc, s, tol);
    const int first = r.i32(CBR_FACE_FIRST_LOOP)[f], count = r.i32(CBR_FACE_LOOP_COUNT)[f];
    for (int l = first; l < first + count; ++l)
    {
      const int  kind  = r.u8(CBR_LOOP_KIND)[l];
      const bool sense = r.u8(CBR_LOOP_SENSE)[l] != 0;
      if (kind == CBR_LOOP_VERTEX)
        vertexLoop(fc, s, l, count, what);
      else if (kind == CBR_LOOP_POLY)
      {
        // (The translator turns the face as it will be before a poly loop; its wire is turned by the loop's sense
        // alone.)
        fc.Orientation(same ? TopAbs_FORWARD : TopAbs_REVERSED);
        TopoDS_Wire w = polyLoop(fc, s, l);
        bb.Add(fc, sense ? w : TopoDS::Wire(w.Reversed()));
      }
      else
      {
        // The loop's sense, and against a reversed face the other way round (the face is turned below).
        const bool reverse = !sense != !same;
        bb.Add(fc, edgeLoop(fc, s, si, isPlane, l, reverse));
      }
    }
    // (Healing bounds a face without wires by its surface: on a degenerate torus, both its parts.)
    if (r.u8(CBR_SURFACE_KIND)[si] == CBR_SURFACE_TORUS && degenerateTorus(si) && !TopoDS_Iterator(fc).More())
      out.warnings.push_back(what + ": bounded by its degenerate torus alone: both of the torus's parts, which part is "
                                    "meant (select_outer) set aside, as OCCT's STEP reader sets it aside");
    fc.Orientation(same ? TopAbs_FORWARD : TopAbs_REVERSED);
    if (id)
      out.faceIds.emplace(fc.TShape().get(), id);
    faces.emplace(f, fc);
    return fc;
  }

  // Whether torus k is degenerate (Part 42's DEGENERATE_TOROIDAL_SURFACE).
  bool degenerateTorus(int k) { return r.i32(CBR_POOL_SURFACE_INT)[r.i32(CBR_SURFACE_INT)[k]] != 0; }

  // A curve-bounded face (its edges without vertices: STEP's CURVE_BOUNDED_SURFACE), as OCCT's STEP translator makes
  // one: on its surface (a B-spline one in periodic form), the surface's natural bounds first where its loops are all
  // inner (an implicit outer bound) and the surface is bounded; each loop a wire of an edge per coedge, from its 3D
  // curve over its whole range with the p-curve added unparameterized, or from its p-curve on the surface alone;
  // reordered and connected by ShapeFix_Wire.
  TopoDS_Face curveBounded(int f, const occ::handle<Geom_Surface>& s)
  {
    BRep_Builder bb;
    TopoDS_Face  fc;
    bb.MakeFace(fc, s, Precision::Confusion());
    const int first = r.i32(CBR_FACE_FIRST_LOOP)[f], count = r.i32(CBR_FACE_LOOP_COUNT)[f];
    bool      implicitOuter = count > 0;
    for (int l = first; l < first + count; ++l)
      implicitOuter = implicitOuter && r.u8(CBR_LOOP_BOUND)[l] == CBR_BOUND_INNER;
    const std::string what = "face #" + std::to_string(r.u32(CBR_FACE_ID)[f]);
    if (implicitOuter)
    {
      if (s->IsKind(STANDARD_TYPE(Geom_BoundedSurface)))
        fc = BRepBuilderAPI_MakeFace(s, Precision::Confusion()).Face();
      else
        out.warnings.push_back(what + ": no natural bounds on an unbounded surface (as OCCT's STEP reader makes none)");
    }
    for (int l = first; l < first + count; ++l)
    {
      if (r.u8(CBR_LOOP_KIND)[l] != CBR_LOOP_EDGE)
        continue;
      occ::handle<ShapeExtend_WireData> wd = new ShapeExtend_WireData;
      // Each segment's edge as made, with its id: kept (alive) until the ids are given to the edges the fixes leave.
      std::vector<std::pair<TopoDS_Edge, uint32_t>> made;
      const int c0 = r.i32(CBR_LOOP_FIRST)[l], cn = r.i32(CBR_LOOP_COUNT)[l];
      for (int c = c0; c < c0 + cn; ++c)
      {
        const int   e  = r.i32(CBR_COEDGE_EDGE)[c], ci = r.i32(CBR_EDGE_CURVE)[e], pc = r.i32(CBR_COEDGE_PCURVE)[c];
        TopoDS_Edge ed;
        try
        {
          occ::handle<Geom2d_Curve> c2d =
            pc >= 0 ? curve2d(pc, s, r.i32(CBR_FACE_SURFACE)[f]) : occ::handle<Geom2d_Curve>();
          if (ci >= 0)
          {
            occ::handle<Geom_Curve> c3 = curve(ci);
            BRepBuilderAPI_MakeEdge me(c3, c3->FirstParameter(), c3->LastParameter());
            if (me.IsDone())
            {
              ed = me.Edge();
              if (!c2d.IsNull())
              {
                TopLoc_Location loc;
                bb.UpdateEdge(ed, c2d, s, loc, 0.);
                bb.Range(ed, s, loc, c2d->FirstParameter(), c2d->LastParameter());
                bb.SameRange(ed, false);
                bb.SameParameter(ed, false);
              }
            }
          }
          else if (!c2d.IsNull())
          {
            BRepBuilderAPI_MakeEdge me(c2d, s, c2d->FirstParameter(), c2d->LastParameter());
            if (me.IsDone())
              ed = me.Edge();
          }
        }
        catch (const Standard_Failure&)
        {
          ed.Nullify();
        }
        if (ed.IsNull())
        {
          out.warnings.push_back(what + ": a boundary segment that can't be made an edge; left out (as OCCT's STEP "
                                 "reader leaves it out)");
          continue;
        }
        const uint32_t id = r.u32(CBR_EDGE_ID)[e];
        if (id)
          made.emplace_back(ed, id);
        wd->Add(r.u8(CBR_COEDGE_ORIENTATION)[c] == CBR_ORIENTATION_REVERSED ? TopoDS::Edge(ed.Reversed()) : ed);
      }
      if (wd->NbEdges() == 0)
        continue;
      occ::handle<ShapeFix_Wire> sfw = new ShapeFix_Wire;
      // (The fixes replace edges whose vertices they join, recorded in the context: the ids go to the replacements.
      // Keyed by the edges as made, an id would outlive its edge, and the next edge at that address take it.)
      occ::handle<ShapeBuild_ReShape> ctx = new ShapeBuild_ReShape;
      sfw->Load(wd);
      sfw->SetContext(ctx);
      sfw->SetPrecision(precision);
      sfw->ClosedWireMode() = true;
      sfw->FixReorder();
      sfw->FixConnected(precision);
      for (const auto& [e0, id] : made)
      {
        TopoDS_Shape now = e0;
        // (Replaced again where a fix replaces a replacement: followed to the last.)
        for (int k = 0; k < 16 && ctx->IsRecorded(now); ++k)
        {
          const TopoDS_Shape next = ctx->Value(now);
          if (next.IsNull() || next.IsSame(now))
            break;
          now = next;
        }
        for (TopExp_Explorer x(now, TopAbs_EDGE); x.More(); x.Next())
          out.edgeIds.emplace(x.Current().TShape().get(), id);
      }
      bb.Add(fc, wd->Wire());
    }
    return fc;
  }

  // A surface item, as OCCT's STEP translator makes a geometric set's: a face over its natural bounds where it's
  // bounded (its B-spline surface as it is, not in periodic form), else none.
  TopoDS_Face surfaceItem(int k, uint32_t id)
  {
    occ::handle<Geom_Surface> s = surface(k, false);
    if (s.IsNull() || !s->IsKind(STANDARD_TYPE(Geom_BoundedSurface)))
    {
      out.warnings.push_back("surface #" + std::to_string(id)
                             + ": unbounded; left out (as OCCT's STEP reader leaves it out)");
      return TopoDS_Face();
    }
    BRepBuilderAPI_MakeFace mf;
    mf.Init(s, true, precision);
    TopoDS_Face fc = mf.Face();
    if (id)
      out.faceIds.emplace(fc.TShape().get(), id);
    return fc;
  }

  // An edge loop's wire, turned as it's to be added (reverse), its edges given the coedges' p-curves on fc's surface
  // (as OCCT's STEP translator gives them: none on planes; a seam's two, the first for its use that runs forward
  // through the wire as added; then, where every edge has one, each edge's range on the face from its vertices
  // projected; then the translator's checks of them).
  TopoDS_Wire edgeLoop(const TopoDS_Face& fc, const occ::handle<Geom_Surface>& s, int si, bool isPlane, int l,
                       bool reverse)
  {
    BRep_Builder bb;
    TopoDS_Wire  w;
    bb.MakeWire(w);
    const int c0 = r.i32(CBR_LOOP_FIRST)[l], cn = r.i32(CBR_LOOP_COUNT)[l];
    // Each coedge's edge as the wire uses it, and the coedge (edges left out skipped).
    std::vector<TopoDS_Edge> used;
    std::vector<int>         coedge;
    for (int c = c0; c < c0 + cn; ++c)
    {
      const int o = r.u8(CBR_COEDGE_ORIENTATION)[c];
      if (o == CBR_ORIENTATION_INTERNAL || o == CBR_ORIENTATION_EXTERNAL)
        throw Unbuilt{"an internal or external coedge"};
      TopoDS_Edge e = edge(r.i32(CBR_COEDGE_EDGE)[c]);
      if (e.IsNull())
        continue;
      used.push_back(o == CBR_ORIENTATION_REVERSED ? TopoDS::Edge(e.Reversed()) : e);
      coedge.push_back(c);
      bb.Add(w, used.back());
    }
    bool all = true;
    if (!isPlane)
    {
      // An edge's uses by its shape: two in this loop make a seam.
      std::map<const TopoDS_TShape*, std::vector<int>> uses;
      for (int j = 0; j < (int)used.size(); ++j)
        uses[used[j].TShape().get()].push_back(j);
      for (const auto& [tshape, js] : uses)
      {
        std::vector<occ::handle<Geom2d_Curve>> pcs;
        for (int j : js)
        {
          const int pc = r.i32(CBR_COEDGE_PCURVE)[coedge[j]];
          if (pc < 0)
            break;
          pcs.push_back(curve2d(pc, s, si));
        }
        if (pcs.size() < js.size())
        {
          all = false;
          continue;
        }
        TopoDS_Edge e = TopoDS::Edge(used[js[0]].Oriented(TopAbs_FORWARD));
        if (js.size() == 2)
        {
          // The use running forward through the wire as added takes the first.
          const bool firstForward = (used[js[0]].Orientation() == TopAbs_FORWARD) != reverse;
          bb.UpdateEdge(e, firstForward ? pcs[0] : pcs[1], firstForward ? pcs[1] : pcs[0], fc, 0.);
        }
        else
          bb.UpdateEdge(e, pcs[0], fc, 0.);
      }
    }
    else
      all = false;
    w.Closed(true);
    if (all)
      for (TopoDS_Iterator ei(w); ei.More(); ei.Next())
      {
        const TopoDS_Edge& e = TopoDS::Edge(ei.Value());
        if (BRep_Tool::Degenerated(e))
          continue;
        occ::handle<ShapeFix_EdgeProjAux> proj = ShapeAlgo::AlgoContainer()->ToolContainer()->EdgeProjAux();
        proj->Init(fc, e);
        proj->Compute(precision);
        if (proj->IsFirstDone() && proj->IsLastDone())
        {
          if (std::abs(proj->FirstParam() - proj->LastParam()) >= Precision::PConfusion())
            bb.Range(e, fc, proj->FirstParam(), proj->LastParam());
        }
        else
          ShapeBuild_Edge().RemovePCurve(e, fc);
      }
    if (!isPlane)
    {
      // The translator's checks: an empty range dropped, a bounded p-curve's clamped, a range against a periodic u
      // shifted, then XSAlgo's check of the p-curve against the edge.
      occ::handle<ShapeExtend_WireData> wd = new ShapeExtend_WireData(w);
      for (int i = 1; i <= wd->NbEdges(); ++i)
      {
        const TopoDS_Edge&        e = wd->Edge(i);
        occ::handle<Geom2d_Curve> pc;
        double                    w1, w2;
        if (!ShapeAnalysis_Edge().PCurve(e, fc, pc, w1, w2, false))
          continue;
        if (w1 == w2)
        {
          ShapeBuild_Edge().RemovePCurve(e, fc);
          continue;
        }
        if (!pc->IsPeriodic())
        {
          if (w1 < pc->FirstParameter())
            bb.Range(e, fc, w1 = pc->FirstParameter(), w2);
          if (w2 > pc->LastParameter())
            bb.Range(e, fc, w1, w2 = pc->LastParameter());
        }
        if (w1 > w2 && s->IsUPeriodic())
        {
          double u1, u2, v1, v2;
          s->Bounds(u1, u2, v1, v2);
          ElCLib::AdjustPeriodic(u1, u2, std::min(std::abs(w2 - w1) / 2, Precision::PConfusion()), w1, w2);
          bb.Range(e, fc, w1, w2);
        }
        XSAlgo_ShapeProcessor::CheckPCurve(e, fc, precision, wd->IsSeam(i));
      }
    }
    return reverse ? TopoDS::Wire(w.Reversed()) : w;
  }

  // A vertex loop, as OCCT's STEP translator takes one: left out on a plane or a torus; the face's natural bounds on a
  // sphere or B-spline surface where it's the face's only loop; otherwise a degenerate edge at its vertex.
  void vertexLoop(TopoDS_Face& fc, const occ::handle<Geom_Surface>& s, int l, int loops, const std::string& what)
  {
    BRep_Builder bb;
    if (s->IsKind(STANDARD_TYPE(Geom_Plane)) || s->IsKind(STANDARD_TYPE(Geom_ToroidalSurface)))
    {
      out.warnings.push_back(what + ": a vertex loop on a " + (s->IsKind(STANDARD_TYPE(Geom_Plane)) ? "plane" : "torus")
                             + " left out (as OCCT's STEP reader leaves it out)");
      return;
    }
    if ((s->IsKind(STANDARD_TYPE(Geom_SphericalSurface)) || s->IsKind(STANDARD_TYPE(Geom_BSplineSurface)))
        && loops == 1)
    {
      BRepBuilderAPI_MakeFace natural(s, precision);
      for (TopoDS_Iterator wi(natural.Face()); wi.More(); wi.Next())
        bb.Add(fc, wi.Value());
      return;
    }
    const int v = r.i32(CBR_LOOP_FIRST)[l];
    TopoDS_Edge e;
    bb.MakeEdge(e);
    bb.Add(e, vertices[v].Oriented(TopAbs_FORWARD));
    bb.Add(e, vertices[v].Oriented(TopAbs_REVERSED));
    bb.Degenerated(e, true);
    TopoDS_Wire w;
    bb.MakeWire(w);
    w.Closed(true);
    bb.Add(w, e);
    bb.Add(fc, w);
  }

  // A poly loop, as OCCT's STEP translator makes one: a line between each two corners (shared with the faces using the
  // same two vertices, as the translator shares them by point), each with its p-curve on fc's surface from the
  // corners' (u, v). Two corners at one position (one vertex, or two coinciding) make no line.
  TopoDS_Wire polyLoop(const TopoDS_Face& fc, const occ::handle<Geom_Surface>& s, int l)
  {
    BRep_Builder   bb;
    const int      n = r.i32(CBR_LOOP_COUNT)[l];
    const int32_t* corner = r.i32(CBR_POOL_LOOP_INT) + r.i32(CBR_LOOP_FIRST)[l];
    const double*  point = r.f64(CBR_VERTEX_POINT);
    occ::handle<ShapeAnalysis_Surface> sas = new ShapeAnalysis_Surface(s);
    TopoDS_Wire w;
    bb.MakeWire(w);
    for (int i = 0; i < n; ++i)
    {
      const int     ka = corner[i], kb = corner[(i + 1) % n];
      const double *a = point + 3 * ka, *b = point + 3 * kb;
      if (ka == kb || pnt(a).Distance(pnt(b)) == 0.)
        continue;
      TopoDS_Vertex va = vertices[ka], vb = vertices[kb];
      auto          found = polyEdges.find({ka, kb});
      TopoDS_Edge   e;
      if (found == polyEdges.end())
      {
        const gp_Vec d(pnt(a), pnt(b));
        bb.MakeEdge(e, new Geom_Line(pnt(a), gp_Dir(d)), Precision::Confusion());
        bb.Add(e, va.Oriented(TopAbs_FORWARD));
        bb.Add(e, vb.Oriented(TopAbs_REVERSED));
        bb.UpdateVertex(TopoDS::Vertex(va.Oriented(TopAbs_FORWARD)), 0., e, 0.);
        bb.UpdateVertex(TopoDS::Vertex(vb.Oriented(TopAbs_REVERSED)), d.Magnitude(), e, 0.);
      }
      else
      {
        // Seen from its second face the other way round from its first.
        e = found->second;
        if (fc.Orientation() == TopAbs_FORWARD)
          e.Reverse();
      }
      const gp_Pnt2d ua = sas->ValueOfUV(pnt(a), precision), ub = sas->ValueOfUV(pnt(b), precision);
      const bool     fwd = e.Orientation() == TopAbs_FORWARD;
      bb.UpdateEdge(e, new Geom2d_Line(fwd ? ua : ub, gp_Dir2d(fwd ? gp_Vec2d(ua, ub) : gp_Vec2d(ub, ua))), fc, 0.);
      if (found == polyEdges.end())
      {
        // Kept for the pair from either end, as the face orientation turns it.
        TopoDS_Edge seen = e;
        seen.Orientation(fc.Orientation());
        polyEdges.emplace(std::make_pair(ka, kb), seen);
        polyEdges.emplace(std::make_pair(kb, ka), seen);
      }
      bb.Add(w, e);
    }
    w.Closed(BRep_Tool::IsClosed(w));
    return w;
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
    // A wire body: its edges (as the translator makes a wireframe model's), loose.
    TopoDS_Compound c;
    bb.MakeCompound(c);
    for (int j = first; j < first + count; ++j)
    {
      TopoDS_Edge e = edge(r.i32(CBR_MEMBER_REF)[j]);
      if (!e.IsNull())
        bb.Add(c, r.u8(CBR_MEMBER_SENSE)[j] ? e : e.Reversed());
    }
    return c;
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
  out.uncertainty = std::isfinite(unc) && unc > 0 ? unc : NAN;
  if (std::isfinite(out.uncertainty))
    b.precision = out.uncertainty;
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
      const int    kind = b.r.u8(CBR_ITEM_KIND)[i], ref = b.r.i32(CBR_ITEM_REF)[i];
      const uint32_t id = b.r.u32(CBR_ITEM_ID)[i];
      TopoDS_Compound one;
      bb.MakeCompound(one);
      if (kind == CBR_ITEM_CURVE)
      {
        // (An exception from OCCT loses the item alone, as the translator loses a geometric set's element.)
        try
        {
          b.curveItem(ref, id, one);
        }
        catch (const Standard_Failure& e)
        {
          out.warnings.push_back("curve #" + std::to_string(id) + ": OCCT failed on it (" + e.what()
                                 + "); left out");
        }
      }
      else if (kind == CBR_ITEM_POINT)
      {
        // A vertex at the point (as the translator makes a geometric set's).
        TopoDS_Vertex v = BRepBuilderAPI_MakeVertex(pnt(b.r.f64(CBR_POOL_ITEM_REAL) + ref)).Vertex();
        if (id)
          out.pointIds.emplace(v.TShape().get(), id);
        bb.Add(one, v);
      }
      else if (kind == CBR_ITEM_FACE || kind == CBR_ITEM_SURFACE)
      {
        // A geometric set's (as the translator loses an element, an exception from OCCT loses the item alone).
        out.geometricSet = true;
        try
        {
          TopoDS_Face fc = kind == CBR_ITEM_FACE ? b.face(ref) : b.surfaceItem(ref, id);
          if (!fc.IsNull())
            bb.Add(one, fc);
        }
        catch (const Standard_Failure& e)
        {
          out.warnings.push_back(std::string(kind == CBR_ITEM_FACE ? "face #" : "surface #")
                                 + std::to_string(id) + ": OCCT failed on it (" + e.what() + "); left out");
        }
      }
      else
        bb.Add(one, b.body(ref));
      bb.Add(all, one);
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
