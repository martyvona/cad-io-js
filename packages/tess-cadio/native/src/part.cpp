// part.h: the edges sampled twice, first to find each face's (u, v) box for its criteria, then with the spacing the
// criteria ask of each face's edges; every face meshed; then rounds of the splits the faces' meshes want (mesh2d.h's
// splitWanted), mapped from their Domain2 segments to edges' spans (found among the face's edges by their points: a
// segment's ends may be labelled with other edges, a junction's point carrying the edge before it), one
// EdgeMesh::split for all, and the faces whose edges changed meshed again. Every face's mesh is made
// from the samples as they finally are, so faces sharing an edge share its points.
#include "tess_cadio/part.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <map>
#include <set>
#include <tuple>
#include <unordered_map>

#include "cad_geom/creases.h"
#include "cad_geom/surface.h"
#include "mesh2d_impl.h"
#include "flip.h"
#include "poles.h"

namespace tesscadio {

/** The deviation check's progress: a report as each face's starts, and again every this many triangles measured. */
constexpr int kDeviationReport = 64;
/** PartOptions::keepSteiner: a face meshed this many times already is seeded with its last mesh's points. */
constexpr int kKeepSteinerFrom = 3;

using namespace cadgeom;

namespace {

/**
 * A face's criteria answering from its verdicts of its last two meshings where it can (PartOptions::reuseVerdicts):
 * keyed by the corners' exact bits in the order given, so an answer is the one the criteria would give. Their one
 * state, whether any deviation was sampled (SurfaceCriteria::bounded), only ever turns true, and did on the first
 * asking. Two generations, the older dropped as each meshing starts. Its bytes are counted (estimated per entry) into
 * the part's total, and past the part's budget it answers from what it holds but keeps nothing new: the same answers,
 * only asked again.
 */
class VerdictMemo final : public SizeField {
public:
  VerdictMemo(const SizeField& field, size_t& total, size_t& peak, size_t budget)
    : field_(field), total_(total), peak_(peak), budget_(budget) {}
  ~VerdictMemo() override { total_ -= bytes_; }
  VerdictMemo(const VerdictMemo&) = delete;
  VerdictMemo& operator=(const VerdictMemo&) = delete;
  /** A meshing starts: the last one's verdicts kept, the one before's dropped. */
  void next() {
    const size_t dropped = old_.size() * kTriBytes + oldMetric_.size() * kPointBytes;
    total_ -= dropped, bytes_ -= dropped;
    old_ = std::move(cur_), cur_.clear();
    oldMetric_ = std::move(curMetric_), curMetric_.clear();
  }
  size_t bytes() const { return bytes_; }
  Metric2 metric(Vec2 p) const override {
    const PointKey k{bits(p.x), bits(p.y)};
    if (auto it = curMetric_.find(k); it != curMetric_.end()) return it->second;
    auto it = oldMetric_.find(k);
    const Metric2 M = it != oldMetric_.end() ? it->second : field_.metric(p);
    if (room(kPointBytes)) curMetric_.emplace(k, M);
    return M;
  }
  bool accept(const Vec2 t[3]) const override { return ask(t, kAccept, [&] { return field_.accept(t); }); }
  bool belowFloor(const Vec2 t[3]) const override { return ask(t, kFloor, [&] { return field_.belowFloor(t); }); }
  int refusalKind(const Vec2 t[3]) const override { return field_.refusalKind(t); }
  bool worstPoint(const Vec2 t[3], Vec2& at) const override { return field_.worstPoint(t, at); }

private:
  /**
   * An entry's bytes as estimated: a hash node (key, value, link, cached hash, the allocator's header) and its bucket,
   * for 64-bit pointers (WebAssembly's 32-bit ones take less).
   */
  static constexpr size_t kTriBytes = 104, kPointBytes = 88;
  struct TriKey {
    uint64_t b[6];
    bool operator==(const TriKey& o) const { return std::equal(b, b + 6, o.b); }
  };
  struct PointKey {
    uint64_t x, y;
    bool operator==(const PointKey& o) const { return x == o.x && y == o.y; }
  };
  static uint64_t mix(uint64_t h, uint64_t v) {
    h ^= v + 0x9e3779b97f4a7c15ull + (h << 6) + (h >> 2);
    return h * 0xff51afd7ed558ccdull;
  }
  struct TriHash {
    size_t operator()(const TriKey& k) const {
      uint64_t h = 0;
      for (uint64_t v : k.b) h = mix(h, v);
      return static_cast<size_t>(h ^ (h >> 33));
    }
  };
  struct PointHash {
    size_t operator()(const PointKey& k) const {
      const uint64_t h = mix(mix(0, k.x), k.y);
      return static_cast<size_t>(h ^ (h >> 33));
    }
  };
  static uint64_t bits(double x) {
    uint64_t u;
    std::memcpy(&u, &x, sizeof u);
    return u;
  }
  /** Whether an entry of n bytes fits the part's budget, counted if it does. */
  bool room(size_t n) const {
    if (total_ + n > budget_) return false;
    total_ += n, bytes_ += n;
    peak_ = std::max(peak_, total_);
    return true;
  }
  // Per triangle, two bits per question: known, then the answer.
  enum : uint8_t { kAccept = 0, kFloor = 2 };
  template <class F> bool ask(const Vec2 t[3], uint8_t q, F evaluate) const {
    const TriKey k{{bits(t[0].x), bits(t[0].y), bits(t[1].x), bits(t[1].y), bits(t[2].x), bits(t[2].y)}};
    uint8_t known = 0;
    auto it = cur_.find(k);
    if (it != cur_.end()) known = it->second;
    else if (auto o = old_.find(k); o != old_.end()) known = o->second;
    if (!(known >> q & 1)) known |= static_cast<uint8_t>((1 | (evaluate() ? 2 : 0)) << q);
    if (it != cur_.end()) it->second = known;
    else if (room(kTriBytes)) cur_.emplace(k, known);
    return known >> (q + 1) & 1;
  }
  const SizeField& field_;
  size_t &total_, &peak_;
  const size_t budget_;
  mutable size_t bytes_ = 0;
  mutable std::unordered_map<TriKey, uint8_t, TriHash> cur_, old_;
  mutable std::unordered_map<PointKey, Metric2, PointHash> curMetric_, oldMetric_;
};

} // namespace

struct PartMesher::Impl {
  const Model& m;
  PartOptions o;
  std::vector<std::unique_ptr<Surface>> surfaces;
  std::vector<std::unique_ptr<SurfaceCriteria>> criteria;
  /** The memos' bytes together (estimated; declared first, as their destructors count it down). */
  size_t memoBytes = 0, memoPeak = 0;
  /** Per face, its criteria's verdicts kept across its meshings (PartOptions::reuseVerdicts), made as first meshed. */
  std::vector<std::unique_ptr<VerdictMemo>> memos;
  /** Each face's last meshing's order: its memo's age, the oldest dropped first. */
  std::vector<long> meshedAt;
  long meshings = 0;
  std::vector<Status> criteriaStatus;
  std::vector<std::string> criteriaWhy;
  std::unique_ptr<EdgeMesh> em;
  std::vector<FaceMesh> faces;
  /** Per face, the edges (model and pseudo) its boundary has points of, and the splits its mesh wants. */
  std::vector<std::set<int>> edgesOf;
  std::vector<std::vector<SplitRequest>> wanted;
  /** Per face, how many of its mesh's triangles are the mesher's (the fans' come after them). */
  std::vector<size_t> mesherTriangles;
  /** Each face's rounds with refinement blocked by a ring's segment (FaceMesh::ringBlocked). */
  std::vector<int> ringBlocked;
  /** The refinement floor (criteria.h): an edge's span whose chord is no longer is never split (EdgeMesh::split). */
  double floor = 0;
  /** Per face, its poles' rings (poles.h), shared across faces and cut into their edges before any face is meshed. */
  std::vector<std::vector<PoleRing>> rings;
  /**
   * Per face, its refused triangles (FaceMesh::rejected, in order): their (u, v) corners and their vertices' indices
   * into the face's points, for the deviation check (PartOptions::maxDeviationFactor).
   */
  struct Refused {
    Vec2 uv[3];
    int32_t v[3];
  };
  std::vector<std::vector<Refused>> refused;
  /**
   * Per face, what the collapse (collapseTurned) needs of its mesh: each of its mesher's points' (u, v); each point's
   * edge and sample, {-2, -1} for a boundary point not an edge's sample (a vertex loop's point inside the face),
   * {-1, -1} the mesher's own; and the segments a collapse mustn't move (the boundary's, the constraints', the
   * rings'), as output indices (low first). Usable where the face meshed without crease copies.
   */
  struct CollapseInfo {
    std::vector<Vec2> uv;
    std::vector<std::pair<int32_t, int32_t>> sample;
    std::set<std::pair<int32_t, int32_t>> fixed;
    bool usable = false;
  };
  std::vector<CollapseInfo> collapseInfo;
  /**
   * Per face, its last mesh as PartOptions::keepSteiner reuses it: its domain's points and segments in (u, v), the
   * mesher's points past them (empty where that meshing failed), and how many times the face has been meshed.
   */
  struct LastMesh {
    std::vector<Vec2> boundary, steiner;
    std::vector<std::pair<Vec2, Vec2>> segments;
    int meshings = 0;
  };
  std::vector<LastMesh> last;
  /**
   * Per face, its creases (cad_geom/creases.h) as constraints: each piece's line (u = at where isoU, else v = at), its
   * samples along it (ascending), and at each end on the boundary the edge sample there (edge, parameter; -1 none).
   */
  struct CreasePiece {
    bool isoU = true;
    double at = 0;
    /** Within this of the line in its coordinate is on it (rounding: its points, the boundary's too, are on it). */
    double near = 0;
    std::vector<double> s;
    int endEdge[2] = {-1, -1};
    double endT[2] = {0, 0};
  };
  std::vector<std::vector<CreasePiece>> creases;
  /**
   * Per face, its loops' (u, v) box's sides on a break of a surface going on past them (findFaceCreases; infinite
   * where not): its points on one take normals from inside.
   */
  std::vector<std::pair<Range, Range>> faceBox;
  /** Per face, the crease segments its last meshing wanted split: (piece, its segment from s[k] to s[k + 1]). */
  std::vector<std::set<std::pair<int, int>>> creaseSplits;
  static Vec2 creaseUv(const CreasePiece& c, double s) { return c.isoU ? Vec2{c.at, s} : Vec2{s, c.at}; }
  int rounds = 0;
  /** In the rounds: the poles whose rings were shrunk for a split asked inside them, the faces meshed again for it. */
  int ringsShrunk = 0, ringFacesRemeshed = 0;
  /** The progress of the pass under way (PartOptions::progress). */
  PartProgress at;
  void report(const PartProgress& p) const {
    if (o.progress) o.progress(p);
  }
  /** An EdgeMesh's progress as PartMesher's, in phase `phase`. */
  std::function<void(int, int, int)> edgeProgress(PartProgress::Phase phase) const {
    if (!o.progress) return {};
    return [this, phase](int done, int total, int face) { o.progress({phase, face, 0, done, total}); };
  }

  Impl(const Model& model, const PartOptions& options) : m(model), o(options) {}

  EdgeOptions edgeOptions() const {
    EdgeOptions e;
    e.projectMissingPcurves = o.projectMissingPcurves;
    e.deflection = o.d.linear;
    e.angle = o.d.angular;
    e.analysis = o.analysis, e.analysisSize = o.analysisSize;
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
    /** The run's first and last points (on the row). */
    BoundaryPoint first, last;
    /** Whether the pole is smooth (its fan's normals judged) or apex-like (its deviation alone), PoleRing::smooth. */
    bool smooth = true;
  };

  static double fixedOf(Vec2 p, bool isoU) { return isoU ? p.x : p.y; }

