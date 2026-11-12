// The SMLib tessellation backend: one part's cad-brep buffer built into SMLib B-reps (smlib_build.cpp), healed and
// meshed by SMLib's tessellator (SmApiTessellate), with per-face and per-edge ids. Exposes a small C ABI; the JS side
// (src/index.ts) copies the results out of the heap.
//
// Coordinates are in the part's unit, minus the request's origin, subtracted in double precision before the conversion
// to float (docs/backends.md).
#include "smlib_build.h"

#include "SmApiBrep.h"
#include "SmAttribute.h"
#include "SmApiGeneral.h"
#include "SmApiQueries.h"
#include "SmBrep.h"
#include "SmEdge.h"
#include "SmEdgeuse.h"
#include "SmFace.h"
#include "SmPoly.h"

#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <algorithm>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

namespace
{
const double DEG = 180.0 / 3.14159265358979323846;

struct Result
{
  std::vector<float> positions, normals;
  std::vector<uint32_t> indices;
  std::vector<int32_t> faces; // triples: entityId (-1 = unknown), first index, index count
  std::vector<float> edgePositions;
  std::vector<int32_t> edges;      // quads: entityId (-1 = unknown), first point, point count, kind
  std::vector<float> edgeAngles;   // max angle (radians) between adjacent face normals along the edge; -1 if n/a
  std::vector<double> measures;    // quads: entityId, area, perimeter, valid (1 or 0)
  std::vector<float> curvePositions;
  std::vector<int32_t> curves;     // triples: entityId (-1 = unknown), first point, point count
  std::vector<float> points;
  std::vector<int32_t> pointIds;   // -1 = unknown
  std::string diag;                // JSON object text
};
Result g;
bool gMeasures = false, gHeal = true, gEdges = false;

// One model edge's mesh: its poly segments (ends as transformed points, and each side face's oriented normal at them).
struct EdgeMesh
{
  int32_t id = -1;
  int kind = 0; // 0 shared, 1 seam, 2 free, 3 degenerate
  std::map<std::pair<SmPolyVertex*, SmPolyVertex*>, int> segments;
  std::unordered_map<SmPolyVertex*, std::array<double, 3>> points;
  std::unordered_map<SmPolyVertex*, std::vector<std::array<double, 3>>> normals;
};

double now()
{
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

std::string jsonEscape(const std::string& t)
{
  std::string o;
  for (char c : t)
  {
    if (c == '"' || c == '\\')
      o += '\\', o += c;
    else if ((unsigned char)c < 0x20)
      o += ' ';
    else
      o += c;
  }
  return o;
}

int32_t idOf(const std::vector<double>& ids, long row)
{
  if (row < 0 || row >= (long)ids.size() || !std::isfinite(ids[row])) return -1;
  return (int32_t)ids[row];
}

// An item's transform (12 reals, column-major) on a point and on a normal (by the inverse transpose, up to scale).
struct Transform
{
  const std::vector<double>* t = nullptr;
  double inv[9] = {};
  bool mirrored = false;
  explicit Transform(const std::vector<double>& m)
  {
    if (m.size() != 12) return;
    t = &m;
    const double* a = m.data();
    // Cofactors of the 3x3 (column-major a[c*3 + r]): the inverse transpose up to the determinant's scale.
    auto at = [&](int r, int c) { return a[c * 3 + r]; };
    double det = at(0, 0) * (at(1, 1) * at(2, 2) - at(1, 2) * at(2, 1))
      - at(0, 1) * (at(1, 0) * at(2, 2) - at(1, 2) * at(2, 0))
      + at(0, 2) * (at(1, 0) * at(2, 1) - at(1, 1) * at(2, 0));
    mirrored = det < 0;
    for (int r = 0; r < 3; r++)
      for (int c = 0; c < 3; c++)
      {
        int r1 = (r + 1) % 3, r2 = (r + 2) % 3, c1 = (c + 1) % 3, c2 = (c + 2) % 3;
        inv[r * 3 + c] = at(r1, c1) * at(r2, c2) - at(r1, c2) * at(r2, c1);
      }
    if (det < 0)
      for (double& x : inv) x = -x;
  }
  void point(double p[3]) const
  {
    if (!t) return;
    const double* a = t->data();
    double q[3];
    for (int r = 0; r < 3; r++) q[r] = a[r] * p[0] + a[3 + r] * p[1] + a[6 + r] * p[2] + a[9 + r];
    std::memcpy(p, q, sizeof q);
  }
  void normal(double n[3]) const
  {
    if (!t) return;
    double q[3];
    for (int r = 0; r < 3; r++) q[r] = inv[r * 3] * n[0] + inv[r * 3 + 1] * n[1] + inv[r * 3 + 2] * n[2];
    double l = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]);
    for (int r = 0; r < 3; r++) n[r] = l > 0 ? q[r] / l : 0;
  }
};

