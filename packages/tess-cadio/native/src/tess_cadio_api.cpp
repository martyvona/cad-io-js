// The module's C API (build.sh's `module`), which src/index.ts wraps: one part's B-rep buffer meshed (part.h) into
// flat arrays a TessellationResult is made of, held until the next call or tc_free. Positions are minus the origin,
// in double precision before single; faces' vertices are their own (normals differ across edges), their positions
// on a shared edge the same numbers. The last result's diagnostics are a JSON object (tc_diag).
#include <cmath>
#include <cstdint>
#include <algorithm>
#include <cstring>
#include <memory>
#include <cstdio>
#include <string>
#include <vector>

#include "cad_geom/surface.h"
#include "tess_cadio/part.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
// Progress to src/index.ts, which throttles it (Module.tcProgress, set for the call); natively, nothing.
EM_JS(void, js_progress, (int phase, uint32_t id, int row, int round, int done, int total), {
  if (Module['tcProgress']) Module['tcProgress'](phase, id, row, round, done, total);
});
#else
static void js_progress(int, uint32_t, int, int, int, int) {}
#endif

using namespace tesscadio;
using namespace cadgeom;

namespace {

/** EdgeKind's codes (cad-scene's scene.ts): src/index.ts's KINDS. */
enum : uint32_t { kShared = 0, kSeam = 1, kFree = 2 };

struct Result {
  std::vector<float> positions, normals, edgePositions, edgeAngles;
  std::vector<uint32_t> indices, faces, edges;
  std::string diag;
};
Result result;
bool project = true;
// PartOptions::maxDeviationFactor and maxPointsPerFace for the next calls.
double deviationFactor = 1.0;
int maxPoints = PartOptions{}.maxPointsPerFace;

void put(std::vector<float>& out, Vec3 p, const double* o) {
  out.insert(out.end(), {static_cast<float>(p.x - o[0]), static_cast<float>(p.y - o[1]),
    static_cast<float>(p.z - o[2])});
}

std::string ids(const std::vector<uint32_t>& v) {
  std::string s = "[";
  for (size_t i = 0; i < v.size(); i++) s += (i ? "," : "") + std::to_string(v[i]);
  return s + "]";
}

} // namespace

