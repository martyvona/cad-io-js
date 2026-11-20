// A probe of OCCT's reading of a STEP representation, for checks (corpus_checks/step_roundtrip.ts), not the library:
// built apart by build-probe.sh into dist/occt_probe.mjs. It reads a bare shape representation as occt_tess.cpp does
// (product mode off, the result in the file's length unit) but without shape processing (healing would change the
// geometry compared), keeps each face's and edge's shape by its STEP id, and evaluates their surfaces and curves at
// given parameters: OCCT's points from two files at the same parameters tell whether their geometry is the same,
// whatever OCCT's parameterizations are (they apply to both alike).
//   - Faces: a parameter box on each face's surface, from its vertices projected onto it (the faces of most files have
//     no p-curves, and healing, which adds them, is off), clamped to the surface's own bounds, else those bounds
//     (infinite ones as [-1, 1]).
//   - Edges (and curve items' edges): their 3D curves' ranges, as the translator set them from the vertices; edges
//     without a 3D curve left out.
// occt_probe_build does the same for a part's cad-brep buffer built by the native builder (occt_build.cpp), unhealed,
// its faces and edges by their source ids (corpus_checks/native_route.ts). occt_probe_classify then classifies (u, v)
// points against such faces by OCCT's 2D face classifier (corpus_checks/geom2d_corpus.ts), in OCCT's parameters, and
// occt_probe_pcurve gives an edge's p-curves on such a face (corpus_checks/pcurve_corpus.ts): the built shape's own
// where it has one (the model's, or a plane's computed on request), else made by healing's ShapeFix_Edge.

#include <BRepClass_FaceClassifier.hxx>
#include <BRep_Tool.hxx>
#include <Geom2d_Curve.hxx>
#include <ShapeFix_Edge.hxx>
#include <DESTEP_Parameters.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <Geom_Curve.hxx>
#include <Geom_Surface.hxx>
#include <STEPConstruct_UnitContext.hxx>
#include <STEPControl_Controller.hxx>
#include <STEPControl_Reader.hxx>
#include <ShapeProcess.hxx>
#include <Standard_Failure.hxx>
#include <StepData_Factors.hxx>
#include <StepData_StepModel.hxx>
#include <StepGeom_Curve.hxx>
#include <StepGeom_GeomRepContextAndGlobUnitAssCtxAndGlobUncertaintyAssCtx.hxx>
#include <StepGeom_GeometricRepresentationContextAndGlobalUnitAssignedContext.hxx>
#include <StepGeom_Surface.hxx>
#include <StepRepr_GlobalUnitAssignedContext.hxx>
#include <StepRepr_Representation.hxx>
#include <StepShape_EdgeCurve.hxx>
#include <StepShape_FaceSurface.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Vertex.hxx>
#include <TransferBRep.hxx>
#include <gp_Pnt2d.hxx>
#include <Transfer_TransientProcess.hxx>
#include <XSControl_TransferReader.hxx>
#include <XSControl_WorkSession.hxx>

#include "occt_build.h"

#include <algorithm>
#include <cmath>
#include <istream>
#include <limits>
#include <map>
#include <streambuf>
#include <string>
#include <vector>