// Triangles of one model face, gathered over the B-reps (a face meshed in several shells is meshed in each).
struct FaceMesh
{
  std::vector<double> pos, nrm;
  std::vector<uint32_t> tri;
};

// One face's judgement after meshing: its mesh's area (in the B-rep's own coordinates), its exact area and perimeter,
// and its polygons.
struct Judged
{
  long row = -1;
  double area = 0, exact = NAN, perimeter = 0;
  int polygons = 0;
};

// How far a face's mesh is from its exact area beyond what the deflection allows, by faceFailures' rules (cad-scene's
// mesh.ts): 0 within them; else the area missing or in excess.
double badness(const Judged& j, double lin)
{
  if (!std::isfinite(j.exact) || !(j.exact > 0)) return 0;
  if (j.polygons == 0) return j.exact > lin * lin ? j.exact : 0;
  double d = j.area - j.exact, slack = lin * j.perimeter;
  if (-d > std::max(0.03 * j.exact, slack)) return -d;
  if (d > std::max(0.10 * j.exact, slack)) return d;
  return 0;
}

// A B-rep meshed: its poly B-rep (null where SMLib made none) and each face's judgement.
struct Meshed
{
  SmPolyBrep* poly = nullptr;
  std::unordered_map<SmFace*, Judged> faces;
  ~Meshed() { delete poly; }
};

struct Stats
{
  int polygons = 0, faces = 0, tessErrors = 0, retried = 0, improved = 0;
  double msMeasures = 0, msTessellate = 0;
  std::string firstError;
};

void tessellate(BuiltBrep& b, double linDefl, double angDefl, Meshed& out, Stats& st)
{
  SmTArray<SmFace*> smFaces;
  SmApiGetFaces(b.brep, smFaces);
  st.faces += (int)smFaces.GetSize();
  double t0 = now();
  // Exact areas and perimeters (to the measures' accuracy when asked for, else enough to judge by).
  for (ULONG i = 0; i < smFaces.GetSize(); i++)
  {
    Judged& j = out.faces[smFaces[i]];
    j.row = (long)smFaces[i]->GetUserIndex1() - 1;
    double area = NAN;
    if (SmApiFaceComputeArea(smFaces[i], gMeasures ? 1e-6 : 1e-3, area) == SM_SUCCESS && std::isfinite(area))
      j.exact = area;
    SmTArray<ULONG> counts;
    SmTArray<SmEdge*> edges;
    SmTArray<SmOrientType> orientations;
    if (SmApiFaceGetBoundaryLoops(smFaces[i], counts, edges, orientations) == SM_SUCCESS)
      for (ULONG k = 0; k < edges.GetSize(); k++)
      {
        double len = 0;
        if (SmApiEdgeComputeLength(edges[k], 1e-6, len) == SM_SUCCESS) j.perimeter += len;
      }
  }
  st.msMeasures += now() - t0;
  SmTessellationParams p;
  p.dChordHeightTol = linDefl;
  p.dCurveAngleTolDeg = angDefl * DEG;
  p.dSurfaceAngleTolDeg = angDefl * DEG;
  SmTArray<SmTessellationFailure> fails;
  t0 = now();
  SmApiStatus status = SmApiTessellate(b.brep, out.poly, p, TRUE, &fails);
  st.msTessellate += now() - t0;
  if (status != SM_SUCCESS)
  {
    st.tessErrors++;
    if (st.firstError.empty()) st.firstError = "SmApiTessellate status " + std::to_string((int)status);
  }
  if (!out.poly) return;
  SmTArray<SmPolyFace*> pfs;
  out.poly->GetPolyFaces(pfs);
  SmTArray<SmPolyEdge*> pes;
  for (ULONG k = 0; k < pfs.GetSize(); k++)
  {
    auto it = out.faces.find(pfs[k]->GetOriginalFace());
    SmPolyLoop* loop = pfs[k]->GetOuterPolyLoop();
    if (it == out.faces.end() || !loop) continue;
    loop->GetPolyEdges(pes);
    ULONG n = pes.GetSize();
    if (n < 3) continue;
    SmPoint3d o = pes[0]->GetStartPolyVertex()->GetPoint();
    for (ULONG j = 1; j + 1 < n; j++)
    {
      SmVector3d u = pes[j]->GetStartPolyVertex()->GetPoint() - o, v = pes[j + 1]->GetStartPolyVertex()->GetPoint() - o;
      it->second.area += (u * v).Length() / 2;
    }
    it->second.polygons++;
  }
}

