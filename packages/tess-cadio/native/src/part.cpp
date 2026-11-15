// part.h: the edges sampled twice, first to find each face's (u, v) box for its criteria, then with the spacing the
// criteria ask of each face's edges; every face meshed; then rounds of the splits the faces' meshes want (mesh2d.h's
// splitWanted), mapped from their Domain2 segments to edges' spans (found among the face's edges by their points: a
// segment's ends may be labelled with other edges, a junction's point carrying the edge before it), one
// EdgeMesh::split for all, and the faces whose edges changed meshed again. Every face's mesh is made
// from the samples as they finally are, so faces sharing an edge share its points.
#include "tess_cadio/part.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <set>

#include "cad_geom/surface.h"

namespace tesscadio {

using namespace cadgeom;

struct PartMesher::Impl {
  const Model& m;
  PartOptions o;
  std::vector<std::unique_ptr<Surface>> surfaces;
  std::vector<std::unique_ptr<SurfaceCriteria>> criteria;
  std::vector<Status> criteriaStatus;
  std::unique_ptr<EdgeMesh> em;
  std::vector<FaceMesh> faces;
  /** Per face, the edges (model and pseudo) its boundary has points of, and the splits its mesh wants. */
  std::vector<std::set<int>> edgesOf;
  std::vector<std::vector<SplitRequest>> wanted;
  int rounds = 0;

  Impl(const Model& model, const PartOptions& options) : m(model), o(options) {}

  EdgeOptions edgeOptions() const {
    EdgeOptions e;
    e.deflection = o.d.linear;
    e.angle = o.d.angular;
    return e;
  }

  /**
   * The span of one of face f's edges that boundary points a and b bound (adjacent samples, found by their points: a
   * one-span edge between two vertices has neither end labelled with it, a junction's point carrying the edge before
   * it), and whether a to b runs up its samples; false if none (a pole line's segment).
   */
  bool spanOf(int f, const BoundaryPoint& a, const BoundaryPoint& b, int& edge, int& span, bool& forward) const {
    auto same = [](Vec3 x, Vec3 y) { return x.x == y.x && x.y == y.y && x.z == y.z; };
    for (int e : edgesOf[f]) {
      const std::vector<Vec3>& p = em->edge(e).points;
      for (size_t j = 0; j + 1 < p.size(); j++)
        if ((same(p[j], a.point) && same(p[j + 1], b.point)) || (same(p[j], b.point) && same(p[j + 1], a.point))) {
          edge = e, span = static_cast<int>(j), forward = same(p[j], a.point);
          return true;
        }
    }
    return false;
  }

