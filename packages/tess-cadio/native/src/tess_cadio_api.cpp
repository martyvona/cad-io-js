// The module's C API (build.sh's `module`), which src/index.ts wraps: one part's B-rep buffer meshed (part.h) into
// flat arrays a TessellationResult is made of, held until the next call or tc_free. Positions are minus the origin,
// in double precision before single; faces' vertices are their own (normals differ across edges), their positions
// on a shared edge the same numbers. A model's loose items are given too: its curve items and wire bodies' edges as
// polylines (curves), its point items as points. The last result's diagnostics are a JSON object (tc_diag).
#include <cmath>
#include <cstdint>
#include <algorithm>
#include <cstring>
#include <memory>
#include <cstdio>
#include <string>
#include <vector>

#include "cad_geom/surface.h"
#include "tess_cadio/expected_counts.h"
#include "tess_cadio/part.h"
#include "tess_cadio/part_size.h"

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
  std::vector<float> positions, normals, edgePositions, edgeAngles, curvePositions, points;
  std::vector<uint32_t> indices, faces, edges, curves, pointIds;
  /**
   * What the meshing measured of each meshed face, for its triage record (cad-scene's records.ts): face id, its
   * deviation check (records.ts's CHECK) and value, its normal check and value, its point cap's expected count on its
   * last meshing (FaceMesh::capExpected): 6 numbers each.
   */
  std::vector<double> reported;
  std::string diag;
};
Result result;
/** tc_expected_counts' last answer: face id, expected count (0: none), 2 numbers each. */
std::vector<double> expectedOut;
/** records.ts's CHECK codes. */
enum : int { kUnchecked = 0, kMeasured = 1, kLowerBound = 2, kPassed = 3, kFailedUnmeasured = 4 };
bool project = true;
// PartOptions::checkDeviation and maxPointsPerFace for the next calls.
bool checkDeviation = PartOptions{}.checkDeviation;
int maxPoints = PartOptions{}.maxPointsPerFace;
// PartOptions::capFloor, capMultiple and capCeiling for the next calls.
double capFloor = PartOptions{}.capFloor, capMultiple = PartOptions{}.capMultiple,
  capCeiling = PartOptions{}.capCeiling;
// PartOptions::minAngle for the next calls (radians).
double minAngle = PartOptions{}.minAngle;
// Deflections::maxEdge for the next calls, a fraction of each part's partSize (0: none).
double maxEdgeFraction = 0;
// PartOptions::elementaryStretchCap for the next calls (0: none).
double elementaryStretchCap = 0;
// x in JSON, round-tripping.
std::string num(double x) {
  char b[32];
  std::snprintf(b, sizeof b, "%.17g", x);
  return b;
}
// PartOptions::countInsertions for the next calls.
bool countInsertions = false;
// PartOptions::countAngles for the next calls.
bool countAngles = false;
// Whether the next calls list each face's poles in the diagnostics ("poles").
bool listPoles = false;
// PartOptions::countExpected for the next calls.
bool countExpected = false;
// PartOptions::failCapped and failTurnedOver for the next calls.
bool failCapped = true, failTurnedOver = true;
// PartOptions::keepDefects for the next calls.
bool keepDefects = PartOptions{}.keepDefects;
// PartOptions::develop for the next calls.
bool develop = PartOptions{}.develop;
// PartOptions::areaBalance for the next calls (0: none).
double areaBalance = PartOptions{}.areaBalance;
// PartOptions::failFoldedFans for the next calls.
bool failFoldedFans = PartOptions{}.failFoldedFans;
// PartOptions::consistentFans and apexCorners for the next calls.
bool consistentFans = true, apexCorners = true;
// PartOptions::analysis for the next calls: the caller's buffer, kept alive by it until set again.
const uint8_t* analysis = nullptr;
size_t analysisSize = 0;

void put(std::vector<float>& out, Vec3 p, const double* o) {
  out.insert(out.end(), {static_cast<float>(p.x - o[0]), static_cast<float>(p.y - o[1]),
    static_cast<float>(p.z - o[2])});
}