// The polygons of a meshed B-rep's chosen faces into the face meshes (by face row) and, when asked, their edges.
void emit(BuiltPart& part, BuiltBrep& b, Meshed& mb, const std::set<SmFace*>& chosen, std::map<long, FaceMesh>& meshes,
  double ox, double oy, double oz, Stats& st)
{
  if (!mb.poly) return;
  Transform tr(b.transform);
  SmTArray<SmPolyFace*> pfs;
  mb.poly->GetPolyFaces(pfs);
  std::unordered_map<long, EdgeMesh> edgeMeshes;
  SmTArray<SmPolyEdge*> pes;
  // Each face's poly vertices, by vertex, as indices into its mesh.
  std::map<long, std::unordered_map<SmPolyVertex*, uint32_t>> local;
  for (ULONG k = 0; k < pfs.GetSize(); k++)
  {
    SmFace* of = pfs[k]->GetOriginalFace();
    if (!chosen.count(of)) continue;
    long row = (long)of->GetUserIndex1() - 1;
    SmPolyLoop* loop = pfs[k]->GetOuterPolyLoop();
    if (!loop) continue;
    loop->GetPolyEdges(pes);
    ULONG n = pes.GetSize();
    if (n < 3) continue;
    st.polygons++;
    FaceMesh& fm = meshes[row];
    auto& lv = local[row];
    // Normals turned over with the face (the transform's own handles mirrors); the winding also by a mirror.
    bool rev = b.reverse.count(of) != 0, flip = rev != tr.mirrored;
    std::vector<uint32_t> ring;
    for (ULONG j = 0; j < n; j++)
    {
      SmPolyVertex* v = pes[j]->GetStartPolyVertex();
      auto it = lv.find(v);
      if (it == lv.end())
      {
        double q[3] = {v->GetPoint().x, v->GetPoint().y, v->GetPoint().z};
        tr.point(q);
        double nn[3] = {0, 0, 0};
        auto& fsr = v->GetFacesRef();
        auto& nsr = v->GetNormalsRef();
        for (ULONG f = 0; f < fsr.GetSize() && f < nsr.GetSize(); f++)
          if (fsr[f] == of)
          {
            nn[0] = nsr[f].x, nn[1] = nsr[f].y, nn[2] = nsr[f].z;
            break;
          }
        if (rev)
          for (double& c : nn) c = -c;
        tr.normal(nn);
        uint32_t idx = (uint32_t)(fm.pos.size() / 3);
        fm.pos.insert(fm.pos.end(), {q[0] - ox, q[1] - oy, q[2] - oz});
        fm.nrm.insert(fm.nrm.end(), {nn[0], nn[1], nn[2]});
        it = lv.emplace(v, idx).first;
      }
      ring.push_back(it->second);
    }
    if (gEdges)
      for (ULONG j = 0; j < n; j++)
      {
        auto* tag = SM_CAST_PTR(SmLongAttribute, pes[j]->FindAttribute(SM_AI_EDGE_ID));
        if (!tag) continue;
        long e = tag->GetValue();
        SmPolyVertex *a = pes[j]->GetStartPolyVertex(), *z = pes[(j + 1) % n]->GetStartPolyVertex();
        EdgeMesh& em = edgeMeshes[e];
        em.segments[{std::min(a, z), std::max(a, z)}]++;
        for (SmPolyVertex* v : {a, z})
        {
          uint32_t k = lv[v];
          em.points[v] = {fm.pos[3 * k], fm.pos[3 * k + 1], fm.pos[3 * k + 2]};
          em.normals[v].push_back({fm.nrm[3 * k], fm.nrm[3 * k + 1], fm.nrm[3 * k + 2]});
        }
      }
    for (size_t j = 1; j + 1 < ring.size(); j++)
    {
      if (flip) fm.tri.insert(fm.tri.end(), {ring[0], ring[j + 1], ring[j]});
      else fm.tri.insert(fm.tri.end(), {ring[0], ring[j], ring[j + 1]});
    }
  }
  // Each edge's segments chained into polylines (an edge SMLib split, or meshed apart in pieces, gives several).
  for (auto& [e, em] : edgeMeshes)
  {
    long row = e / 4 - 1;
    int32_t id = idOf(part.edgeIds, row);
    int kind = (int)(e % 4);
    std::unordered_map<SmPolyVertex*, std::vector<SmPolyVertex*>> adj;
    for (auto& [seg, count] : em.segments)
    {
      adj[seg.first].push_back(seg.second);
      adj[seg.second].push_back(seg.first);
    }
    std::set<std::pair<SmPolyVertex*, SmPolyVertex*>> used;
    auto walk = [&](SmPolyVertex* start) {
      std::vector<SmPolyVertex*> chain{start};
      for (SmPolyVertex* cur = start;;)
      {
        SmPolyVertex* next = nullptr;
        for (SmPolyVertex* w : adj[cur])
          if (!used.count({std::min(cur, w), std::max(cur, w)})) { next = w; break; }
        if (!next) break;
        used.insert({std::min(cur, next), std::max(cur, next)});
        chain.push_back(next);
        cur = next;
      }
      if (chain.size() < 2) return;
      int32_t first = (int32_t)(g.edgePositions.size() / 3);
      double angle = -1;
      for (SmPolyVertex* v : chain)
      {
        auto& q = em.points[v];
        g.edgePositions.insert(g.edgePositions.end(), {(float)q[0], (float)q[1], (float)q[2]});
        auto& ns = em.normals[v];
        if (kind == 0 && ns.size() >= 2)
          for (size_t i = 1; i < ns.size(); i++)
          {
            double c = ns[0][0] * ns[i][0] + ns[0][1] * ns[i][1] + ns[0][2] * ns[i][2];
            angle = std::max(angle, std::acos(std::max(-1.0, std::min(1.0, c))));
          }
      }
      g.edges.insert(g.edges.end(), {id, first, (int32_t)chain.size(), kind});
      g.edgeAngles.push_back((float)angle);
    };
    // Open chains from their ends first, then what's left (closed ones).
    for (auto& [v, ws] : adj)
      if (ws.size() % 2 == 1) walk(v);
    for (auto& [seg, count] : em.segments)
      if (!used.count(seg)) walk(seg.first);
  }
}