  void meshFace(int f) {
    FaceMesh& out = faces[f];
    out = {};
    wanted[f].clear();
    edgesOf[f].clear();
    if (!surfaces[f]) return;
    if (!criteria[f]) {
      out.status = criteriaStatus[f];
      return;
    }
    FaceBoundary fb = em->face(f);
    if (fb.status != Status::ok && fb.status != Status::singular) {
      out.status = fb.status;
      return;
    }
    if (fb.status == Status::singular) out.note = "a seam's side in (u, v) not settled by its neighbours";
    // The domain: the loops' points, then the interior chains' (segments between consecutive ones).
    Domain2 d;
    std::vector<BoundaryPoint> bp;
    for (const auto& l : fb.loops) {
      std::vector<int32_t> loop;
      for (const BoundaryPoint& p : l) {
        loop.push_back(static_cast<int32_t>(bp.size()));
        bp.push_back(p);
      }
      d.loops.push_back(loop);
    }
    for (const auto& c : fb.interior) {
      int32_t first = static_cast<int32_t>(bp.size());
      for (const BoundaryPoint& p : c) bp.push_back(p);
      for (int32_t i = 0; i + 1 < static_cast<int32_t>(c.size()); i++)
        d.segments.insert(d.segments.end(), {first + i, first + i + 1});
    }
    // Its edges: its loops' model edges, and the pseudo-edges its boundary has.
    for (int i = 0; i < m.faceLoopCount(f); i++) {
      int l = m.faceFirstLoop(f) + i;
      if (m.loopKind(l) == CBR_LOOP_EDGE)
        for (int k = 0; k < m.loopCount(l); k++) edgesOf[f].insert(m.coedgeEdge(m.loopFirst(l) + k));
    }
    for (const BoundaryPoint& p : bp) {
      d.points.push_back(p.uv);
      if (p.kind == BoundaryPoint::pseudoSample) edgesOf[f].insert(p.edgeIndex);
    }
    Mesh2 mesh = mesh2(d, *criteria[f]);
    if (mesh.status != Status::ok && mesh.status != Status::noConvergence) {
      out.status = mesh.status;
      return;
    }
    out.status = Status::ok;
    // The segments' pairs, as mesh2d.h numbers them: each loop's, then the interior ones.
    std::vector<std::pair<int32_t, int32_t>> segs;
    for (const auto& l : d.loops)
      for (size_t k = 0; k < l.size(); k++) segs.push_back({l[k], l[(k + 1) % l.size()]});
    for (size_t k = 0; k + 1 < d.segments.size(); k += 2) segs.push_back({d.segments[k], d.segments[k + 1]});
    for (const SplitWanted& w : mesh.splitWanted) {
      if (w.segment < 0 || w.segment >= static_cast<int32_t>(segs.size())) continue;
      int edge, span;
      bool forward;
      if (!spanOf(f, bp[segs[w.segment].first], bp[segs[w.segment].second], edge, span, forward)) continue;
      wanted[f].push_back({edge, span, forward ? w.fraction : 1 - w.fraction});
    }
    // (Only splits of edges count: a pole line's segments, which the floored metric can find long, can't be split.)
    out.splitsWanted = static_cast<int>(wanted[f].size());
    // In 3D: the boundary's points exactly, the mesher's on the surface.
    const Surface& s = *surfaces[f];
    double sense = m.faceSameSense(f) ? 1 : -1;
    size_t n = mesh.points.size();
    out.points.resize(n);
    out.normals.assign(n, Vec3{0, 0, 0});
    std::vector<char> regular(n, 0);
    for (size_t i = 0; i < n; i++) {
      if (i < bp.size()) {
        out.points[i] = bp[i].point;
      } else {
        SurfacePoint q;
        s.eval(mesh.points[i].x, mesh.points[i].y, 0, q);
        out.points[i] = q.p;
      }
      Vec3 nn;
      if (s.normal(mesh.points[i].x, mesh.points[i].y, nn) == Status::ok && std::isfinite(norm(nn)) && norm(nn) > 0) {
        out.normals[i] = sense * nn;
        regular[i] = 1;
      }
    }
    auto samePoint = [](Vec3 a, Vec3 b) { return a.x == b.x && a.y == b.y && a.z == b.z; };
    std::set<int32_t> refused(mesh.rejected.begin(), mesh.rejected.end());
    for (size_t t = 0; t + 2 < mesh.triangles.size(); t += 3) {
      int32_t a = mesh.triangles[t], b = mesh.triangles[t + 1], c = mesh.triangles[t + 2];
      if (samePoint(out.points[a], out.points[b]) || samePoint(out.points[b], out.points[c]) ||
        samePoint(out.points[a], out.points[c]))
        continue;  // two corners on a pole line: no triangle in 3D
      if (refused.count(static_cast<int32_t>(t / 3)))
        out.rejected.push_back(static_cast<int32_t>(out.triangles.size() / 3));
      // Counterclockwise in (u, v) is about S_u x S_v: turned where the face's normal is the opposite.
      if (sense > 0) out.triangles.insert(out.triangles.end(), {a, b, c});
      else out.triangles.insert(out.triangles.end(), {a, c, b});
    }
    // At a singular point (a pole, an apex) the limit: the mean of its triangles' other corners' normals, else of
    // the triangles' own normals, else any regular vertex's.
    for (size_t i = 0; i < n; i++) {
      if (regular[i]) continue;
      Vec3 sum{0, 0, 0}, geo{0, 0, 0};
      for (size_t t = 0; t + 2 < out.triangles.size(); t += 3) {
        const int32_t* v = &out.triangles[t];
        if (v[0] != int32_t(i) && v[1] != int32_t(i) && v[2] != int32_t(i)) continue;
        for (int k = 0; k < 3; k++)
          if (v[k] != int32_t(i) && regular[v[k]]) sum = sum + out.normals[v[k]];
        geo = geo + cross(out.points[v[1]] - out.points[v[0]], out.points[v[2]] - out.points[v[0]]);
      }
      Vec3 pick = norm(sum) > 0 ? sum : geo;
      if (!(norm(pick) > 0))
        for (size_t j = 0; j < n && !(norm(pick) > 0); j++)
          if (regular[j]) pick = out.normals[j];
      out.normals[i] = norm(pick) > 0 ? (1 / norm(pick)) * pick : Vec3{0, 0, 1};
    }
  }
};

PartMesher::PartMesher(const Model& model, const PartOptions& options) : impl_(new Impl(model, options)) {
  Impl& I = *impl_;
  const Model& m = model;
  int nf = m.faces();
  I.surfaces.resize(nf);
  I.criteria.resize(nf);
  I.criteriaStatus.assign(nf, Status::unsupported);
  I.faces.resize(nf);
  I.edgesOf.resize(nf);
  I.wanted.resize(nf);
  for (int f = 0; f < nf; f++) {
    Status st;
    if (m.faceLoopCount(f) > 0) I.surfaces[f] = makeSurface(m, m.faceSurface(f), st);
  }
  // The faces' (u, v) boxes from a first sampling, their criteria, then the edges again at the spacing they ask.
  std::vector<double> spacing(nf, INFINITY);
  {
    EdgeMesh first(m, I.edgeOptions());
    for (int f = 0; f < nf; f++) {
      if (!I.surfaces[f]) continue;
      FaceBoundary fb = first.face(f);
      Box2 box{{INFINITY, -INFINITY}, {INFINITY, -INFINITY}};
      auto add = [&](Vec2 p) {
        box.x.lo = std::min(box.x.lo, p.x), box.x.hi = std::max(box.x.hi, p.x);
        box.y.lo = std::min(box.y.lo, p.y), box.y.hi = std::max(box.y.hi, p.y);
      };
      for (const auto& l : fb.loops)
        for (const BoundaryPoint& p : l) add(p.uv);
      for (const auto& c : fb.interior)
        for (const BoundaryPoint& p : c) add(p.uv);
      if (!(box.x.lo <= box.x.hi)) {
        I.criteriaStatus[f] = fb.status == Status::ok ? Status::invalidModel : fb.status;
        continue;
      }
      I.criteria[f] = makeCriteria(m, f, *I.surfaces[f], box, I.o.d, I.criteriaStatus[f]);
      if (I.criteria[f]) spacing[f] = I.criteria[f]->edgeSpacing() * I.o.edgeSpacingScale;
    }
  }
  I.em = std::make_unique<EdgeMesh>(m, I.edgeOptions(), spacing);
  for (int f = 0; f < nf; f++) I.meshFace(f);
  for (I.rounds = 0; I.rounds < I.o.maxSplitRounds; I.rounds++) {
    // Every face's wanted splits, each span once (the first face's fraction).
    std::vector<SplitRequest> requests;
    std::set<std::pair<int, int>> seen;
    for (int f = 0; f < nf; f++)
      for (const SplitRequest& r : I.wanted[f])
        if (seen.insert({r.edge, r.span}).second) requests.push_back(r);
    if (requests.empty()) break;
    I.em->split(requests);
    std::set<int> touched;
    for (const SplitRequest& r : requests) touched.insert(r.edge);
    for (int f = 0; f < nf; f++) {
      bool redo = false;
      for (int e : touched) redo = redo || I.edgesOf[f].count(e);
      if (redo) I.meshFace(f);
    }
  }
}

PartMesher::~PartMesher() { delete impl_; }
const FaceMesh& PartMesher::face(int f) const { return impl_->faces[f]; }
const EdgeMesh& PartMesher::edges() const { return *impl_->em; }
int PartMesher::rounds() const { return impl_->rounds; }

} // namespace tesscadio
