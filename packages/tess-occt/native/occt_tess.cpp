// The OCCT tessellation backend: tessellates one STEP subset (docs/architecture.md, "The tessellator interface"),
// with per-face and per-edge STEP entity ids. Grown from the phase 0 spike (phase0_tessellation_spike/occt_tess).
// Exposes a small C ABI; the JS side (src/index.ts) copies the results out of the heap.
//
// Coordinates are in the file's units (the root representation's), minus the request's origin, which is subtracted
// in double precision before the conversion to float (docs/phase2_progress.md, decision 3).
#include <BRepLib_ToolTriangulatedShape.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <DESTEP_Parameters.hxx>
#include <DE_ShapeFixParameters.hxx>
#include <IMeshTools_Parameters.hxx>
#include <BRep_Tool.hxx>
#include <Interface_Static.hxx>
#include <Poly_Polygon3D.hxx>
#include <Poly_PolygonOnTriangulation.hxx>
#include <Poly_Triangulation.hxx>
#include <STEPConstruct_UnitContext.hxx>
#include <STEPControl_Controller.hxx>
#include <STEPControl_Reader.hxx>
#include <StepData_Factors.hxx>
#include <StepData_StepModel.hxx>
#include <StepGeom_GeomRepContextAndGlobUnitAssCtxAndGlobUncertaintyAssCtx.hxx>
#include <StepGeom_GeometricRepresentationContextAndGlobalUnitAssignedContext.hxx>
#include <StepGeom_Surface.hxx>
#include <StepRepr_GlobalUnitAssignedContext.hxx>
#include <StepRepr_Representation.hxx>
#include <StepShape_EdgeCurve.hxx>
#include <StepShape_FaceSurface.hxx>
#include <StepShape_GeometricallyBoundedSurfaceShapeRepresentation.hxx>
#include <TopExp.hxx>
#include <TopoDS_Vertex.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TransferBRep.hxx>
#include <Transfer_TransientProcess.hxx>
#include <XSControl_TransferReader.hxx>
#include <XSControl_WorkSession.hxx>

#include <cmath>
#include <cstdint>
#include <istream>
#include <streambuf>
#include <string>
#include <unordered_map>
#include <vector>

namespace
{
struct MemBuf : std::streambuf
{
  MemBuf(const char* p, size_t n) { setg(const_cast<char*>(p), const_cast<char*>(p), const_cast<char*>(p) + n); }
};

struct Result
{
  std::vector<float>    positions, normals;
  std::vector<uint32_t> indices;
  std::vector<int32_t>  faces; // triples: entityId (-1 = unknown), first index, index count
  std::vector<float>    edgePositions;
  std::vector<int32_t>  edges;      // quads: entityId (-1 = unknown), first point, point count, kind
  std::vector<float>    edgeAngles; // max angle (radians) between adjacent face normals along the edge; -1 if n/a
  std::string           diag;  // JSON object text
};
Result g;

struct MeshOptions
{
  int    algo          = -1; // IMeshTools_MeshAlgoType: -1 default (Watson), 0 Watson, 1 Delabella
  bool   adjustMinSize = false;
  double minSize       = 0.0; // <= 0: OCCT default (derived from deflection)
  bool   controlSurfaceDeflection = true;
};
MeshOptions gMesh;

// Length factor (file unit -> mm) of a representation's context, computed the way STEPControl_ActorRead does.
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
} // namespace