  /**
   * The ring's free coordinates qs (at offset side x r from the row of pole S) kept where the chain from the boundary
   * point pa through them to pb turns one way about the pole, within the sector pa and pb bound: seen from the pole in
   * the plane across its normal (its limit on the row at the ring's middle; at an apex, which has none, the mean of
   * the surface's normals at the ring's points, about its axis), each kept point a step from the last in
   * the chain's direction (that of its whole turn from pa to pb through them) and short of pb. A point that steps back
   * or past pb, or by under kTurn, is left out, the fan going straight from its predecessor to the next, all of them
   * perhaps (makeFans keeps them where its loop would be left under three points): where a curve through the pole
   * bends at once, the ring at its floor crosses it in 3D, and a fan triangle on such a point would land on the
   * mesher's side of its ring segment, folding the mesh (PartOptions::failFoldedFans). All of qs where neither gives a
   * direction.
   */
  static std::vector<double> inSector(const Surface& s, const Singularity& S, double side, double r, Vec3 pa, Vec3 pb,
    const std::vector<double>& qs) {
    if (qs.empty()) return qs;
    auto ringUv = [&](double q) { return S.isoU ? Vec2{S.at + side * r, q} : Vec2{q, S.at + side * r}; };
    Vec3 n;
    const Vec2 mid = S.isoU ? Vec2{S.at, 0.5 * (qs.front() + qs.back())} : Vec2{0.5 * (qs.front() + qs.back()), S.at};
    const Status ns = s.normal(mid.x, mid.y, n);
    if ((ns != Status::ok && ns != Status::singular) || !(norm(n) > 0.5)) {
      n = {0, 0, 0};
      for (double q : qs) {
        Vec3 m;
        const Vec2 uv = ringUv(q);
        if (s.normal(uv.x, uv.y, m) == Status::ok) n = n + m;
      }
      if (!(norm(n) > 1e-9)) return qs;
      n = (1 / norm(n)) * n;
    }
    Vec3 e1 = cross(n, Vec3{1, 0, 0});
    if (norm(e1) < 0.5) e1 = cross(n, Vec3{0, 1, 0});
    e1 = (1 / norm(e1)) * e1;
    const Vec3 e2 = cross(n, e1);
    auto angle = [&](Vec3 p) { const Vec3 d = p - S.point; return std::atan2(dot(d, e2), dot(d, e1)); };
    std::vector<double> th;
    for (double q : qs) {
      SurfacePoint sp;
      const Vec2 uv = ringUv(q);
      s.eval(uv.x, uv.y, 0, sp);
      th.push_back(angle(sp.p));
    }
    // (A step of next to no turn, a ring point on the line from the pole through its neighbour, makes a needle of a
    // fan triangle, aspect past 1000, whose orientation by its normals is anyone's: one along an edge through an apex
    // that's an iso-line, a spindle torus's, LMP1 #173466's #1091324. The ring's pieces turn far more, by the angle.)
    constexpr double kTurn = 1e-3;
    std::vector<double> kept;
    for (size_t j : sectorKeep(angle(pa), th, angle(pb), kTurn)) kept.push_back(qs[j]);
    return kept;
  }
  static double freeOf(Vec2 p, bool isoU) { return isoU ? p.y : p.x; }
  static Vec2 uvOf(double fixed, double fr, bool isoU) { return isoU ? Vec2{fixed, fr} : Vec2{fr, fixed}; }