namespace
{
struct MemBuf : std::streambuf
{
  MemBuf(const char* p, size_t n) { setg(const_cast<char*>(p), const_cast<char*>(p), const_cast<char*>(p) + n); }
};

struct Probe
{
  // The first face and edge read for each STEP id.
  std::map<uint32_t, TopoDS_Face> faces;
  std::map<uint32_t, TopoDS_Edge> edges;
  std::vector<double>             faceBoxes; // id, u0, u1, v0, v1
  std::vector<double>             edgeRanges; // id, t0, t1
  std::string                     diag;
  // occt_probe_pcurve's route per (face id, edge id), from its first call: a p-curve it adds is the shape's after.
  std::map<std::pair<uint32_t, uint32_t>, int> routes;
};
Probe p;

// Length factor (file unit -> mm) of a representation's context, as occt_tess.cpp computes it.
double contextLengthFactor(const occ::handle<StepRepr_Representation>& rep)
{
  if (rep.IsNull() || rep->ContextOfItems().IsNull())
    return 1.0;
  occ::handle<StepRepr_RepresentationContext> ctx = rep->ContextOfItems();
  occ::handle<StepRepr_GlobalUnitAssignedContext> guac;
  if (auto c = occ::down_cast<StepGeom_GeomRepContextAndGlobUnitAssCtxAndGlobUncertaintyAssCtx>(ctx))
    guac = c->GlobalUnitAssignedContext();
  else if (auto c2 = occ::down_cast<StepGeom_GeometricRepresentationContextAndGlobalUnitAssignedContext>(ctx))
    guac = c2->GlobalUnitAssignedContext();
  if (guac.IsNull())
    return 1.0;
  STEPConstruct_UnitContext uc;
  StepData_Factors          f;
  f.SetCascadeUnit(1.0);
  if (uc.ComputeFactors(guac, f) != 0)
    return 1.0;
  return uc.LengthFactor();
}

const double NaN = std::numeric_limits<double>::quiet_NaN();
double finite(double x) { return std::isfinite(x) && std::abs(x) < 1e100 ? x : (x < 0 ? -1.0 : 1.0); }

// A face's parameter box: its vertices projected onto its surface, clamped to the surface's bounds; else the bounds.
void faceBox(const TopoDS_Face& face, double box[4])
{
  TopLoc_Location            loc;
  occ::handle<Geom_Surface>  s = BRep_Tool::Surface(face, loc);
  double u0, u1, v0, v1;
  s->Bounds(u0, u1, v0, v1);
  double lo[2] = {std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity()};
  double hi[2] = {-lo[0], -lo[1]};
  const gp_Trsf toSurface = loc.Transformation().Inverted();
  for (TopExp_Explorer ex(face, TopAbs_VERTEX); ex.More(); ex.Next())
  {
    gp_Pnt q = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current())).Transformed(toSurface);
    GeomAPI_ProjectPointOnSurf proj(q, s);
    if (!proj.IsDone() || proj.NbPoints() == 0)
      continue;
    double u, v;
    proj.LowerDistanceParameters(u, v);
    lo[0] = std::min(lo[0], u); hi[0] = std::max(hi[0], u);
    lo[1] = std::min(lo[1], v); hi[1] = std::max(hi[1], v);
  }
  if (lo[0] <= hi[0])
  {
    box[0] = std::max(lo[0], u0); box[1] = std::min(hi[0], u1);
    box[2] = std::max(lo[1], v0); box[3] = std::min(hi[1], v1);
  }
  else
  {
    box[0] = finite(u0); box[1] = finite(u1); box[2] = finite(v0); box[3] = finite(v1);
  }
}

// The kept faces' boxes and edges' ranges.
void boxes()
{
  for (const auto& [id, f] : p.faces)
  {
    double b[4];
    try
    {
      faceBox(f, b);
    }
    catch (const Standard_Failure&)
    {
      continue;
    }
    p.faceBoxes.insert(p.faceBoxes.end(), {(double)id, b[0], b[1], b[2], b[3]});
  }
  for (const auto& [id, e] : p.edges)
  {
    double t0, t1;
    if (BRep_Tool::Curve(e, t0, t1).IsNull())
      continue;
    p.edgeRanges.insert(p.edgeRanges.end(), {(double)id, t0, t1});
  }
}
// OCCT's one-time set-up, before either entry point: the native builder needs it too (without it a build traps on
// a null function where a read never ran first).
void initOcct()
{
  static bool inited = false;
  if (!inited)
  {
    STEPControl_Controller::Init();
    inited = true;
  }
}
} // namespace

