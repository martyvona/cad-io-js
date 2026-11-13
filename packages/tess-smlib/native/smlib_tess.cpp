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
  // Ids are source ids, 0 for none (as cad-brep's).
  std::vector<uint32_t> faces; // triples: entityId (0 = unknown), first index, index count
  std::vector<float> edgePositions;
  std::vector<uint32_t> edges;     // quads: entityId (0 = unknown), first point, point count, kind
  std::vector<float> edgeAngles;   // max angle (radians) between adjacent face normals along the edge; -1 if n/a
  std::vector<double> measures;    // quads: entityId, area, perimeter, valid (1 or 0); faces with an id only
  std::vector<float> curvePositions;
  std::vector<uint32_t> curves;    // triples: entityId (0 = unknown), first point, point count
  std::vector<float> points;
  std::vector<uint32_t> pointIds;  // 0 = unknown
  std::string diag;                // JSON object text
};
Result g;
bool gMeasures = false, gHeal = true, gEdges = false;
double gScale = 1;

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

uint32_t idOf(const std::vector<uint32_t>& ids, long row)
{
  return row < 0 || row >= (long)ids.size() ? 0 : ids[row];
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

// One face's use of a model edge in one meshing: its boundary segments on the edge, as vertex pairs of the face's mesh.
struct Side
{
  int source; // the meshing: 0 the shell's, then one for each face meshed again alone
  int kind;   // 0 shared, 1 seam, 2 free, 3 degenerate, as that meshing's B-rep has the edge
  long face;  // the face row
  FaceMesh* fm;
  std::vector<std::array<uint32_t, 2>> segs;
};
// By edge row.
using Sides = std::map<long, std::vector<Side>>;
using P3 = std::array<double, 3>;

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

// How far a face's mesh is from its exact area, for choosing between meshes: badness where there is any (so a failing
// mesh never beats a passing one), else the difference where it is over 5% of the exact area, which the deflection
// may allow on a small face but a mesh of shorter edges often betters.
double offBy(const Judged& j, double lin)
{
  double by = badness(j, lin);
  if (by > 0) return j.exact + by;
  if (!std::isfinite(j.exact) || !(j.exact > 0) || j.polygons == 0) return 0;
  double d = std::fabs(j.area - j.exact);
  return d > 0.05 * j.exact ? d : 0;
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
  int polygons = 0, faces = 0, tessErrors = 0, retried = 0, improved = 0, unjoined = 0, folded = 0;
  double msMeasures = 0, msTessellate = 0;
  std::string firstError;
};

// (maxEdge: SMLib's edge-length target, 0 for none.) Lengths in and the judgements out are in the part's unit, whatever
// the B-rep's scale.
void tessellate(BuiltBrep& b, double linDefl, double angDefl, Meshed& out, Stats& st, double maxEdge = 0)
{
  const double S = b.scale;
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
      j.exact = area / (S * S);
    SmTArray<ULONG> counts;
    SmTArray<SmEdge*> edges;
    SmTArray<SmOrientType> orientations;
    if (SmApiFaceGetBoundaryLoops(smFaces[i], counts, edges, orientations) == SM_SUCCESS)
      for (ULONG k = 0; k < edges.GetSize(); k++)
      {
        double len = 0;
        if (SmApiEdgeComputeLength(edges[k], 1e-6, len) == SM_SUCCESS) j.perimeter += len / S;
      }
  }
  st.msMeasures += now() - t0;
  SmTessellationParams p;
  p.dChordHeightTol = linDefl * S;
  p.dCurveAngleTolDeg = angDefl * DEG;
  p.dSurfaceAngleTolDeg = angDefl * DEG;
  p.dMaxEdgeLength = maxEdge * S;
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
      it->second.area += (u * v).Length() / 2 / (S * S);
    }
    it->second.polygons++;
  }
}

// The polygons of a meshed B-rep's chosen faces into the face meshes (by face row), and their uses of the model's edges
// into sides.
void emit(BuiltBrep& b, Meshed& mb, const std::set<SmFace*>& chosen, std::map<long, FaceMesh>& meshes, double ox,
  double oy, double oz, Stats& st, Sides& sides, int source)
{
  if (!mb.poly) return;
  Transform tr(b.transform);
  SmTArray<SmPolyFace*> pfs;
  mb.poly->GetPolyFaces(pfs);
  SmTArray<SmPolyEdge*> pes;
  // Each face's poly vertices, by vertex, as indices into its mesh.
  std::map<long, std::unordered_map<SmPolyVertex*, uint32_t>> local;
  // Each face's side on an edge row, as its index in the row's sides.
  std::map<std::pair<long, FaceMesh*>, size_t> mine;
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
    for (ULONG j = 0; j < n; j++)
    {
      auto* tag = SM_CAST_PTR(SmLongAttribute, pes[j]->FindAttribute(SM_AI_EDGE_ID));
      if (!tag) continue;
      long e = tag->GetValue();
      auto& uses = sides[e / 4 - 1];
      auto it = mine.find({e / 4 - 1, &fm});
      if (it == mine.end())
      {
        it = mine.emplace(std::make_pair(e / 4 - 1, &fm), uses.size()).first;
        uses.push_back({source, (int)(e % 4), row, &fm, {}});
      }
      uses[it->second].segs.push_back({ring[j], ring[(j + 1) % n]});
    }
    for (size_t j = 1; j + 1 < ring.size(); j++)
    {
      if (flip) fm.tri.insert(fm.tri.end(), {ring[0], ring[j + 1], ring[j]});
      else fm.tri.insert(fm.tri.end(), {ring[0], ring[j], ring[j + 1]});
    }
  }
}