extern "C" {

/** The API's version (src/index.ts's API_VERSION). */
int tc_api_version() { return 4; }

/**
 * Meshes the part in `data` (cad-brep's buffer, `size` bytes) at the deflections, positions minus (ox, oy, oz); with
 * `wantEdges`, its model edges as polylines too. 0, or -1 where the bytes aren't a model.
 */
/** Whether the next calls project uses without p-curves (PartOptions::projectMissingPcurves; default 1). */
void tc_set_project(int on) { project = on != 0; }

/** The next calls' PartOptions::maxDeviationFactor (default 1; 0 or less: never). */
void tc_set_deviation_factor(double factor) { deviationFactor = factor; }

/** The next calls' PartOptions::maxPointsPerFace (default 100,000; under 1: the default). */
void tc_set_max_points(int points) { maxPoints = points > 0 ? points : PartOptions{}.maxPointsPerFace; }

int tc_tessellate(const uint8_t* data, int size, double linear, double angular, double ox, double oy, double oz,
  int wantEdges) {
  result = {};
  // (The model's views need 8-byte alignment: a copy that has it.)
  std::vector<uint64_t> buf((static_cast<size_t>(size) + 7) / 8);
  std::memcpy(buf.data(), data, static_cast<size_t>(size));
  const Model m(reinterpret_cast<const uint8_t*>(buf.data()), static_cast<size_t>(size));
  if (!m.ok()) {
    result.diag = "{\"error\":\"not a cad-brep model\"}";
    return -1;
  }
  const double o[3] = {ox, oy, oz};
  PartOptions opts;
  opts.d.linear = linear;
  opts.d.angular = angular;
  opts.projectMissingPcurves = project;
  opts.maxDeviationFactor = deviationFactor;
  opts.maxPointsPerFace = maxPoints;
  const uint32_t* faceId = m.u32(CBR_FACE_ID);
  opts.progress = [&](const PartProgress& p) {
    js_progress(p.phase, p.row >= 0 ? faceId[p.row] : 0, p.row, p.round, p.facesDone, p.facesTotal);
  };
  PartMesher pm(m, opts);
  std::vector<uint32_t> failed, failedRows, failedStatus, refused, unsplit, unsettled, sampled, againstSense;
  std::vector<uint32_t> ringBlocked, ringBlockedRounds, capped;
  std::vector<uint32_t> folded;
  std::vector<uint32_t> refusedBy(kRefusalKinds, 0);
  uint32_t folds = 0;
  std::vector<std::string> failedCause;
  // Refused triangles, and those of them in a pole's fan (a corner at a surface singularity's point).
  size_t refusedTriangles = 0, poleSlivers = 0;
  const Tolerances tols(m);
  const double tol = tols.part();
  for (int f = 0; f < m.faces(); f++) {
    const FaceMesh& fm = pm.face(f);
    uint32_t base = static_cast<uint32_t>(result.positions.size() / 3), start = static_cast<uint32_t>(
      result.indices.size());
    if (fm.status == Status::ok && !fm.triangles.empty()) {
      for (size_t i = 0; i < fm.points.size(); i++) {
        put(result.positions, fm.points[i], o);
        Vec3 n = fm.normals[i];
        result.normals.insert(result.normals.end(), {static_cast<float>(n.x), static_cast<float>(n.y),
          static_cast<float>(n.z)});
      }
      for (int32_t v : fm.triangles) result.indices.push_back(base + static_cast<uint32_t>(v));
      if (!fm.rejected.empty()) {
        refused.push_back(faceId[f]);
        refusedTriangles += fm.rejected.size();
        for (int k = 0; k < kRefusalKinds; k++) refusedBy[k] += static_cast<uint32_t>(fm.refusedBy[k]);
        Status st;
        std::vector<Singularity> sing;
        if (std::unique_ptr<Surface> s = closedSurface(m, tols, f, st)) s->singularities(sing);
        for (int32_t t : fm.rejected) {
          bool pole = false;
          for (int k = 0; k < 3 && !pole; k++)
            for (const Singularity& g : sing)
              pole = pole || (g.kind != Singularity::normalVanishes &&
                norm(fm.points[fm.triangles[3 * t + k]] - g.point) <= tol);
          poleSlivers += pole;
        }
      }
      if (fm.splitsWanted) unsplit.push_back(faceId[f]);
      if (fm.ringBlocked) ringBlocked.push_back(faceId[f]), ringBlockedRounds.push_back(fm.ringBlocked);
      if (fm.sampled) sampled.push_back(faceId[f]);
      if (fm.seamUnsettled) unsettled.push_back(faceId[f]);
      if (fm.capped) capped.push_back(faceId[f]);
      if (fm.againstSense) againstSense.push_back(faceId[f]);
      if (fm.foldsRepaired) folded.push_back(faceId[f]), folds += static_cast<uint32_t>(fm.foldsRepaired);
    } else {
      failed.push_back(faceId[f]);
      failedRows.push_back(static_cast<uint32_t>(f));
      failedStatus.push_back(static_cast<uint32_t>(fm.status == Status::ok ? Status::invalidModel : fm.status));
      failedCause.push_back(fm.status == Status::ok ? "meshed to no triangles" : fm.cause.empty() ? "cause not given"
        : fm.cause);
    }
    result.faces.insert(result.faces.end(), {faceId[f], start, static_cast<uint32_t>(result.indices.size()) - start});
  }
  if (wantEdges) {
    // Each model edge some face uses: its samples; its kind by its uses (one face twice: a seam; two or more faces:
    // shared, its dihedral the largest angle between their normals at its samples; else free).
    std::vector<std::vector<int>> uses(m.edges());
    for (int f = 0; f < m.faces(); f++)
      for (int i = 0; i < m.faceLoopCount(f); i++) {
        int l = m.faceFirstLoop(f) + i;
        if (m.loopKind(l) != CBR_LOOP_EDGE) continue;
        for (int k = 0; k < m.loopCount(l); k++) uses[m.coedgeEdge(m.loopFirst(l) + k)].push_back(m.loopFirst(l) + k);
      }
    std::vector<std::unique_ptr<Surface>> surfaces(m.faces());
    auto surface = [&](int f) -> const Surface* {
      Status st;
      if (!surfaces[f]) surfaces[f] = closedSurface(m, tols, f, st);
      return surfaces[f].get();
    };
    auto faceOf = [&](int c) {
      for (int f = 0; f < m.faces(); f++)
        for (int i = 0; i < m.faceLoopCount(f); i++) {
          int l = m.faceFirstLoop(f) + i;
          if (m.loopKind(l) == CBR_LOOP_EDGE && c >= m.loopFirst(l) && c < m.loopFirst(l) + m.loopCount(l)) return f;
        }
      return -1;
    };
    const uint32_t* edgeId = m.u32(CBR_EDGE_ID);
    for (int e = 0; e < m.edges(); e++) {
      const EdgeSamples& s = pm.edges().edge(e);
      if (uses[e].empty() || s.points.size() < 2) continue;
      std::vector<int> fs;
      for (int c : uses[e]) fs.push_back(faceOf(c));
      bool seam = fs.size() == 2 && fs[0] == fs[1];
      int distinct = 0;
      for (size_t i = 0; i < fs.size(); i++) distinct += std::find(fs.begin(), fs.begin() + i, fs[i]) == fs.begin() + i;
      uint32_t kind = seam ? kSeam : distinct >= 2 ? kShared : kFree;
      float angle = -1;
      if (kind == kShared && uses[e].size() == 2) {
        double worst = 0;
        const CoedgeSamples &a = pm.edges().coedge(uses[e][0]), &b = pm.edges().coedge(uses[e][1]);
        const Surface *sa = surface(fs[0]), *sb = surface(fs[1]);
        if (sa && sb && a.uv.size() == s.points.size() && b.uv.size() == s.points.size()) {
          double ga = m.faceSameSense(fs[0]) ? 1 : -1, gb = m.faceSameSense(fs[1]) ? 1 : -1;
          // Each sample's (u, v) in each use (index[i] the edge's sample at use position i).
          std::vector<Vec2> ua(s.points.size()), ub(s.points.size());
          for (size_t i = 0; i < a.uv.size(); i++) ua[a.index[i]] = a.uv[i];
          for (size_t i = 0; i < b.uv.size(); i++) ub[b.index[i]] = b.uv[i];
          for (size_t i = 0; i < s.points.size(); i++) {
            Vec3 na, nb;
            if (sa->normal(ua[i].x, ua[i].y, na) != Status::ok || sb->normal(ub[i].x, ub[i].y, nb) != Status::ok)
              continue;
            worst = std::fmax(worst, std::acos(std::fmin(1.0, std::fmax(-1.0, ga * gb * dot(na, nb)))));
          }
          angle = static_cast<float>(worst);
        }
      }
      uint32_t first = static_cast<uint32_t>(result.edgePositions.size() / 3);
      for (Vec3 p : s.points) put(result.edgePositions, p, o);
      result.edges.insert(result.edges.end(), {edgeId[e], first, static_cast<uint32_t>(s.points.size()), kind});
      result.edgeAngles.push_back(angle);
    }
  }
  // (Causes are this code's own ASCII phrases: no quotes or backslashes to escape.)
  std::string causes = "[";
  for (size_t i = 0; i < failedCause.size(); i++) causes += (i ? ",\"" : "\"") + failedCause[i] + "\"";
  causes += "]";
  const ProjectionCounts& pc = pm.edges().projections();
  const TraceCounts& tc = pm.edges().traces();
  // Each local step that fell back on the global search: [edge id, edge parameter, distance, why].
  std::string fallbacks = "[";
  for (const TraceFallback& x : pm.edges().traceFallbacks()) {
    char row[96];
    std::snprintf(row, sizeof row, "[%u,%.17g,%.17g,\"", m.u32(CBR_EDGE_ID)[m.coedgeEdge(x.coedge)], x.t,
      x.distance);
    fallbacks += (fallbacks.size() > 1 ? "," : "") + std::string(row) + x.why + "\"]";
  }
  fallbacks += "]";
  result.diag = "{\"failed\":" + ids(failed) + ",\"failedRows\":" + ids(failedRows) + ",\"failedStatus\":" +
    ids(failedStatus) + ",\"failedCause\":" + causes + ",\"refused\":" + ids(refused) +
    ",\"unsplit\":" + ids(unsplit) + ",\"unsettled\":" + ids(unsettled) + ",\"sampled\":" + ids(sampled) +
    ",\"againstSense\":" + ids(againstSense) + ",\"folded\":" + ids(folded) + ",\"ringBlocked\":" +
    ids(ringBlocked) + ",\"ringBlockedRounds\":" + ids(ringBlockedRounds) + ",\"capped\":" + ids(capped) +
    ",\"refusedBy\":" + ids(refusedBy) + ",\"folds\":" +
    std::to_string(folds) + ",\"projections\":[" + std::to_string(pc.withinMesh) + "," +
    std::to_string(pc.atEdgeTolerance) + "," + std::to_string(pc.byInversion) + "],\"traces\":[" +
    std::to_string(tc.local) + "," + std::to_string(tc.global) + "],\"traceFallbacks\":" + fallbacks + ",\"rounds\":" +
    std::to_string(pm.rounds()) + ",\"refusedTriangles\":" + std::to_string(refusedTriangles) +
    ",\"poleSlivers\":" + std::to_string(poleSlivers) + "}";
  return 0;
}

int tc_num_vertices() { return static_cast<int>(result.positions.size() / 3); }
const float* tc_positions() { return result.positions.data(); }
const float* tc_normals() { return result.normals.data(); }
int tc_num_indices() { return static_cast<int>(result.indices.size()); }
const uint32_t* tc_indices() { return result.indices.data(); }
/** Per face row: its id (0: none), its first index, its index count. */
int tc_num_faces() { return static_cast<int>(result.faces.size() / 3); }
const uint32_t* tc_faces() { return result.faces.data(); }
/** Per edge: its id (0: none), its first point, its point count, its kind (shared 0, seam 1, free 2). */
int tc_num_edges() { return static_cast<int>(result.edges.size() / 4); }
const uint32_t* tc_edges() { return result.edges.data(); }
/** Per edge: its dihedral in radians, -1 where it has none. */
const float* tc_edge_angles() { return result.edgeAngles.data(); }
int tc_num_edge_points() { return static_cast<int>(result.edgePositions.size() / 3); }
const float* tc_edge_positions() { return result.edgePositions.data(); }
/**
 * The last call's diagnostics: {"failed": [face ids], "failedRows", "failedStatus" (each one's result.h Status: an
 * empty triangulation counts as invalidModel), "failedCause" (each one's FaceMesh::cause), "refused", "unsplit",
 * "unsettled", "sampled" (faces whose deviation accept() sampled rather than bounded: SurfaceCriteria::bounded),
 * "refusedBy" (the refused triangles by why: criteria.h's Refusal as indices, [0] unused),
 * "againstSense" (faces with a loop against their sense, meshed: FaceBoundary::againstSense), "folded" and "folds"
 * (the faces with boundary folds repaired, and how many: FaceBoundary::foldsRepaired), "projections" (the
 * uses without p-curves, by how they were sampled: EdgeMesh::projections, [withinMesh, atEdgeTolerance,
 * byInversion]), "traces" (the samples of uses traced sample by sample, [local, global]: EdgeMesh::traces) and
 * "traceFallbacks" (each local step that fell back on the global search, [edge id, t, distance, why]), "rounds",
 * "refusedTriangles", "poleSlivers" (refused triangles with a corner at a pole or apex), "ringBlocked" and
 * "ringBlockedRounds" (the faces whose refinement asked for a pole ring's segment to be split, which a ring's never
 * is, and in how many rounds: FaceMesh::ringBlocked), "capped" (the faces whose refinement stopped at the point
 * cap: FaceMesh::capped)}.
 */
const char* tc_diag() { return result.diag.c_str(); }
void tc_free() { result = {}; }

} // extern "C"
