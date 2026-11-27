// What part.h's tests share (part_test.cpp, part_criteria_test.cpp, part_rounds_test.cpp): the test models by name,
// and checks of a part's mesh against its model (edges' samples shared, closed and oriented shells, poles' fans,
// deviation statistics).
#pragma once
#include <tess_cadio/criteria.h>
#include <tess_cadio/edges.h>
#include <tess_cadio/part.h>
#include <tess_cadio/part_size.h>

#include <cad_geom/surface.h>
#include <cad_geom/tolerance.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <random>
#include <map>
#include <memory>
#include <array>
#include <set>
#include <string>
#include <tuple>

#include "brep_models.h"
#include "check.h"
#include "tess_models.h"

using namespace tesscadio;
using cadgeom::Vec3;

namespace parttest {

inline cadgeom::Model load(const char* name) {
  if (const tessfixtures::Model* t = tessfixtures::model(name)) return cadgeom::Model(t->data, t->size);
  const fixtures::Model* f = fixtures::model(name);
  return cadgeom::Model(f ? f->data : nullptr, f ? f->size : 0);
}

/** A test model's bytes with every coedge's p-curve removed (-1): what the projection must make again. */
inline std::vector<uint8_t> withoutPcurves(const char* name) {
  const tessfixtures::Model* t = tessfixtures::model(name);
  const fixtures::Model* f = t ? nullptr : fixtures::model(name);
  const uint8_t* data = t ? t->data : f ? f->data : nullptr;
  std::vector<uint8_t> b(data, data + (t ? t->size : f ? f->size : 0));
  cadgeom::Model m(b.data(), b.size());
  if (m.ok()) {
    int32_t* pc = const_cast<int32_t*>(m.i32(CBR_COEDGE_PCURVE));
    for (int c = 0; c < m.coedges(); c++) pc[c] = -1;
  }
  return b;
}

using Key = std::tuple<double, double, double>;
inline Key key(Vec3 p) { return {p.x, p.y, p.z}; }

/** The faces using each model edge (by its loops), each face once. */
inline std::map<int, std::vector<int>> edgeFaces(const cadgeom::Model& m) {
  std::map<int, std::vector<int>> out;
  for (int f = 0; f < m.faces(); f++)
    for (int i = 0; i < m.faceLoopCount(f); i++) {
      int l = m.faceFirstLoop(f) + i;
      if (m.loopKind(l) != CBR_LOOP_EDGE) continue;
      for (int k = 0; k < m.loopCount(l); k++) {
        std::vector<int>& fs = out[m.coedgeEdge(m.loopFirst(l) + k)];
        if (fs.empty() || fs.back() != f) fs.push_back(f);
      }
    }
  return out;
}

/** Each model edge's samples in each of its faces: every point there, every span a triangle's side. */
inline int sharedEdges(const cadgeom::Model& m, const PartMesher& pm, const char* what) {
  int bad = 0;
  // Per face, once: its vertices by point (a seam's points and a closed edge's vertex are at several: any of them),
  // its triangles' sides.
  std::vector<std::map<Key, std::vector<int>>> ats(m.faces());
  std::vector<std::set<std::pair<int, int>>> sideSets(m.faces());
  for (int f = 0; f < m.faces(); f++) {
    const FaceMesh& fm = pm.face(f);
    for (size_t i = 0; i < fm.points.size(); i++) ats[f][key(fm.points[i])].push_back(static_cast<int>(i));
    for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3)
      for (int k = 0; k < 3; k++) {
        int a = fm.triangles[t + k], b = fm.triangles[t + (k + 1) % 3];
        sideSets[f].insert({std::min(a, b), std::max(a, b)});
      }
  }
  for (auto& [e, fs] : edgeFaces(m)) {
    const EdgeSamples& s = pm.edges().edge(e);
    for (int f : fs) {
      const FaceMesh& fm = pm.face(f);
      if (fm.status != cadgeom::Status::ok) continue;
      const std::map<Key, std::vector<int>>& at = ats[f];
      const std::set<std::pair<int, int>>& sides = sideSets[f];
      int missing = 0, unjoined = 0;
      for (size_t i = 0; i < s.points.size(); i++) {
        auto it = at.find(key(s.points[i]));
        if (it == at.end()) {
          missing++;
          continue;
        }
        // (A span from a point to itself, an edge of no length's, is no side: no gap, as openEdges has it.)
        if (i + 1 < s.points.size() && key(s.points[i + 1]) != key(s.points[i])) {
          auto jt = at.find(key(s.points[i + 1]));
          bool joined = false;
          if (jt != at.end())
            for (int a : it->second)
              for (int b : jt->second) joined = joined || sides.count({std::min(a, b), std::max(a, b)});
          if (!joined) unjoined++;
        }
      }
      if (missing || unjoined) {
        std::printf("  %s: edge %d in face %d: %d samples missing, %d spans no triangle's side\n", what, e, f, missing,
          unjoined);
        bad++;
      }
    }
  }
  return bad;
}