P3 at(const FaceMesh& fm, uint32_t i)
{
  return {fm.pos[3 * i], fm.pos[3 * i + 1], fm.pos[3 * i + 2]};
}
double dist(const P3& a, const P3& b)
{
  return std::sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]));
}

// One meshing's points along a model edge, in order: its sides' segments (by position: a shell's faces share theirs)
// chained. ok: they make one open path or one closed ring.
struct Chain
{
  int source = 0;
  std::vector<Side*> sides;
  std::vector<P3> pts;
  bool closed = false, ok = false;
};

Chain chainOf(int source, const std::vector<Side*>& sides)
{
  Chain c;
  c.source = source;
  c.sides = sides;
  std::map<P3, std::set<P3>> adj;
  for (Side* s : sides)
    for (auto& seg : s->segs)
    {
      P3 a = at(*s->fm, seg[0]), z = at(*s->fm, seg[1]);
      if (a == z) continue;
      adj[a].insert(z);
      adj[z].insert(a);
    }
  if (adj.empty()) return c;
  std::vector<P3> ends;
  for (auto& [p, ns] : adj)
  {
    if (ns.size() > 2) return c;
    if (ns.size() == 1) ends.push_back(p);
  }
  if (ends.size() != 0 && ends.size() != 2) return c;
  c.closed = ends.empty();
  P3 prev = c.closed ? adj.begin()->first : ends[0], cur = prev;
  c.pts.push_back(cur);
  for (;;)
  {
    const P3* next = nullptr;
    for (auto& q : adj[cur])
      if (c.pts.size() == 1 || !(q == prev)) { next = &q; break; }
    if (!next || (c.closed && *next == c.pts[0])) break;
    prev = cur;
    cur = *next;
    c.pts.push_back(cur);
    if (c.pts.size() > adj.size()) return c;
  }
  c.ok = c.pts.size() == adj.size();
  return c;
}

// An edge row's chains by meshing, the earliest first; none unless there are several meshings.
std::vector<Chain> chains(std::vector<Side>& of)
{
  std::map<int, std::vector<Side*>> by;
  for (Side& s : of) by[s.source].push_back(&s);
  std::vector<Chain> out;
  if (by.size() < 2) return out;
  for (auto& [source, ss] : by) out.push_back(chainOf(source, ss));
  return out;
}

// Whether an open chain's ends are another's: which way round, or 0 when either end is over the guard away.
int endsMeet(const Chain& m, const Chain& x, double guard)
{
  bool same = dist(m.pts.front(), x.pts.front()) + dist(m.pts.back(), x.pts.back())
    <= dist(m.pts.front(), x.pts.back()) + dist(m.pts.back(), x.pts.front());
  const P3 &x0 = same ? x.pts.front() : x.pts.back(), &x1 = same ? x.pts.back() : x.pts.front();
  return dist(m.pts.front(), x0) > guard || dist(m.pts.back(), x1) > guard ? 0 : same ? 1 : -1;
}

// The edge rows whose meshings stitch can't join for their shapes: chains that aren't one path or ring each, a path
// against a ring, or ends apart (the healer moved or merged a vertex of the shell's, so the shell's faces there end
// elsewhere than the model's).
std::vector<long> unjoinable(Sides& sides, double guard)
{
  std::vector<long> out;
  for (auto& [row, of] : sides)
  {
    std::vector<Chain> cs = chains(of);
    bool ok = true;
    for (size_t i = 0; ok && i < cs.size(); i++)
      ok = cs[i].ok && cs[i].closed == cs[0].closed && (cs[i].closed || i == 0 || endsMeet(cs[0], cs[i], guard) != 0);
    if (!ok) out.push_back(row);
  }
  return out;
}

// Where a point lies along a polyline: the nearest segment and the fraction along it (the last point of a closed one
// joined to the first); how far from it.
std::pair<double, double> along(const std::vector<P3>& line, bool closed, const P3& p)
{
  double best = INFINITY, key = 0;
  size_t n = line.size(), segs = closed ? n : n - 1;
  for (size_t i = 0; i < segs; i++)
  {
    const P3 &a = line[i], &b = line[(i + 1) % n];
    double d[3] = {b[0] - a[0], b[1] - a[1], b[2] - a[2]}, len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    double t = len2 > 0 ? ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / len2 : 0;
    t = std::max(0.0, std::min(1.0, t));
    double far = dist(p, {a[0] + t * d[0], a[1] + t * d[1], a[2] + t * d[2]});
    if (far < best) best = far, key = (double)i + t;
  }
  return {key, best};
}