  /**
   * Face f's runs of loop points at a pole replaced by rings (each loop's points as they come, the fans' chains
   * recorded): a run of two points or more (a pole line's, or a junction at the pole) between regular points on one
   * side of the pole's row, which are the incident curves' crossings of the ring (cutRings made them). The ring is the
   * pole's (rings[f]): its row at the pole's radius, in pieces by the edge rules (ringPieces). A pole with no ring
   * keeps its run as it is.
   */
  std::vector<Fan> makeFans(int f, FaceBoundary& fb) const {
    std::vector<Fan> fans;
    const Surface& s = *surfaces[f];
    std::vector<Singularity> sing;
    s.singularities(sing);
    if (sing.empty()) return fans;
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
        const PoleRing* ring = nullptr;
        for (const PoleRing& pr : rings[f])
          if (pr.singularity == g && pr.radius > 0) ring = &pr;
        if (len < 2 || !(da * db > 0) || std::fabs(da) <= onRow || std::fabs(db) <= onRow || !ring) {
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
        fan.first = first, fan.last = last;
        double side = da > 0 ? 1 : -1, q0 = freeOf(first.uv, S.isoU), q1 = freeOf(last.uv, S.isoU);
        // The ring: its pole's (poles.h: the radius by the pole-ring rule, one reach for every face at the pole, cut
        // into the curves through it), in pieces by the edge rules, at the radius throughout so it stays under the
        // clearance. An end off the row by over half as much again (a curve whose crossing at the shared reach is
        // farther out in this face's fixed coordinate) is reached along its own row of the free coordinate, so the
        // chain runs beside no other boundary. The pieces span the chain from end to end: an end on the ring is
        // where the chain starts in the free coordinate, which can be far along the row from the run's own ends (a
        // curve's crossing of the ring away from where it meets the pole), and the ring's segments are never split
        // later.
        const PoleRing& R = *ring;
        const double r = R.radius;
        fan.smooth = R.smooth;
        const bool farA = std::fabs(da) > 1.5 * r, farB = std::fabs(db) > 1.5 * r;
        const double lo = farA ? q0 : freeOf(a.uv, S.isoU), hi = farB ? q1 : freeOf(b.uv, S.isoU);
        const int pieces = ringPieces(s, R, {lo, hi}, r, o.d.linear, o.d.angular);
        std::vector<double> qs;
        double piece = (hi - lo) / pieces;
        if (farA) qs.push_back(q0);
        for (int j = 1; j < pieces; j++) qs.push_back(lo + j * piece);
        if (farB) qs.push_back(q1);
        // (Kept where leaving them out would leave the loop under three points: a face as small as the ring.)
        // (At a smooth pole only: an apex's fans run round a cone, its ring a whole turn and more of its points
        // needed for the deflection.)
        if (fan.smooth)
          if (std::vector<double> in = inSector(s, S, side, r, a.point, b.point, qs); !in.empty() || n - len >= 3)
            qs = std::move(in);
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

  /**
   * Why the mesher refused face f's domain, from the segments it names (mesh2d.h): two of the boundary's points at
   * one (u, v), a segment through another point, or two that cross; and what they're of (an edge's samples, a cut's,
   * a pole line, a pole's ring).
   */
  static std::string meshWhy(const Mesh2& mesh, const std::vector<BoundaryPoint>& bp) {
    const std::vector<int32_t>& r = mesh.rejected;
    auto of = [&](int32_t i) -> std::string {
      if (i < 0 || i >= static_cast<int32_t>(bp.size())) return "a point";
      switch (bp[i].kind) {
        case BoundaryPoint::edgeSample: return "an edge";
        case BoundaryPoint::pseudoSample: return "a cut";
        case BoundaryPoint::poleLine: return "a pole line";
        default: return "a pole's ring or a vertex";
      }
    };
    if (r.size() == 2) return "two of its boundary's points at one (u, v) (" + of(r[0]) + ", " + of(r[1]) + ")";
    if (r.size() >= 4 && r[2] == r[3])
      return "its boundary in (u, v) through its own point (" + of(r[0]) + " through " + of(r[2]) + ")";
    if (r.size() >= 4) return "its boundary in (u, v) crossing itself (" + of(r[0]) + " and " + of(r[2]) + ")";
    return "its boundary not a domain in (u, v) (a loop under 3 points, a segment not closed)";
  }

  /**
   * The loop point of face boundary fb that is edge `edge`'s sample at parameter t exactly, if any: by its 3D point (a
   * junction's point carries the edge before it).
   */
  bool boundaryPoint(const FaceBoundary& fb, int edge, double t, BoundaryPoint& out) const {
    const EdgeSamples& es = em->edge(edge);
    int j = -1;
    for (size_t k = 0; k < es.t.size() && j < 0; k++)
      if (es.t[k] == t) j = static_cast<int>(k);
    if (j < 0) return false;
    const Vec3 x = es.points[j];
    for (const auto& L : fb.loops)
      for (const BoundaryPoint& p : L)
        if (p.point.x == x.x && p.point.y == x.y && p.point.z == x.z) return out = p, true;
    return false;
  }

  /**
   * Each face's creases (cad_geom/creases.h: iso-lines inside it where the normal jumps past the angle) as
   * constraints: a piece's end on the boundary crossed with its loop's (u, v) polyline, an edge sample placed there
   * (EdgeMesh::split's exact: both faces get it); pieces crossing each other share the crossing; then each sampled as
   * an edge is in 3D (chord within d, at most the face's edge spacing apart). A piece whose boundary end can't be
   * placed on an edge's span is dropped.
   */
  void findFaceCreases() {
    const int nf = m.faces();
    creases.assign(nf, {});
    creaseSplits.assign(nf, {});
    faceBox.assign(nf, {{INFINITY, -INFINITY}, {INFINITY, -INFINITY}});
    std::vector<SplitRequest> exact;
    for (int f = 0; f < nf; f++) {
      if (!surfaces[f] || !criteria[f]) continue;
      const FaceBoundary fb = em->face(f);
      if (fb.status != Status::ok) continue;
      // (Its edges as meshFace lists them, for spanOf: the first meshing comes after.)
      for (int i = 0; i < m.faceLoopCount(f); i++) {
        const int l = m.faceFirstLoop(f) + i;
        if (m.loopKind(l) == CBR_LOOP_EDGE)
          for (int k = 0; k < m.loopCount(l); k++) edgesOf[f].insert(m.coedgeEdge(m.loopFirst(l) + k));
      }
      for (const auto& L : fb.loops)
        for (const BoundaryPoint& p : L)
          if (p.kind == BoundaryPoint::pseudoSample) edgesOf[f].insert(p.edgeIndex);
      const Surface& s = *surfaces[f];
      Range ru{INFINITY, -INFINITY}, rv{INFINITY, -INFINITY};
      for (const auto& L : fb.loops)
        for (const BoundaryPoint& p : L)
          ru.lo = std::min(ru.lo, p.uv.x), ru.hi = std::max(ru.hi, p.uv.x), rv.lo = std::min(rv.lo, p.uv.y),
          rv.hi = std::max(rv.hi, p.uv.y);
      if (!(ru.lo < ru.hi && rv.lo < rv.hi)) continue;
      // The (u, v) tolerance findCreases classifies by, bisects to and extends ends past the boundary by: rounding,
      // 1e-7 of the box, not the face's tolerance. Both the classification and the crossing are with these loops'
      // own polyline, and a crease within the face's tolerance of the boundary (trj3's #1349: u = 7, 0.05 of a 1 mm
      // tolerance's 0.5 from its edge) still has a strip beyond it that triangles across it can't mesh.
      const double box = std::max(ru.hi - ru.lo, rv.hi - rv.lo);
      auto uvTol = [&](Vec2) { return 1e-7 * box; };
      // In (0), out (1) or on (2: within uvTol of a loop's segment) by the loops' even-odd rule.
      auto inside = [&](const Vec2* p, int n, int* sides) {
        for (int i = 0; i < n; i++) {
          const Vec2 x = p[i];
          const double near = uvTol(x);
          bool in = false, on = false;
          for (const auto& L : fb.loops)
            for (size_t k = 0; k < L.size() && !on; k++) {
              const Vec2 a = L[k].uv, b = L[(k + 1) % L.size()].uv;
              const Vec2 e{b.x - a.x, b.y - a.y};
              const double l2 = e.x * e.x + e.y * e.y;
              const double w = l2 > 0 ? std::clamp(((x.x - a.x) * e.x + (x.y - a.y) * e.y) / l2, 0.0, 1.0) : 0;
              on = std::hypot(x.x - a.x - w * e.x, x.y - a.y - w * e.y) <= near;
              if ((a.y > x.y) != (b.y > x.y) && x.x < a.x + (x.y - a.y) * (b.x - a.x) / (b.y - a.y)) in = !in;
            }
          sides[i] = on ? 2 : in ? 0 : 1;
        }
      };
      // (Past half the angle: a jump just under it leaves a triangle across it no room, refined to the cap.)
      const std::vector<cadgeom::Crease> found = cadgeom::findCreases(s, ru, rv, 0.5 * o.d.angular, inside, uvTol);
      for (const cadgeom::Crease& c : found) {
        CreasePiece P;
        P.isoU = c.isoU, P.at = c.at;
        double ends[2] = {c.lo, c.hi};
        bool ok = true;
        const bool onB[2] = {c.loOnBoundary, c.hiOnBoundary};
        for (int e = 0; e < 2 && ok; e++) {
          if (!onB[e]) continue;
          // The loop's segment the line crosses nearest that end, within the piece.
          double best = INFINITY, along = 0, frac = 0;
          const BoundaryPoint *ba = nullptr, *bb = nullptr;
          for (const auto& L : fb.loops)
            for (size_t k = 0; k < L.size(); k++) {
              const BoundaryPoint &a = L[k], &b = L[(k + 1) % L.size()];
              const double xa = c.isoU ? a.uv.x : a.uv.y, xb = c.isoU ? b.uv.x : b.uv.y;
              if (xa == xb || (xa - c.at) * (xb - c.at) > 0) continue;
              const double w = (c.at - xa) / (xb - xa);
              const double ya = c.isoU ? a.uv.y : a.uv.x, yb = c.isoU ? b.uv.y : b.uv.x, y = ya + w * (yb - ya);
              if (y < c.lo || y > c.hi || std::fabs(y - ends[e]) >= best) continue;
              best = std::fabs(y - ends[e]), along = y, frac = w, ba = &a, bb = &b;
            }
          int edge, span;
          bool forward;
          ok = ba && spanOf(f, *ba, *bb, edge, span, forward);
          if (!ok) break;
          const double fr = forward ? frac : 1 - frac;
          const std::vector<double>& ts = em->edge(edge).t;
          P.endEdge[e] = edge, P.endT[e] = ts[span] + fr * (ts[span + 1] - ts[span]);
          if (!(fr > 1e-9 && fr < 1 - 1e-9)) P.endT[e] = fr < 0.5 ? ts[span] : ts[span + 1];
          else exact.push_back({edge, span, fr, true});
          ends[e] = along;
        }
        if (!ok || !(ends[0] < ends[1])) continue;
        P.s = {ends[0], ends[1]};
        creases[f].push_back(P);
      }
      // Crossings: a u-line's and a v-line's shared point.
      for (CreasePiece& A : creases[f])
        for (CreasePiece& B : creases[f])
          if (A.isoU && !B.isoU && B.at > A.s.front() && B.at < A.s.back() && A.at > B.s.front() && A.at < B.s.back())
            A.s.push_back(B.at), B.s.push_back(A.at);
      // Sampled as an edge: chord within d of the line's middle, no longer than the face's edge spacing (both coarser
      // with PartOptions::edgeSpacingScale, the chord's sag as its square, left to the split rounds).
      const double spacing = criteria[f]->edgeSpacing() * o.edgeSpacingScale;
      const double sag = o.d.linear * o.edgeSpacingScale * o.edgeSpacingScale;
      for (CreasePiece& P : creases[f]) {
        std::sort(P.s.begin(), P.s.end());
        std::vector<double> out{P.s.front()};
        std::function<void(double, double, int)> sample = [&](double a, double b, int depth) {
          SurfacePoint pa, pb, pm;
          const Vec2 ua = creaseUv(P, a), ub = creaseUv(P, b), um = creaseUv(P, 0.5 * (a + b));
          bool split = depth < 24 && s.eval(ua.x, ua.y, 0, pa) == Status::ok && s.eval(ub.x, ub.y, 0, pb) ==
            Status::ok && s.eval(um.x, um.y, 0, pm) == Status::ok;
          split = split && (norm(pm.p - 0.5 * (pa.p + pb.p)) > sag || norm(pb.p - pa.p) > spacing);
          if (split) sample(a, 0.5 * (a + b), depth + 1), sample(0.5 * (a + b), b, depth + 1);
          else out.push_back(b);
        };
        for (size_t i = 0; i + 1 < P.s.size(); i++) sample(P.s[i], P.s[i + 1], 0);
        P.s = std::move(out);
      }
      std::vector<SurfaceCriteria::Crease> lines;
      for (CreasePiece& P : creases[f]) {
        P.near = 1e-9 * (1 + std::fabs(P.at));
        lines.push_back({P.isoU, P.at, P.near});
      }
      // And the box's sides on a break of a surface going on past them (trj3's #1307: u = 6, a C0 knot inside its
      // B-spline): normals there from inside, not from the span beyond. (Not elsewhere: a pole line's are limits.)
      const SurfaceDomain D = s.domain();
      bool sideU[2] = {false, false}, sideV[2] = {false, false};
      for (int k = 0; k < 4; k++) {
        const bool isoU = k < 2;
        const double a = isoU ? (k == 0 ? ru.lo : ru.hi) : (k == 2 ? rv.lo : rv.hi);
        const Range dom = isoU ? D.u : D.v, other = isoU ? rv : ru;
        const double w = 1e-3 * box;
        const Range near{std::max(dom.lo, a - w), std::min(dom.hi, a + w)};
        if (!(near.lo < a && a < near.hi)) continue;
        std::vector<double> us, vs;
        s.breaks(isoU ? near : other, isoU ? other : near, us, vs);
        const std::vector<double>& b = isoU ? us : vs;
        if (std::find(b.begin(), b.end(), a) == b.end()) continue;
        lines.push_back({isoU, a, 1e-9 * (1 + std::fabs(a))});
        (isoU ? sideU : sideV)[k % 2] = true;
      }
      criteria[f]->setCreases(lines);
      faceBox[f] = {{sideU[0] ? ru.lo : -INFINITY, sideU[1] ? ru.hi : INFINITY},
        {sideV[0] ? rv.lo : -INFINITY, sideV[1] ? rv.hi : INFINITY}};
    }
    if (!exact.empty()) em->split(exact);
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

  /**
   * Faces left farther from their surfaces than maxDeviationFactor x the larger of the deflection and the face's
   * tolerance (cad-geom's Tolerances::face: the part's, widened by the face's own; the limit) fail: below its
   * tolerance the model doesn't say where the surface is. A refused
   * triangle is settled without measuring where its criteria's bound (deviationBound) plus its corners' distances from
   * the surface's points at their (u, v) is within the limit: its points' distances are at most that. Otherwise the
   * points of its barycentric lattice of order 4 but its corners are inverted onto the surface, the face failing at the
   * first past the limit: the verdict as measuring them all would give it (where inversion finds the nearest point),
   * the measure in its cause a lower bound on the worst.
   */
  void checkDeviation() {
    if (!(o.maxDeviationFactor > 0)) return;
    const cadgeom::Tolerances tols(m);
    const int nf = static_cast<int>(faces.size());
    for (int f = 0; f < nf; f++) {
      FaceMesh& fm = faces[f];
      if (fm.status != Status::ok || fm.rejected.empty() || !surfaces[f]) continue;
      const double within = std::fmax(o.d.linear, tols.face(f)), limit = o.maxDeviationFactor * within;
      const Surface& s = *surfaces[f];
      const SurfaceDomain D = s.domain();
      const PartProgress here{PartProgress::deviation, f, rounds, f, nf};
      report(here);
      double worst = 0;
      bool past = false;
      for (size_t k = 0; k < fm.rejected.size() && !past; k++) {
        // (The box's bound first, the pieces' only where that doesn't settle it: over a B-spline's many knots the
        // pieces cost far more, tens of thousands of refused triangles at a point cap.)
        if (refused[f].size() == fm.rejected.size() && criteria[f]) {
          const Refused& r = refused[f][k];
          double gap = 0;
          for (int i = 0; i < 3; i++) {
            SurfacePoint q;
            gap = s.eval(r.uv[i].x, r.uv[i].y, 0, q) == Status::ok ? std::fmax(gap, norm(fm.points[r.v[i]] - q.p))
                                                                   : INFINITY;
          }
          double bound;
          if (gap < limit && criteria[f]->deviationBound(r.uv, bound, false) && bound + gap <= limit) continue;
          if (gap < limit && criteria[f]->deviationBound(r.uv, bound, true) && bound + gap <= limit) continue;
        }
        if (fm.deviationMeasured++ % kDeviationReport == kDeviationReport - 1) report(here);
        const int32_t t = fm.rejected[k];
        // Each corner's (u, v), where the refused triangle's record has it: the surface's point at a lattice point's
        // barycentric (u, v), inside its domain, is a point of the surface, so its distance bounds the point's own
        // from above, and only a point it doesn't put within the limit is inverted (globally, over the whole domain:
        // dear on a B-spline).
        Vec2 uvc[3];
        bool haveUv = refused[f].size() == fm.rejected.size();
        for (int c = 0; c < 3 && haveUv; c++) {
          int at = -1;
          for (int i = 0; i < 3; i++)
            if (refused[f][k].v[i] == fm.triangles[3 * t + c]) at = i;
          haveUv = at >= 0;
          if (haveUv) uvc[c] = refused[f][k].uv[at];
        }
        for (int i = 0; i <= 4 && !past; i++)
          for (int j = 0; i + j <= 4 && !past; j++) {
            if ((i == 4) || (j == 4) || (i + j == 0)) continue;  // (the corners: on the surface)
            const Vec3 x = (i / 4.0) * fm.points[fm.triangles[3 * t]] + (j / 4.0) * fm.points[fm.triangles[3 * t + 1]]
              + ((4 - i - j) / 4.0) * fm.points[fm.triangles[3 * t + 2]];
            Vec2 uv{0, 0};
            if (haveUv) {
              uv = (i / 4.0) * uvc[0] + (j / 4.0) * uvc[1] + ((4 - i - j) / 4.0) * uvc[2];
              SurfacePoint q;
              const bool inside = uv.x >= D.u.lo && uv.x <= D.u.hi && uv.y >= D.v.lo && uv.y <= D.v.hi;
              if (inside && s.eval(uv.x, uv.y, 0, q) == Status::ok && norm(x - q.p) <= limit) continue;
            }
            // (The distance alone, within 1e-3 d of the nearest: invertSurface's distanceOnly, the lattice point's
            // barycentric (u, v) its seed.)
            const SurfaceInversion inv =
              invertSurface(s, x, D.u, D.v, o.d.linear, haveUv ? &uv : nullptr, nullptr, true);
            if (inv.status != Status::ok) continue;
            worst = std::fmax(worst, inv.distance);
            past = worst > limit;
          }
      }
      fm.worstDeviation = worst;
      if (!past) continue;
      char why[240];
      std::snprintf(why, sizeof why, "meshed past its deflection: at least %.3g x the deflection (a refused triangle's "
        "point inverted onto its surface), past %.3g x max(d, tol) = %.3g x %.3g mm", worst / o.d.linear,
        o.maxDeviationFactor, o.maxDeviationFactor, within);
      fm.status = Status::noConvergence;
      fm.cause = why;
      fm.points.clear(), fm.normals.clear(), fm.triangles.clear(), fm.rejected.clear();
      refused[f].clear();
    }
  }

  /**
   * Faces whose mesher's triangles include one turned against its surface (its facet against the mean of its corners'
   * normals, as shipped where the output's origin is known: PartOptions::outputOrigin) fail as one past its deflection
   * does (PartOptions::failTurnedOver): wrong output however small. Such a
   * triangle is one its criteria refused that refinement didn't mend (they refuse a facet turned against any corner's
   * normal). Not judged so: a pole's fans, and a triangle with a corner within the face's tolerance of a pole or apex
   * (the normal there a limit, on a strongly curved patch).
   */
  /**
   * The faces' requests whose point is inside the ring of a pole the face hasn't (EdgeMesh::split drops them; a
   * pole's own faces were sized their rings), each pole's (within `tol`) least reach to the point, never nearer the
   * pole than the refinement floor (a ring already there keeps the split dropped). Planned before the split, on the
   * spans the requests name.
   */
  std::vector<std::pair<Vec3, double>> ringShrinks(double tol) const {
    std::vector<std::pair<Vec3, double>> shrink;
    for (size_t asker = 0; asker < wanted.size(); asker++)
      for (const SplitRequest& r : wanted[asker]) {
        const EdgeSamples& es = em->edge(r.edge);
        if (es.rings.empty() || r.span < 0 || r.span + 1 >= static_cast<int>(es.t.size())) continue;
        const double f = r.exact ? r.fraction : std::clamp(r.fraction, 0.1, 0.9);
        const double x = es.t[r.span] + f * (es.t[r.span + 1] - es.t[r.span]);
        bool inRing = false;
        for (const cadgeom::Range& g : es.rings) inRing = inRing || (x > g.lo && x < g.hi);
        if (!inRing) continue;
        // (The ring is the one whose pole, among those approaching this edge, is nearest the point.)
        const Vec3 at = em->point(r.edge, x);
        const PoleRing* ring = nullptr;
        for (const auto& fr : rings)
          for (const PoleRing& pr : fr) {
            if (!(pr.reach > 0)) continue;
            bool approaches = false;
            for (auto [e, t0] : pr.approaches) approaches = approaches || e == r.edge;
            if (approaches && (!ring || norm(pr.pole - at) < norm(ring->pole - at))) ring = &pr;
          }
        if (!ring) continue;
        bool own = false;
        for (const PoleRing& pr : rings[asker]) own = own || norm(pr.pole - ring->pole) <= tol;
        for (const Vec3& q : unshrinkable) own = own || norm(q - ring->pole) <= tol;
        if (own) continue;
        // (Only a pole whose faces are all elementary: a free-form one's ring, smaller, leaves slivers along its
        // pole row that turn against the surface.)
        bool freeForm = false;
        for (size_t f = 0; f < rings.size(); f++)
          for (const PoleRing& pr : rings[f])
            if (norm(pr.pole - ring->pole) <= tol) {
              const int kind = m.surfaceKind(m.faceSurface(static_cast<int>(f)));
              freeForm = freeForm || !(kind >= CBR_SURFACE_PLANE && kind <= CBR_SURFACE_TORUS);
            }
        if (freeForm) continue;
        const double reach = std::max(norm(at - ring->pole), floor);
        if (!(reach < ring->reach)) continue;
        size_t k = 0;
        while (k < shrink.size() && norm(shrink[k].first - ring->pole) > tol) k++;
        if (k == shrink.size()) shrink.push_back({ring->pole, reach});
        else shrink[k].second = std::min(shrink[k].second, reach);
      }
    return shrink;
  }

  /**
   * A pole's rings shrunk in a round: as they were (face, ring, reach, radius), its cut edges' samples as they were
   * (a pole's rings overlap on an edge its faces approach at different parameters, each cut removing the others'
   * samples, so cutting again wouldn't give them back), and the faces it changes (its rings' and its cut edges'),
   * those ok before it.
   */
  struct RingShrink {
    Vec3 pole;
    std::vector<std::tuple<int, int, double, double>> was;
    std::vector<std::pair<int, EdgeSamples>> edges;
    std::set<int> faces, okBefore;
  };
  /** Poles whose shrink was undone (shrinkRings, undoShrinks): never shrunk again. */
  std::vector<Vec3> unshrinkable;

  /**
   * Each planned pole's rings shrunk (poles.h's shrinkRings) and cut again, so the dropped split's span is out of
   * the ring for the next round. The edges cut added to `touched`; each shrink as undoShrinks needs it.
   */
  std::vector<RingShrink> shrinkRings(const std::vector<std::pair<Vec3, double>>& shrink, double tol,
    std::set<int>& touched) {
    std::vector<RingShrink> done;
    if (shrink.empty()) return done;
    std::vector<const Surface*> sp(surfaces.size(), nullptr);
    for (size_t f = 0; f < surfaces.size(); f++) sp[f] = surfaces[f].get();
    std::set<int> cutThisRound;
    for (auto [pole, reach] : shrink) {
      RingShrink R{pole, {}, {}, {}, {}};
      for (int f = 0; f < static_cast<int>(rings.size()); f++)
        for (int k = 0; k < static_cast<int>(rings[f].size()); k++)
          if (norm(rings[f][k].pole - pole) <= tol) R.was.push_back({f, k, rings[f][k].reach, rings[f][k].radius});
      const std::vector<int> changed = tesscadio::shrinkRings(sp, rings, tol, pole, reach);
      if (changed.empty()) continue;
      std::vector<RingCut> cuts;
      std::set<std::tuple<int, double, double>> seen;
      for (int f : changed) {
        R.faces.insert(f);
        for (const PoleRing& pr : rings[f])
          if (norm(pr.pole - pole) <= tol)
            for (const RingCut& c : ringCuts(*em, pr))
              if (seen.insert({c.edge, c.approach, c.crossing}).second) cuts.push_back(c);
      }
      // (A pole whose cuts meet an edge another pole's cut this round waits for the next: each undone alone.)
      bool shared = false;
      for (const RingCut& c : cuts) shared = shared || cutThisRound.count(c.edge);
      if (shared) {
        for (auto [f, k, was, radius] : R.was) rings[f][k].reach = was, rings[f][k].radius = radius;
        continue;
      }
      for (const RingCut& c : cuts) cutThisRound.insert(c.edge);
      std::set<int> saved;
      for (const RingCut& c : cuts) {
        if (saved.insert(c.edge).second) R.edges.push_back({c.edge, em->edge(c.edge)});
        touched.insert(c.edge);
        for (int f = 0; f < static_cast<int>(faces.size()); f++)
          if (edgesOf[f].count(c.edge)) R.faces.insert(f);
      }
      for (int f : R.faces)
        if (faces[f].status == Status::ok) R.okBefore.insert(f);
      em->cutRings(cuts);
      ringsShrunk++;
      done.push_back(std::move(R));
    }
    return done;
  }

  /**
   * A shrink after which a face it changed that was ok before isn't (a pole's boundary, its ring smaller, crossing
   * itself or its edges' others): undone, the rings and their cuts as they were, the pole never shrunk again. The
   * faces to mesh again.
   */
  std::set<int> undoShrinks(const std::vector<RingShrink>& done) {
    std::set<int> again;
    for (const RingShrink& R : done) {
      bool worse = false;
      for (int f : R.okBefore) worse = worse || faces[f].status != Status::ok;
      if (!worse) continue;
      for (auto [f, k, reach, radius] : R.was) rings[f][k].reach = reach, rings[f][k].radius = radius;
      for (const auto& [e, s] : R.edges) em->restore(e, s);
      unshrinkable.push_back(R.pole);
      ringsShrunk--;
      again.insert(R.faces.begin(), R.faces.end());
    }
    return again;
  }

  /**
   * PartOptions::flipTurned over the face's mesh in (u, v) (flip.h), its points' 3D positions and normals given (as
   * the output has them, before crease copies): turned as checkFacing judges it (as shipped where the output's origin
   * is known), a corner within the face's tolerance of a pole or apex aside; accepted by the face's criteria; fixed
   * the boundary's, the constraints' (a crease's among them) and the rings' segments; barred a triangle with a point
   * on a crease or two corners at one point (a pole line). Returns the flips made.
   */
  int flipTurnedFace(int f, Mesh2& mesh, const std::vector<Vec3>& P, const std::vector<Vec3>& N,
    const std::vector<std::pair<int32_t, int32_t>>& segs, const std::set<std::pair<int32_t, int32_t>>& ringSegments,
    const std::map<int32_t, std::vector<std::pair<bool, double>>>& onCrease, bool forward) {
    if (!criteria[f] || !surfaces[f]) return 0;
    const double* O = o.outputOrigin;
    const bool shipped = std::isfinite(O[0]) && std::isfinite(O[1]) && std::isfinite(O[2]);
    auto asFloat = [](Vec3 p) {
      return Vec3{static_cast<double>(static_cast<float>(p.x)), static_cast<double>(static_cast<float>(p.y)),
        static_cast<double>(static_cast<float>(p.z))};
    };
    std::vector<Singularity> sing;
    surfaces[f]->singularities(sing);
    const double near = cadgeom::Tolerances(m).face(f);
    auto atSingular = [&](int32_t v) {
      for (const Singularity& g : sing)
        if (g.kind != Singularity::normalVanishes && norm(P[v] - g.point) <= near) return true;
      return false;
    };
    // (Counterclockwise in (u, v) is output as (a, b, c) where the face's sense is the surface's, else (a, c, b).)
    auto turned = [&](int32_t a, int32_t b, int32_t c) {
      if (atSingular(a) || atSingular(b) || atSingular(c)) return false;
      if (!forward) std::swap(b, c);
      if (shipped) {
        Vec3 q[3], n{0, 0, 0};
        const int32_t v[3] = {a, b, c};
        for (int k = 0; k < 3; k++)
          q[k] = asFloat(Vec3{P[v[k]].x - O[0], P[v[k]].y - O[1], P[v[k]].z - O[2]}), n = n + asFloat(N[v[k]]);
        return facetAgainst(cross(q[1] - q[0], q[2] - q[0]), n);
      }
      return facetAgainst(cross(P[b] - P[a], P[c] - P[a]), N[a] + N[b] + N[c]);
    };
    auto accepted = [&](int32_t a, int32_t b, int32_t c) {
      const Vec2 uv[3] = {mesh.points[a], mesh.points[b], mesh.points[c]};
      return criteria[f]->accept(uv);
    };
    auto samePoint = [&](int32_t a, int32_t b) { return P[a].x == P[b].x && P[a].y == P[b].y && P[a].z == P[b].z; };
    auto barred = [&](int32_t a, int32_t b, int32_t c) {
      return onCrease.count(a) || onCrease.count(b) || onCrease.count(c) || samePoint(a, b) || samePoint(b, c) ||
        samePoint(c, a);
    };
    std::set<std::pair<int32_t, int32_t>> fixed(ringSegments.begin(), ringSegments.end());
    for (auto [a, b] : segs) fixed.insert({std::min(a, b), std::max(a, b)});
    return flipTurned(mesh.points, mesh.triangles, mesh.rejected, fixed, turned, accepted, barred);
  }

  /** Whether the output triangle (a, b, c) of face f is turned as checkFacing judges it (a pole's corner aside). */
  bool turnedAsShipped(int f, int32_t a, int32_t b, int32_t c, const std::vector<Singularity>& sing,
    double near) const {
    const FaceMesh& fm = faces[f];
    const int32_t v[3] = {a, b, c};
    for (int32_t x : v)
      for (const Singularity& g : sing)
        if (g.kind != Singularity::normalVanishes && norm(fm.points[x] - g.point) <= near) return false;
    const double* O = o.outputOrigin;
    if (std::isfinite(O[0]) && std::isfinite(O[1]) && std::isfinite(O[2])) {
      auto asFloat = [](Vec3 p) {
        return Vec3{static_cast<double>(static_cast<float>(p.x)), static_cast<double>(static_cast<float>(p.y)),
          static_cast<double>(static_cast<float>(p.z))};
      };
      Vec3 q[3], n{0, 0, 0};
      for (int k = 0; k < 3; k++)
        q[k] = asFloat(Vec3{fm.points[v[k]].x - O[0], fm.points[v[k]].y - O[1], fm.points[v[k]].z - O[2]}),
        n = n + asFloat(fm.normals[v[k]]);
      return facetAgainst(cross(q[1] - q[0], q[2] - q[0]), n);
    }
    return facetAgainst(cross(fm.points[b] - fm.points[a], fm.points[c] - fm.points[a]),
      fm.normals[a] + fm.normals[b] + fm.normals[c]);
  }

  /**
   * Whether the flat triangle p (its corners' (u, v) uv) of face f is within maxDeviationFactor x max(d, the face's
   * tolerance) of its surface at its barycentric lattice of order 4: each point's surface point at its lattice (u, v)
   * first (an upper bound on its distance), inverted only where that isn't within. True where the factor is 0.
   */
  bool deviationWithin(int f, const Vec3 p[3], const Vec2 uv[3]) const {
    if (!(o.maxDeviationFactor > 0)) return true;
    const Surface& s = *surfaces[f];
    const SurfaceDomain D = s.domain();
    const double limit = o.maxDeviationFactor * std::fmax(o.d.linear, cadgeom::Tolerances(m).face(f));
    for (int i = 0; i <= 4; i++)
      for (int j = 0; i + j <= 4; j++) {
        const double wa = i / 4.0, wb = j / 4.0, wc = (4 - i - j) / 4.0;
        const Vec3 x = wa * p[0] + wb * p[1] + wc * p[2];
        Vec2 q = wa * uv[0] + wb * uv[1] + wc * uv[2];
        SurfacePoint sp;
        if (s.eval(q.x, q.y, 0, sp) == Status::ok && norm(x - sp.p) <= limit) continue;
        const SurfaceInversion inv = invertSurface(s, x, D.u, D.v, o.d.linear, &q, nullptr, true);
        if (inv.status != Status::ok || inv.distance > limit) return false;
      }
    return true;
  }

  /** Face f's triangle t removed: the last mesher triangle moved into its place, the fans after it shifted down. */
  void eraseTriangle(int f, size_t t) {
    FaceMesh& fm = faces[f];
    const size_t last = mesherTriangles[f] - 1;
    std::vector<int32_t> rej;
    std::vector<Refused> ref;
    const bool haveRef = refused[f].size() == fm.rejected.size();
    for (size_t k = 0; k < fm.rejected.size(); k++) {
      size_t r = static_cast<size_t>(fm.rejected[k]);
      if (r == t) continue;
      if (r == last) r = t;
      else if (r > last) r--;
      rej.push_back(static_cast<int32_t>(r));
      if (haveRef) ref.push_back(refused[f][k]);
    }
    std::copy(fm.triangles.begin() + 3 * last, fm.triangles.begin() + 3 * last + 3, fm.triangles.begin() + 3 * t);
    fm.triangles.erase(fm.triangles.begin() + 3 * last, fm.triangles.begin() + 3 * last + 3);
    fm.rejected = std::move(rej);
    if (haveRef) refused[f] = std::move(ref);
    mesherTriangles[f]--;
  }

  /** The output triangles of face f with vertex v (among its mesher's and the fans'). */
  std::vector<size_t> trianglesAt(int f, int32_t v) const {
    std::vector<size_t> out;
    const FaceMesh& fm = faces[f];
    for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3)
      if (fm.triangles[t] == v || fm.triangles[t + 1] == v || fm.triangles[t + 2] == v) out.push_back(t / 3);
    return out;
  }

  /** The (u, v) of output point v of face f where collapseInfo has it (a fan's pole doesn't: false). */
  bool uvOfPoint(int f, int32_t v, Vec2& out) const {
    const CollapseInfo& si = collapseInfo[f];
    if (v < 0 || static_cast<size_t>(v) >= si.uv.size()) return false;
    out = si.uv[v];
    return true;
  }

  /** Whether face f's triangles at vertex v and those listed all face their surface and lie within the deviation. */
  bool collapseHolds(int f, const std::vector<size_t>& tris, const std::vector<Singularity>& sing, double near) const {
    const FaceMesh& fm = faces[f];
    for (size_t t : tris) {
      const int32_t* v = &fm.triangles[3 * t];
      if (turnedAsShipped(f, v[0], v[1], v[2], sing, near)) return false;
      Vec3 p[3];
      Vec2 uv[3];
      bool known = true;
      for (int k = 0; k < 3; k++) p[k] = fm.points[v[k]], known = known && uvOfPoint(f, v[k], uv[k]);
      if (known && !deviationWithin(f, p, uv)) return false;
    }
    return true;
  }

  /**
   * Face f's interior point C collapsed onto its neighbour E (flip.h's collapseVertex), the two triangles it leaves
   * erased; kept only where collapseHolds holds of every triangle at E, and neither was a fan's. Else nothing changes.
   * Returns whether it collapsed.
   */
  bool collapseOnto(int f, int32_t C, int32_t E, const std::vector<Singularity>& sing, double near) {
    FaceMesh& fm = faces[f];
    const FaceMesh savedMesh = fm;
    const std::vector<Refused> savedRefused = refused[f];
    const size_t savedCount = mesherTriangles[f];
    std::vector<size_t> gone;
    auto uv = [&](int32_t v, Vec2& out) { return uvOfPoint(f, v, out); };
    if (!collapseVertex(uv, fm.triangles, C, E, collapseInfo[f].fixed, gone)) return false;
    // (Erased highest first, each erase moving the last mesher triangle into its place.)
    bool fans = false;
    for (size_t t : gone) fans = fans || t >= mesherTriangles[f];
    if (!fans)
      for (size_t t : gone) eraseTriangle(f, t);
    if (fans || !collapseHolds(f, trianglesAt(f, E), sing, near)) {
      faces[f] = savedMesh, refused[f] = savedRefused, mesherTriangles[f] = savedCount;
      return false;
    }
    return true;
  }

  /**
   * PartOptions::collapseTurned over every face (in order, its turned triangles in index order): collapseOnto, each
   * collapse undone there where a triangle it touches fails collapseHolds.
   */
  void collapseTurned() {
    const cadgeom::Tolerances tols(m);
    const int nf = static_cast<int>(faces.size());
    std::vector<std::vector<Singularity>> sings(nf);
    for (int f = 0; f < nf; f++)
      if (surfaces[f]) surfaces[f]->singularities(sings[f]);
    auto key = [](int32_t a, int32_t b) { return std::pair<int32_t, int32_t>{std::min(a, b), std::max(a, b)}; };
    for (int f = 0; f < nf; f++) {
      // (Not a face failCapped will fail: its many refused triangles cost as many tries.)
      if (faces[f].status != Status::ok || !collapseInfo[f].usable || !surfaces[f] || (o.failCapped && faces[f].capped))
        continue;
      const double near = tols.face(f);
      for (size_t t = 0; t < mesherTriangles[f]; t++) {
        FaceMesh& fm = faces[f];
        int32_t v[3] = {fm.triangles[3 * t], fm.triangles[3 * t + 1], fm.triangles[3 * t + 2]};
        if (!turnedAsShipped(f, v[0], v[1], v[2], sings[f], near)) continue;
        // (A, B) its longest edge in 3D, C opposite: (A, B, C) in its own order.
        int k = 0;
        double best = -1;
        for (int i = 0; i < 3; i++) {
          const double l = norm(fm.points[v[(i + 1) % 3]] - fm.points[v[i]]);
          if (l > best) best = l, k = i;
        }
        const int32_t A = v[k], B = v[(k + 1) % 3], C = v[(k + 2) % 3];
        CollapseInfo& si = collapseInfo[f];
        // (Only the mesher's own points move: not the boundary's, nor a vertex loop's point inside the face.)
        if (static_cast<size_t>(C) >= si.sample.size() || si.sample[C].first != -1) continue;
        const Vec3 pa = fm.points[A], pb = fm.points[B], pc = fm.points[C];
        const double sAB = dot(pc - pa, pb - pa) / dot(pb - pa, pb - pa);
        if (!(sAB > 0 && sAB < 1)) continue;
        // (An interior long edge: snapping C onto it is in the README's backlog, never needed on the corpus.)
        if (!si.fixed.count(key(A, B))) continue;
        // A boundary span of a model edge: its curve's point nearest C's projection. A split there would fall under
        // the floor: C, interior, collapsed onto the nearer end of AB. (Splitting a longer span there, every face's
        // triangle on it split too, is in the README's backlog.)
        const auto sa = si.sample[A], sb = si.sample[B];
        if (sa.first < 0 || sa.first != sb.first || std::abs(sa.second - sb.second) != 1 || em->isPseudo(sa.first))
          continue;
        const int e = sa.first, span = std::min(sa.second, sb.second);
        const EdgeSamples before = em->edge(e);
        const double t0 = before.t[span], t1 = before.t[span + 1];
        const Vec3 Q = pa + sAB * (pb - pa);
        // (The curve's nearest point to Q over the span: golden section, the span short.)
        double lo = t0, hi = t1;
        const double g = 0.5 * (std::sqrt(5.0) - 1);
        for (int it = 0; it < 60; it++) {
          const double x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
          if (norm(em->point(e, x1) - Q) < norm(em->point(e, x2) - Q)) hi = x2;
          else lo = x1;
        }
        const double tP = 0.5 * (lo + hi);
        const Vec3 P = em->point(e, tP);
        const Vec3 p0 = before.points[span], p1 = before.points[span + 1];
        if (norm(P - p0) >= floor && norm(P - p1) >= floor) continue;
        if (collapseOnto(f, C, norm(pc - pa) <= norm(pc - pb) ? A : B, sings[f], near)) {
          faces[f].collapsed++;
          t--;  // (the triangle at t erased, the last mesher triangle moved into its place: t again next)
        }
      }
    }
  }

  /**
   * A face whose output, welded at its shipped positions (float32 minus the output's origin, else as computed), has
   * an edge with a corner within the face's tolerance of a pole or apex used twice the same way (flip.h's
   * foldedEdges) fails: its pole's fan folds over itself (PartOptions::failFoldedFans). The facing check exempts
   * triangles there; this keeps the mesh manifold.
   */
  void checkFoldedFans() {
    if (!o.failFoldedFans) return;
    const cadgeom::Tolerances tols(m);
    const double* O = o.outputOrigin;
    const bool shipped = std::isfinite(O[0]) && std::isfinite(O[1]) && std::isfinite(O[2]);
    for (size_t f = 0; f < faces.size(); f++) {
      FaceMesh& fm = faces[f];
      if (fm.status != Status::ok || !surfaces[f]) continue;
      std::vector<Singularity> sing;
      surfaces[f]->singularities(sing);
      const double near = tols.face(static_cast<int>(f));
      std::vector<Vec3> poles;
      for (const Singularity& g : sing)
        if (g.kind != Singularity::normalVanishes) poles.push_back(g.point);
      if (poles.empty()) continue;
      // (Each point's welded index: points equal as shipped are one.)
      std::map<std::array<float, 3>, int32_t> at;
      std::vector<int32_t> weld(fm.points.size());
      std::vector<char> byPole(fm.points.size(), 0);
      for (size_t i = 0; i < fm.points.size(); i++) {
        const Vec3 p = fm.points[i];
        const std::array<float, 3> k = shipped
          ? std::array<float, 3>{static_cast<float>(p.x - O[0]), static_cast<float>(p.y - O[1]),
            static_cast<float>(p.z - O[2])}
          : std::array<float, 3>{static_cast<float>(p.x), static_cast<float>(p.y), static_cast<float>(p.z)};
        weld[i] = at.emplace(k, static_cast<int32_t>(at.size())).first->second;
        for (const Vec3& q : poles) byPole[i] = byPole[i] || norm(p - q) <= near;
      }
      const int folded = foldedEdges(fm.triangles, weld, byPole);
      if (!folded) continue;
      char why[160];
      std::snprintf(why, sizeof why, "a pole's fan folds over itself: %d %s used twice the same way", folded,
        folded == 1 ? "edge" : "edges");
      fm.status = Status::noConvergence;
      fm.cause = why;
      fm.points.clear(), fm.normals.clear(), fm.triangles.clear(), fm.rejected.clear();
    }
  }

  void checkFacing() {
    if (!o.failTurnedOver) return;
    // (As shipped, where the output's origin is known: float32 positions minus it, float32 normals.)
    const double* O = o.outputOrigin;
    const bool shipped = std::isfinite(O[0]) && std::isfinite(O[1]) && std::isfinite(O[2]);
    auto asFloat = [](Vec3 p) {
      return Vec3{static_cast<double>(static_cast<float>(p.x)), static_cast<double>(static_cast<float>(p.y)),
        static_cast<double>(static_cast<float>(p.z))};
    };
    auto asShipped = [&](Vec3 p) { return asFloat(Vec3{p.x - O[0], p.y - O[1], p.z - O[2]}); };
    const cadgeom::Tolerances tols(m);
    for (size_t f = 0; f < faces.size(); f++) {
      FaceMesh& fm = faces[f];
      if (fm.status != Status::ok || !surfaces[f]) continue;
      std::vector<Singularity> sing;
      surfaces[f]->singularities(sing);
      const double near = tols.face(static_cast<int>(f));
      auto atSingular = [&](Vec3 p) {
        for (const Singularity& g : sing)
          if (g.kind != Singularity::normalVanishes && norm(p - g.point) <= near) return true;
        return false;
      };
      int against = 0;
      for (size_t t = 0; t + 2 < fm.triangles.size() && t / 3 < mesherTriangles[f]; t += 3) {
        const int32_t* v = &fm.triangles[t];
        if (atSingular(fm.points[v[0]]) || atSingular(fm.points[v[1]]) || atSingular(fm.points[v[2]])) continue;
        if (shipped) {
          Vec3 q[3], n{0, 0, 0};
          for (int k = 0; k < 3; k++) q[k] = asShipped(fm.points[v[k]]), n = n + asFloat(fm.normals[v[k]]);
          against += facetAgainst(cross(q[1] - q[0], q[2] - q[0]), n);
          continue;
        }
        const Vec3 g = cross(fm.points[v[1]] - fm.points[v[0]], fm.points[v[2]] - fm.points[v[0]]);
        against += facetAgainst(g, fm.normals[v[0]] + fm.normals[v[1]] + fm.normals[v[2]]);
      }
      if (!against) continue;
      char why[160];
      std::snprintf(why, sizeof why, "meshed with %d triangles turned against its surface (their facets against their "
        "corners' normals, refused and not mended)", against);
      fm.status = Status::noConvergence;
      fm.cause = why;
      fm.points.clear(), fm.normals.clear(), fm.triangles.clear(), fm.rejected.clear();
    }
  }

  /** Faces whose refinement stopped at the point cap fail (PartOptions::failCapped). */
  void failCapped() {
    if (!o.failCapped) return;
    for (FaceMesh& fm : faces) {
      if (fm.status != Status::ok || !fm.capped) continue;
      fm.status = Status::noConvergence;
      fm.cause = "refinement stopped at its point cap, " + std::to_string(fm.triangles.size() / 3) + " triangles";
      fm.points.clear(), fm.normals.clear(), fm.triangles.clear(), fm.rejected.clear();
    }
  }

  void meshFace(int f) {
    at.row = f;
    if (o.progress) o.progress(at);
    FaceMesh& out = faces[f];
    out = {};
    refused[f].clear();
    collapseInfo[f] = {};
    wanted[f].clear();
    if (f < static_cast<int>(creaseSplits.size())) creaseSplits[f].clear();
    edgesOf[f].clear();
    if (!surfaces[f]) {
      out.cause = "its surface not made (a kind or form cad-geom lacks)";
      return;
    }
    if (!criteria[f]) {
      out.status = criteriaStatus[f];
      out.cause = criteriaWhy[f];
      return;
    }
    FaceBoundary fb = em->face(f);
    if (fb.status != Status::ok && fb.status != Status::singular) {
      out.status = fb.status;
      out.cause = fb.cause;
      return;
    }
    if (fb.status == Status::singular) {
      out.note = "a seam's side in (u, v) not settled by its neighbours";
      out.seamUnsettled = true;
    }
    out.againstSense = fb.againstSense;
    out.holesOnly = fb.holesOnly;
    out.foldsRepaired = fb.foldsRepaired;
    // A crease's end on the boundary: the loop's sample there put on the crease's line in this face's (u, v) (its 3D
    // point the edge's, shared; moved within the face's tolerance), so no triangle beside the end crosses the line.
    if (f < static_cast<int>(creases.size()))
      for (const CreasePiece& P : creases[f])
        for (int e = 0; e < 2; e++) {
          BoundaryPoint b;
          if (P.endEdge[e] < 0 || !boundaryPoint(fb, P.endEdge[e], P.endT[e], b)) continue;
          for (auto& L : fb.loops)
            for (BoundaryPoint& p : L)
              if (p.point.x == b.point.x && p.point.y == b.point.y && p.point.z == b.point.z)
                (P.isoU ? p.uv.x : p.uv.y) = P.at;
        }
    // (Not where the seam's side wasn't settled: such a boundary is a guess, and its face stays singular.)
    std::vector<Fan> fans;
    if (fb.status == Status::ok) fans = makeFans(f, fb);
    // The domain: the loops' points, then the interior chains' (segments between consecutive ones). A point exactly
    // equal to one before, in (u, v) and in 3D, is that point again (mesh2d.h's Domain2): a vertex a loop passes
    // twice (a hole of circles touching at their vertices), or loops share.
    Domain2 d;
    std::vector<BoundaryPoint> bp;
    std::map<std::tuple<double, double, double, double, double>, int32_t> seen;
    auto index = [&](const BoundaryPoint& p) {
      auto [it, added] = seen.try_emplace({p.uv.x, p.uv.y, p.point.x, p.point.y, p.point.z},
        static_cast<int32_t>(bp.size()));
      if (added) bp.push_back(p);
      return it->second;
    };
    for (const auto& l : fb.loops) {
      std::vector<int32_t> loop;
      for (const BoundaryPoint& p : l) loop.push_back(index(p));
      d.loops.push_back(loop);
    }
    for (const auto& c : fb.interior) {
      std::vector<int32_t> chain;
      for (const BoundaryPoint& p : c) chain.push_back(index(p));
      for (size_t i = 0; i + 1 < chain.size(); i++) d.segments.insert(d.segments.end(), {chain[i], chain[i + 1]});
    }
    // Its creases' chains: interior constraints too, an end on the boundary the loop's own sample there. Each
    // segment's (piece, k), for the splits the mesher asks of it; each point's lines, for its normals by side.
    std::map<std::pair<int32_t, int32_t>, std::pair<int, int>> creaseSegment;
    std::map<int32_t, std::vector<std::pair<bool, double>>> onCrease;
    if (f < static_cast<int>(creases.size()))
      for (size_t k = 0; k < creases[f].size(); k++) {
        const CreasePiece& P = creases[f][k];
        std::vector<int32_t> chain;
        for (size_t i = 0; i < P.s.size(); i++) {
          const int end = i == 0 ? 0 : i + 1 == P.s.size() ? 1 : -1;
          BoundaryPoint b;
          if (!(end >= 0 && P.endEdge[end] >= 0 && boundaryPoint(fb, P.endEdge[end], P.endT[end], b))) {
            b.kind = BoundaryPoint::vertexPoint, b.uv = creaseUv(P, P.s[i]);
            SurfacePoint q;
            surfaces[f]->eval(b.uv.x, b.uv.y, 0, q);
            b.point = q.p;
          }
          chain.push_back(index(b));
          onCrease[chain.back()].push_back({P.isoU, P.at});
        }
        for (size_t i = 0; i + 1 < chain.size(); i++) {
          d.segments.insert(d.segments.end(), {chain[i], chain[i + 1]});
          creaseSegment[{std::min(chain[i], chain[i + 1]), std::max(chain[i], chain[i + 1])}] =
            {static_cast<int>(k), static_cast<int>(i)};
        }
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
    // The segments the edges won't split (an edge's span whose chord is within the refinement floor, or an end
    // span too short to take a point past the edge's near-end drop, as EdgeMesh::split has them): frozen, so the
    // mesher inserts past them rather than asking.
    auto frozenSpan = [&](int32_t a, int32_t b) -> uint8_t {
      int edge, span;
      bool forward;
      if (a == b || !spanOf(f, bp[a], bp[b], edge, span, forward)) return 0;
      return norm(bp[b].point - bp[a].point) <= floor || em->endSpanFrozen(edge, span);
    };
    for (const auto& l : d.loops)
      for (size_t k = 0; k < l.size(); k++) d.frozen.push_back(frozenSpan(l[k], l[(k + 1) % l.size()]));
    for (size_t k = 0; k + 1 < d.segments.size(); k += 2)
      d.frozen.push_back(frozenSpan(d.segments[k], d.segments[k + 1]));
    // Each fan's ring as domain points (its chain's positions in its loop, through the loop's indices).
    std::vector<std::vector<int32_t>> ring(fans.size());
    for (size_t k = 0; k < fans.size(); k++)
      for (int j : fans[k].chain) ring[k].push_back(d.loops[fans[k].loop][j]);
    MeshOptions mo;
    mo.maxPoints = o.maxPointsPerFace;
    mo.minAngle = o.minAngle;
    if (o.progress) mo.onWork = [this] { o.progress(at); };
    static_assert(sizeof(Mesh2Detail::inserted) / sizeof(int) == kInsertionKinds);
    Mesh2Detail detail;
    const SizeField* field = criteria[f].get();
    if (o.reuseVerdicts) {
      // Room for this face's: the other faces' memos dropped, least recently meshed first, while the part's total is
      // past half its budget.
      if (memos[f]) memos[f]->next();
      while (memoBytes > o.verdictBudget / 2) {
        int oldest = -1;
        for (int g = 0; g < static_cast<int>(memos.size()); g++)
          if (g != f && memos[g] && (oldest < 0 || meshedAt[g] < meshedAt[oldest])) oldest = g;
        if (oldest < 0) break;
        memos[oldest].reset();
      }
      if (!memos[f]) memos[f] = std::make_unique<VerdictMemo>(*criteria[f], memoBytes, memoPeak, o.verdictBudget);
      meshedAt[f] = meshings++;
      field = memos[f].get();
    }
    // (The boundary's own points for the criteria's facet tests: the output's, which the edges' curves give.)
    {
      std::vector<std::pair<Vec2, Vec3>> own;
      own.reserve(bp.size());
      for (const BoundaryPoint& q : bp)
        if (q.kind == BoundaryPoint::edgeSample || q.kind == BoundaryPoint::pseudoSample)
          own.push_back({q.uv, q.point});
      criteria[f]->setBoundaryPoints(own);
    }
    const bool detailed = o.countInsertions || o.countAngles;
    mo.refusalKinds = o.countInsertions;
    // Meshed kKeepSteinerFrom times already (PartOptions::keepSteiner): its last mesh's points kept as seeds, but those
    // in a removed segment's diametral disc in (u, v), which holds the boundary's change there (the new point and the
    // two segments to it), and those near a new segment in the metric (within 1.5 x its diametral ellipse's radius:
    // a fixed point encroaching a fixed segment makes refinement beside it run away); none where a point of the last
    // boundary is gone. Meshed from scratch each round, a face's leftover refusals land somewhere new each time, so
    // its asks wander and a chain of rounds doesn't end; kept, they settle (Kuka #4099: 48 rounds to 30).
    const size_t nb = d.points.size();
    auto uvKey = [](Vec2 p) { return std::pair<double, double>{p.x, p.y}; };
    std::vector<std::pair<Vec2, Vec2>> segsUv;
    for (const auto& l : d.loops)
      for (size_t k = 0; k < l.size(); k++) segsUv.push_back({d.points[l[k]], d.points[l[(k + 1) % l.size()]]});
    for (size_t k = 0; k + 1 < d.segments.size(); k += 2)
      segsUv.push_back({d.points[d.segments[k]], d.points[d.segments[k + 1]]});
    if (o.keepSteiner && last[f].meshings >= kKeepSteinerFrom && !last[f].steiner.empty()) {
      std::set<std::pair<double, double>> now;
      for (Vec2 p : d.points) now.insert(uvKey(p));
      bool kept = true;
      for (Vec2 p : last[f].boundary) kept = kept && now.count(uvKey(p));
      if (kept) {
        std::set<std::tuple<double, double, double, double>> segNow, segThen;
        for (auto [a, b] : segsUv) segNow.insert({a.x, a.y, b.x, b.y}), segNow.insert({b.x, b.y, a.x, a.y});
        for (auto [a, b] : last[f].segments) segThen.insert({a.x, a.y, b.x, b.y}), segThen.insert({b.x, b.y, a.x, a.y});
        std::vector<std::pair<Vec2, double>> discs;
        for (auto [a, b] : last[f].segments)
          if (!segNow.count({a.x, a.y, b.x, b.y})) {
            const Vec2 mm{0.5 * (a.x + b.x), 0.5 * (a.y + b.y)};
            const double r2 = 0.25 * ((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
            discs.push_back({mm, r2 * (1 + 1e-9)});
          }
        struct Ellipse {
          Vec2 m, e;
          Metric2 M;
        };
        std::vector<Ellipse> fresh;
        for (auto [a, b] : segsUv)
          if (!segThen.count({a.x, a.y, b.x, b.y})) {
            const Metric2 Ma = criteria[f]->metric(a), Mb = criteria[f]->metric(b);
            fresh.push_back({{0.5 * (a.x + b.x), 0.5 * (a.y + b.y)}, {0.5 * (b.x - a.x), 0.5 * (b.y - a.y)},
              {0.5 * (Ma.a + Mb.a), 0.5 * (Ma.b + Mb.b), 0.5 * (Ma.c + Mb.c)}});
          }
        auto mdot = [](const Metric2& M, Vec2 u) { return M.a * u.x * u.x + 2 * M.b * u.x * u.y + M.c * u.y * u.y; };
        for (Vec2 q : last[f].steiner) {
          bool in = now.count(uvKey(q)) > 0;
          for (size_t k = 0; k < discs.size() && !in; k++) {
            const Vec2 mm = discs[k].first;
            in = (q.x - mm.x) * (q.x - mm.x) + (q.y - mm.y) * (q.y - mm.y) <= discs[k].second;
          }
          for (size_t k = 0; k < fresh.size() && !in; k++) {
            const Ellipse& E = fresh[k];
            in = mdot(E.M, {q.x - E.m.x, q.y - E.m.y}) <= 2.25 * mdot(E.M, E.e);
          }
          if (!in) d.seeds.push_back(q), now.insert(uvKey(q));
        }
      }
    }
    Mesh2 mesh = detailed ? mesh2Detailed(d, *field, mo, &detail) : mesh2(d, *field, mo);
    // (Meshing from the seeds failed, or left a triangle its criteria refuse, which a kept point can stand in the way
    // of without the triangle asking a split: from the boundary alone, as the first time.)
    if (!d.seeds.empty() && ((mesh.status != Status::ok && mesh.status != Status::noConvergence) ||
      !mesh.rejected.empty())) {
      d.seeds.clear();
      mesh = detailed ? mesh2Detailed(d, *field, mo, &detail) : mesh2(d, *field, mo);
    }
    {
      const int meshings = last[f].meshings + 1;
      last[f] = {};
      last[f].meshings = meshings;
    }
    if (o.keepSteiner && (mesh.status == Status::ok || mesh.status == Status::noConvergence)) {
      last[f].boundary.assign(d.points.begin(), d.points.begin() + nb);
      last[f].steiner.assign(mesh.points.begin() + nb, mesh.points.end());
      last[f].segments = std::move(segsUv);
    }
    if (o.countInsertions) std::copy(detail.inserted, detail.inserted + kInsertionKinds, out.inserted);
    if (mesh.status != Status::ok && mesh.status != Status::noConvergence) {
      // (A boundary whose seam side wasn't settled fails for that.)
      out.status = fb.status == Status::singular ? Status::singular : mesh.status;
      out.cause = fb.status == Status::singular ? fb.cause : meshWhy(mesh, bp);
      // Segments that cross, or one through a point: each segment the refusal names (every one, not the first:
      // mesh2 names them all; a span named twice split once, as split keeps one request a span) that is an edge's
      // span split at its middle, for the next round to mesh again.
      // Two edges leaving a vertex nearly tangent (the coarser one's chord across the other's samples), or two loops
      // closer than their chords' sag (a ring thinner than the deflection): no criterion of either edge sees it, and
      // a few spans a round wouldn't mend many crossings within the rounds.
      if (mesh.rejected.size() >= 4)
        for (size_t k = 0; k + 1 < mesh.rejected.size(); k += 2) {
          const int32_t a = mesh.rejected[k], b = mesh.rejected[k + 1];
          int edge, span;
          bool forward;
          if (a >= 0 && b >= 0 && a < static_cast<int32_t>(bp.size()) && b < static_cast<int32_t>(bp.size()) &&
            spanOf(f, bp[a], bp[b], edge, span, forward))
            wanted[f].push_back({edge, span, 0.5});
        }
      out.splitsWanted = static_cast<int>(wanted[f].size());
      return;
    }
    out.status = Status::ok;
    if (mesh.status == Status::noConvergence) {
      out.note += std::string(out.note.empty() ? "" : "; ") + "refinement stopped at its point cap";
      out.capped = true;
    }
    // The segments' pairs, as mesh2d.h numbers them: each loop's, then the interior ones.
    std::vector<std::pair<int32_t, int32_t>> segs;
    for (const auto& l : d.loops)
      for (size_t k = 0; k < l.size(); k++) segs.push_back({l[k], l[(k + 1) % l.size()]});
    for (size_t k = 0; k + 1 < d.segments.size(); k += 2) segs.push_back({d.segments[k], d.segments[k + 1]});
    // (A ring's segments, consecutive in a fan's ring, aren't an edge's: counted, as refinement is blocked there.)
    std::set<std::pair<int32_t, int32_t>> ringSegments;
    for (const auto& rg : ring)
      for (size_t j = 0; j + 1 < rg.size(); j++)
        ringSegments.insert({std::min(rg[j], rg[j + 1]), std::max(rg[j], rg[j + 1])});
    bool blocked = false;
    for (const SplitWanted& w : mesh.splitWanted) {
      if (w.segment < 0 || w.segment >= static_cast<int32_t>(segs.size())) continue;
      int edge, span;
      bool forward;
      auto [a, b] = segs[w.segment];
      if (spanOf(f, bp[a], bp[b], edge, span, forward))
        wanted[f].push_back({edge, span, forward ? w.fraction : 1 - w.fraction});
      else if (auto c = creaseSegment.find({std::min(a, b), std::max(a, b)}); c != creaseSegment.end())
        creaseSplits[f].insert(c->second);
      else
        blocked = blocked || ringSegments.count({std::min(a, b), std::max(a, b)});
    }
    if (blocked) ringBlocked[f]++;
    out.ringBlocked = ringBlocked[f];
    // (A pole line's segments, which the floored metric can find long, can't be split; a ring is fixed: its segments
    // are this code's own, and the edges' spans inside it are kept empty, cutRings.)
    out.splitsWanted = static_cast<int>(wanted[f].size() + creaseSplits[f].size());
    out.sampled = !criteria[f]->bounded();
    if (o.countExpected) {
      double metricArea = 0;
      for (size_t t = 0; t + 2 < mesh.triangles.size(); t += 3) {
        const Vec2 a = mesh.points[mesh.triangles[t]], b = mesh.points[mesh.triangles[t + 1]],
                   c = mesh.points[mesh.triangles[t + 2]];
        const double area = 0.5 * std::fabs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
        metricArea += area * criteria[f]->gridDensity({(a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3});
      }
      out.expectedTriangles = metricArea / (std::sqrt(3.0) / 4);
    }
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
      // (At a singular point, the limit where the surface gives one: surface.h's normal() with Status::singular. On
      // the box's side, from inside: the surface may go on past a C0 line there, findFaceCreases.)
      Vec2 at = mesh.points[i];
      if (f < static_cast<int>(faceBox.size())) {
        const auto [bu, bv] = faceBox[f];
        auto in = [](double& x, Range r) {
          if (x == r.lo) x = r.lo + 1e-9 * (1 + std::fabs(r.lo));
          else if (x == r.hi) x = r.hi - 1e-9 * (1 + std::fabs(r.hi));
        };
        in(at.x, bu), in(at.y, bv);
      }
      Vec3 nn;
      Status ns = s.normal(at.x, at.y, nn);
      if ((ns == Status::ok || ns == Status::singular) && std::isfinite(norm(nn)) && std::fabs(norm(nn) - 1) < 1e-9) {
        out.normals[i] = sense * nn;
        regular[i] = 1;
      }
    }
    auto samePoint = [](Vec3 a, Vec3 b) { return a.x == b.x && a.y == b.y && a.z == b.z; };
    // (Not where refinement stopped at its point cap and the face fails for that: a capped face's many refused
    // triangles cost as many tries.)
    if (o.flipTurned && o.failTurnedOver && !(mesh.status == Status::noConvergence && o.failCapped))
      out.turnedFlips = flipTurnedFace(f, mesh, out.points, out.normals, segs, ringSegments, onCrease, sense > 0);
    // The thin triangles (PartOptions::countAngles), but those with two corners on a pole line (no triangle in 3D).
    if (o.countAngles)
      for (size_t k = 0; k < detail.thin.size(); k++) {
        const int32_t* v = &mesh.triangles[3 * static_cast<size_t>(detail.thin[k])];
        const Vec3 &a = out.points[v[0]], &b = out.points[v[1]], &c = out.points[v[2]];
        if (samePoint(a, b) || samePoint(b, c) || samePoint(a, c)) continue;
        const double deg = detail.thinAngle[k] * 180 / M_PI;
        const uint8_t fl = detail.thinFlags[k];
        out.thin++;
        out.thinByAngle[deg < 1 ? 0 : deg < 2 ? 1 : deg < 5 ? 2 : deg < 8 ? 3 : deg < 10 ? 4 : 5]++;
        out.thinArea += 0.5 * norm(cross(b - a, c - a));
        out.thinBoundary += (fl & kThinBoundary) != 0, out.thinFrozen += (fl & kThinFrozen) != 0;
        out.thinFloor += (fl & kThinFloor) != 0;
      }
    std::set<int32_t> refusedHere(mesh.rejected.begin(), mesh.rejected.end());
    // A point on a crease: a copy per side of its lines a triangle lies on, each with its side's normal (the
    // surface's there one-sided), the first side met keeping the point itself.
    std::map<std::pair<int32_t, int>, int32_t> sideCopy;
    auto bySide = [&](int32_t v, const int32_t* tri) -> int32_t {
      auto it = onCrease.find(v);
      if (it == onCrease.end()) return v;
      const Vec2 g{(mesh.points[tri[0]].x + mesh.points[tri[1]].x + mesh.points[tri[2]].x) / 3,
        (mesh.points[tri[0]].y + mesh.points[tri[1]].y + mesh.points[tri[2]].y) / 3};
      Vec2 q = mesh.points[v];
      int key = 0;
      for (size_t l = 0; l < it->second.size() && l < 8; l++) {
        auto [isoU, at] = it->second[l];
        const double side = isoU ? g.x : g.y;
        if (side == at) continue;
        (isoU ? q.x : q.y) = at + (side > at ? 1 : -1) * 1e-9 * (1 + std::fabs(at));
        key |= (side > at ? 1 : 2) << (2 * l);
      }
      Vec3 nn;
      const Status ns = s.normal(q.x, q.y, nn);
      const bool reg = (ns == Status::ok || ns == Status::singular) && std::isfinite(norm(nn)) &&
        std::fabs(norm(nn) - 1) < 1e-9;
      auto [c, added] = sideCopy.try_emplace({v, key}, v);
      if (added) {
        bool first = true;
        for (const auto& [k, w] : sideCopy) first = first && !(k.first == v && k.second != key);
        if (!first) {
          c->second = static_cast<int32_t>(out.points.size());
          out.points.push_back(out.points[v]);
          out.normals.push_back(Vec3{0, 0, 0});
          regular.push_back(0);
        }
        if (reg) out.normals[c->second] = sense * nn, regular[c->second] = 1;
      }
      return c->second;
    };
    for (size_t t = 0; t + 2 < mesh.triangles.size(); t += 3) {
      int32_t a = mesh.triangles[t], b = mesh.triangles[t + 1], c = mesh.triangles[t + 2];
      if (samePoint(out.points[a], out.points[b]) || samePoint(out.points[b], out.points[c]) ||
        samePoint(out.points[a], out.points[c]))
        continue;  // two corners on a pole line: no triangle in 3D
      const Vec2 uvTri[3] = {mesh.points[a], mesh.points[b], mesh.points[c]};
      if (!onCrease.empty()) {
        const int32_t* tri = &mesh.triangles[t];
        a = bySide(a, tri), b = bySide(b, tri), c = bySide(c, tri);
      }
      if (refusedHere.count(static_cast<int32_t>(t / 3))) {
        out.rejected.push_back(static_cast<int32_t>(out.triangles.size() / 3));
        out.refusedBy[static_cast<int>(criteria[f]->refusal(uvTri))]++;
        refused[f].push_back({{uvTri[0], uvTri[1], uvTri[2]}, {a, b, c}});
      }
      // Counterclockwise in (u, v) is about S_u x S_v: turned where the face's normal is the opposite.
      if (sense > 0) out.triangles.insert(out.triangles.end(), {a, b, c});
      else out.triangles.insert(out.triangles.end(), {a, c, b});
    }
    mesherTriangles[f] = out.triangles.size() / 3;
    if (onCrease.empty()) {
      CollapseInfo& si = collapseInfo[f];
      si.uv.assign(mesh.points.begin(), mesh.points.end());
      si.sample.assign(n, {-1, -1});
      for (size_t i = 0; i < bp.size() && i < n; i++)
        si.sample[i] = bp[i].kind == BoundaryPoint::edgeSample
          ? std::pair<int32_t, int32_t>{bp[i].edgeIndex, bp[i].sample} : std::pair<int32_t, int32_t>{-2, -1};
      for (auto [a, b] : segs) si.fixed.insert({std::min(a, b), std::max(a, b)});
      si.fixed.insert(ringSegments.begin(), ringSegments.end());
      si.usable = true;
    }
    // The fans: each ring's chain to its pole, a point of its own (the run's edge sample there, else the surface's).
    for (size_t k = 0; k < fans.size(); k++) {
      const Fan& fan = fans[k];
      int32_t pole = static_cast<int32_t>(out.points.size());
      out.points.push_back(fan.pole);
      Vec3 nn{0, 0, 0};
      double q0 = freeOf(fan.first.uv, fan.isoU), q1 = freeOf(fan.last.uv, fan.isoU);
      Vec2 puv = uvOf(fan.at, 0.5 * (q0 + q1), fan.isoU);
      Status ns = s.normal(puv.x, puv.y, nn);
      bool reg = (ns == Status::ok || ns == Status::singular) && std::isfinite(norm(nn)) &&
        std::fabs(norm(nn) - 1) < 1e-9;
      out.normals.push_back(reg ? sense * nn : Vec3{0, 0, 0});
      regular.push_back(reg);
      for (size_t j = 0; j + 1 < ring[k].size(); j++) {
        int32_t a = ring[k][j], b = ring[k][j + 1];
        double qa = freeOf(mesh.points[a], fan.isoU), qb = freeOf(mesh.points[b], fan.isoU);
        const Vec2 apex = uvOf(fan.at, 0.5 * (qa + qb), fan.isoU);
        Vec2 tri[3] = {mesh.points[a], mesh.points[b], apex};
        orient(tri);
        if (!(fan.smooth ? criteria[f]->acceptFan(tri) : criteria[f]->acceptDeviation(tri))) {
          out.rejected.push_back(static_cast<int32_t>(out.triangles.size() / 3));
          out.refusedBy[static_cast<int>(criteria[f]->refusal(tri, fan.smooth, true))]++;
          refused[f].push_back({{mesh.points[a], mesh.points[b], apex}, {a, b, pole}});
        }
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
  I.memos.resize(nf);
  I.meshedAt.assign(nf, 0);
  I.criteriaStatus.assign(nf, Status::unsupported);
  I.criteriaWhy.assign(nf, "");
  I.faces.resize(nf);
  I.edgesOf.resize(nf);
  I.wanted.resize(nf);
  I.rings.resize(nf);
  I.mesherTriangles.assign(nf, 0);
  I.collapseInfo.assign(nf, {});
  I.ringBlocked.assign(nf, 0);
  I.refused.resize(nf);
  I.last.resize(nf);
  I.creases.assign(nf, {}), I.creaseSplits.assign(nf, {});
  const cadgeom::Tolerances tols(m);
  I.floor = refinementFloor(tols.part(), I.o.d.linear);
  for (int f = 0; f < nf; f++) {
    Status st;
    // (A face with no loops too: its surface's natural extent, where it has one, edges.h.)
    I.report({PartProgress::surfaces, f, 0, f, nf});
    I.surfaces[f] = closedSurface(m, tols, f, st);
  }
  // The edges sampled once, at their own deflection and angle; the faces' (u, v) boxes from those samples, their
  // criteria, then the edges refined to the spacing the criteria ask (EdgeMesh::respace): each use traced once.
  std::vector<double> spacing(nf, INFINITY);
  {
    EdgeOptions eo = I.edgeOptions();
    eo.progress = I.edgeProgress(PartProgress::edges);
    I.em = std::make_unique<EdgeMesh>(m, eo);
    EdgeMesh& first = *I.em;
    for (int f = 0; f < nf; f++) {
      I.report({PartProgress::criteria, f, 0, f, nf});
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
        I.criteriaWhy[f] = !fb.cause.empty() ? fb.cause : "its boundary gives no points in (u, v)";
        continue;
      }
      I.criteria[f] = makeCriteria(m, f, *I.surfaces[f], box, I.o.d, I.criteriaStatus[f]);
      if (I.criteria[f]) I.criteria[f]->setOutputOrigin(I.o.outputOrigin);
      if (!I.criteria[f]) I.criteriaWhy[f] = "no criteria for it (its (u, v) box not finite)";
      if (I.criteria[f]) spacing[f] = I.criteria[f]->edgeSpacing() * I.o.edgeSpacingScale;
    }
  }
  I.em->respace(spacing);
  // The poles' rings: each face's, one reach per pole across faces, cut into the edges through them once for all.
  {
    std::vector<const Surface*> sp(nf, nullptr);
    for (int f = 0; f < nf; f++) {
      sp[f] = I.surfaces[f].get();
      if (!I.surfaces[f] || !I.criteria[f]) continue;
      FaceBoundary fb = I.em->face(f);
      if (fb.status != Status::ok) continue;
      I.rings[f] = facePoles(m, f, *I.surfaces[f], fb, *I.em, *I.criteria[f], tols.face(f), I.o.d.linear,
        I.o.d.angular);
    }
    shareRings(sp, I.rings, tols.part());
    std::vector<RingCut> cuts;
    std::set<std::tuple<int, double, double>> seen;
    for (int f = 0; f < nf; f++)
      for (const PoleRing& r : I.rings[f])
        for (const RingCut& c : ringCuts(*I.em, r))
          if (seen.insert({c.edge, c.approach, c.crossing}).second) cuts.push_back(c);
    if (!cuts.empty()) I.em->cutRings(cuts);
  }
  if (I.o.creases) I.findFaceCreases();
  I.at = {PartProgress::meshing, 0, 0, 0, nf};
  for (int f = 0; f < nf; f++, I.at.facesDone++) I.meshFace(f);
  for (I.rounds = 0; I.rounds < I.o.maxSplitRounds; I.rounds++) {
    // Every face's wanted splits, each span once (the first face's fraction).
    std::vector<SplitRequest> requests;
    std::set<std::pair<int, int>> seen;
    for (int f = 0; f < nf; f++)
      for (const SplitRequest& r : I.wanted[f])
        if (seen.insert({r.edge, r.span}).second) requests.push_back(r);
    // And the creases' segments the faces asked split: a sample at the middle, the face meshed again.
    std::set<int> creased;
    for (int f = 0; f < nf && f < static_cast<int>(I.creaseSplits.size()); f++) {
      if (I.creaseSplits[f].empty()) continue;
      for (auto it = I.creaseSplits[f].rbegin(); it != I.creaseSplits[f].rend(); ++it) {
        std::vector<double>& cs = I.creases[f][it->first].s;
        const size_t k = static_cast<size_t>(it->second);
        if (k + 1 < cs.size()) cs.insert(cs.begin() + k + 1, 0.5 * (cs[k] + cs[k + 1]));
      }
      creased.insert(f);
    }
    if (requests.empty() && creased.empty()) break;
    I.report({PartProgress::splitting, -1, I.rounds + 1, 0, static_cast<int>(requests.size())});
    // Only the edges the split changed: it drops a request inside a pole's ring or on a span within the refinement
    // floor (EdgeMesh::split), and a face whose edges didn't change would mesh to the same bits again, asking the
    // same. None changed (and no crease split): the rounds end.
    std::map<int, size_t> before;
    for (const SplitRequest& r : requests) before.emplace(r.edge, I.em->edge(r.edge).t.size());
    const std::vector<std::pair<Vec3, double>> shrinks = I.ringShrinks(tols.part());
    if (!requests.empty()) I.em->split(requests);
    std::set<int> touched;
    for (auto [e, n] : before)
      if (I.em->edge(e).t.size() != n) touched.insert(e);
    const std::vector<Impl::RingShrink> shrunk = I.shrinkRings(shrinks, tols.part(), touched);
    if (touched.empty() && creased.empty()) break;
    std::vector<int> redo;
    for (int f = 0; f < nf; f++) {
      bool again = creased.count(f) > 0;
      for (const Impl::RingShrink& R : shrunk) again = again || R.faces.count(f);
      for (int e : touched) again = again || I.edgesOf[f].count(e);
      if (again) redo.push_back(f);
    }
    I.at = {PartProgress::meshing, 0, I.rounds + 1, 0, static_cast<int>(redo.size())};
    for (int f : redo) {
      I.meshFace(f);
      I.at.facesDone++;
    }
    for (const Impl::RingShrink& R : shrunk) I.ringFacesRemeshed += static_cast<int>(R.faces.size());
    const std::set<int> undone = I.undoShrinks(shrunk);
    for (int f : undone) I.meshFace(f);
    I.ringFacesRemeshed += static_cast<int>(undone.size());
  }
  I.memos.clear();
  if (I.o.collapseTurned) I.collapseTurned();
  I.failCapped();
  I.checkDeviation();
  I.checkFacing();
  I.checkFoldedFans();
}

PartMesher::~PartMesher() { delete impl_; }
const FaceMesh& PartMesher::face(int f) const { return impl_->faces[f]; }
const EdgeMesh& PartMesher::edges() const { return *impl_->em; }
int PartMesher::rounds() const { return impl_->rounds; }
int PartMesher::ringsShrunk() const { return impl_->ringsShrunk; }
int PartMesher::ringFacesRemeshed() const { return impl_->ringFacesRemeshed; }
size_t PartMesher::verdictPeak() const { return impl_->memoPeak; }

} // namespace tesscadio
