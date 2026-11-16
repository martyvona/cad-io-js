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

/** The most a pole's fan triangle spans about the pole in 3D (16 per turn, as pole lines have at least). */
constexpr double kFanAngle = M_PI / 8;

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
  /**
   * A pole's fan: a run of a loop's points at a pole (or apex) replaced by a ring of points near it, the ring's
   * chain (its ends the boundary points either side of the run) joined to the pole in 3D by triangles made here,
   * outside the mesher, which can't make good ones there: the pole line is one point in 3D, so a triangle the mesher
   * finds well shaped in (u, v) can have its two other corners on one meridian.
   */
  struct Fan {
    int loop;
    /** The chain's positions in its (new) loop, the run's ends either side; the pole's (u, v) row and side. */
    std::vector<int> chain;
    Vec3 pole;
    bool isoU;
    double at;
    /** The ring's target radius in the fixed coordinate, and the ends' radii. */
    double target, ra, rb;
    BoundaryPoint a, first, last, b;
  };

  static double fixedOf(Vec2 p, bool isoU) { return isoU ? p.x : p.y; }
  static double freeOf(Vec2 p, bool isoU) { return isoU ? p.y : p.x; }
  static Vec2 uvOf(double fixed, double fr, bool isoU) { return isoU ? Vec2{fixed, fr} : Vec2{fr, fixed}; }

  /**
   * Face f's runs of loop points at a pole replaced by rings (each loop's points as they come, the fans' chains
   * recorded): a run of two points or more (a pole line's, or a junction at the pole) between regular points on one
   * side of the pole's row. The ring spans the run's free coordinate in pieces of at most kFanAngle about the pole
   * in 3D at one radius: the largest at which such a fan passes accept(), halved from the ends' radii and under half
   * the clearance of the face's other boundary points in that range.
   */
  std::vector<Fan> makeFans(int f, FaceBoundary& fb) const {
    std::vector<Fan> fans;
    const Surface& s = *surfaces[f];
    std::vector<Singularity> sing;
    s.singularities(sing);
    if (sing.empty()) return fans;
    SurfaceDomain dom = s.domain();
    // At a pole: on its row in (u, v).
    auto poleOf = [&](const BoundaryPoint& p) -> int {
      for (size_t g = 0; g < sing.size(); g++) {
        if (sing[g].kind == Singularity::normalVanishes) continue;
        double F = fixedOf(p.uv, sing[g].isoU);
        if (std::fabs(F - sing[g].at) <= 1e-12 * (1 + std::fabs(sing[g].at))) return static_cast<int>(g);
      }
      return -1;
    };
    for (size_t li = 0; li < fb.loops.size(); li++) {
      std::vector<BoundaryPoint>& L = fb.loops[li];
      int n = static_cast<int>(L.size());
      std::vector<int> at(n);
      int start = -1;
      for (int i = 0; i < n; i++) {
        at[i] = poleOf(L[i]);
        if (at[i] < 0 && start < 0) start = i;
      }
      if (start < 0) continue;
      std::vector<BoundaryPoint> out;
      std::vector<Fan> mine;
      for (int k = 0; k < n;) {
        int i = (start + k) % n;
        if (at[i] < 0) {
          out.push_back(L[i]);
          k++;
          continue;
        }
        int g = at[i], len = 0;
        while (k + len < n && at[(start + k + len) % n] == g) len++;
        const Singularity& S = sing[g];
        const BoundaryPoint& a = L[(start + k - 1 + n) % n];
        const BoundaryPoint& b = L[(start + k + len) % n];
        const BoundaryPoint& first = L[i];
        const BoundaryPoint& last = L[(start + k + len - 1) % n];
        double da = fixedOf(a.uv, S.isoU) - S.at, db = fixedOf(b.uv, S.isoU) - S.at;
        // (Not where an end is on the row itself, all but: a sample inverted to the pole from an edge a little off its
        // surface, its own point not at the pole. The pole line stays as it is there.)
        double onRow = 1e-9 * (1 + std::fabs(S.at));
        if (len < 2 || !(da * db > 0) || std::fabs(da) <= onRow || std::fabs(db) <= onRow) {
          for (int j = 0; j < len; j++) out.push_back(L[(start + k + j) % n]);
          k += len;
          continue;
        }
        Fan fan;
        fan.loop = static_cast<int>(li);
        fan.isoU = S.isoU;
        fan.at = S.at;
        fan.pole = S.point;
        for (int j = 0; j < len; j++) {
          const BoundaryPoint& q = L[(start + k + j) % n];
          if (q.kind == BoundaryPoint::edgeSample || q.kind == BoundaryPoint::pseudoSample) fan.pole = q.point;
        }
        fan.a = a, fan.first = first, fan.last = last, fan.b = b;
        double side = da > 0 ? 1 : -1, q0 = freeOf(first.uv, S.isoU), q1 = freeOf(last.uv, S.isoU);
        fan.ra = std::fabs(da), fan.rb = std::fabs(db);
        // The angle the run spans about the pole in 3D, near it.
        double eps = 1e-3 * std::min(fan.ra, fan.rb), spanned = 0;
        Vec3 prev{};
        for (int j = 0; j <= 64; j++) {
          SurfacePoint sp;
          s.eval(uvOf(S.at + side * eps, q0 + (q1 - q0) * j / 64, S.isoU).x,
            uvOf(S.at + side * eps, q0 + (q1 - q0) * j / 64, S.isoU).y, 0, sp);
          Vec3 d = sp.p - fan.pole;
          if (j) spanned += std::atan2(norm(cross(prev, d)), dot(prev, d));
          prev = d;
        }
        int m = std::max(1, static_cast<int>(std::ceil(spanned / kFanAngle)));
        // Clearance: the face's other boundary points over the run's free range, on its side.
        double period = S.isoU ? dom.vPeriod : dom.uPeriod, lo = std::min(q0, q1), hi = std::max(q0, q1);
        bool whole = period > 0 && hi - lo >= period * (1 - 1e-12);
        double clear = INFINITY;
        for (const auto& l2 : fb.loops)
          for (const BoundaryPoint& p : l2) {
            if (poleOf(p) >= 0 || (p.uv.x == a.uv.x && p.uv.y == a.uv.y) || (p.uv.x == b.uv.x && p.uv.y == b.uv.y))
              continue;
            double qf = freeOf(p.uv, S.isoU), df = (fixedOf(p.uv, S.isoU) - S.at) * side;
            if (period > 0 && !whole) qf = lo + std::fmod(std::fmod(qf - lo, period) + period, period);
            if (df > 0 && (whole || (qf >= lo && qf <= hi))) clear = std::min(clear, df);
          }
        for (const auto& c : fb.interior)
          for (const BoundaryPoint& p : c) {
            double df = (fixedOf(p.uv, S.isoU) - S.at) * side;
            if (df > 0) clear = std::min(clear, df);
          }
        // The largest radius at which a ring's fan passes.
        auto passes = [&](double r) {
          for (int j = 0; j < m; j++) {
            double qa = q0 + (q1 - q0) * j / m, qb = q0 + (q1 - q0) * (j + 1) / m;
            Vec2 tri[3] = {uvOf(S.at + side * r, qa, S.isoU), uvOf(S.at + side * r, qb, S.isoU),
              uvOf(S.at, 0.5 * (qa + qb), S.isoU)};
            orient(tri);
            if (!criteria[f]->accept(tri)) return false;
          }
          return true;
        };
        double r = std::min({fan.ra, fan.rb, 0.5 * clear});
        for (int it = 0; it < 40 && !passes(r); it++) r *= 0.5;
        fan.target = r;
        // The ring: at the radius throughout, so it stays under the clearance; an end farther out than that (until
        // its split brings it in) reached along its own row of the free coordinate, so the chain runs beside no other
        // boundary (the fan's triangle there is a sliver in 3D until then, refused, its corner at the pole).
        std::vector<double> qs;
        double piece = (q1 - q0) / m;
        if (fan.ra > 1.5 * r) qs.push_back(q0);
        for (int j = 1; j < m; j++) qs.push_back(q0 + j * piece);
        if (fan.rb > 1.5 * r) qs.push_back(q1);
        fan.chain.push_back(static_cast<int>(out.size()) - 1);
        for (double qj : qs) {
          BoundaryPoint q;
          q.kind = BoundaryPoint::vertexPoint;
          q.uv = uvOf(S.at + side * r, qj, S.isoU);
          SurfacePoint sp;
          s.eval(q.uv.x, q.uv.y, 0, sp);
          q.point = sp.p;
          fan.chain.push_back(static_cast<int>(out.size()));
          out.push_back(q);
        }
        fan.chain.push_back(static_cast<int>(out.size()));  // b, pushed next (or the loop's first point)
        mine.push_back(fan);
        k += len;
      }
      // A chain's last position past the end is the loop's first point (b was where the rotation started).
      for (Fan& fan : mine) {
        if (fan.chain.front() < 0) fan.chain.front() += static_cast<int>(out.size());
        if (fan.chain.back() >= static_cast<int>(out.size())) fan.chain.back() -= static_cast<int>(out.size());
        fans.push_back(fan);
      }
      L = out;
    }
    return fans;
  }

  /** Triangle t turned counterclockwise in (u, v). */
  static void orient(Vec2 t[3]) {
    if (cross(t[1] - t[0], t[2] - t[0]) < 0) std::swap(t[1], t[2]);
  }

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
    // (Not where the seam's side wasn't settled: such a boundary is a guess, and its face stays singular.)
    std::vector<Fan> fans;
    if (fb.status == Status::ok) fans = makeFans(f, fb);
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
    std::vector<int32_t> loopStart;
    for (const auto& l : d.loops) loopStart.push_back(l.empty() ? 0 : l[0]);
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
    // A fan whose ends are farther from the pole than its ring wants the spans into the pole split there (asked
    // whatever the mesh does: a boundary the mesher can't take may be one the split rounds bring in).
    for (const Fan& fan : fans) {
      int edge, span;
      bool forward;
      if (fan.ra > 1.5 * fan.target && spanOf(f, fan.a, fan.first, edge, span, forward)) {
        double x = 1 - fan.target / fan.ra;
        wanted[f].push_back({edge, span, forward ? x : 1 - x});
      }
      if (fan.rb > 1.5 * fan.target && spanOf(f, fan.last, fan.b, edge, span, forward)) {
        double x = fan.target / fan.rb;
        wanted[f].push_back({edge, span, forward ? x : 1 - x});
      }
    }
    MeshOptions mo;
    mo.maxPoints = o.maxPointsPerFace;
    Mesh2 mesh = mesh2(d, *criteria[f], mo);
    if (mesh.status != Status::ok && mesh.status != Status::noConvergence) {
      // (A boundary whose seam side wasn't settled fails for that.)
      out.status = fb.status == Status::singular ? Status::singular : mesh.status;
      return;
    }
    out.status = Status::ok;
    if (mesh.status == Status::noConvergence)
      out.note += std::string(out.note.empty() ? "" : "; ") + "refinement stopped at its point cap";
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
    // (Only splits of edges count: a ring's segments, a pole line's, which the floored metric can find long, can't be
    // split.)
    out.splitsWanted = static_cast<int>(wanted[f].size());
    out.sampled = !criteria[f]->bounded();
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
      // (At a singular point, the limit where the surface gives one: surface.h's normal() with Status::singular.)
      Vec3 nn;
      Status ns = s.normal(mesh.points[i].x, mesh.points[i].y, nn);
      if ((ns == Status::ok || ns == Status::singular) && std::isfinite(norm(nn)) && std::fabs(norm(nn) - 1) < 1e-9) {
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
    // The fans: each ring's chain to its pole, a point of its own (the run's edge sample there, else the surface's).
    for (const Fan& fan : fans) {
      int32_t pole = static_cast<int32_t>(out.points.size());
      int32_t base = loopStart[fan.loop];
      out.points.push_back(fan.pole);
      Vec3 nn{0, 0, 0};
      double q0 = freeOf(fan.first.uv, fan.isoU), q1 = freeOf(fan.last.uv, fan.isoU);
      Vec2 puv = uvOf(fan.at, 0.5 * (q0 + q1), fan.isoU);
      Status ns = s.normal(puv.x, puv.y, nn);
      bool reg = (ns == Status::ok || ns == Status::singular) && std::isfinite(norm(nn)) &&
        std::fabs(norm(nn) - 1) < 1e-9;
      out.normals.push_back(reg ? sense * nn : Vec3{0, 0, 0});
      regular.push_back(reg);
      for (size_t j = 0; j + 1 < fan.chain.size(); j++) {
        int32_t a = base + fan.chain[j], b = base + fan.chain[j + 1];
        double qa = freeOf(mesh.points[a], fan.isoU), qb = freeOf(mesh.points[b], fan.isoU);
        Vec2 tri[3] = {mesh.points[a], mesh.points[b], uvOf(fan.at, 0.5 * (qa + qb), fan.isoU)};
        orient(tri);
        if (!criteria[f]->accept(tri)) out.rejected.push_back(static_cast<int32_t>(out.triangles.size() / 3));
        // Counterclockwise about the face's normals at its other corners (in (u, v) an end's triangle along its row
        // has no area to tell by).
        Vec3 g = cross(out.points[b] - out.points[a], out.points[pole] - out.points[a]);
        if (dot(g, out.normals[a] + out.normals[b]) >= 0) out.triangles.insert(out.triangles.end(), {a, b, pole});
        else out.triangles.insert(out.triangles.end(), {b, a, pole});
      }
    }
    n = out.points.size();
    // At a singular point (a pole, an apex) with no limit given: the mean of its triangles' other corners' normals,
    // else of the triangles' own normals, else any regular vertex's.
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
    if (m.faceLoopCount(f) > 0) I.surfaces[f] = closedSurface(m, f, st);
  }
  // The faces' (u, v) boxes from a first sampling, their criteria, then the edges again at the spacing they ask.
  std::vector<double> spacing(nf, INFINITY);
  {
    // (Only for the boxes: a coarse sampling, 10 x the deflection, no angle, as each sample there is an inversion.)
    EdgeOptions rough = I.edgeOptions();
    rough.deflection *= 10;
    rough.angle = 0;
    EdgeMesh first(m, rough);
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