extern "C"
{
// Returns 0 on success, <0 on failure. rootId <= 0: let OCCT choose roots. (ox, oy, oz): the origin to subtract.
int occt_tessellate(const char* data, int len, int rootId, double linDefl, double angDefl, int productMode,
                    double ox, double oy, double oz)
{
  g = Result();
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
    params.ReadProductMode = productMode != 0;
    MemBuf       buf(data, (size_t)len);
    std::istream in(&buf);
    if (reader.ReadStream("subset.stp", params, in) != IFSelect_RetDone)
    {
      g.diag = "{\"error\":\"read failed\"}";
      return -1;
    }
    occ::handle<StepData_StepModel> model = reader.StepModel();

    // locate the root representation (for units) by its #label
    occ::handle<StepRepr_Representation> rootRep;
    const int nbEnt = model->NbEntities();
    if (rootId > 0)
      for (int i = 1; i <= nbEnt && rootRep.IsNull(); ++i)
        if (model->IdentLabel(model->Value(i)) == rootId)
          rootRep = occ::down_cast<StepRepr_Representation>(model->Value(i));
    const double unitMm = contextLengthFactor(rootRep);
    reader.SetSystemLengthUnit(unitMm); // output in file units

    // A geometric set's curve-bounded surfaces on closed surfaces (spheres, tori): a lone boundary that OCCT doesn't
    // classify as outer is reversed, as OCCT 7.6 did, rather than kept as a hole in the natural bounds (OCCT 8), which
    // gives the rest of the surface. Other writers' copies of the same models agree with 7.6
    // (docs/phase3_progress.md, step 5); for faces (topology) OCCT 8's reading is right (its tests bug28414, bug29564).
    if (occ::down_cast<StepShape_GeometricallyBoundedSurfaceShapeRepresentation>(rootRep))
    {
      DE_ShapeFixParameters fix  = DESTEP_Parameters::GetDefaultShapeFixParameters();
      fix.FixAddNaturalBoundMode = DE_ShapeFixParameters::FixMode::NotFix;
      reader.SetShapeFixParameters(fix);
    }
    const int nbRoots = reader.NbRootsForTransfer();
    reader.TransferRoots();
    TopoDS_Shape shape = reader.OneShape();
    if (shape.IsNull())
    {
      g.diag = "{\"error\":\"no shape\",\"roots\":" + std::to_string(nbRoots) + "}";
      return -2;
    }

    // face/edge TShape -> STEP entity label, from the transfer bindings (updated with shape-fix history)
    occ::handle<Transfer_TransientProcess> tp = reader.WS()->TransferReader()->TransientProcess();
    std::unordered_map<const TopoDS_TShape*, int> faceIds, edgeIds;
    int stepFaces = 0, stepEdges = 0;
    for (int i = 1; i <= nbEnt; ++i)
    {
      occ::handle<Standard_Transient> ent = model->Value(i);
      const bool isFace = ent->IsKind(STANDARD_TYPE(StepShape_FaceSurface));
      const bool isEdge = !isFace && ent->IsKind(STANDARD_TYPE(StepShape_EdgeCurve));
      if (!isFace && !isEdge)
        continue;
      ++(isFace ? stepFaces : stepEdges);
      TopoDS_Shape s = TransferBRep::ShapeResult(tp, ent);
      if (s.IsNull())
        continue;
      for (TopExp_Explorer ex(s, isFace ? TopAbs_FACE : TopAbs_EDGE); ex.More(); ex.Next())
        (isFace ? faceIds : edgeIds).emplace(ex.Current().TShape().get(), model->IdentLabel(ent));
    }
    // Faces made from a geometric set's surfaces (GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION): OCCT binds each
    // element's shape to it. After the faces, so that a face entity's id wins.
    for (int i = 1; i <= nbEnt; ++i)
    {
      occ::handle<Standard_Transient> ent = model->Value(i);
      if (!ent->IsKind(STANDARD_TYPE(StepGeom_Surface)))
        continue;
      TopoDS_Shape s = TransferBRep::ShapeResult(tp, ent);
      if (s.IsNull())
        continue;
      for (TopExp_Explorer ex(s, TopAbs_FACE); ex.More(); ex.Next())
        faceIds.emplace(ex.Current().TShape().get(), model->IdentLabel(ent));
    }

    IMeshTools_Parameters mp;
    mp.Deflection               = linDefl;
    mp.Angle                    = angDefl;
    mp.InParallel               = false;
    mp.MeshAlgo                 = (IMeshTools_MeshAlgoType)gMesh.algo;
    mp.AdjustMinSize            = gMesh.adjustMinSize;
    mp.ControlSurfaceDeflection = gMesh.controlSurfaceDeflection;
    if (gMesh.minSize > 0.0)
      mp.MinSize = gMesh.minSize;
    BRepMesh_IncrementalMesh mesher(shape, mp);

    int nFaces = 0, unmapped = 0, noTri = 0;
    for (TopExp_Explorer ex(shape, TopAbs_FACE); ex.More(); ex.Next())
    {
      const TopoDS_Face& face = TopoDS::Face(ex.Current());
      ++nFaces;
      auto it = faceIds.find(face.TShape().get());
      const int id = it == faceIds.end() ? -1 : it->second;
      if (id < 0)
        ++unmapped;
      TopLoc_Location                 loc;
      occ::handle<Poly_Triangulation> tri = BRep_Tool::Triangulation(face, loc);
      const uint32_t first = (uint32_t)g.indices.size();
      if (tri.IsNull() || tri->NbTriangles() == 0)
      {
        ++noTri;
        g.faces.insert(g.faces.end(), {id, (int32_t)first, 0});
        continue;
      }
      if (!tri->HasNormals())
        BRepLib_ToolTriangulatedShape::ComputeNormals(face, tri);
      const gp_Trsf  trsf     = loc.Transformation();
      const bool     reversed = face.Orientation() == TopAbs_REVERSED;
      const uint32_t base     = (uint32_t)(g.positions.size() / 3);
      for (int n = 1; n <= tri->NbNodes(); ++n)
      {
        gp_Pnt p = tri->Node(n).Transformed(trsf);
        g.positions.insert(g.positions.end(), {(float)(p.X() - ox), (float)(p.Y() - oy), (float)(p.Z() - oz)});
        gp_Dir d = tri->Normal(n);
        d.Transform(trsf);
        if (reversed)
          d.Reverse();
        g.normals.insert(g.normals.end(), {(float)d.X(), (float)d.Y(), (float)d.Z()});
      }
      for (int t = 1; t <= tri->NbTriangles(); ++t)
      {
        int a, b, c;
        tri->Triangle(t).Get(a, b, c);
        if (reversed)
          std::swap(b, c);
        g.indices.insert(g.indices.end(), {base + a - 1, base + b - 1, base + c - 1});
      }
      g.faces.insert(g.faces.end(), {id, (int32_t)first, (int32_t)(g.indices.size() - first)});
    }
    // edges: one polyline per topological edge, taken from a face triangulation so points coincide with mesh vertices
    NCollection_IndexedDataMap<TopoDS_Shape, NCollection_List<TopoDS_Shape>, TopTools_ShapeMapHasher> edgeFaces;
    TopExp::MapShapesAndUniqueAncestors(shape, TopAbs_EDGE, TopAbs_FACE, edgeFaces);
    int edgesUnmapped = 0, edgesNoPolygon = 0;
    for (int ie = 1; ie <= edgeFaces.Extent(); ++ie)
    {
      const TopoDS_Edge& edge   = TopoDS::Edge(edgeFaces.FindKey(ie));
      const auto&        adj    = edgeFaces.FindFromIndex(ie);
      auto               itId   = edgeIds.find(edge.TShape().get());
      const int          id     = itId == edgeIds.end() ? -1 : itId->second;
      if (id < 0)
        ++edgesUnmapped;
      // kind: 0 shared (2+ faces), 1 seam (closed on its face), 2 free (one face), 3 degenerate
      int kind = adj.Extent() >= 2 ? 0 : 2;
      if (BRep_Tool::Degenerated(edge))
        kind = 3;
      else if (adj.Extent() == 1 && BRep_Tool::IsClosed(edge, TopoDS::Face(adj.First())))
        kind = 1;

      // per adjacent face: its polygon on the face triangulation (node indices) + triangulation
      struct OnFace
      {
        occ::handle<Poly_Triangulation>          tri;
        occ::handle<Poly_PolygonOnTriangulation> poly;
        TopLoc_Location                          loc;
        bool                                     reversed;
      };
      std::vector<OnFace> on;
      for (const TopoDS_Shape& fs : adj)
      {
        const TopoDS_Face& f = TopoDS::Face(fs);
        OnFace             o;
        o.tri = BRep_Tool::Triangulation(f, o.loc);
        if (o.tri.IsNull())
          continue;
        o.poly = BRep_Tool::PolygonOnTriangulation(edge, o.tri, o.loc);
        if (o.poly.IsNull())
          continue;
        o.reversed = f.Orientation() == TopAbs_REVERSED;
        on.push_back(o);
      }
      const uint32_t first = (uint32_t)(g.edgePositions.size() / 3);
      float          angle = -1.f;
      if (!on.empty())
      {
        const OnFace& o0   = on[0];
        const gp_Trsf trsf = o0.loc.Transformation();
        for (int k = 1; k <= o0.poly->NbNodes(); ++k)
        {
          gp_Pnt p = o0.tri->Node(o0.poly->Node(k)).Transformed(trsf);
          g.edgePositions.insert(g.edgePositions.end(), {(float)(p.X() - ox), (float)(p.Y() - oy), (float)(p.Z() - oz)});
        }
        if (kind == 0 && on.size() >= 2 && on[1].poly->NbNodes() == o0.poly->NbNodes() && o0.tri->HasNormals()
            && on[1].tri->HasNormals())
        {
          double maxA = 0.0;
          for (int k = 1; k <= o0.poly->NbNodes(); ++k)
          {
            gp_Dir n0 = o0.tri->Normal(o0.poly->Node(k));
            gp_Dir n1 = on[1].tri->Normal(on[1].poly->Node(k));
            n0.Transform(o0.loc.Transformation());
            n1.Transform(on[1].loc.Transformation());
            if (o0.reversed)
              n0.Reverse();
            if (on[1].reversed)
              n1.Reverse();
            maxA = std::max(maxA, n0.Angle(n1));
          }
          angle = (float)maxA;
        }
      }
      else
      {
        // no polygon on any triangulation (e.g. faces that failed to mesh): fall back to the 3D polygon.
        // All kinds are kept, degenerate ones included: whether to draw them is the renderer's decision.
        TopLoc_Location                    l3;
        const occ::handle<Poly_Polygon3D>& p3 = BRep_Tool::Polygon3D(edge, l3);
        if (!p3.IsNull())
          for (int k = 1; k <= p3->NbNodes(); ++k)
          {
            gp_Pnt p = p3->Nodes().Value(k).Transformed(l3.Transformation());
            g.edgePositions.insert(g.edgePositions.end(), {(float)(p.X() - ox), (float)(p.Y() - oy), (float)(p.Z() - oz)});
          }
      }
      if (g.edgePositions.size() / 3 == first && kind == 3)
      {
        // degenerate edge without any polygon: emit its (single) vertex so it still has a location
        const TopoDS_Vertex v = TopExp::FirstVertex(edge);
        if (!v.IsNull())
        {
          const gp_Pnt p = BRep_Tool::Pnt(v);
          g.edgePositions.insert(g.edgePositions.end(), {(float)(p.X() - ox), (float)(p.Y() - oy), (float)(p.Z() - oz)});
        }
      }
      const int32_t count = (int32_t)(g.edgePositions.size() / 3 - first);
      if (count == 0)
        ++edgesNoPolygon;
      g.edges.insert(g.edges.end(), {id, (int32_t)first, count, kind});
      g.edgeAngles.push_back(angle);
    }

    g.diag = "{\"roots\":" + std::to_string(nbRoots) + ",\"stepFaces\":" + std::to_string(stepFaces)
             + ",\"faces\":" + std::to_string(nFaces) + ",\"unmapped\":" + std::to_string(unmapped)
             + ",\"noTriangulation\":" + std::to_string(noTri) + ",\"stepEdges\":" + std::to_string(stepEdges)
             + ",\"edges\":" + std::to_string(edgeFaces.Extent()) + ",\"edgesUnmapped\":" + std::to_string(edgesUnmapped)
             + ",\"edgesNoPolygon\":" + std::to_string(edgesNoPolygon) + ",\"unitMm\":" + std::to_string(unitMm) + "}";
    return 0;
  }
  catch (const Standard_Failure& e)
  {
    g.diag = std::string("{\"error\":\"Standard_Failure\",\"what\":\"") + e.what() + "\"}";
    return -3;
  }
  catch (...)
  {
    g.diag = "{\"error\":\"unknown exception\"}";
    return -4;
  }
}

void occt_set_mesh_options(int algo, int adjustMinSize, double minSize, int controlSurfaceDeflection)
{
  gMesh.algo                     = algo;
  gMesh.adjustMinSize            = adjustMinSize != 0;
  gMesh.minSize                  = minSize;
  gMesh.controlSurfaceDeflection = controlSurfaceDeflection != 0;
}

const float*    occt_positions() { return g.positions.data(); }
const float*    occt_normals() { return g.normals.data(); }
int             occt_num_vertices() { return (int)(g.positions.size() / 3); }
const uint32_t* occt_indices() { return g.indices.data(); }
int             occt_num_indices() { return (int)g.indices.size(); }
const int32_t*  occt_faces() { return g.faces.data(); }
int             occt_num_faces() { return (int)(g.faces.size() / 3); }
const float*    occt_edge_positions() { return g.edgePositions.data(); }
int             occt_num_edge_points() { return (int)(g.edgePositions.size() / 3); }
const int32_t*  occt_edges() { return g.edges.data(); }
const float*    occt_edge_angles() { return g.edgeAngles.data(); }
int             occt_num_edges() { return (int)g.edgeAngles.size(); }
const char*     occt_diag() { return g.diag.c_str(); }
void            occt_free() { g = Result(); }
}