/**
 * The options the next calls mesh `m` with (the setters' values), at these deflections: tc_tessellate's and
 * tc_expected_counts', so a face's expected count is the one its meshing caps it by. `partLength` the part's size
 * where maxEdge needs it, else 0.
 */
PartOptions partOptions(const Model& m, double linear, double angular, double& partLength) {
  PartOptions opts;
  opts.d.linear = linear;
  opts.d.angular = angular;
  partLength = maxEdgeFraction > 0 ? partSize(m) : 0;
  opts.d.maxEdge = maxEdgeFraction * partLength;
  opts.projectMissingPcurves = project;
  opts.checkDeviation = checkDeviation;
  opts.maxPointsPerFace = maxPoints;
  opts.capFloor = capFloor, opts.capMultiple = capMultiple, opts.capCeiling = capCeiling;
  opts.minAngle = minAngle;
  opts.elementaryStretchCap = elementaryStretchCap;
  opts.countInsertions = countInsertions;
  opts.countAngles = countAngles;
  opts.countExpected = countExpected;
  opts.failCapped = failCapped;
  opts.failTurnedOver = failTurnedOver;
  opts.keepDefects = keepDefects;
  opts.develop = develop;
  opts.areaBalance = areaBalance;
  opts.failFoldedFans = failFoldedFans;
  opts.consistentFans = consistentFans, opts.apexCorners = apexCorners;
  opts.analysis = analysis, opts.analysisSize = analysisSize;
  return opts;
}

std::string ids(const std::vector<uint32_t>& v) {
  std::string s = "[";
  for (size_t i = 0; i < v.size(); i++) s += (i ? "," : "") + std::to_string(v[i]);
  return s + "]";
}

} // namespace