extern "C"
{
// Reads a bare representation (rootId) and keeps its faces and edges; 0 on success, < 0 on failure.
int occt_probe_read(const char* data, int len, int rootId)
{
  p = Probe();
  initOcct();
  try
  {
    STEPControl_Reader reader;
    DESTEP_Parameters  params;
    params.InitFromStatic();
    params.ReadProductMode = false;
    MemBuf       buf(data, (size_t)len);
    std::istream in(&buf);
    if (reader.ReadStream("probe.stp", params, in) != IFSelect_RetDone)
    {
      p.diag = "read failed";
      return -1;
    }
    occ::handle<StepData_StepModel>      model = reader.StepModel();
    occ::handle<StepRepr_Representation> rootRep;
    const int                            nbEnt = model->NbEntities();
    for (int i = 1; i <= nbEnt && rootRep.IsNull(); ++i)
      if (model->IdentLabel(model->Value(i)) == rootId)
        rootRep = occ::down_cast<StepRepr_Representation>(model->Value(i));
    reader.SetSystemLengthUnit(contextLengthFactor(rootRep));
    // No shape processing: the geometry as the translator made it.
    reader.SetShapeProcessFlags(ShapeProcess::OperationsFlags());
    reader.TransferRoots();
    if (reader.OneShape().IsNull())
    {
      p.diag = "no shape";
      return -2;
    }
    occ::handle<Transfer_TransientProcess> tp = reader.WS()->TransferReader()->TransientProcess();
    for (int i = 1; i <= nbEnt; ++i)
    {
      occ::handle<Standard_Transient> ent = model->Value(i);
      const bool face = ent->IsKind(STANDARD_TYPE(StepShape_FaceSurface))
        || ent->IsKind(STANDARD_TYPE(StepGeom_Surface));
      // (A curve item's: its first edge, as the native builder keeps a composite's.)
      const bool edge = !face && (ent->IsKind(STANDARD_TYPE(StepShape_EdgeCurve))
        || ent->IsKind(STANDARD_TYPE(StepGeom_Curve)));
      if (!face && !edge)
        continue;
      TopoDS_Shape s = TransferBRep::ShapeResult(tp, ent);
      if (s.IsNull())
        continue;
      const uint32_t id = (uint32_t)model->IdentLabel(ent);
      TopExp_Explorer ex(s, face ? TopAbs_FACE : TopAbs_EDGE);
      if (!ex.More())
        continue;
      if (face)
        p.faces.emplace(id, TopoDS::Face(ex.Current()));
      else
        p.edges.emplace(id, TopoDS::Edge(ex.Current()));
    }
    boxes();
    return 0;
  }
  catch (const Standard_Failure& e)
  {
    p.diag = std::string("exception: ") + e.what();
    return -3;
  }
}

// Builds a part's cad-brep buffer (8-byte aligned) by the native builder, unhealed, and keeps its faces and edges by
// their source ids (the first of each); 0 on success, -1 where the builder fails (the reason in the diagnostic).
int occt_probe_build(const uint8_t* buf, int len)
{
  p = Probe();
  initOcct();
  try
  {
    BuiltPart b = buildPart(buf, (size_t)len);
    if (!b.error.empty())
    {
      p.diag = b.error;
      return -1;
    }
    for (TopExp_Explorer ex(b.shape, TopAbs_FACE); ex.More(); ex.Next())
      if (auto it = b.faceIds.find(ex.Current().TShape().get()); it != b.faceIds.end())
        p.faces.emplace(it->second, TopoDS::Face(ex.Current()));
    for (TopExp_Explorer ex(b.shape, TopAbs_EDGE); ex.More(); ex.Next())
      if (auto it = b.edgeIds.find(ex.Current().TShape().get()); it != b.edgeIds.end())
        p.edges.emplace(it->second, TopoDS::Edge(ex.Current()));
    boxes();
    return 0;
  }
  catch (const Standard_Failure& e)
  {
    p.diag = std::string("exception: ") + e.what();
    return -3;
  }
}

const double* occt_probe_faces() { return p.faceBoxes.data(); }
int           occt_probe_num_faces() { return (int)(p.faceBoxes.size() / 5); }
const double* occt_probe_edges() { return p.edgeRanges.data(); }
int           occt_probe_num_edges() { return (int)(p.edgeRanges.size() / 3); }
const char*   occt_probe_diag() { return p.diag.c_str(); }

// Points at parameters: n queries of (kind: 0 face, 1 edge; id; u; v) into out (x, y, z each; NaN where the id isn't
// read, or the evaluation fails).
void occt_probe_eval(const double* queries, int n, double* out)
{
  for (int k = 0; k < n; ++k)
  {
    const double* q   = queries + 4 * k;
    double*       o   = out + 3 * k;
    o[0] = o[1] = o[2] = NaN;
    const uint32_t id = (uint32_t)q[1];
    try
    {
      gp_Pnt pt;
      if (q[0] == 0)
      {
        auto it = p.faces.find(id);
        if (it == p.faces.end())
          continue;
        TopLoc_Location           loc;
        occ::handle<Geom_Surface> s = BRep_Tool::Surface(it->second, loc);
        pt = s->Value(q[2], q[3]).Transformed(loc.Transformation());
      }
      else
      {
        auto it = p.edges.find(id);
        if (it == p.edges.end())
          continue;
        TopLoc_Location         loc;
        double                  t0, t1;
        occ::handle<Geom_Curve> c = BRep_Tool::Curve(it->second, loc, t0, t1);
        if (c.IsNull())
          continue;
        pt = c->Value(q[2]).Transformed(loc.Transformation());
      }
      o[0] = pt.X(); o[1] = pt.Y(); o[2] = pt.Z();
    }
    catch (const Standard_Failure&)
    {
    }
  }
}

// Points against faces: n queries of (id; u; v; tol), (u, v) in OCCT's parameters of the face's surface and tol
// OCCT's 2D tolerance there, into out: 0 in, 1 out, 2 on, 3 unknown (OCCT's TopAbs_State), 255 where the id isn't
// kept or the classifier fails.
void occt_probe_classify(const double* queries, int n, unsigned char* out)
{
  for (int k = 0; k < n; ++k)
  {
    const double* q = queries + 4 * k;
    out[k]          = 255;
    auto it         = p.faces.find((uint32_t)q[0]);
    if (it == p.faces.end())
      continue;
    try
    {
      BRepClass_FaceClassifier c(it->second, gp_Pnt2d(q[1], q[2]), q[3]);
      const TopAbs_State      st = c.State();
      out[k] = st == TopAbs_IN ? 0 : st == TopAbs_OUT ? 1 : st == TopAbs_ON ? 2 : 3;
    }
    catch (const Standard_Failure&)
    {
    }
  }
}

// An edge's p-curves on a face (occt_probe_build's ids), at n parameters of the edge's 3D curve spread over its range
// (midpoints of n equal steps). The face is taken in its surface's sense (oriented forward), so a use oriented
// forward runs with the curve's parameter and has the face on its left in (u, v). info: the uses' count (1, or 2 on a
// seam), each one's orientation (1 forward, 0 reversed), and the route: 0 the shape's own p-curve stored (the
// model's), 1 computed on request (a plane's), 2 added by ShapeFix_Edge::FixAddPCurve at tol, both a seam's at once.
// out: per parameter (t, the curve's point x, y, z), then per use its parameters' (u, v, the distance from the surface
// there to the curve's point) and its (u, v) at its p-curve's first and last parameters (where its loop's neighbours
// join it: 4). 0, or -1 the ids not kept, -2 no p-curve made, -3 an exception.
int occt_probe_pcurve(int faceId, int edgeId, double tol, int n, double* out, double* info)
{
  info[0] = 0;
  info[1] = info[2] = 0;
  info[3] = -1;
  auto fi = p.faces.find((uint32_t)faceId);
  auto ei = p.edges.find((uint32_t)edgeId);
  if (fi == p.faces.end() || ei == p.edges.end())
    return -1;
  try
  {
    const TopoDS_Face face = TopoDS::Face(fi->second.Oriented(TopAbs_FORWARD));
    std::vector<TopoDS_Edge> uses;
    for (TopExp_Explorer ex(face, TopAbs_EDGE); ex.More(); ex.Next())
      if (ex.Current().TShape() == ei->second.TShape())
        uses.push_back(TopoDS::Edge(ex.Current()));
    if (uses.empty() || uses.size() > 2)
      return -1;
    const auto key = std::make_pair((uint32_t)faceId, (uint32_t)edgeId);
    auto       ri  = p.routes.find(key);
    if (ri == p.routes.end())
    {
      double a, b;
      bool   stored = false;
      int    route  = -1;
      if (!BRep_Tool::CurveOnSurface(uses[0], face, a, b, &stored).IsNull())
        route = stored ? 0 : 1;
      else
      {
        ShapeFix_Edge fix;
        fix.FixAddPCurve(uses[0], face, uses.size() == 2, tol);
        if (!BRep_Tool::CurveOnSurface(uses[0], face, a, b).IsNull())
          route = 2;
      }
      ri = p.routes.emplace(key, route).first;
    }
    info[3] = ri->second;
    if (ri->second < 0)
      return -2;
    TopLoc_Location         cloc, sloc;
    double                  t0, t1;
    occ::handle<Geom_Curve> c = BRep_Tool::Curve(uses[0], cloc, t0, t1);
    if (c.IsNull())
      return -2;
    occ::handle<Geom_Surface> s = BRep_Tool::Surface(face, sloc);
    info[0]                     = (int)uses.size();
    std::vector<gp_Pnt> points;
    for (int i = 0; i < n; ++i)
    {
      const double t = t0 + (t1 - t0) * (i + 0.5) / n;
      points.push_back(c->Value(t).Transformed(cloc.Transformation()));
      out[4 * i] = t;
      out[4 * i + 1] = points.back().X(), out[4 * i + 2] = points.back().Y(), out[4 * i + 3] = points.back().Z();
    }
    for (size_t k = 0; k < uses.size(); ++k)
    {
      info[1 + k] = uses[k].Orientation() == TopAbs_FORWARD ? 1 : 0;
      double                    a, b;
      occ::handle<Geom2d_Curve> pc = BRep_Tool::CurveOnSurface(uses[k], face, a, b);
      double*                   o  = out + 4 * n + (3 * n + 4) * k;
      for (int j = 0; j < 4; ++j)
        o[3 * n + j] = NaN;
      if (!pc.IsNull())
      {
        const gp_Pnt2d qa = pc->Value(a), qb = pc->Value(b);
        o[3 * n] = qa.X(), o[3 * n + 1] = qa.Y(), o[3 * n + 2] = qb.X(), o[3 * n + 3] = qb.Y();
      }
      for (int i = 0; i < n; ++i)
      {
        o[3 * i] = o[3 * i + 1] = o[3 * i + 2] = NaN;
        if (pc.IsNull())
          continue;
        const gp_Pnt2d q = pc->Value(out[4 * i]);
        const gp_Pnt   x = s->Value(q.X(), q.Y()).Transformed(sloc.Transformation());
        const gp_Pnt& y = points[i];
        o[3 * i] = q.X(), o[3 * i + 1] = q.Y(), o[3 * i + 2] = std::hypot(x.X() - y.X(), x.Y() - y.Y(), x.Z() - y.Z());
      }
    }
    return 0;
  }
  catch (const Standard_Failure&)
  {
    return -3;
  }
}

void occt_probe_free() { p = Probe(); }
}