// A face mesh's triangles by edge, for splitting them.
struct Splitter
{
  FaceMesh& fm;
  std::unordered_map<uint64_t, std::vector<uint32_t>> tris;
  static uint64_t key(uint32_t a, uint32_t b) { return ((uint64_t)std::min(a, b) << 32) | std::max(a, b); }
  explicit Splitter(FaceMesh& fm) : fm(fm)
  {
    for (uint32_t t = 0; t < fm.tri.size() / 3; t++)
      for (int j = 0; j < 3; j++) tris[key(fm.tri[3 * t + j], fm.tri[3 * t + (j + 1) % 3])].push_back(t);
  }
  // The edge a-b split at points (in order from a): new vertices, each triangle on the edge a fan of triangles from
  // its third vertex, wound as it was. The new vertices, in order.
  std::vector<uint32_t> split(uint32_t a, uint32_t b, const std::vector<P3>& points)
  {
    std::vector<uint32_t> mid;
    for (size_t j = 0; j < points.size(); j++)
    {
      double f = (double)(j + 1) / (double)(points.size() + 1), nn[3], len = 0;
      for (int c = 0; c < 3; c++) nn[c] = (1 - f) * fm.nrm[3 * a + c] + f * fm.nrm[3 * b + c], len += nn[c] * nn[c];
      len = len > 0 ? std::sqrt(len) : 1;
      mid.push_back((uint32_t)(fm.pos.size() / 3));
      fm.pos.insert(fm.pos.end(), {points[j][0], points[j][1], points[j][2]});
      fm.nrm.insert(fm.nrm.end(), {nn[0] / len, nn[1] / len, nn[2] / len});
    }
    std::vector<uint32_t> on = tris[key(a, b)];
    for (uint32_t t : on)
    {
      uint32_t* v = &fm.tri[3 * t];
      int j = 0;
      while (j < 3 && !((v[j] == a && v[(j + 1) % 3] == b) || (v[j] == b && v[(j + 1) % 3] == a))) j++;
      if (j == 3) continue;
      // From the triangle's own first end of the edge to its second, about the third vertex.
      uint32_t first = v[j], last = v[(j + 1) % 3], third = v[(j + 2) % 3];
      std::vector<uint32_t> run{first};
      if (first == a) run.insert(run.end(), mid.begin(), mid.end());
      else run.insert(run.end(), mid.rbegin(), mid.rend());
      run.push_back(last);
      v[0] = run[0], v[1] = run[1], v[2] = third;
      for (size_t i = 1; i + 1 < run.size(); i++)
      {
        uint32_t nt = (uint32_t)(fm.tri.size() / 3);
        fm.tri.insert(fm.tri.end(), {run[i], run[i + 1], third});
        if (i + 2 == run.size())
        {
          // The triangle's other edge at the edge's far end is the last new triangle's.
          auto& far = tris[key(last, third)];
          std::replace(far.begin(), far.end(), t, nt);
        }
      }
    }
    return mid;
  }
};

// The meshes of faces meshed apart (a shell's, and each face meshed again alone) made to meet exactly along the model
// edges they share: SMLib splits a face's boundary edges to suit that face, so two meshings of an edge have different
// points. First the edges' ends, the model's vertices: every meshing's vertex at one moved to the earliest meshing's
// position (the shell's before a retry's). Then each edge: the meshings' points in one order along it (a point of one
// placed by the nearest segment of the others'), and each side's boundary segments split at the points it lacks, its
// triangles there into fans. Every point is one meshing's own, copied, so the sides' vertices are the same numbers,
// and no triangle is moved but at corners. An edge whose meshings don't chain into one path or ring each, or whose
// points' order isn't the same along both, or that lie over the guard apart, is left as it is (openRows counts it).
void stitch(Sides& sides, double guard)
{
  // The vertices (a mesh's, by index) at a chain's point.
  auto vertices = [](const Chain& c, const P3& p) {
    std::set<std::pair<FaceMesh*, uint32_t>> out;
    for (Side* s : c.sides)
      for (auto& seg : s->segs)
        for (uint32_t i : seg)
          if (at(*s->fm, i) == p) out.insert({s->fm, i});
    return out;
  };
  // Ends: clusters of vertices that are one model vertex, each taking its earliest meshing's position.
  struct Corner
  {
    int source;
    P3 p;
    std::set<std::pair<FaceMesh*, uint32_t>> vs;
  };
  std::vector<Corner> corners;
  std::map<std::pair<FaceMesh*, uint32_t>, size_t> cornerOf;
  auto join = [&](const Chain& c, const P3& p, const Chain& d, const P3& q) {
    size_t to = corners.size();
    corners.push_back({std::min(c.source, d.source), c.source <= d.source ? p : q, {}});
    for (auto* pair : {&c, &d})
      for (auto& v : vertices(*pair, pair == &c ? p : q))
      {
        auto it = cornerOf.find(v);
        if (it != cornerOf.end() && it->second != to)
        {
          Corner& old = corners[it->second];
          if (old.source < corners[to].source) corners[to].source = old.source, corners[to].p = old.p;
          for (auto& w : old.vs) corners[to].vs.insert(w), cornerOf[w] = to;
          old.vs.clear();
        }
        corners[to].vs.insert(v);
        cornerOf[v] = to;
      }
  };
  for (auto& [row, of] : sides)
  {
    std::vector<Chain> cs = chains(of);
    for (size_t i = 1; i < cs.size(); i++)
    {
      const Chain &m = cs[0], &x = cs[i];
      if (!m.ok || !x.ok || m.closed || x.closed) continue;
      int way = endsMeet(m, x, guard);
      if (way == 0) continue;
      join(m, m.pts.front(), x, way > 0 ? x.pts.front() : x.pts.back());
      join(m, m.pts.back(), x, way > 0 ? x.pts.back() : x.pts.front());
    }
  }
  for (Corner& c : corners)
    for (auto& [fm, i] : c.vs) fm->pos[3 * i] = c.p[0], fm->pos[3 * i + 1] = c.p[1], fm->pos[3 * i + 2] = c.p[2];
  std::map<FaceMesh*, Splitter> splitters;
  for (auto& [row, of] : sides)
  {
    std::vector<Chain> cs = chains(of);
    if (cs.empty()) continue;
    // The points of all the meshings in one order: the first's, then each other's placed among them.
    std::vector<P3> all = cs[0].pts;
    bool ok = cs[0].ok;
    for (size_t i = 1; ok && i < cs.size(); i++)
    {
      Chain& x = cs[i];
      ok = x.ok && x.closed == cs[0].closed;
      if (!ok) break;
      std::map<P3, size_t> have;
      for (size_t k = 0; k < all.size(); k++) have[all[k]] = k;
      size_t n = x.pts.size();
      std::vector<double> keys(n);
      for (size_t k = 0; ok && k < n; k++)
      {
        auto it = have.find(x.pts[k]);
        if (it != have.end()) { keys[k] = (double)it->second; continue; }
        auto [key, far] = along(all, x.closed, x.pts[k]);
        // (A point of an open chain that isn't its end lies before the others' end.)
        keys[k] = x.closed ? key : std::min(key, std::nextafter((double)(all.size() - 1), 0.0));
        ok = far <= guard;
      }
      if (!ok) break;
      // The chain turned (and a ring started) so that its points run with the others'.
      std::vector<size_t> order(n);
      for (size_t k = 0; k < n; k++) order[k] = k;
      if (x.closed)
      {
        size_t least = std::min_element(keys.begin(), keys.end()) - keys.begin();
        bool up = keys[(least + 1) % n] <= keys[(least + n - 1) % n];
        for (size_t k = 0; k < n; k++) order[k] = up ? (least + k) % n : (least + n - k) % n;
      }
      else
      {
        if (keys.front() > keys.back()) std::reverse(order.begin(), order.end());
        ok = x.pts[order.front()] == all.front() && x.pts[order.back()] == all.back();
      }
      for (size_t k = 1; ok && k < n; k++) ok = keys[order[k - 1]] <= keys[order[k]];
      if (!ok) break;
      // Merged, each of this chain's points after those of its key or less.
      std::vector<P3> merged;
      size_t k = 0;
      for (size_t a = 0; a < all.size(); a++)
      {
        merged.push_back(all[a]);
        for (; k < n && keys[order[k]] < (double)(a + 1); k++)
          if (!have.count(x.pts[order[k]])) merged.push_back(x.pts[order[k]]);
      }
      all = merged;
    }
    if (!ok) continue;
    std::map<P3, size_t> where;
    for (size_t k = 0; k < all.size(); k++) where[all[k]] = k;
    if (where.size() != all.size()) continue;
    for (Chain& c : cs)
      for (Side* s : c.sides)
      {
        Splitter& sp = splitters.try_emplace(s->fm, *s->fm).first->second;
        std::vector<std::array<uint32_t, 2>> segs;
        std::set<uint64_t> done;
        for (auto& seg : s->segs)
        {
          P3 a = at(*s->fm, seg[0]), z = at(*s->fm, seg[1]);
          if (a == z || !done.insert(Splitter::key(seg[0], seg[1])).second) { segs.push_back(seg); continue; }
          size_t i = where[a], j = where[z], m = all.size();
          // The points between, from a to z: the shorter way round a ring.
          bool up = cs[0].closed ? (j + m - i) % m <= (i + m - j) % m : j > i;
          std::vector<P3> mid;
          for (size_t q = up ? (i + 1) % m : (i + m - 1) % m; q != j; q = up ? (q + 1) % m : (q + m - 1) % m)
            mid.push_back(all[q]);
          uint32_t from = seg[0];
          for (uint32_t v : sp.split(seg[0], seg[1], mid)) segs.push_back({from, v}), from = v;
          segs.push_back({from, seg[1]});
        }
        s->segs = segs;
      }
  }
}