/** A closed shell: every directed side by 3D points used once, and its reverse once. */
inline int closedAndOriented(const PartMesher& pm, int nf) {
  std::map<std::pair<Key, Key>, int> uses;
  for (int f = 0; f < nf; f++) {
    const FaceMesh& fm = pm.face(f);
    for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3)
      for (int k = 0; k < 3; k++)
        uses[{key(fm.points[fm.triangles[t + k]]), key(fm.points[fm.triangles[t + (k + 1) % 3]])}]++;
  }
  int bad = 0;
  for (auto& [side, n] : uses) {
    auto rev = uses.find({side.second, side.first});
    if (n != 1 || rev == uses.end() || rev->second != 1) bad++;
  }
  return bad;
}

/** Whether triangle t (an index into triangles / 3) has a corner within `near` of `pole` (at it, by default). */
inline bool atPole(const FaceMesh& fm, int32_t t, Vec3 pole, double near = 1e-12) {
  for (int k = 0; k < 3; k++)
    if (cadgeom::norm(fm.points[fm.triangles[3 * t + k]] - pole) < near) return true;
  return false;
}

struct Stats {
  double area = 0, worst = 0;
  int badNormals = 0, facing = 0;
};
/**
 * A face's mesh: its area, its triangles' worst distance from the surface (by `dist`, the surface's own measure),
 * normals not unit or not finite, triangles facing against their corners' normals.
 */
template <class Dist> Stats stats(const FaceMesh& fm, Dist dist, const Vec3* pole = nullptr, double near = 1e-12) {
  Stats s;
  for (const Vec3& n : fm.normals)
    if (!std::isfinite(n.x) || !std::isfinite(n.y) || !std::isfinite(n.z) || std::fabs(cadgeom::norm(n) - 1) > 1e-9)
      s.badNormals++;
  for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3) {
    Vec3 a = fm.points[fm.triangles[t]], b = fm.points[fm.triangles[t + 1]], c = fm.points[fm.triangles[t + 2]];
    Vec3 g = cadgeom::cross(b - a, c - a);
    s.area += 0.5 * cadgeom::norm(g);
    Vec3 nsum = fm.normals[fm.triangles[t]] + fm.normals[fm.triangles[t + 1]] + fm.normals[fm.triangles[t + 2]];
    // (A pole's fan's slivers aside: poleFanOnly.)
    if (cadgeom::dot(g, nsum) <= 0 && !(pole && atPole(fm, static_cast<int32_t>(t / 3), *pole, near))) s.facing++;
    for (double u : {1. / 3, 0.5}) {
      Vec3 p = u == 0.5 ? 0.5 * (a + b) : (1.0 / 3) * (a + b + c);
      s.worst = std::fmax(s.worst, dist(p));
    }
  }
  return s;
}

/**
 * The face's refused triangles other than those in a pole's fan (a corner at `pole`): slivers there, skewed or turned
 * over in 3D, that refinement in (u, v) can't reach until poles are meshed as fans.
 */
inline int poleFanOnly(const FaceMesh& fm, Vec3 pole, double near = 1e-12) {
  int bad = 0;
  for (int32_t t : fm.rejected)
    if (!atPole(fm, t, pole, near)) {
      std::printf("  triangle %d refused, away from the pole\n", t);
      bad++;
    }
  return bad;
}

inline PartOptions options(double linear, double angular) {
  PartOptions o;
  o.d.linear = linear;
  o.d.angular = angular;
  return o;
}

}  // namespace parttest


using namespace parttest;