// A transform's scale on areas and lengths (similarities only: the determinant's cube root).
double scaleOf(const std::vector<double>& t)
{
  if (t.size() != 12) return 1;
  const double* a = t.data();
  double det = a[0] * (a[4] * a[8] - a[7] * a[5]) - a[3] * (a[1] * a[8] - a[7] * a[2])
    + a[6] * (a[1] * a[5] - a[4] * a[2]);
  return std::cbrt(std::fabs(det));
}

// Every B-rep of the part meshed. A face that meshes badly in its shell (by its exact area: badness) is built again
// alone and unhealed and meshed again, and the better of the two kept: SMLib's healer can spoil a face's mesh in its
// shell while leaving its trims right, and an unhealed face alone can mesh where its healed shell doesn't. The retry's
// edges aren't shared with its neighbours'.
void meshPart(const uint8_t* buf, size_t len, BuiltPart& part, double linDefl, double angDefl, double ox, double oy,
  double oz, std::string& diag)
{
  std::map<long, FaceMesh> meshes; // by face row (-1: a face SMLib made without one)
  std::set<long> measured, seen;
  Stats st;
  for (auto& b : part.breps)
  {
    Meshed mb;
    tessellate(b, linDefl, angDefl, mb, st);
    std::set<SmFace*> chosen;
    std::vector<int> bad;
    std::map<long, double> badBy;
    for (auto& [f, j] : mb.faces)
    {
      if (j.row >= 0) seen.insert(j.row);
      double by = badness(j, linDefl);
      if (by > 0 && j.row >= 0) { bad.push_back((int)j.row); badBy[j.row] = by; }
      else chosen.insert(f);
    }
    std::vector<std::pair<std::unique_ptr<BuiltPart>, std::unique_ptr<Meshed>>> retries;
    // The judgement of the mesh kept, by face row: the retry's where it was better.
    std::map<long, Judged> kept;
    if (!bad.empty())
    {
      std::sort(bad.begin(), bad.end());
      bad.erase(std::unique(bad.begin(), bad.end()), bad.end());
      auto rp = std::make_unique<BuiltPart>();
      buildFaces(buf, len, bad, b.transform, *rp);
      st.retried += (int)bad.size();
      std::set<long> better;
      for (auto& rb : rp->breps)
      {
        auto rm = std::make_unique<Meshed>();
        tessellate(rb, linDefl, angDefl, *rm, st);
        std::set<SmFace*> rchosen;
        for (auto& [f, j] : rm->faces)
          if (badness(j, linDefl) < badBy[j.row] && j.polygons > 0)
          {
            rchosen.insert(f);
            better.insert(j.row);
            kept[j.row] = j;
          }
        emit(part, rb, *rm, rchosen, meshes, ox, oy, oz, st);
        retries.emplace_back(nullptr, std::move(rm));
      }
      st.improved += (int)better.size();
      for (auto& [f, j] : mb.faces)
        if (badBy.count(j.row) && !better.count(j.row)) chosen.insert(f);
      retries.emplace_back(std::move(rp), nullptr);
    }
    emit(part, b, mb, chosen, meshes, ox, oy, oz, st);
    if (gMeasures)
    {
      double s = scaleOf(b.transform);
      for (auto& [f, j0] : mb.faces)
      {
        if (j0.row < 0 || measured.count(j0.row)) continue;
        measured.insert(j0.row);
        const Judged& j = kept.count(j0.row) ? kept[j0.row] : j0;
        g.measures.insert(g.measures.end(), {(double)idOf(part.faceIds, j.row), j.exact * s * s, j.perimeter * s,
          std::isfinite(j.exact) ? 1.0 : 0.0});
      }
    }
    // (The retries' B-reps and meshes go before the poly B-rep they replaced faces of: retries before mb.)
    retries.clear();
  }
  int failed = 0;
  for (auto& [row, fm] : meshes)
  {
    uint32_t base = (uint32_t)(g.positions.size() / 3);
    for (double x : fm.pos) g.positions.push_back((float)x);
    for (double x : fm.nrm) g.normals.push_back((float)x);
    g.faces.insert(g.faces.end(), {idOf(part.faceIds, row), (int32_t)g.indices.size(), (int32_t)fm.tri.size()});
    for (uint32_t i : fm.tri) g.indices.push_back(base + i);
  }
  for (long row : seen)
    if (!meshes.count(row) || meshes[row].tri.empty()) failed++;
  diag += ",\"faces\":" + std::to_string(st.faces) + ",\"failures\":" + std::to_string(failed)
    + ",\"polygons\":" + std::to_string(st.polygons) + ",\"tessErrors\":" + std::to_string(st.tessErrors)
    + ",\"retried\":" + std::to_string(st.retried) + ",\"improved\":" + std::to_string(st.improved)
    + ",\"msMeasures\":" + std::to_string(st.msMeasures) + ",\"msTessellate\":" + std::to_string(st.msTessellate);
  if (!st.firstError.empty()) diag += ",\"tessError\":\"" + jsonEscape(st.firstError) + "\"";
}
} // namespace