// The model's edges whose faces' meshes don't meet along them, among the edges two or more faces use (by the model)
// that all have meshes here: one with a boundary segment that only one triangle of the B-rep's meshes has. By the
// positions as output (single precision, minus the origin), which is what makes the result watertight or not: the
// faces' meshes share no vertices but by position. Whatever the cause: an edge stitch couldn't join, or one SMLib's
// own shell mesh leaves open. (Not by the sides alone: SMLib leaves some faces' poly edges without their edge's
// attribute.)
int openRows(const BuiltPart& part, Sides& sides, const std::map<long, FaceMesh>& local)
{
  using F3 = std::array<float, 3>;
  auto out = [](const FaceMesh& fm, uint32_t i) {
    return F3{(float)fm.pos[3 * i], (float)fm.pos[3 * i + 1], (float)fm.pos[3 * i + 2]};
  };
  std::map<std::pair<F3, F3>, int> uses;
  for (auto& [row, fm] : local)
    for (size_t t = 0; t + 2 < fm.tri.size(); t += 3)
      for (int j = 0; j < 3; j++)
      {
        // (Never a segment from a point to itself: a side's segments of one point count as joined.)
        F3 a = out(fm, fm.tri[t + j]), z = out(fm, fm.tri[t + (j + 1) % 3]);
        if (a != z) uses[{std::min(a, z), std::max(a, z)}]++;
      }
  int open = 0;
  for (auto& [row, of] : sides)
  {
    if (row < 0 || row >= (long)part.edgeFaces.size()) continue;
    std::set<int> users(part.edgeFaces[row].begin(), part.edgeFaces[row].end());
    bool all = users.size() >= 2, bad = false;
    for (int f : users)
    {
      auto it = local.find(f);
      all = all && it != local.end() && !it->second.tri.empty();
    }
    if (!all) continue;
    for (Side& s : of)
      for (auto& seg : s.segs)
      {
        F3 a = out(*s.fm, seg[0]), z = out(*s.fm, seg[1]);
        bad = bad || uses[{std::min(a, z), std::max(a, z)}] == 1;
      }
    if (bad) open++;
  }
  return open;
}

