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
// its faces and edges by their source ids (corpus_checks/native_route.ts).

#include <BRep_Tool.hxx>
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
  std::map<int, TopoDS_Face> faces;
  std::map<int, TopoDS_Edge> edges;
  std::vector<double>        faceBoxes; // id, u0, u1, v0, v1
  std::vector<double>        edgeRanges; // id, t0, t1
  std::string                diag;
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
} // namespace

extern "C"
{
// Reads a bare representation (rootId) and keeps its faces and edges; 0 on success, < 0 on failure.
int occt_probe_read(const char* data, int len, int rootId)
{
  p = Probe();
  static bool inited = false;
  if (!inited)
  {
    STEPControl_Controller::Init();
    inited = true;
  }
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
      const int id = model->IdentLabel(ent);
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
    const int id = (int)q[1];
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

void occt_probe_free() { p = Probe(); }
}