extern "C" {

/** The API's version (src/index.ts's API_VERSION). */
int tc_api_version() { return 14; }

/**
 * Meshes the part in `data` (cad-brep's buffer, `size` bytes) at the deflections, positions minus (ox, oy, oz); with
 * `wantEdges`, its model edges as polylines too. 0, or -1 where the bytes aren't a model.
 */
/** Whether the next calls project uses without p-curves (PartOptions::projectMissingPcurves; default 1). */
void tc_set_project(int on) { project = on != 0; }

/** Whether the next calls check each face's deviation after the rounds (PartOptions::checkDeviation); default 1. */
void tc_set_check_deviation(int on) { checkDeviation = on != 0; }

/** The next calls' PartOptions::maxPointsPerFace (under 1: each face's cap by capFloor and the rest, the default). */
void tc_set_max_points(int points) { maxPoints = points > 0 ? points : -1; }
/**
 * The next calls' PartOptions::capFloor, capMultiple and capCeiling, triangles (defaults 200,000, 64 and 10M; each
 * not positive: its default).
 */
void tc_set_cap(double floor, double multiple, double ceiling) {
  const PartOptions d;
  capFloor = floor > 0 ? floor : d.capFloor, capMultiple = multiple > 0 ? multiple : d.capMultiple;
  capCeiling = ceiling > 0 ? ceiling : d.capCeiling;
}

/**
 * The next calls' PartOptions::minAngle in radians (default 10 degrees, at most 30; negative or not finite: the
 * default).
 */
void tc_set_min_angle(double radians) {
  minAngle = std::isfinite(radians) && radians >= 0 ? radians : PartOptions{}.minAngle;
}

/**
 * The next calls' longest edge (Deflections::maxEdge) as a fraction of each part's size (partSize); 0 (or negative,
 * or not finite): no limit.
 */
void tc_set_max_edge(double fraction) { maxEdgeFraction = std::isfinite(fraction) && fraction > 0 ? fraction : 0; }

/**
 * The next calls' PartOptions::elementaryStretchCap: elementary faces' stretch capped at this from their first
 * meshing; 0 (or under 1, or not finite): none.
 */
void tc_set_elementary_stretch_cap(double cap) { elementaryStretchCap = std::isfinite(cap) && cap >= 1 ? cap : 0; }

/**
 * Whether the next calls count the mesher's insertions by what queued them (PartOptions::countInsertions; default
 * 0).
 */
void tc_set_count_insertions(int on) { countInsertions = on != 0; }

/**
 * Whether the next calls count each face's triangles under the minimum angle (PartOptions::countAngles; default 0).
 */
void tc_set_count_angles(int on) { countAngles = on != 0; }
/**
 * Whether the next calls list each face's poles and apexes, as its closed surface has them (edges.h's closedSurface,
 * the one checkFacing exempts corners at), in the diagnostics ("poles"; default 0).
 */
void tc_set_list_poles(int on) { listPoles = on != 0; }
/**
 * Whether the next calls give each meshed face's triangles as its own size metric expects them
 * (PartOptions::countExpected) in the diagnostics ("expected"; default 0).
 */
void tc_set_count_expected(int on) { countExpected = on != 0; }

/**
 * Whether the next calls fail a face whose refinement reached its point cap (PartOptions::failCapped), and one with
 * a triangle turned against its surface (failTurnedOver); default 1 each. 0 keeps them, as meshed (for measuring).
 */
void tc_set_fail_capped(int on) { failCapped = on != 0; }
void tc_set_fail_turned_over(int on) { failTurnedOver = on != 0; }
/** Whether the next calls mesh each face in its developed plane (PartOptions::develop); default 1. */
void tc_set_develop(int on) { develop = on != 0; }
/**
 * The most a face's mesh area may gain or lose from its boundary's chords for the next calls, a fraction of its area
 * (PartOptions::areaBalance; default 0.02); 0 for no limit, a negative value the default.
 */
void tc_set_area_balance(double limit) { areaBalance = limit >= 0 ? limit : PartOptions{}.areaBalance; }
/**
 * Whether the next calls keep a face whose defect is small rather than failing it (PartOptions::keepDefects: a few
 * turned triangles, a little past its deflection, at its point cap; its defect in the diagnostics' "kept"); default 1.
 */
void tc_set_keep_defects(int on) { keepDefects = on != 0; }
/** Whether the next calls fail a face whose pole's fan folds over itself (PartOptions::failFoldedFans; default 1). */
void tc_set_fail_folded_fans(int on) { failFoldedFans = on != 0; }
/** Whether the next calls apply the fold rules (PartOptions::consistentFans, apexCorners; default 1 each). */
void tc_set_fan_rules(int consistent, int corners) { consistentFans = consistent != 0, apexCorners = corners != 0; }

/**
 * The model's analysis buffer for the next calls (PartOptions::analysis: 8-byte aligned, held by the caller until
 * set again), or none (size 0).
 */
void tc_set_analysis(const uint8_t* data, int size) {
  analysis = size > 0 ? data : nullptr;
  analysisSize = size > 0 ? static_cast<size_t>(size) : 0;
}

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
  double partLength = 0;
  PartOptions opts = partOptions(m, linear, angular, partLength);
  for (int k = 0; k < 3; k++) opts.outputOrigin[k] = o[k];
  const uint32_t* faceId = m.u32(CBR_FACE_ID);
  opts.progress = [&](const PartProgress& p) {
    js_progress(p.phase, p.row >= 0 ? faceId[p.row] : 0, p.row, p.round, p.facesDone, p.facesTotal);
  };
  PartMesher pm(m, opts);
  std::vector<uint32_t> failed, failedRows, failedStatus, refused, unsplit, unsettled, sampled, againstSense,
    holesOnly;
  std::vector<uint32_t> ringBlocked, ringBlockedRounds, capped, dropped, droppedCount;
  // (Each face kept with a defect, PartOptions::keepDefects: [id, turned, deviation over max(d, tol), capped 0/1, past
  // the limits 0/1, its edges off its surface past max(d, tol): 1 an edge, 2 a vertex, else 0, its id, the distance
  // in mm].)
  std::string kept = "[";
  std::vector<uint32_t> folded;
  std::vector<uint32_t> refusedBy(kRefusalKinds, 0), inserted(kInsertionKinds, 0), thin;
  std::string thinArea = "[";
  uint32_t folds = 0;
  std::vector<std::string> failedCause;
  // Refused triangles, and those of them in a pole's fan (a corner at a surface singularity's point).
  size_t refusedTriangles = 0, poleSlivers = 0;
  const Tolerances tols(m);
  // (With tc_set_list_poles: each face's singularities, 5 numbers each, absolute.)
  std::string poles = "[";
  if (listPoles)
    for (int f = 0; f < m.faces(); f++) {
      Status st;
      std::vector<Singularity> sing;
      if (std::unique_ptr<Surface> s = closedSurface(m, tols, f, st)) s->singularities(sing);
      for (const Singularity& g : sing) {
        char b[160];
        std::snprintf(b, sizeof b, "%s%u,%d,%.17g,%.17g,%.17g", poles.size() > 1 ? "," : "", faceId[f], int(g.kind),
          g.point.x, g.point.y, g.point.z);
        poles += b;
      }
    }
  poles += "]";
  // (With tc_set_count_expected: each face's expected triangles where it was meshed, those failed after (at the point
  // cap, turned) too, and its mesh's (0 where it failed), 3 numbers each.)
  std::string expected = "[";
  if (countExpected)
    for (int f = 0; f < m.faces(); f++) {
      const FaceMesh& fm = pm.face(f);
      if (!(fm.expectedTriangles > 0)) continue;
      char b[96];
      std::snprintf(b, sizeof b, "%s%u,%.6g,%zu", expected.size() > 1 ? "," : "", faceId[f], fm.expectedTriangles,
        fm.triangles.size() / 3);
      expected += b;
    }
  expected += "]";
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
      for (int k = 0; k < kInsertionKinds; k++) inserted[k] += static_cast<uint32_t>(fm.inserted[k]);
      if (fm.thin) {
        thin.insert(thin.end(), {faceId[f], static_cast<uint32_t>(fm.thin)});
        for (int k = 0; k < kThinBins; k++) thin.push_back(static_cast<uint32_t>(fm.thinByAngle[k]));
        thin.insert(thin.end(), {static_cast<uint32_t>(fm.thinBoundary), static_cast<uint32_t>(fm.thinFrozen),
          static_cast<uint32_t>(fm.thinFloor)});
        char a[32];
        std::snprintf(a, sizeof a, "%.6g", fm.thinArea);
        thinArea += (thinArea.size() > 1 ? "," : "") + std::string(a);
      }
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
      // (Its triage values: (c) passed where nothing it kept was refused for deviation, else its measured worst, a
      // lower bound where past the check's limit, failed unmeasured where not measured; and where its edges lie off
      // its surface past max(d, tol), at least that far (the mesh's points on them are); (d) passed where nothing
      // was refused for its normals, else failed unmeasured: the mesher doesn't keep the angle.)
      {
        const int byDeviation = fm.refusedBy[static_cast<int>(Refusal::deviationClosedForm)]
          + fm.refusedBy[static_cast<int>(Refusal::deviationSampled)]
          + fm.refusedBy[static_cast<int>(Refusal::deviationBounded)]
          + fm.refusedBy[static_cast<int>(Refusal::deviationNearPole)];
        const int byNormal = fm.refusedBy[static_cast<int>(Refusal::normalFacet)]
          + fm.refusedBy[static_cast<int>(Refusal::normalSpread)];
        int dev = !byDeviation ? kPassed : fm.worstDeviation > 0 ? (fm.defectDeviation > 0 ? kLowerBound
          : kMeasured) : kFailedUnmeasured;
        double value = dev == kMeasured || dev == kLowerBound ? fm.worstDeviation : NAN;
        if (fm.offSurfaceWithin > 0 && fm.offSurface > fm.offSurfaceWithin)
          dev = kLowerBound, value = std::isnan(value) ? fm.offSurface : std::fmax(value, fm.offSurface);
        result.reported.insert(result.reported.end(), {static_cast<double>(faceId[f]), static_cast<double>(dev),
          value,
          static_cast<double>(byNormal ? kFailedUnmeasured : kPassed), NAN, fm.capExpected});
      }
      if (fm.splitsWanted) unsplit.push_back(faceId[f]);
      if (fm.ringBlocked) ringBlocked.push_back(faceId[f]), ringBlockedRounds.push_back(fm.ringBlocked);
      if (fm.splitsDropped) dropped.push_back(faceId[f]), droppedCount.push_back(fm.splitsDropped);
      if (fm.defectTurned || fm.defectDeviation > 0 || fm.defectCapped) {
        char row[160];
        const bool off = fm.offSurfaceWithin > 0 && fm.offSurface > fm.offSurfaceWithin;
        const int offKind = !off ? 0 : fm.offSurfaceEdge >= 0 ? 1 : fm.offSurfaceVertex >= 0 ? 2 : 0;
        const uint32_t offId = offKind == 1 ? m.u32(CBR_EDGE_ID)[fm.offSurfaceEdge]
          : offKind == 2 ? m.u32(CBR_VERTEX_ID)[fm.offSurfaceVertex] : 0;
        std::snprintf(row, sizeof row, "%s[%u,%d,%.4g,%d,%d,%d,%u,%.4g]", kept.size() > 1 ? "," : "", faceId[f],
          fm.defectTurned, fm.defectDeviation, fm.defectCapped ? 1 : 0, fm.defectPastLimits ? 1 : 0, offKind, offId,
          offKind ? fm.offSurface : 0.0);
        kept += row;
      }
      if (fm.sampled) sampled.push_back(faceId[f]);
      if (fm.seamUnsettled) unsettled.push_back(faceId[f]);
      if (fm.againstSense) againstSense.push_back(faceId[f]);
      if (fm.holesOnly) holesOnly.push_back(faceId[f]);
      if (fm.foldsRepaired) folded.push_back(faceId[f]), folds += static_cast<uint32_t>(fm.foldsRepaired);
    } else {
      if (fm.capped) capped.push_back(faceId[f]);
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
  // The loose items, as the other backends give them: a curve item's polylines over its whole domain (a composite's
  // segments each one; their id the item's, else the curve's), a wire body's edges each as its samples (the edge's
  // id; one its EdgeMesh didn't sample within the criteria left out), a point item's point.
  std::vector<uint32_t> curvesLeftOut, curvesUnconverged;
  {
    const uint8_t* kind = m.u8(CBR_ITEM_KIND);
    const int32_t* ref = m.i32(CBR_ITEM_REF);
    const uint32_t* itemId = m.u32(CBR_ITEM_ID);
    EdgeOptions eo;
    eo.deflection = linear, eo.angle = angular;
    auto polyline = [&](uint32_t id, const std::vector<Vec3>& pts) {
      result.curves.insert(result.curves.end(), {id, static_cast<uint32_t>(result.curvePositions.size() / 3),
        static_cast<uint32_t>(pts.size())});
      for (Vec3 p : pts) put(result.curvePositions, p, o);
    };
    for (int i = 0; i < m.rows(CBR_ITEM_KIND); i++) {
      if (kind[i] == CBR_ITEM_CURVE) {
        const uint32_t id = itemId[i] ? itemId[i] : m.u32(CBR_CURVE_ID)[ref[i]];
        Status st;
        const std::vector<std::vector<Vec3>> lines = sampleLooseCurve(m, ref[i], eo, tol, st);
        if (st == Status::noConvergence) curvesUnconverged.push_back(id);
        else if (st != Status::ok || lines.empty()) curvesLeftOut.push_back(id);
        for (const std::vector<Vec3>& pts : lines) polyline(id, pts);
      } else if (kind[i] == CBR_ITEM_POINT) {
        const double* q = m.f64(CBR_POOL_ITEM_REAL) + ref[i];
        put(result.points, {q[0], q[1], q[2]}, o);
        result.pointIds.push_back(itemId[i]);
      } else if (kind[i] == CBR_ITEM_BODY && m.u8(CBR_BODY_KIND)[ref[i]] == CBR_BODY_WIRE) {
        const int b = ref[i];
        for (int k = m.i32(CBR_BODY_FIRST)[b]; k < m.i32(CBR_BODY_FIRST)[b] + m.i32(CBR_BODY_COUNT)[b]; k++) {
          const int e = m.i32(CBR_MEMBER_REF)[k];
          const EdgeSamples& es = pm.edges().edge(e);
          const uint32_t id = m.u32(CBR_EDGE_ID)[e];
          // (Not sampled within the criteria: left out, as its faces would fail for it. An edge from a vertex back
          // to it on a line runs to the sampler's cap.)
          if (es.status != Status::ok || es.points.size() < 2) curvesLeftOut.push_back(id);
          else polyline(id, es.points);
        }
      }
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
    ",\"againstSense\":" + ids(againstSense) + ",\"holesOnly\":" + ids(holesOnly) + ",\"folded\":" + ids(folded) +
    ",\"ringBlocked\":" + ids(ringBlocked) + ",\"ringBlockedRounds\":" + ids(ringBlockedRounds) +
    ",\"splitsDropped\":" + ids(dropped) + ",\"splitsDroppedCount\":" + ids(droppedCount) + ",\"capped\":" +
    ids(capped) + ",\"kept\":" + kept + "]" +
    ",\"refusedBy\":" + ids(refusedBy) + ",\"inserted\":" + ids(inserted) + ",\"thin\":" + ids(thin) +
    ",\"thinArea\":" + thinArea + "]" + ",\"folds\":" +
    std::to_string(folds) + ",\"projections\":[" + std::to_string(pc.withinMesh) + "," +
    std::to_string(pc.atEdgeTolerance) + "," + std::to_string(pc.byInversion) + "],\"traces\":[" +
    std::to_string(tc.local) + "," + std::to_string(tc.global) + "],\"traceFallbacks\":" + fallbacks + ",\"rounds\":" +
    std::to_string(pm.rounds()) + ",\"refusedTriangles\":" + std::to_string(refusedTriangles) +
    ",\"poleSlivers\":" + std::to_string(poleSlivers) + ",\"curvesLeftOut\":" + ids(curvesLeftOut) +
    ",\"curvesUnconverged\":" + ids(curvesUnconverged) + (listPoles ? ",\"poles\":" + poles : std::string()) +
    (countExpected ? ",\"expected\":" + expected : std::string()) +
    (opts.d.maxEdge > 0 ? ",\"maxEdge\":[" + num(opts.d.maxEdge) + "," + num(partLength) + "]" : std::string()) + "}";
  return 0;
}

/**
 * The model's partSize (part_size.h), the length tc_set_max_edge's fraction is of: what judging another backend's
 * mesh by the same limit takes as the part's size. -1 if the buffer isn't a model.
 */
double tc_part_size(const uint8_t* data, int size) {
  std::vector<uint64_t> buf((static_cast<size_t>(size) + 7) / 8);
  std::memcpy(buf.data(), data, static_cast<size_t>(size));
  const Model m(reinterpret_cast<const uint8_t*>(buf.data()), static_cast<size_t>(size));
  return m.ok() ? partSize(m) : -1;
}

/**
 * Each face's expected triangles (expected_counts.h: its first meshing's point cap count, with the setters' options,
 * the analysis among them, as tc_tessellate would mesh it), into tc_expected_out: 2 numbers a face, its id and the
 * count (0: none). The number of faces, or -1 if the buffer isn't a model. tc_tessellate's result is kept.
 */
int tc_expected_counts(const uint8_t* data, int size, double linear, double angular) {
  expectedOut.clear();
  std::vector<uint64_t> buf((static_cast<size_t>(size) + 7) / 8);
  std::memcpy(buf.data(), data, static_cast<size_t>(size));
  const Model m(reinterpret_cast<const uint8_t*>(buf.data()), static_cast<size_t>(size));
  if (!m.ok()) return -1;
  double partLength = 0;
  for (const auto& [id, n] : expectedCounts(m, partOptions(m, linear, angular, partLength)))
    expectedOut.insert(expectedOut.end(), {static_cast<double>(id), n});
  return static_cast<int>(expectedOut.size() / 2);
}
const double* tc_expected_out() { return expectedOut.data(); }

int tc_num_reported() { return static_cast<int>(result.reported.size() / 6); }
const double* tc_reported() { return result.reported.data(); }

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
/** Per loose curve (a curve item, a wire body's edge): its id (0: none), its first point, its point count. */
int tc_num_curves() { return static_cast<int>(result.curves.size() / 3); }
const uint32_t* tc_curves() { return result.curves.data(); }
int tc_num_curve_points() { return static_cast<int>(result.curvePositions.size() / 3); }
const float* tc_curve_positions() { return result.curvePositions.data(); }
/** The point items: their positions, and each one's id (0: none). */
int tc_num_points() { return static_cast<int>(result.pointIds.size()); }
const float* tc_points() { return result.points.data(); }
const uint32_t* tc_point_ids() { return result.pointIds.data(); }
/**
 * The last call's diagnostics: {"failed": [face ids], "failedRows", "failedStatus" (each one's result.h Status: an
 * empty triangulation counts as invalidModel), "failedCause" (each one's FaceMesh::cause), "refused", "unsplit",
 * "unsettled", "sampled" (faces whose deviation accept() sampled rather than bounded: SurfaceCriteria::bounded),
 * "refusedBy" (the refused triangles by why: criteria.h's Refusal as indices, [0] unused), "inserted" (with
 * tc_set_count_insertions, the meshed faces' Steiner points by what queued them: part.h's FaceMesh::inserted, summed),
 * "thin" and "thinArea" (with tc_set_count_angles, per meshed face with triangles under the minimum angle, 11 numbers
 * [face id, count, by angle under 1, 2, 5, 8, 10 degrees and the rest, every corner on the boundary, an edge frozen,
 * within the floor] and its area of them in mm^2: FaceMesh::thin and the rest),
 * "againstSense" (faces with a loop against their sense, meshed: FaceBoundary::againstSense), "holesOnly" (faces whose
 * edge loops are all holes, meshed as their surface's natural extent less them: FaceBoundary::holesOnly), "folded"
 * and "folds" (the faces with boundary folds repaired, and how many: FaceBoundary::foldsRepaired), "projections" (the
 * uses without p-curves, by how they were sampled: EdgeMesh::projections, [withinMesh, atEdgeTolerance,
 * byInversion]), "traces" (the samples of uses traced sample by sample, [local, global]: EdgeMesh::traces) and
 * "traceFallbacks" (each local step that fell back on the global search, [edge id, t, distance, why]), "rounds",
 * "refusedTriangles", "poleSlivers" (refused triangles with a corner at a pole or apex), "ringBlocked" and
 * "ringBlockedRounds" (the faces whose refinement asked for a pole ring's segment to be split, which a ring's never
 * is, and in how many rounds: FaceMesh::ringBlocked), "splitsDropped" and "splitsDroppedCount" (the faces whose
 * refinement asked for a split of a segment that is no edge's, crease's or ring's, and how many requests:
 * FaceMesh::splitsDropped; none expected), "capped" (the faces failed for refinement stopped at the
 * point cap: FaceMesh::capped), "kept" (the faces kept with a defect, PartOptions::keepDefects: [face id, triangles
 * turned, measured deviation over max(d, tol) where past the limit else 0, 1 if at its point cap, 1 if past the
 * keep limits, 1 if an edge or 2 if a vertex lies off its surface past max(d, tol) else 0, that edge's or vertex's
 * id, its distance in mm: FaceMesh::offSurface] each), "poles"
 * (with tc_set_list_poles, every face's singularities as its closed surface has them, 5 numbers each [face id,
 * cad-geom's Singularity::kind, x, y, z], absolute), "expected" (with
 * tc_set_count_expected, each face's [face id, triangles its size metric expects: FaceMesh::expectedTriangles,
 * triangles meshed], for every face its mesher meshed, 0 meshed where it failed after: at its point cap, say),
 * "curvesLeftOut" (the loose curves not given, or a composite's segments not: not made, unbounded, an edge not
 * sampled) and "curvesUnconverged"
 * (those given whose sampling ran out of refinement), by id}.
 */
const char* tc_diag() { return result.diag.c_str(); }
void tc_free() { result = {}; }

} // extern "C"