// The model's edges as polylines, from the sides' segments (by position, so the faces along an edge share its points),
// with their kinds and dihedral angles.
void emitEdges(BuiltPart& part, Sides& sides)
{
  for (auto& [row, of] : sides)
  {
    if (of.empty()) continue;
    uint32_t id = idOf(part.edgeIds, row);
    // (The kind as the earliest meshing has it, but shared where two faces have it: a face meshed again alone, or one
    // in a shell of its own, has its edges free.)
    const Side* first = &of[0];
    std::set<long> faces;
    for (const Side& s : of)
    {
      if (s.source < first->source) first = &s;
      faces.insert(s.face);
    }
    int kind = first->kind == EDGE_FREE && faces.size() >= 2 ? EDGE_SHARED : first->kind;
    std::map<P3, std::set<P3>> adj;
    std::map<P3, std::vector<P3>> normals;
    for (const Side& s : of)
    {
      std::set<uint32_t> seen;
      for (auto& seg : s.segs)
      {
        P3 a = at(*s.fm, seg[0]), z = at(*s.fm, seg[1]);
        if (!(a == z)) adj[a].insert(z), adj[z].insert(a);
        for (uint32_t i : seg)
          if (seen.insert(i).second)
            normals[at(*s.fm, i)].push_back({s.fm->nrm[3 * i], s.fm->nrm[3 * i + 1], s.fm->nrm[3 * i + 2]});
      }
    }
    std::set<std::pair<P3, P3>> used;
    auto walk = [&](const P3& start) {
      std::vector<P3> chain{start};
      for (P3 cur = start;;)
      {
        const P3* next = nullptr;
        for (auto& w : adj[cur])
          if (!used.count({std::min(cur, w), std::max(cur, w)})) { next = &w; break; }
        if (!next) break;
        used.insert({std::min(cur, *next), std::max(cur, *next)});
        chain.push_back(*next);
        cur = *next;
      }
      if (chain.size() < 2) return;
      int32_t at0 = (int32_t)(g.edgePositions.size() / 3);
      double angle = -1;
      for (const P3& q : chain)
      {
        g.edgePositions.insert(g.edgePositions.end(), {(float)q[0], (float)q[1], (float)q[2]});
        auto& ns = normals[q];
        if (kind == 0 && ns.size() >= 2)
          for (size_t i = 1; i < ns.size(); i++)
          {
            double c = ns[0][0] * ns[i][0] + ns[0][1] * ns[i][1] + ns[0][2] * ns[i][2];
            angle = std::max(angle, std::acos(std::max(-1.0, std::min(1.0, c))));
          }
      }
      g.edges.insert(g.edges.end(), {id, (uint32_t)at0, (uint32_t)chain.size(), (uint32_t)kind});
      g.edgeAngles.push_back((float)angle);
    };
    // Open chains from their ends first, then what's left (closed ones).
    for (auto& [v, ws] : adj)
      if (ws.size() % 2 == 1) walk(v);
    for (auto& [v, ws] : adj) walk(v);
  }
}