extern "C"
{

// Returns 0 on success; -5 for a part the builder didn't build (its reason in the diag); -3 for an exception.
int smlib_tessellate_model(const uint8_t* data, int len, double linDefl, double angDefl, double ox, double oy,
  double oz)
{
  g = Result();
  try
  {
    // (cbr_open reads the buffer in place: 8-byte aligned.)
    std::vector<double> aligned(((size_t)len + 7) / 8);
    std::memcpy(aligned.data(), data, (size_t)len);
    BuildOptions opt;
    opt.heal = gHeal;
    opt.linearDeflection = linDefl;
    opt.angularDeflection = angDefl;
    BuiltPart part;
    double t0 = now();
    buildPart(reinterpret_cast<const uint8_t*>(aligned.data()), (size_t)len, opt, part);
    std::string builder = "[";
    for (size_t i = 0; i < part.warnings.size(); ++i)
      builder += (i ? ",\"" : "\"") + jsonEscape(part.warnings[i]) + "\"";
    builder += "]";
    if (!part.error.empty())
    {
      g.diag = "{\"error\":\"" + jsonEscape(part.error) + "\",\"builder\":" + builder + "}";
      return -5;
    }
    std::string meshDiag = ",\"msBuild\":" + std::to_string(now() - t0);
    meshPart(reinterpret_cast<const uint8_t*>(aligned.data()), (size_t)len, part, linDefl, angDefl, ox, oy, oz,
      meshDiag);
    auto finite = [](double id) { return std::isfinite(id) ? (int32_t)id : -1; };
    for (auto& c : part.curves)
    {
      Transform tr(c.transform);
      g.curves.insert(g.curves.end(), {finite(c.id), (int32_t)(g.curvePositions.size() / 3),
        (int32_t)(c.points.size() / 3)});
      for (size_t k = 0; k < c.points.size(); k += 3)
      {
        double q[3] = {c.points[k], c.points[k + 1], c.points[k + 2]};
        tr.point(q);
        g.curvePositions.insert(g.curvePositions.end(), {(float)(q[0] - ox), (float)(q[1] - oy), (float)(q[2] - oz)});
      }
    }
    for (auto& pt : part.points)
    {
      Transform tr(pt.transform);
      double q[3] = {pt.points[0], pt.points[1], pt.points[2]};
      tr.point(q);
      g.points.insert(g.points.end(), {(float)(q[0] - ox), (float)(q[1] - oy), (float)(q[2] - oz)});
      g.pointIds.push_back(finite(pt.id));
    }
    g.diag = "{\"breps\":" + std::to_string(part.breps.size()) + meshDiag + ",\"builder\":" + builder + "}";
    return 0;
  }
  catch (...)
  {
    g = Result();
    g.diag = "{\"error\":\"exception\"}";
    return -3;
  }
}

void smlib_set_measures(int on) { gMeasures = on != 0; }
void smlib_set_edges(int on) { gEdges = on != 0; }
void smlib_set_heal(int on) { gHeal = on != 0; }
const float* smlib_positions() { return g.positions.data(); }
const float* smlib_normals() { return g.normals.data(); }
int smlib_num_vertices() { return (int)(g.positions.size() / 3); }
const uint32_t* smlib_indices() { return g.indices.data(); }
int smlib_num_indices() { return (int)g.indices.size(); }
const int32_t* smlib_faces() { return g.faces.data(); }
int smlib_num_faces() { return (int)(g.faces.size() / 3); }
const float* smlib_edge_positions() { return g.edgePositions.data(); }
int smlib_num_edge_points() { return (int)(g.edgePositions.size() / 3); }
const int32_t* smlib_edges() { return g.edges.data(); }
const float* smlib_edge_angles() { return g.edgeAngles.data(); }
int smlib_num_edges() { return (int)g.edgeAngles.size(); }
const double* smlib_measures() { return g.measures.data(); }
int smlib_num_measures() { return (int)(g.measures.size() / 4); }
const float* smlib_curve_positions() { return g.curvePositions.data(); }
int smlib_num_curve_points() { return (int)(g.curvePositions.size() / 3); }
const int32_t* smlib_curves() { return g.curves.data(); }
int smlib_num_curves() { return (int)(g.curves.size() / 3); }
const float* smlib_points() { return g.points.data(); }
const int32_t* smlib_point_ids() { return g.pointIds.data(); }
int smlib_num_points() { return (int)g.pointIds.size(); }
const char* smlib_diag() { return g.diag.c_str(); }
void smlib_free() { g = Result(); }
}