// A face mesh's triangles on the same three points (by position) as another: a pair wound opposite ways (SMLib folds a
// face back on itself so, at a corner it puts off the model's vertex: trj3_s1-id-203.stp #569's face #5003) both
// removed, as together they cover nothing; a repeat wound the same way, the repeat. The count removed.
int unfold(FaceMesh& fm)
{
  std::map<std::array<P3, 3>, std::vector<size_t>> by;
  size_t n = fm.tri.size() / 3;
  for (size_t t = 0; t < n; t++)
  {
    std::array<P3, 3> k = {at(fm, fm.tri[3 * t]), at(fm, fm.tri[3 * t + 1]), at(fm, fm.tri[3 * t + 2])};
    std::sort(k.begin(), k.end());
    by[k].push_back(t);
  }
  // Each triangle's turn: its points in sorted order an even or odd permutation of its own.
  auto turn = [&](size_t t) {
    P3 a = at(fm, fm.tri[3 * t]), b = at(fm, fm.tri[3 * t + 1]), c = at(fm, fm.tri[3 * t + 2]);
    return (a < b) + (b < c) + (c < a) == 2;
  };
  std::vector<bool> drop(n, false);
  int removed = 0;
  for (auto& [k, ts] : by)
  {
    if (ts.size() < 2) continue;
    std::vector<size_t> up, down;
    for (size_t t : ts) (turn(t) ? up : down).push_back(t);
    // Opposite pairs out; then of those left, all but one.
    size_t pairs = std::min(up.size(), down.size());
    for (size_t i = 0; i < pairs; i++) drop[up[i]] = drop[down[i]] = true;
    auto& rest = up.size() > pairs ? up : down;
    for (size_t i = pairs + 1; i < rest.size(); i++) drop[rest[i]] = true;
  }
  std::vector<uint32_t> kept;
  for (size_t t = 0; t < n; t++)
    if (drop[t]) removed++;
    else kept.insert(kept.end(), {fm.tri[3 * t], fm.tri[3 * t + 1], fm.tri[3 * t + 2]});
  fm.tri = kept;
  return removed;
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

// The ways a face that meshed badly in its shell is built alone again, in order, while its mesh still fails: unhealed
// and healed, at the part's size and with the model's lengths times 1024. SMLib's healer can spoil a face's mesh in
// its shell while leaving its trims right; alone, some faces mesh only healed, some only unhealed, and some only
// larger (SMLib has absolute constants). A power of two, so that the model's points come back from it as they were.
// Never smaller: SMLib traps on parts made small (a part in metres divided by 1024).
struct Way
{
  bool heal;
  double scale;
};
const Way kWays[] = {{false, 1}, {true, 1}, {false, 1024}, {true, 1024}};

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
  // A placed item's B-reps (each shell of a body) at a time: their face meshes (by face row) and the faces' uses of
  // the model's edges, over every meshing (each shell's: sources 0 to shells - 1; then each face meshed alone), so
  // that faces in different shells are joined along the edges they share as faces meshed alone are.
  std::vector<std::vector<size_t>> groups;
  {
    std::map<int, size_t> at;
    for (size_t i = 0; i < part.breps.size(); i++)
    {
      auto it = at.emplace(part.breps[i].group, groups.size()).first;
      if (it->second == groups.size()) groups.emplace_back();
      groups[it->second].push_back(i);
    }
  }
  for (const auto& members : groups)
  {
    std::map<long, FaceMesh> local;
    Sides sides;
    const int shells = (int)members.size();
    int source = shells - 1;
    // The judgement of the mesh kept, by face row: the retry's where it was better.
    std::map<long, Judged> kept;
    // Each shell's faces' judgements, for the measures.
    std::vector<std::vector<Judged>> judged(shells);
    std::set<long> alone;
    // (The item's transform from the model's own coordinates, and the stitching's guard: twice the deflection, as
    // the meshes have it.)
    const BuiltBrep& lead = part.breps[members[0]];
    std::vector<double> plain = lead.transform;
    for (size_t i = 0; i < 9 && plain.size() == 12; i++) plain[i] *= lead.scale;
    const double guard = 2 * linDefl * scaleOf(lead.transform) * lead.scale;
    for (size_t shell = 0; shell < members.size(); shell++)
    {
      BuiltBrep& b = part.breps[members[shell]];
      Meshed mb;
      tessellate(b, linDefl, angDefl, mb, st);
      std::set<SmFace*> chosen;
      std::vector<int> bad;
      std::map<long, double> badBy;
      // Judged by model face: the SMLib faces healing split one into, together.
      std::map<long, Judged> whole;
      for (auto& [f, j] : mb.faces)
      {
        if (j.row < 0) { chosen.insert(f); continue; }
        seen.insert(j.row);
        auto it = whole.find(j.row);
        if (it == whole.end()) { whole[j.row] = j; continue; }
        it->second.area += j.area;
        it->second.exact += j.exact;
        it->second.perimeter += j.perimeter;
        it->second.polygons += j.polygons;
      }
      // Whether the mesh kept for a face row still fails (no mesh, or one failing by badness).
      std::map<long, bool> fails;
      for (auto& [row, j] : whole)
      {
        double by = offBy(j, linDefl);
        // (A face without a mesh too small for badness to count is still tried again: most such mesh alone.)
        if (j.polygons == 0 && !(j.exact <= 0)) by = INFINITY;
        if (by > 0)
        {
          bad.push_back((int)row);
          badBy[row] = by;
          fails[row] = j.polygons == 0 || badness(j, linDefl) > 0;
        }
      }
      // A face healing removed (a sliver): alone, as any mesh betters none.
      for (int row : b.rows)
        if (!whole.count(row))
        {
          seen.insert(row);
          bad.push_back(row);
          badBy[row] = INFINITY;
          fails[row] = true;
        }
      for (auto& [f, j] : mb.faces)
        if (j.row >= 0 && !badBy.count(j.row)) chosen.insert(f);
      std::vector<std::unique_ptr<BuiltPart>> retries;
      if (!bad.empty())
      {
        std::sort(bad.begin(), bad.end());
        bad.erase(std::unique(bad.begin(), bad.end()), bad.end());
        st.retried += (int)bad.size();
        std::set<long> better;
        // A retry's mesh that betters what there was but still fails: kept until the ways are through, a later way's
        // replacing it.
        struct Pending
        {
          std::unique_ptr<Meshed> mesh;
          BuiltBrep* brep;
          std::set<SmFace*> faces;
        };
        std::map<long, Pending> pending;
        // Rows with a known area above zero: only those go on to the later ways.
        std::set<long> real;
        std::vector<int> todo = bad;
        for (size_t w = 0; w < sizeof kWays / sizeof *kWays && !todo.empty(); w++)
        {
          auto rp = std::make_unique<BuiltPart>();
          BuildOptions ro;
          ro.heal = kWays[w].heal;
          ro.linearDeflection = linDefl;
          ro.angularDeflection = angDefl;
          buildFaces(buf, len, todo, plain, ro, b.scale * kWays[w].scale, *rp);
          for (auto& rb : rp->breps)
          {
            if (rb.rows.size() != 1) continue;
            const long row = rb.rows[0];
            // The face as built, then (the first way only), while it is still bad, with SMLib's triangles' edges
            // limited to a half, a quarter and an eighth of the face's size (the root of its area): SMLib
            // triangulates in (u, v), and on a face thin in space but not in (u, v) joins boundary points by long
            // edges that leave the surface.
            std::unique_ptr<Meshed> best;
            std::set<SmFace*> bestFaces;
            Judged bestJ;
            // (No finer than a two-hundredth of the perimeter or twice the deflection: a wrong exact area mustn't ask
            // for millions of triangles.)
            double bestBy = badBy[row], size = 0, least = 0;
            // (Only for a face that fails outright or is over a fifth off, and no further once an attempt gives
            // nothing: SMLib's edge-length refinement itself runs away on some faces, as on one of bug31711.stp's 8%
            // off.)
            bool shorter = false;
            for (int attempt = 0; attempt < (w == 0 ? 4 : 1) && bestBy > 0; attempt++)
            {
              if (attempt > 0 && (!(size > 0) || !shorter)) break;
              auto rm = std::make_unique<Meshed>();
              tessellate(rb, linDefl, angDefl, *rm, st, attempt == 0 ? 0 : std::max(size / (1 << attempt), least));
              // The face's judgement over its pieces (healing may split it).
              Judged j;
              std::set<SmFace*> faces;
              j.row = row;
              j.exact = 0;
              for (auto& [f, jf] : rm->faces)
              {
                faces.insert(f);
                j.area += jf.area;
                j.exact += jf.exact;
                j.perimeter += jf.perimeter;
                j.polygons += jf.polygons;
              }
              if (faces.empty()) break;
              if (j.exact > 0) real.insert(row);
              if (attempt == 0)
              {
                size = std::isfinite(j.exact) && j.exact > 0 ? std::sqrt(j.exact) : 0;
                least = std::max(j.perimeter / 200, 2 * linDefl);
              }
              double by = offBy(j, linDefl);
              shorter = j.polygons > 0 && (badness(j, linDefl) > 0 || std::fabs(j.area - j.exact) > 0.2 * j.exact);
              if (j.polygons > 0 && by < bestBy)
              {
                bestBy = by;
                bestFaces = faces;
                bestJ = j;
                best = std::move(rm);
              }
            }
            if (!best) continue;
            badBy[row] = bestBy;
            better.insert(row);
            kept[row] = bestJ;
            pending.erase(row);
            fails[row] = badness(bestJ, linDefl) > 0;
            // (A passing mesh's poly B-rep freed at once: SMLib's take about 6 kB a triangle, and a part may have
            // hundreds retried.)
            if (fails[row]) pending[row] = {std::move(best), &rb, bestFaces};
            else emit(rb, *best, bestFaces, local, ox, oy, oz, st, sides, ++source);
          }
          retries.push_back(std::move(rp));
          std::vector<int> still;
          for (int row : todo)
            if (fails[row] && real.count(row)) still.push_back(row);
          todo = still;
        }
        for (auto& [row, pd] : pending) emit(*pd.brep, *pd.mesh, pd.faces, local, ox, oy, oz, st, sides, ++source);
        pending.clear();
        st.improved += (int)better.size();
        for (auto& [f, j] : mb.faces)
          if (badBy.count(j.row) && !better.count(j.row)) chosen.insert(f);
      }
      emit(b, mb, chosen, local, ox, oy, oz, st, sides, (int)shell);
      for (auto& [f, j] : mb.faces) judged[shell].push_back(j);
      alone.insert(bad.begin(), bad.end());
      // (The retries' B-reps and meshes go before the poly B-rep they replaced faces of: retries before mb.)
      retries.clear();
    }
    std::vector<std::unique_ptr<BuiltPart>> retries;
    // Where a face meshed again can't be joined to the shell's faces along an edge, those faces don't end at the
    // model's vertices there (the healer moved or merged a vertex; or SMLib trimmed a face wrongly, its corner off
    // the vertex, in its shell and alone alike: trj3_s1-id-203.stp #569's face #5003, 1.7 mm). They are meshed alone
    // too, each way in turn, and the first mesh that passes and meets the faces already meshed alone is taken; and
    // so on from them, each face once.
    for (;;)
    {
      std::vector<int> more;
      for (long row : unjoinable(sides, guard))
        for (Side& s : sides[row])
          if (s.source < shells && s.face >= 0 && alone.insert(s.face).second) more.push_back((int)s.face);
      if (more.empty()) break;
      st.retried += (int)more.size();
      for (size_t w = 0; w < sizeof kWays / sizeof *kWays && !more.empty(); w++)
      {
        auto rp = std::make_unique<BuiltPart>();
        BuildOptions ro;
        ro.heal = kWays[w].heal;
        ro.linearDeflection = linDefl;
        ro.angularDeflection = angDefl;
        buildFaces(buf, len, more, plain, ro, lead.scale * kWays[w].scale, *rp);
        for (auto& rb : rp->breps)
        {
          if (rb.rows.size() != 1) continue;
          const long row = rb.rows[0];
          Meshed rm;
          tessellate(rb, linDefl, angDefl, rm, st);
          Judged j;
          std::set<SmFace*> faces;
          j.row = row;
          j.exact = 0;
          for (auto& [f, jf] : rm.faces)
          {
            faces.insert(f);
            j.area += jf.area;
            j.exact += jf.exact;
            j.perimeter += jf.perimeter;
            j.polygons += jf.polygons;
          }
          if (j.polygons == 0 || badness(j, linDefl) > 0) continue;
          // Tried against the other faces meshed alone, on the edges it shares with them.
          std::map<long, FaceMesh> trial;
          Sides mine;
          Stats none;
          emit(rb, rm, faces, trial, ox, oy, oz, none, mine, 1);
          bool fits = true;
          for (auto& [e, uses] : mine)
          {
            std::vector<Side> both = uses;
            for (Side& s : sides[e])
              if (s.source >= shells) both.push_back({0, s.kind, s.face, s.fm, s.segs});
            Sides one;
            one[e] = both;
            fits = fits && unjoinable(one, guard).empty();
          }
          if (!fits) continue;
          // The shell's mesh of the face dropped for this one.
          auto it = local.find(row);
          if (it != local.end())
          {
            for (auto& [e, of] : sides)
              of.erase(std::remove_if(of.begin(), of.end(), [&](const Side& s) { return s.fm == &it->second; }),
                of.end());
            local.erase(it);
          }
          emit(rb, rm, faces, local, ox, oy, oz, st, sides, ++source);
          kept[row] = j;
          st.improved++;
          more.erase(std::remove(more.begin(), more.end(), (int)row), more.end());
        }
        retries.push_back(std::move(rp));
      }
    }
    stitch(sides, guard);
    // (Folds out before the count: a fold's two triangles hide a boundary segment open once they are gone.)
    for (auto& [row, fm] : local) st.folded += unfold(fm);
    st.unjoined += openRows(part, sides, local);
    if (gEdges) emitEdges(part, sides);
    for (auto& [row, fm] : local)
    {
      FaceMesh& to = meshes[row];
      uint32_t base = (uint32_t)(to.pos.size() / 3);
      to.pos.insert(to.pos.end(), fm.pos.begin(), fm.pos.end());
      to.nrm.insert(to.nrm.end(), fm.nrm.begin(), fm.nrm.end());
      for (uint32_t i : fm.tri) to.tri.push_back(base + i);
    }
    if (gMeasures)
    {
      double s = scaleOf(lead.transform) * lead.scale;
      // A model face's measure: summed over the SMLib faces it became (healing splits a face at a seam), in the first
      // B-rep it's in; the retry's where that was kept.
      std::map<long, std::pair<double, double>> sums;
      std::map<long, size_t> in;
      for (size_t k = 0; k < judged.size(); k++)
        for (auto& j0 : judged[k])
        {
          if (j0.row < 0 || measured.count(j0.row) || in.emplace(j0.row, k).first->second != k) continue;
          auto it = sums.emplace(j0.row, std::make_pair(0.0, 0.0)).first;
          it->second.first += j0.exact;
          it->second.second += j0.perimeter;
        }
      for (auto& [row, j] : kept)
        if (!measured.count(row)) sums.emplace(row, std::make_pair(j.exact, j.perimeter));
      for (auto& [row, sum] : sums)
      {
        measured.insert(row);
        if (!idOf(part.faceIds, row)) continue;
        double exact = kept.count(row) ? kept[row].exact : sum.first;
        double perimeter = kept.count(row) ? kept[row].perimeter : sum.second;
        g.measures.insert(g.measures.end(), {(double)idOf(part.faceIds, row), exact * s * s, perimeter * s,
          std::isfinite(exact) ? 1.0 : 0.0});
      }
    }
  }
  int failed = 0;
  for (auto& [row, fm] : meshes)
  {
    // (Again over the groups' meshes together: a face in two shells meshed in each.)
    st.folded += unfold(fm);
    uint32_t base = (uint32_t)(g.positions.size() / 3);
    for (double x : fm.pos) g.positions.push_back((float)x);
    for (double x : fm.nrm) g.normals.push_back((float)x);
    g.faces.insert(g.faces.end(), {idOf(part.faceIds, row), (uint32_t)g.indices.size(), (uint32_t)fm.tri.size()});
    for (uint32_t i : fm.tri) g.indices.push_back(base + i);
  }
  for (long row : seen)
    if (!meshes.count(row) || meshes[row].tri.empty()) failed++;
  // Faces the builder left out (warned of, with why): the model's faces with an id never given to SMLib nor judged.
  std::set<long> given(seen.begin(), seen.end());
  for (const BuiltBrep& b : part.breps) given.insert(b.rows.begin(), b.rows.end());
  int leftOut = 0;
  for (size_t row = 0; row < part.faceIds.size(); row++)
    if (part.faceIds[row] && !given.count((long)row)) leftOut++;
  diag += ",\"faces\":" + std::to_string(st.faces) + ",\"failures\":" + std::to_string(failed)
    + ",\"leftOut\":" + std::to_string(leftOut)
    + ",\"polygons\":" + std::to_string(st.polygons) + ",\"tessErrors\":" + std::to_string(st.tessErrors)
    + ",\"unjoined\":" + std::to_string(st.unjoined) + ",\"folded\":" + std::to_string(st.folded)
    + ",\"retried\":" + std::to_string(st.retried)
    + ",\"improved\":" + std::to_string(st.improved) + ",\"msMeasures\":" + std::to_string(st.msMeasures)
    + ",\"msTessellate\":" + std::to_string(st.msTessellate);
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
    buildPart(reinterpret_cast<const uint8_t*>(aligned.data()), (size_t)len, opt, gScale, part);
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
    for (auto& c : part.curves)
    {
      Transform tr(c.transform);
      g.curves.insert(g.curves.end(), {c.id, (uint32_t)(g.curvePositions.size() / 3),
        (uint32_t)(c.points.size() / 3)});
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
      g.pointIds.push_back(pt.id);
    }
    g.diag = "{\"breps\":" + std::to_string(part.breps.size()) + meshDiag + ",\"builder\":" + builder + "}";
    return 0;
  }
  catch (const std::bad_alloc&)
  {
    g = Result();
    g.diag = "{\"error\":\"out of memory\"}";
    return -3;
  }
  catch (const std::exception& e)
  {
    g = Result();
    g.diag = "{\"error\":\"exception: " + jsonEscape(e.what()) + "\"}";
    return -3;
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
void smlib_set_scale(double scale) { gScale = scale >= 1 ? scale : 1; }
// Present where the id arrays are uint32 with 0 for none (a module built before had int32 with -1).
int smlib_ids_u32() { return 1; }
const float* smlib_positions() { return g.positions.data(); }
const float* smlib_normals() { return g.normals.data(); }
int smlib_num_vertices() { return (int)(g.positions.size() / 3); }
const uint32_t* smlib_indices() { return g.indices.data(); }
int smlib_num_indices() { return (int)g.indices.size(); }
const uint32_t* smlib_faces() { return g.faces.data(); }
int smlib_num_faces() { return (int)(g.faces.size() / 3); }
const float* smlib_edge_positions() { return g.edgePositions.data(); }
int smlib_num_edge_points() { return (int)(g.edgePositions.size() / 3); }
const uint32_t* smlib_edges() { return g.edges.data(); }
const float* smlib_edge_angles() { return g.edgeAngles.data(); }
int smlib_num_edges() { return (int)g.edgeAngles.size(); }
const double* smlib_measures() { return g.measures.data(); }
int smlib_num_measures() { return (int)(g.measures.size() / 4); }
const float* smlib_curve_positions() { return g.curvePositions.data(); }
int smlib_num_curve_points() { return (int)(g.curvePositions.size() / 3); }
const uint32_t* smlib_curves() { return g.curves.data(); }
int smlib_num_curves() { return (int)(g.curves.size() / 3); }
const float* smlib_points() { return g.points.data(); }
const uint32_t* smlib_point_ids() { return g.pointIds.data(); }
int smlib_num_points() { return (int)g.pointIds.size(); }
const char* smlib_diag() { return g.diag.c_str(); }
void smlib_free() { g = Result(); }
}
