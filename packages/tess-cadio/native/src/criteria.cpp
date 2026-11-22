// The criteria (criteria.h). The metric is local and anisotropic: at each (u, v) the principal curvatures k1, k2 and
// their directions (the eigenpairs of the second fundamental form against the first), and along each direction the
// size h_i a chord may have, the smallest of sqrt(6 d / |k_i|) (an equilateral triangle's centroid strays h^2 |k| / 6
// from the surface), angle / |k_i| (the normal turns h |k| along it) and the face's 3D extent. In 3D the metric is
// sum e_i e_i^T / h_i^2 (e_i the unit principal directions), conservative in every direction between them (the
// normal curvature there is k1 cos^2 + k2 sin^2); in (u, v) it's pulled back through S_u, S_v. Sizes graded: the
// metric on a grid over the face's (u, v) box, each node's intersected with its neighbours' grown by their distance
// (Borouchaki, Hecht and Frey, "Mesh gradation control", 1998: M / (1 + beta L)^2 at metric length L), the size
// growing at most kGrowth per unit of its own length; a query takes the grid's, interpolated, intersected with its
// own point's. Where the parameterization degenerates (a pole: S_u x S_v vanishing) the point's own is skipped and
// the grid's used.
// accept() bounds a triangle's deviation from the surface on planes and cylinders by the second derivative bounds over
// its (u, v) box (Local::bounds), takes a sphere's exactly, and samples the rest (the centroid and edges' middles:
// makeCriteria says why). The normals are sampled: the corners' within the angle of one another and of the facet's
// own (a triangle turned over in 3D). No check of the facet's tilt for area: with its corners on the surface and its
// normal within the angle of theirs, the patch it stands for is a graph over it, whose area (the integral of
// 1 / cos of the normals' tilt) is at least the facet's; a mesh's area exceeds its face's only where the boundary's
// chords stand for a region past the boundary curve (a band's on a sphere), not through a facet's tilt.
#include "tess_cadio/criteria.h"

#include "cad_geom/tolerance.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <unordered_map>
#include <vector>

namespace tesscadio {

using namespace cadgeom;

namespace {

/** The size's growth per unit of its own length between neighbouring points, at most (the gradation). */
constexpr double kGrowth = 0.5;
/** Grid cells per side of the face's (u, v) box, for the gradation. */
constexpr int kGrid = 16;
/** A triangle's (u, v) box is cut for its second derivative bounds kSplit x kSplit besides its breaks, into
 * kMaxPieces at most. */
constexpr int kSplit = 2;
constexpr size_t kMaxPieces = 64;

Metric2 scaled(Metric2 m, double s) { return {m.a * s, m.b * s, m.c * s}; }
double length2(Metric2 m, double x, double y) { return m.a * x * x + 2 * m.b * x * y + m.c * y * y; }

/** The symmetric 2 x 2 matrix's eigenvalues (lo, hi) and the unit eigenvector of hi. */
void eigen(Metric2 m, double& lo, double& hi, Vec2& vHi) {
  double t = 0.5 * (m.a + m.c), d = std::sqrt(0.25 * (m.a - m.c) * (m.a - m.c) + m.b * m.b);
  lo = t - d, hi = t + d;
  Vec2 v = std::fabs(m.a - hi) + std::fabs(m.b) >= std::fabs(m.c - hi) + std::fabs(m.b) ? Vec2{m.b, hi - m.a}
    : Vec2{hi - m.c, m.b};
  double l = std::hypot(v.x, v.y);
  vHi = l > 0 ? Vec2{v.x / l, v.y / l} : Vec2{1, 0};
}

/** m with its smaller eigenvalue at least `ratio` times its larger: positive definite whatever rounding did. */
Metric2 floored(Metric2 m, double ratio) {
  double lo, hi;
  Vec2 v;
  eigen(m, lo, hi, v);
  if (!(hi > 0) || !std::isfinite(hi)) return {1, 0, 1};
  if (lo >= ratio * hi) return m;
  lo = ratio * hi;
  // hi v v^T + lo w w^T, w perpendicular to v.
  return {hi * v.x * v.x + lo * v.y * v.y, (hi - lo) * v.x * v.y, hi * v.y * v.y + lo * v.x * v.x};
}

/**
 * The intersection of two metrics (the larger of the two in every direction, by simultaneous reduction), in the
 * symmetric form that stays well conditioned when they're nearly proportional: A = L L^T (Cholesky), C = L^-1 B L^-T
 * with orthonormal eigenvectors Q and eigenvalues c_i, M = L Q diag(max(1, c_i)) Q^T L^T.
 */
Metric2 intersect(Metric2 A, Metric2 B) {
  if (!(A.a > 0) || !(A.a * A.c - A.b * A.b > 0)) return B;
  double l11 = std::sqrt(A.a), l21 = A.b / l11, l22 = std::sqrt(A.c - l21 * l21);
  // L^-1 = [[1 / l11, 0], [-l21 / (l11 l22), 1 / l22]]; C = L^-1 B L^-T.
  double i11 = 1 / l11, i21 = -l21 / (l11 * l22), i22 = 1 / l22;
  double r1a = i11 * B.a, r1b = i11 * B.b;                                      // row 1 of L^-1 B
  double r2a = i21 * B.a + i22 * B.b, r2b = i21 * B.b + i22 * B.c;              // row 2
  Metric2 C{r1a * i11, r1a * i21 + r1b * i22, r2a * i21 + r2b * i22};
  double lo, hi;
  Vec2 v;
  eigen(C, lo, hi, v);
  double dh = std::max(1.0, hi), dl = std::max(1.0, lo);
  // Q D Q^T with Q = [v w], w perpendicular to v.
  Metric2 D{dh * v.x * v.x + dl * v.y * v.y, (dh - dl) * v.x * v.y, dh * v.y * v.y + dl * v.x * v.x};
  // M = L D L^T, L = [[l11, 0], [l21, l22]].
  return {l11 * l11 * D.a, l11 * (l21 * D.a + l22 * D.b),
    l21 * l21 * D.a + 2 * l21 * l22 * D.b + l22 * l22 * D.c};
}

/** A (u, v) metric's smaller eigenvalue at least this times its larger: positive definite (sizes 1e7 apart at most). */
constexpr double kUvFloor = 1e-14;

/**
 * m with its smaller eigenvalue at least `ratio` times its larger in 3D, through the surface's first fundamental form
 * I = L L^T (Cholesky): m's form on 3D tangent vectors, L^-1 m L^-T, floored and taken back. In (u, v) the ratio would
 * be the 3D one times the parameterization's distortion (a cylinder of radius r: |S_u| = r, |S_v| = 1), so it would
 * cap a large one's size along its axis at a few times its size across. Then floored in (u, v) at kUvFloor, for
 * positive definiteness whatever rounding did. I degenerate (a pole): floored in (u, v) alone.
 */
Metric2 flooredIn3d(Metric2 m, Metric2 I, double ratio) {
  // (Degenerate as own() judges it, at a pole: L's tiny entry would turn rounding into the metric.)
  const double det = I.a * I.c - I.b * I.b;
  if (!(I.a > 0) || !(det > 1e-12 * (I.a + I.c) * (I.a + I.c)) || !std::isfinite(det)) return floored(m, ratio);
  double l11 = std::sqrt(I.a), l21 = I.b / l11, l22 = std::sqrt(I.c - l21 * l21);
  double i11 = 1 / l11, i21 = -l21 / (l11 * l22), i22 = 1 / l22;
  double r1a = i11 * m.a, r1b = i11 * m.b;
  double r2a = i21 * m.a + i22 * m.b, r2b = i21 * m.b + i22 * m.c;
  const Metric2 D = floored({r1a * i11, r1a * i21 + r1b * i22, r2a * i21 + r2b * i22}, ratio);
  return floored({l11 * l11 * D.a, l11 * (l21 * D.a + l22 * D.b),
    l21 * l21 * D.a + 2 * l21 * l22 * D.b + l22 * l22 * D.c}, kUvFloor);
}

class Local : public SurfaceCriteria {
public:
  /** The kinds whose deviation has a closed form: their frame (origin, axis), and radius and a second parameter. */
  enum class Kind { none, sphere, cone, torus };
  Local(const Surface& s, Box2 uv, const Deflections& d, double extent, bool bounded, Kind kind, Vec3 centre,
    Vec3 axis, double radius, double second, double tolerance, bool elementary)
    : s_(s), box_(uv), d_(d), hmax_(extent), hmin_(1e-7 * extent), bounded_(bounded), elementary_(elementary),
      kind_(kind),
      centre_(centre), axis_(axis), radius_(radius), second_(second),
      floor_(refinementFloor(tolerance, d.linear)), tolerance_(tolerance) {
    std::vector<Singularity> sing;
    s.singularities(sing);
    for (const Singularity& g : sing)
      if (g.kind != Singularity::normalVanishes) poles_.push_back(g.point);
    // The grid's own metrics, then graded: sweeps until no node changes (or a bound on them).
    grid_.resize((kGrid + 1) * (kGrid + 1));
    valid_.assign(grid_.size(), false);
    for (int i = 0; i <= kGrid; i++)
      for (int j = 0; j <= kGrid; j++) valid_[at(i, j)] = own(node(i, j), grid_[at(i, j)]);
    // Nodes at a degenerate point take a valid neighbour's (the nearest along the row or column).
    for (int pass = 0; pass < 2 * kGrid; pass++) {
      bool missing = false;
      for (int i = 0; i <= kGrid; i++)
        for (int j = 0; j <= kGrid; j++) {
          if (valid_[at(i, j)]) continue;
          missing = true;
          for (auto [di, dj] : {std::pair{1, 0}, {-1, 0}, {0, 1}, {0, -1}}) {
            int a = i + di, b = j + dj;
            if (a < 0 || b < 0 || a > kGrid || b > kGrid || !valid_[at(a, b)]) continue;
            grid_[at(i, j)] = grid_[at(a, b)], valid_[at(i, j)] = true;
            break;
          }
        }
      if (!missing) break;
    }
    for (int i = 0; i <= kGrid; i++)
      for (int j = 0; j <= kGrid; j++) grid_[at(i, j)] = floorOf(grid_[at(i, j)], node(i, j));
    for (int sweep = 0; sweep < 4 * kGrid; sweep++) {
      bool changed = false;
      for (int i = 0; i <= kGrid; i++)
        for (int j = 0; j <= kGrid; j++)
          for (int di = -1; di <= 1; di++)
            for (int dj = -1; dj <= 1; dj++) {
              int a = i + di, b = j + dj;
              if ((!di && !dj) || a < 0 || b < 0 || a > kGrid || b > kGrid) continue;
              Vec2 p = node(i, j), q = node(a, b);
              Metric2 from = grid_[at(a, b)];
              double L = std::sqrt(length2(from, p.x - q.x, p.y - q.y));
              Metric2 grown = scaled(from, 1 / ((1 + kGrowth * L) * (1 + kGrowth * L)));
              Metric2& m = grid_[at(i, j)];
              Metric2 n = intersect(m, grown);
              // (Changed where it's longer than before in some direction, by more than rounding.)
              bool longer = false;
              for (auto [x, y] : {std::pair{1.0, 0.0}, {0.0, 1.0}, {1.0, 1.0}, {1.0, -1.0}})
                longer = longer || length2(n, x, y) > length2(m, x, y) * (1 + 1e-9);
              if (longer) m = n, changed = true;
            }
      if (!changed) break;
    }
    for (int i = 0; i <= kGrid; i++)
      for (int j = 0; j <= kGrid; j++) spacing_ = std::max(spacing_, largest(grid_[at(i, j)], i, j));
    spacing_ = std::min(spacing_, hmax_);
  }

  double edgeSpacing() const override { return spacing_; }
  void setCreases(std::vector<Crease> lines) override { creases_ = std::move(lines); }

  bool bounded() const override { return (bounded_ || kind_ != Kind::none) && !sampledAny_; }

  Metric2 metric(Vec2 p) const override {
    // (On an elementary surface each floored in 3D where its first fundamental form is its own: the grid's at its
    // nodes, the point's own here. Not their intersection: near a pole the grid's, interpolated in (u, v) between
    // nodes whose |S_u| differ many times, is far finer across u in 3D than the point's own, and a 3D floor of the two
    // would pull the size along v down with it.)
    Metric2 g = interpolated(p), m, I;
    if (!own(p, m, &I)) return g;
    return elementary_ ? floored(intersect(g, flooredIn3d(m, I, kFloor)), kUvFloor) : floored(intersect(g, m), kFloor);
  }

  bool accept(const Vec2 t[3]) const override {
    // A triangle whose patch is within the refinement floor (belowFloor) is accepted unless turned over on the
    // surface's points: nothing is refined below it for its size or its normals' angles, but a facet against its
    // surface is wrong output however small. Not judged there on the boundary's own points (setBoundaryPoints): a
    // boundary off its surface turns slivers that refinement, only thinning them, turns further, to the point cap (a
    // healed fitted p-curve 0.024 off, bug24594_284965 #13); the part's check of its output fails what's left. Every
    // check applies everywhere else, near an apex too (a pole's fans, poles.h, are judged by the deviation alone).
    Vec3 p[3];
    const bool evaluated = corners(t, p);
    Vec3 q[3];
    const bool own = output(t, p, q);
    if (belowFloor(t, p, evaluated)) return !turnedOver(t, p);
    double longest3 = std::max({norm(p[1] - p[0]), norm(p[2] - p[1]), norm(p[0] - p[2])});
    return deviationOk(t, p, longest3) && normalsWithin(t, p, false) && !(own && turnedAsOutput(t, p, q));
  }

  bool acceptFan(const Vec2 t[3]) const override {
    Vec3 p[3];
    const bool evaluated = corners(t, p);
    Vec3 q[3];
    const bool own = output(t, p, q);
    if (belowFloor(t, p, evaluated)) return !turnedOver(t, p);
    double longest3 = std::max({norm(p[1] - p[0]), norm(p[2] - p[1]), norm(p[0] - p[2])});
    return deviationOk(t, p, longest3) && normalsWithin(t, p, true) && !(own && turnedAsOutput(t, p, q));
  }

  int refusalKind(const Vec2 t[3]) const override { return static_cast<int>(refusal(t, true, false)); }
  bool worstPoint(const Vec2 t[3], Vec2& out) const override {
    // (Elementary surfaces only: on free-form ones the point, off where the curvature metric expects points, turns
    // triangles against the surface. Inside the triangle: the centroid, near each edge's middle and toward each
    // corner; an edge's own middle would be on the edge, a constrained one's maybe.)
    if (!elementary_) return false;
    static const double w[7][3] = {{1. / 3, 1. / 3, 1. / 3}, {0.45, 0.45, 0.1}, {0.1, 0.45, 0.45}, {0.45, 0.1, 0.45},
      {0.6, 0.2, 0.2}, {0.2, 0.6, 0.2}, {0.2, 0.2, 0.6}};
    Vec3 p[3];
    if (!corners(t, p)) return false;
    double worst = d_.linear;
    bool found = false;
    for (const auto& b : w) {
      Vec2 uv{b[0] * t[0].x + b[1] * t[1].x + b[2] * t[2].x, b[0] * t[0].y + b[1] * t[1].y + b[2] * t[2].y};
      const double dev = norm(at(uv) - (b[0] * p[0] + b[1] * p[1] + b[2] * p[2]));
      if (dev > worst) worst = dev, out = uv, found = true;
    }
    return found;
  }

  Refusal refusal(const Vec2 t[3], bool normals, bool fan) const override {
    Vec3 p[3];
    const bool evaluated = corners(t, p);
    Vec3 q[3];
    const bool own = output(t, p, q);
    if (belowFloor(t, p, evaluated)) return normals && turnedOver(t, p) ? Refusal::normalFacet : Refusal::none;
    const bool sampled = sampledAny_;
    double longest3 = std::max({norm(p[1] - p[0]), norm(p[2] - p[1]), norm(p[0] - p[2])});
    Refusal r = deviationRefusal(t, p, longest3);
    if (r == Refusal::none && normals) r = normalsRefusal(t, p, fan);
    if (r == Refusal::none && normals && own && turnedAsOutput(t, p, q)) r = Refusal::normalFacet;
    sampledAny_ = sampled;  // (a diagnosis, not a judgement: the face's sampled flag as accept() left it)
    return r;
  }

  bool acceptDeviation(const Vec2 t[3]) const override {
    Vec3 p[3];
    const bool evaluated = corners(t, p);
    if (belowFloor(t, p, evaluated)) return true;
    double longest3 = std::max({norm(p[1] - p[0]), norm(p[2] - p[1]), norm(p[0] - p[2])});
    return deviationOk(t, p, longest3);
  }

  bool deviationBound(const Vec2 t[3], double& out, bool pieces) const override {
    Vec3 p[3];
    for (int i = 0; i < 3; i++)
      if (!corner(t[i], p[i])) return false;
    if (kind_ == Kind::sphere) {
      out = radius_ - pointTriangle(centre_, p);
      return std::isfinite(out);
    }
    if (kind_ != Kind::none && distanceBound(p, out)) return true;
    Bounds b;
    if (!bounded_ || !bounds(t, b, pieces)) return false;
    // (The least of the bounds the verdict takes: the sub-cells' too, cellDeviation.)
    double cd;
    out = cellDeviation(t, cd) ? std::fmin(b.deviation, cd) : b.deviation;
    return std::isfinite(out);
  }

  /**
   * The surface over the triangle's (u, v) box within the floor across, by its bound (not the corners: a patch can
   * reach well past them): max(part tolerance, 0.1 x the deflection). Below it a triangle can't stray from the
   * surface by anything that counts, and its facet's normal is rounding (trj7_k1-id's face 2160, a B-spline's
   * degenerate spot, refined towards 1e-14 mm until its point cap, its facets refused for normals 90 degrees off).
   */
  bool belowFloor(const Vec2 t[3]) const override {
    Vec3 p[3];
    const bool evaluated = corners(t, p);
    return belowFloor(t, p, evaluated);
  }

private:
  /**
   * belowFloor, the triangle's corners on the surface (at) given: two of them farther apart than the floor settle it
   * without the bound, whose box holds them (the bound, B-spline control nets over the box, costs more than the rest
   * of accept() together). Only where all three were evaluated (`evaluated`): the bound decides the rest.
   */
  bool belowFloor(const Vec2 t[3], const Vec3 p[3], bool evaluated) const {
    if (evaluated && (norm(p[1] - p[0]) > floor_ || norm(p[2] - p[1]) > floor_ || norm(p[0] - p[2]) > floor_))
      return false;
    Range ru{std::min({t[0].x, t[1].x, t[2].x}), std::max({t[0].x, t[1].x, t[2].x})};
    Range rv{std::min({t[0].y, t[1].y, t[2].y}), std::max({t[0].y, t[1].y, t[2].y})};
    Box3 b;
    if (s_.bound(ru, rv, b) != Status::ok) return false;
    return std::hypot(b.x.width(), b.y.width(), b.z.width()) <= floor_;
  }

  /** The triangle's corners on the surface, as at() gives them; whether all three evaluated. */
  /**
   * The surface's point and normal at (u, v), each evaluated once (a mesh's vertex is the corner of every triangle
   * around it, judged again as they change): by (u, v)'s bits, so the same doubles as evaluating again, the meshes
   * the same bits. Cleared past kEvalMemo entries.
   */
  struct Evaluated {
    Status st;
    Vec3 v;
  };
  static uint64_t bits(double x) {
    uint64_t b;
    std::memcpy(&b, &x, 8);
    return b;
  }
  struct PairHash {
    size_t operator()(const std::pair<uint64_t, uint64_t>& k) const {
      return std::hash<uint64_t>()(k.first * 0x9e3779b97f4a7c15ull ^ k.second);
    }
  };
  static constexpr size_t kEvalMemo = size_t(1) << 20;
  mutable std::unordered_map<std::pair<uint64_t, uint64_t>, Evaluated, PairHash> points_, normals_;
  Evaluated pointAt(double u, double v) const {
    if (points_.size() > kEvalMemo) points_.clear();
    auto [it, fresh] = points_.try_emplace({bits(u), bits(v)});
    if (fresh) {
      SurfacePoint q;
      it->second = {s_.eval(u, v, 0, q), q.p};
    }
    return it->second;
  }
  Status normalAt(double u, double v, Vec3& n) const {
    if (normals_.size() > kEvalMemo) normals_.clear();
    auto [it, fresh] = normals_.try_emplace({bits(u), bits(v)});
    if (fresh) it->second.st = s_.normal(u, v, it->second.v);
    n = it->second.v;
    return it->second.st;
  }

  /** The boundary's own points by (u, v)'s bits (setBoundaryPoints). */
  std::unordered_map<std::pair<uint64_t, uint64_t>, Vec3, PairHash> boundary_;
  void setBoundaryPoints(const std::vector<std::pair<Vec2, Vec3>>& points) override {
    boundary_.clear();
    for (const auto& [uv, p] : points) boundary_[{bits(uv.x), bits(uv.y)}] = p;
  }
  /**
   * A triangle's corners as the output has them: the boundary's own point at a corner on it, else p's; whether any
   * corner has one. (Only the output's own turn is judged on these, checkFacing's test: the angle to the normals, on a
   * thin triangle along a boundary a little off its surface, grows as refinement thins it, and a facet against one
   * corner's normal but not their mean, a refusal it can't mend either; chasing them turns others.)
   */
  bool output(const Vec2 t[3], const Vec3 p[3], Vec3 q[3]) const {
    bool any = false;
    for (int i = 0; i < 3; i++) {
      auto it = boundary_.empty() ? boundary_.end() : boundary_.find({bits(t[i].x), bits(t[i].y)});
      q[i] = it != boundary_.end() ? (any = true, it->second) : p[i];
    }
    return any;
  }

  bool corners(const Vec2 t[3], Vec3 p[3]) const {
    bool ok = true;
    for (int i = 0; i < 3; i++) {
      const Evaluated e = pointAt(t[i].x, t[i].y);
      ok = e.st == Status::ok && ok;
      p[i] = e.v;
    }
    return ok;
  }

  /** The surface's point at (u, v), false where it can't be evaluated. */
  bool corner(Vec2 uv, Vec3& out) const {
    const Evaluated e = pointAt(uv.x, uv.y);
    if (e.st != Status::ok || !std::isfinite(e.v.x + e.v.y + e.v.z)) return false;
    out = e.v;
    return true;
  }

  /** accept()'s deviation, its 3D corners p and longest side given. */
  bool deviationOk(const Vec2 t[3], const Vec3 p[3], double longest3) const {
    return deviationRefusal(t, p, longest3) == Refusal::none;
  }
  Refusal deviationRefusal(const Vec2 t[3], const Vec3 p[3], double longest3) const {
    const Refusal r = deviationWithin(t, p);
    if (r == Refusal::none) return r;
    // Near a pole (a corner within twice the triangle's size of it) the sample and the bound overstate: a triangle
    // wide in u is small in 3D, S's tangential part large, and a bound over its (u, v) box reaches far from it.
    // There the surface's distance itself, by inversion, at the same points (the face then counted as sampled).
    if (!nearPole(p, longest3)) return r;
    if (!nearestDeviation(t, p)) return Refusal::deviationNearPole;
    sampledAny_ = true;
    return Refusal::none;
  }

  /** The deviation within the deflection (Refusal::none), in closed form, bounded or sampled, as the surface allows. */
  Refusal deviationWithin(const Vec2 t[3], const Vec3 p[3]) const {
    Bounds b;
    double closedForm;
    if (kind_ == Kind::sphere) {
      // (Every point of the flat triangle is inside the ball: its distance to the sphere is R - |x - c|.)
      return radius_ - pointTriangle(centre_, p) <= d_.linear ? Refusal::none : Refusal::deviationClosedForm;
    }
    if (kind_ != Kind::none && distanceBound(p, closedForm))
      return closedForm <= d_.linear ? Refusal::none : Refusal::deviationClosedForm;
    if (bounded_) {
      // Sampled first, sparing the bound the many large triangles refinement refuses (what it measures, |S(x) - L(x)|
      // at the corners' barycentric (u, v), is at least the distance there, so its refusals err only to the strict
      // side, where S''s tangential part is large); then bounded, over the whole box, and only where that isn't
      // enough over its pieces (stripBounds); where the surface gives no bound, the sample stands (and is noted).
      if (!sampledDeviation(t, p)) return Refusal::deviationSampled;
      // The deviation bounded by the least of the sub-cells' (cellDeviation, cached: tried first, cheap), the
      // box's and its pieces' bounds.
      double cd;
      if (cellDeviation(t, cd) && cd <= d_.linear) return Refusal::none;
      if (!bounds(t, b, false)) {
        sampledAny_ = true;
      } else if (b.deviation > d_.linear) {
        if (!bounds(t, b, true)) sampledAny_ = true;
        else if (b.deviation > d_.linear) return Refusal::deviationBounded;
      }
      return Refusal::none;
    }
    sampledAny_ = true;
    return sampledDeviation(t, p) ? Refusal::none : Refusal::deviationSampled;
  }

  /**
   * The normals at the corners (where the surface has one) within the angle of one another and of the flat
   * triangle's own (which a triangle turned over in 3D, as one wide in u near a pole can be, fails).
   */
  bool normalsWithin(const Vec2 t[3], const Vec3 p[3], bool fan) const {
    return normalsRefusal(t, p, fan) == Refusal::none;
  }
  /**
   * (A triangle thinner than the refinement floor, twice its area over its longest side, has its facet held only to
   * the side its corners' normals face, not to the angle: a needle's facet normal is rounding that refinement can't
   * mend, ec_turbine-A's fold beside its u = 0 side. Not a smooth pole's fan (`fan`), held to the angle however thin,
   * as the pole's ring was sized for.)
   */
  Refusal normalsRefusal(const Vec2 t[3], const Vec3 p[3], bool fan) const {
    Vec3 n[3], g = facet(p);
    bool has[3];
    for (int i = 0; i < 3; i++) has[i] = cornerNormal(t, i, n[i]) == Status::ok;
    // (A facet with two corners on a pole line has rounding for a normal: no direction to judge.)
    double gl = norm(g), c = d_.angular > 0 ? std::cos(d_.angular) : 0;
    double longest = std::max({norm(p[1] - p[0]), norm(p[2] - p[1]), norm(p[0] - p[2])});
    bool facet = gl > 1e-9 * longest * longest, thin = !fan && gl / longest <= floor_;
    for (int i = 0; i < 3; i++) {
      if (!has[i]) continue;
      if (facet && (facetAgainst(g, n[i]) || (!thin && dot(g, n[i]) < c * gl))) return Refusal::normalFacet;
      for (int j = i + 1; j < 3; j++)
        if (d_.angular > 0 && has[j] && dot(n[i], n[j]) < c) return Refusal::normalSpread;
    }
    return Refusal::none;
  }

  bool nearPole(const Vec3 p[3], double size) const {
    for (Vec3 q : poles_)
      for (int i = 0; i < 3; i++)
        if (norm(p[i] - q) <= 2 * size) return true;
    return false;
  }

  /**
   * The flat triangle within the deflection of the surface at 7 points, each by its distance to some point of the
   * surface (an upper bound on its distance to it): from the point's barycentric (u, v), a few damped Gauss-Newton
   * steps towards its foot, the nearest point seen kept.
   */
  bool nearestDeviation(const Vec2 t[3], const Vec3 p[3]) const {
    // (sampledDeviation's points and the three between the centroid and the corners, with a tenth to spare: a
    // sample misses the deepest point, which the bounds would have found.)
    const double w[7][3] = {{1. / 3, 1. / 3, 1. / 3}, {0.5, 0.5, 0}, {0, 0.5, 0.5}, {0.5, 0, 0.5},
      {2. / 3, 1. / 6, 1. / 6}, {1. / 6, 2. / 3, 1. / 6}, {1. / 6, 1. / 6, 2. / 3}};
    for (const auto& b : w) {
      Vec2 uv{b[0] * t[0].x + b[1] * t[1].x + b[2] * t[2].x, b[0] * t[0].y + b[1] * t[1].y + b[2] * t[2].y};
      Vec3 flat = b[0] * p[0] + b[1] * p[1] + b[2] * p[2];
      if (footDistance(flat, uv) > 0.9 * d_.linear) return false;
    }
    return true;
  }

  /** The least |S(u, v) - x| seen over a few damped Gauss-Newton steps from uv (kept inside the face's box). */
  double footDistance(Vec3 x, Vec2 uv) const {
    double best = INFINITY;
    for (int it = 0; it < 8; it++) {
      SurfacePoint q;
      if (s_.eval(uv.x, uv.y, 1, q) != Status::ok) break;
      Vec3 r = x - q.p;
      best = std::min(best, norm(r));
      if (best <= 1e-3 * d_.linear) break;
      double a = dot(q.du, q.du), bb = dot(q.du, q.dv), c = dot(q.dv, q.dv), lambda = 1e-9 * (a + c) + 1e-300;
      a += lambda, c += lambda;
      double det = a * c - bb * bb, gu = dot(q.du, r), gv = dot(q.dv, r);
      if (!(det > 0)) break;
      Vec2 next{uv.x + (c * gu - bb * gv) / det, uv.y + (a * gv - bb * gu) / det};
      next.x = std::clamp(next.x, box_.x.lo, box_.x.hi), next.y = std::clamp(next.y, box_.y.lo, box_.y.hi);
      if (next.x == uv.x && next.y == uv.y) break;
      uv = next;
    }
    return best;
  }

  /** A triangle's bound: its deviation from the surface. */
  struct Bounds {
    double deviation = INFINITY;
  };

  /**
   * The bounds over the triangle from the surface's derivative bounds on its (u, v) box (false where there are none).
   * Deviation: |S(x) - L(x)| <= (1/2) max_x sum b_i q(x - x_i), q(d) = M_uu du^2 + 2 M_uv |du dv| + M_vv dv^2 <=
   * a_u du^2 + a_v dv^2 (a_u = M_uu + M_uv e, a_v = M_vv + M_uv / e, any e > 0), and in coordinates scaled by
   * sqrt(a_u), sqrt(a_v) the maximum of sum b_i |x - x_i|^2 over the triangle is its smallest enclosing circle's
   * radius squared. (The normals' spread isn't bounded so, and mustn't be retried that way: bounding |d(S_u x S_v)|
   * by the derivatives' magnitudes and dividing by |S_u x S_v|, which shrinks where the parameterization does, runs
   * far past the turn, 2 / cos^2 v times it on a sphere: a hemisphere went from 555 triangles to 40,918.)
   */
  bool bounds(const Vec2 t[3], Bounds& out, bool pieces) const {
    Range ru{std::min({t[0].x, t[1].x, t[2].x}), std::max({t[0].x, t[1].x, t[2].x})};
    Range rv{std::min({t[0].y, t[1].y, t[2].y}), std::max({t[0].y, t[1].y, t[2].y})};
    double d2[3], strips = 0;
    double Du = ru.hi - ru.lo, Dv = rv.hi - rv.lo;
    if (pieces ? !stripBounds(ru, rv, d2, strips) : !wholeBounds(ru, rv, d2)) return false;
    // (e = Dv / Du minimizes the cross term's share over the triangle's extents, (M_uv e) Du^2 + (M_uv / e) Dv^2;
    // sqrt(M_vv / M_uu) instead blows up where M_vv is rounding, a cylinder's or a tube's along its lines.)
    double e = Du > 0 && Dv > 0 ? Dv / Du : 1;
    double au = d2[0] + d2[1] * e, av = d2[2] + d2[1] / e;
    Vec2 q[3];
    for (int i = 0; i < 3; i++) q[i] = {std::sqrt(au) * t[i].x, std::sqrt(av) * t[i].y};
    out.deviation = 0.5 * enclosing2(q) + strips;
    return true;
  }

  /**
   * The deviation bound over the triangle (as bounds() has it) from the second partials' bounds over the sub-cells
   * its (u, v) box covers: each knot cell (between consecutive breaks, both ways) cut kCellSplit x kCellSplit, each
   * sub-cell bounded once and kept, the largest over at most kCellsCovered of them. False where the box covers more,
   * leaves the cells, the domain isn't finite, or a sub-cell has no bound. A bound over sub-cells holds over the box
   * they cover; one of the bounds the triangle's deviation is the least of (deviationWithin, deviationBound).
   */
  bool cellDeviation(const Vec2 t[3], double& out) const {
    if (!cellsReady_) {
      cellsReady_ = true;
      const SurfaceDomain D = s_.domain();
      std::vector<double> ku, kv;
      if (std::isfinite(D.u.lo) && std::isfinite(D.u.hi) && std::isfinite(D.v.lo) && std::isfinite(D.v.hi))
        s_.breaks(D.u, D.v, ku, kv);
      auto cut = [](const std::vector<double>& k, std::vector<double>& c) {
        for (size_t a = 0; a + 1 < k.size(); a++)
          for (int g = 0; g < kCellSplit; g++) c.push_back(k[a] + (k[a + 1] - k[a]) * g / kCellSplit);
        if (!k.empty()) c.push_back(k.back());
      };
      cut(ku, cellU_), cut(kv, cellV_);
    }
    if (cellU_.size() < 2 || cellV_.size() < 2) return false;
    const Range ru{std::min({t[0].x, t[1].x, t[2].x}), std::max({t[0].x, t[1].x, t[2].x})};
    const Range rv{std::min({t[0].y, t[1].y, t[2].y}), std::max({t[0].y, t[1].y, t[2].y})};
    // The sub-cells [a, b] a range covers (false outside them).
    auto span = [](const std::vector<double>& c, Range r, long& a, long& b) {
      auto lo = std::upper_bound(c.begin(), c.end(), r.lo);
      if (lo == c.begin() || r.hi > c.back()) return false;
      a = static_cast<long>(lo - c.begin()) - 1;
      b = std::max(a, static_cast<long>(std::lower_bound(c.begin(), c.end(), r.hi) - c.begin()) - 1);
      return a + 1 < static_cast<long>(c.size());
    };
    long i0, i1, j0, j1;
    if (!span(cellU_, ru, i0, i1) || !span(cellV_, rv, j0, j1)) return false;
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > kCellsCovered) return false;
    double d2[3] = {0, 0, 0};
    for (long i = i0; i <= i1; i++)
      for (long j = j0; j <= j1; j++) {
        auto [it, added] = cellBounds_.try_emplace(static_cast<uint64_t>(i) << 32 | static_cast<uint64_t>(j));
        if (added) it->second.ok = wholeBounds({cellU_[i], cellU_[i + 1]}, {cellV_[j], cellV_[j + 1]}, it->second.d2);
        if (!it->second.ok) return false;
        for (int k = 0; k < 3; k++) d2[k] = std::fmax(d2[k], it->second.d2[k]);
      }
    const double Du = ru.hi - ru.lo, Dv = rv.hi - rv.lo, e = Du > 0 && Dv > 0 ? Dv / Du : 1;
    const double au = d2[0] + d2[1] * e, av = d2[2] + d2[1] / e;
    Vec2 q[3];
    for (int k = 0; k < 3; k++) q[k] = {std::sqrt(au) * t[k].x, std::sqrt(av) * t[k].y};
    out = 0.5 * enclosing2(q);
    return std::isfinite(out);
  }

  /**
   * The second partials' bounds over the pieces ru x rv is cut into at the surface's breaks (a B-spline's knots,
   * where its bound is the spans' hulls) and in kSplit x kSplit besides (each piece's centred form the tighter for its
   * size): d2 the largest of the pieces' outside narrow strips, `strips` what those add to the deviation. The
   * whole's (wholeBounds) where that would be more than kMaxPieces pieces. False where any fails.
   *
   * A strip is a column of pieces between consecutive cuts in u (or a row in v) narrower than kStrip of the triangle's
   * extent there: a B-spline's knots a hair apart, where a C1 surface bends sharply over a span of no consequence
   * (Iron.step part #47's face 3396: 6.7e-5 of its u, its pieces' bound 1.48 mm on a 0.7 mm triangle within 1e-3 of
   * the surface). Its maxima, quadratic in the triangle's size, would dominate; its width bounds its part instead.
   *
   * Why that is a bound. With L the triangle's linear interpolant, e(x) = S(x) - L(x) = -sum_i l_i R_i at x, l_i its
   * barycentric weights and R_i the Taylor remainder along d_i = p_i - x:
   * R_i = int_0^1 (1 - t) D2S(x + t d_i)[d_i, d_i] dt, D2S[d, d] = d_u^2 S_uu + 2 d_u d_v S_uv + d_v^2 S_vv. Bound each
   * term's integral apart, splitting it by where x + t d_i lies. Outside every strip the partials are within d2, whose
   * part is at most theirs over the whole segment. A u-strip [a, a + w]: the segment (straight, u along it linear)
   * meets only the part of it between u and u_i, of width w_i, for at most w_i / |d_u| of t, where (1 - t) <= 1; so
   * the uu term's part there is at most w_i |u_i - u| M_uu, M_uu the strip's maximum. With u outside the strip, only
   * corners beyond it have w_i > 0 (w); inside, those either side have w_i the strip's part on their side, the two
   * summing to w. And either side's sum_i l_i |u_i - u| is half the corners' mean distance from their mean u
   * (sum_i l_i u_i = u), so at most a quarter of their extent U: the strip adds at most w U M_uu / 4. The uv and vv
   * terms' fractions have no such bound (|d_u| may be 0): the strip's M_uv and M_vv join d2's (on a C1 surface only
   * the partial across a narrow span is large there). A v-strip likewise with u and v swapped. Summed over the
   * corners, the rest's part is at most the scaled circle's (bounds), and the strips' theirs.
   * (No test tells that join from its absence, and leaving it out may well be sound, but that isn't proven: what the
   * strip has beyond its neighbours is confined to its width, so its height is about M_uu w^2 / 4 at most, which its
   * uu term, at least 2 w^2 M_uu as U > 8 w, already covers. A ridge along the strip, bent along it there alone,
   * was refused alike with and without the join.)
   */
  bool stripBounds(Range ru, Range rv, double d2[3], double& strips) const {
    strips = 0;
    std::vector<double> us, vs;
    s_.breaks(ru, rv, us, vs);
    auto cuts = [](Range r, std::vector<double> c) {
      for (int i = 1; i < kSplit; i++) c.push_back(r.lo + (r.hi - r.lo) * i / kSplit);
      std::sort(c.begin(), c.end());
      c.erase(std::unique(c.begin(), c.end()), c.end());
      return c;
    };
    us = cuts(ru, us), vs = cuts(rv, vs);
    if (us.size() < 2 || vs.size() < 2 || (us.size() - 1) * (vs.size() - 1) > kMaxPieces)
      return wholeBounds(ru, rv, d2);
    double U = ru.hi - ru.lo, V = rv.hi - rv.lo;
    size_t nu = us.size() - 1, nv = vs.size() - 1;
    std::vector<char> thinU(nu), thinV(nv);
    for (size_t i = 0; i < nu; i++) thinU[i] = us[i + 1] - us[i] < kStrip * U;
    for (size_t j = 0; j < nv; j++) thinV[j] = vs[j + 1] - vs[j] < kStrip * V;
    // Each strip's maxima over its pieces (a piece in both a u- and a v-strip taken as the u-strip's), the rest's d2.
    std::vector<std::array<double, 3>> su(nu, {0, 0, 0}), sv(nv, {0, 0, 0});
    d2[0] = d2[1] = d2[2] = 0;
    for (size_t i = 0; i < nu; i++)
      for (size_t j = 0; j < nv; j++) {
        if (!(us[i + 1] > us[i] && vs[j + 1] > vs[j])) continue;
        double d[3];
        if (!wholeBounds({us[i], us[i + 1]}, {vs[j], vs[j + 1]}, d)) return false;
        double* into = thinU[i] ? su[i].data() : thinV[j] ? sv[j].data() : d2;
        for (int k = 0; k < 3; k++) into[k] = std::fmax(into[k], d[k]);
      }
    for (size_t i = 0; i < nu; i++)
      if (thinU[i]) {
        double w = us[i + 1] - us[i];
        strips += 0.25 * w * U * su[i][0];
        d2[1] = std::fmax(d2[1], su[i][1]), d2[2] = std::fmax(d2[2], su[i][2]);
      }
    for (size_t j = 0; j < nv; j++)
      if (thinV[j]) {
        double w = vs[j + 1] - vs[j];
        strips += 0.25 * w * V * sv[j][2];
        d2[0] = std::fmax(d2[0], sv[j][0]), d2[1] = std::fmax(d2[1], sv[j][1]);
      }
    return true;
  }

  /** The second partials' bounds over the whole of ru x rv; false where they fail. */
  bool wholeBounds(Range ru, Range rv, double out[3]) const {
    if (s_.derivBound(ru, rv, 2, out) != Status::ok) return false;
    for (int i = 0; i < 3; i++)
      if (!std::isfinite(out[i]) || out[i] < 0) return false;
    return true;
  }

  /**
   * A cone's or a torus's deviation bound over the flat triangle p (its corners on the surface), from a distance
   * function g (an upper bound on the distance to the surface, positive inside the solid) at the centroid c: g concave
   * over the triangle, g(x) <= g(c) + grad g(c) . (x - c), the most at a corner. False where the form doesn't hold
   * (on a cone's axis, a torus's inner half or near its core, a spindle torus): a torus's deviation then bounded by
   * its derivatives (makeCriteria), a cone's sampled.
   * Cone: g = -((rho - r0) - k h) / sqrt(1 + k^2) in its meridian plane (rho the distance to the axis, h the height,
   * k = tan of the semi-angle), concave as rho is convex; the facet lies in the solid nappe (convex: rho <= r0 + k h)
   * and from inside it the foot on the generator is outward, rho growing by |g| / sqrt(1 + k^2), so on the nappe's
   * ray: g is the distance to the generator there, at least the distance to the surface.
   * Torus: g = r - rho_c (rho_c the distance to the core circle), Hess rho_c's eigenvalues 0, 1 / rho_c and
   * t / (rho_c s) (s the distance to the axis, t = s - R): concave with g >= 0 where the triangle stays at t >= 0, the
   * tube locally convex there (t >= L at the anchor keeps it, L the longest side).
   */
  bool distanceBound(const Vec3 p[3], double& out) const {
    double L = std::max({norm(p[1] - p[0]), norm(p[2] - p[1]), norm(p[0] - p[2])});
    auto split = [&](Vec3 x, double& h, double& rho, Vec3& radial) {
      Vec3 q = x - centre_;
      h = dot(q, axis_);
      Vec3 r = q - h * axis_;
      rho = norm(r);
      radial = rho > 0 ? (1 / rho) * r : Vec3{};
    };
    if (kind_ == Kind::torus && !(second_ < radius_)) return false;
    // The bound at the centroid, the most of its form at a corner. (Anchoring at the facet's deepest point too, where
    // the gradient's term vanishes, changed nothing measurable.)
    std::vector<Vec3> anchors{(1.0 / 3) * (p[0] + p[1] + p[2])};
    bool any = false;
    out = INFINITY;
    for (Vec3 c : anchors) {
      double h, rho, bound;
      Vec3 rad;
      split(c, h, rho, rad);
      if (!(rho > 0)) continue;
      if (kind_ == Kind::cone) {
        double k = second_, w = std::sqrt(1 + k * k), g = -((rho - radius_) - k * h) / w;
        Vec3 grad = (-1 / w) * (rad - k * axis_);
        bound = g;
        for (int i = 0; i < 3; i++) bound = std::fmax(bound, g + dot(grad, p[i] - c));
      } else {
        double R = radius_, r = second_, t = rho - R, rc = std::hypot(t, h);
        if (!(rc - L > 0) || !(rho - L > 0)) continue;
        // Only where the triangle stays on the outer half (t >= L at the anchor): on the inner half a bound with
        // the Hessian's terms (|x - c|^2 / (2 s_min) above, (1 / rho_min + 1 / s_min) |x - c|^2 / 2 below, the facet
        // leaving the tube there) runs 5 x past a chord round the axis and doubled the triangles; the derivatives'
        // bound there.
        if (t - L < 0) continue;
        double g = r - rc;
        Vec3 grad = (-1 / rc) * (t * rad + h * axis_);
        bound = g;
        for (int i = 0; i < 3; i++) bound = std::fmax(bound, g + dot(grad, p[i] - c));
      }
      out = std::fmin(out, bound), any = true;
    }
    return any;
  }

  /** The distance from c to the triangle p (its nearest point: inside, on an edge or at a corner). */
  static double pointTriangle(Vec3 c, const Vec3 p[3]) {
    Vec3 e1 = p[1] - p[0], e2 = p[2] - p[0], n = cross(e1, e2);
    double nn = dot(n, n);
    if (nn > 0) {
      // The projection's barycentric coordinates: inside, the plane's distance.
      Vec3 w = c - p[0];
      double b1 = dot(cross(w, e2), n) / nn, b2 = dot(cross(e1, w), n) / nn;
      if (b1 >= 0 && b2 >= 0 && b1 + b2 <= 1) return std::fabs(dot(w, n)) / std::sqrt(nn);
    }
    double best = INFINITY;
    for (int i = 0; i < 3; i++) {
      Vec3 a = p[i], d = p[(i + 1) % 3] - a;
      double l2 = dot(d, d), x = l2 > 0 ? std::clamp(dot(c - a, d) / l2, 0.0, 1.0) : 0;
      best = std::fmin(best, norm(c - (a + x * d)));
    }
    return best;
  }

  /** The smallest enclosing circle's radius squared of three points: half the longest side's if obtuse, else the
   * circumradius's. */
  static double enclosing2(const Vec2 q[3]) {
    double l[3];
    for (int i = 0; i < 3; i++) {
      Vec2 a = q[(i + 1) % 3], b = q[(i + 2) % 3];
      l[i] = (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);  // the side opposite i, squared
    }
    for (int i = 0; i < 3; i++)
      if (l[i] >= l[(i + 1) % 3] + l[(i + 2) % 3]) return l[i] / 4;  // obtuse (or right) at i
    double area2 = std::fabs((q[1].x - q[0].x) * (q[2].y - q[0].y) - (q[2].x - q[0].x) * (q[1].y - q[0].y));
    if (!(area2 > 0)) return std::max({l[0], l[1], l[2]}) / 4;
    return l[0] * l[1] * l[2] / (4 * area2 * area2);  // R^2 = (abc)^2 / (4 area)^2, area2 = 2 area
  }

  /** The surface within the deflection of the flat triangle at its centroid and its edges' middles (sampled). */
  bool sampledDeviation(const Vec2 t[3], const Vec3 p[3]) const {
    const double w[4][3] = {{1. / 3, 1. / 3, 1. / 3}, {0.5, 0.5, 0}, {0, 0.5, 0.5}, {0.5, 0, 0.5}};
    for (const auto& b : w) {
      Vec2 uv{b[0] * t[0].x + b[1] * t[1].x + b[2] * t[2].x, b[0] * t[0].y + b[1] * t[1].y + b[2] * t[2].y};
      Vec3 flat = b[0] * p[0] + b[1] * p[1] + b[2] * p[2];
      if (norm(at(uv) - flat) > d_.linear) return false;
    }
    return true;
  }

  /**
   * The metric's smaller eigenvalue at least this times its larger (a size ratio of 1000 at most): in 3D on an
   * elementary surface, in (u, v) on the others. The curvature metric holds along a free-form surface's principal
   * directions at a point but not how fast they turn (its twist): long triangles laid along them leave the surface
   * where it twists (turned against it, or refined again and again), and the (u, v) floor, its ratio the 3D one times
   * the parameterization's distortion, stands in for that.
   */
  static constexpr double kFloor = 1e-6;
  /** A piece between breaks narrower than this of the triangle's extent there is a strip (stripBounds). */
  static constexpr double kStrip = 0.125;

  int at(int i, int j) const { return i * (kGrid + 1) + j; }
  Vec2 node(int i, int j) const {
    return {box_.x.lo + (box_.x.hi - box_.x.lo) * i / kGrid, box_.y.lo + (box_.y.hi - box_.y.lo) * j / kGrid};
  }
  Vec3 at(Vec2 p) const {
    SurfacePoint q;
    s_.eval(p.x, p.y, 0, q);
    return q.p;
  }
  /**
   * The facet against any corner's normal (where it has one and the facet an area). Not judged with a corner within
   * the tolerance of a pole or apex, as PartMesher's check doesn't judge it there: below the floor at such a point
   * refinement would chase rounding to the point cap (LMP1 #172881's apex, 100,000 refused triangles of 1e-10 mm).
   */
  /**
   * Corner i's normal: on a crease (setCreases: within its `near`), the side's, a step of 1e-9 x (1 + |at|) across
   * its line toward the triangle's centroid (into the span on that side), the surface's there one-sided.
   */
  Status cornerNormal(const Vec2 t[3], int i, Vec3& n) const {
    Vec2 q = t[i];
    if (!creases_.empty()) {
      const Vec2 c{(t[0].x + t[1].x + t[2].x) / 3, (t[0].y + t[1].y + t[2].y) / 3};
      for (const Crease& k : creases_) {
        double& x = k.isoU ? q.x : q.y;
        const double side = k.isoU ? c.x : c.y;
        if (std::fabs(x - k.at) <= k.near && std::fabs(side - k.at) > k.near)
          x = k.at + (side > k.at ? 1 : -1) * 1e-9 * (1 + std::fabs(k.at));
      }
    }
    return normalAt(q.x, q.y, n);
  }

  /**
   * Turned as the part judges its output (part.cpp's checkFacing): the facet of q, the corners as output, against the
   * mean of the corners' normals, p the surface's points at the corners; not with a corner within the tolerance of a
   * pole or apex.
   */
  bool turnedAsOutput(const Vec2 t[3], const Vec3 p[3], const Vec3 q[3]) const {
    for (const Vec3& s : poles_)
      for (int i = 0; i < 3; i++)
        if (norm(q[i] - s) <= tolerance_) return false;
    const Vec3 g = facet(q);
    Vec3 sum{0, 0, 0};
    for (int i = 0; i < 3; i++) {
      Vec3 n;
      if (cornerNormal(t, i, n) == Status::ok) sum = sum + n;
    }
    return facetAgainst(g, sum);
  }
  /** The output's origin (setOutputOrigin), and corners as shipped from it. */
  double origin_[3] = {0, 0, 0};
  bool shipped_ = false;
  void setOutputOrigin(const double o[3]) override {
    shipped_ = std::isfinite(o[0]) && std::isfinite(o[1]) && std::isfinite(o[2]);
    for (int k = 0; k < 3; k++) origin_[k] = o[k];
  }
  /** The facet's normal (unnormalized) of corners p, as shipped where the output's origin is known. */
  Vec3 facet(const Vec3 p[3]) const {
    if (!shipped_) return cross(p[1] - p[0], p[2] - p[0]);
    Vec3 s[3];
    for (int i = 0; i < 3; i++)
      s[i] = {static_cast<double>(static_cast<float>(p[i].x - origin_[0])),
        static_cast<double>(static_cast<float>(p[i].y - origin_[1])),
        static_cast<double>(static_cast<float>(p[i].z - origin_[2]))};
    return cross(s[1] - s[0], s[2] - s[0]);
  }
  bool turnedOver(const Vec2 t[3], const Vec3 p[3]) const {
    for (const Vec3& q : poles_)
      for (int i = 0; i < 3; i++)
        if (norm(p[i] - q) <= tolerance_) return false;
    const Vec3 g = facet(p);
    const double longest = std::max({norm(p[1] - p[0]), norm(p[2] - p[1]), norm(p[0] - p[2])});
    if (!(norm(g) > 1e-9 * longest * longest)) return false;
    for (int i = 0; i < 3; i++) {
      Vec3 n;
      if (cornerNormal(t, i, n) == Status::ok && facetAgainst(g, n)) return true;
    }
    return false;
  }
  double size(double k) const {
    double h = hmax_;
    k = std::fabs(k);
    if (k > 0) {
      h = std::min(h, std::sqrt(6 * d_.linear / k));
      if (d_.angular > 0) h = std::min(h, d_.angular / k);
    }
    return std::max(h, hmin_);
  }
  /** The largest 3D size a metric at grid node (i, j) allows (along its smaller eigenvalue), through S_u, S_v. */
  double largest(Metric2 m, int i, int j) const {
    double lo, hi;
    Vec2 v;
    eigen(m, lo, hi, v);
    // (The direction of the smaller eigenvalue, perpendicular to v, in 3D.)
    SurfacePoint q;
    Vec2 p = node(i, j);
    s_.eval(p.x, p.y, 1, q);
    Vec3 d = (-v.y) * q.du + v.x * q.dv;
    double len = norm(d);
    return lo > 0 && len > 0 ? len / std::sqrt(lo) : hmax_;
  }

  /** A grid node's metric floored as kFloor says. */
  Metric2 floorOf(Metric2 m, Vec2 p) const {
    return elementary_ ? flooredIn3d(m, first(p), kFloor) : floored(m, kFloor);
  }
  /** The surface's first fundamental form at p (zero where it can't be evaluated). */
  Metric2 first(Vec2 p) const {
    SurfacePoint q;
    Status st = s_.eval(p.x, p.y, 1, q);
    if (st != Status::ok && st != Status::outOfDomain) return {0, 0, 0};
    return {dot(q.du, q.du), dot(q.du, q.dv), dot(q.dv, q.dv)};
  }
  /**
   * The metric of the point's own curvature, in (u, v); false where the parameterization degenerates there. `I`, if
   * given, receives the first fundamental form there.
   */
  bool own(Vec2 p, Metric2& out, Metric2* I = nullptr) const {
    SurfacePoint q;
    Status st = s_.eval(p.x, p.y, 2, q);
    if (st != Status::ok && st != Status::outOfDomain) return false;
    double E = dot(q.du, q.du), F = dot(q.du, q.dv), G = dot(q.dv, q.dv), det = E * G - F * F;
    if (I) *I = {E, F, G};
    Vec3 nn = cross(q.du, q.dv);
    double nl = norm(nn);
    if (!(det > 1e-12 * (E + G) * (E + G)) || !(nl > 0) || !std::isfinite(det)) return false;
    Vec3 n = (1 / nl) * nn;
    double L = dot(n, q.duu), M = dot(n, q.duv), N = dot(n, q.dvv);
    // Principal curvatures: H +- sqrt(H^2 - K), H = (E N - 2 F M + G L) / (2 det), K = (L N - M^2) / det.
    double H = (E * N - 2 * F * M + G * L) / (2 * det), K = (L * N - M * M) / det;
    double r = std::sqrt(std::max(0.0, H * H - K)), k1 = H + r, k2 = H - r;
    // A direction of k1: (II - k1 I) x = 0, from its larger row; k2's I-orthogonal to it.
    Vec2 a{M - k1 * F, -(L - k1 * E)}, b{N - k1 * G, -(M - k1 * F)};
    Vec2 x1 = std::hypot(a.x, a.y) >= std::hypot(b.x, b.y) ? a : b;
    double h1 = size(k1), h2 = size(k2);
    double s1 = length2({E, F, G}, x1.x, x1.y);
    if (!(s1 > 0) || r <= 1e-12 * (std::fabs(H) + 1e-300) || !std::isfinite(s1)) {
      // An umbilic (or no curvature): every direction alike, the smaller size.
      double h = std::min(h1, h2);
      out = {E / (h * h), F / (h * h), G / (h * h)};
      return true;
    }
    x1 = {x1.x / std::sqrt(s1), x1.y / std::sqrt(s1)};
    Vec2 w1{E * x1.x + F * x1.y, F * x1.x + G * x1.y};  // I x1
    // (x2 = (-w1.y, w1.x) / sqrt(det): I-orthogonal to x1, and I-unit as x1 is.)
    Vec2 x2{-w1.y / std::sqrt(det), w1.x / std::sqrt(det)};
    Vec2 w2{E * x2.x + F * x2.y, F * x2.x + G * x2.y};
    double i1 = 1 / (h1 * h1), i2 = 1 / (h2 * h2);
    out = {i1 * w1.x * w1.x + i2 * w2.x * w2.x, i1 * w1.x * w1.y + i2 * w2.x * w2.y,
      i1 * w1.y * w1.y + i2 * w2.y * w2.y};
    return std::isfinite(out.a) && std::isfinite(out.b) && std::isfinite(out.c);
  }

  Metric2 interpolated(Vec2 p) const {
    double fx = box_.x.hi > box_.x.lo ? (p.x - box_.x.lo) / (box_.x.hi - box_.x.lo) * kGrid : 0;
    double fy = box_.y.hi > box_.y.lo ? (p.y - box_.y.lo) / (box_.y.hi - box_.y.lo) * kGrid : 0;
    fx = std::clamp(fx, 0.0, double(kGrid)), fy = std::clamp(fy, 0.0, double(kGrid));
    int i = std::min(int(fx), kGrid - 1), j = std::min(int(fy), kGrid - 1);
    double s = fx - i, t = fy - j;
    const Metric2 &m00 = grid_[at(i, j)], &m10 = grid_[at(i + 1, j)], &m01 = grid_[at(i, j + 1)],
      &m11 = grid_[at(i + 1, j + 1)];
    auto mix = [&](double x00, double x10, double x01, double x11) {
      return (1 - s) * (1 - t) * x00 + s * (1 - t) * x10 + (1 - s) * t * x01 + s * t * x11;
    };
    return {mix(m00.a, m10.a, m01.a, m11.a), mix(m00.b, m10.b, m01.b, m11.b), mix(m00.c, m10.c, m01.c, m11.c)};
  }

  const Surface& s_;
  Box2 box_;
  Deflections d_;
  double hmax_, hmin_;
  /** Whether accept() bounds the deviation (Local::bounds), by a closed form (kind_), or samples it. */
  bool bounded_;
  /** A plane, cylinder, cone, sphere or torus: the metric floored in 3D (kFloor). */
  bool elementary_;
  /** Whether any triangle's deviation was sampled so far (a bound unavailable there: bounded() then false). */
  mutable bool sampledAny_ = false;
  /** Each knot cell cut so many times each way into sub-cells (cellDeviation), and the most a box may cover. */
  static constexpr int kCellSplit = 4, kCellsCovered = 16;
  /** The surface's sub-cells (cellDeviation): their edges each way, and each one's bounds once made. */
  struct CellBound {
    double d2[3] = {0, 0, 0};
    bool ok = false;
  };
  mutable bool cellsReady_ = false;
  mutable std::vector<double> cellU_, cellV_;
  mutable std::unordered_map<uint64_t, CellBound> cellBounds_;
  /** The face's creases (setCreases). */
  std::vector<Crease> creases_;
  Kind kind_;
  Vec3 centre_, axis_;
  double radius_, second_;  // a cone's radius at v = 0 and tan of its semi-angle; a torus's major and minor radii
  double spacing_ = 0;
  /** The surface's poles' and apexes' points. */
  std::vector<Vec3> poles_;
  double tolerance_;
  /** The refinement floor (belowFloor). */
  double floor_;
  std::vector<Metric2> grid_;
  std::vector<bool> valid_;
};

} // namespace

std::unique_ptr<SurfaceCriteria> makeCriteria(const Model& m, int f, const Surface& s, Box2 uv, const Deflections& d,
  Status& status) {
  status = Status::unsupported;
  if (!(d.linear > 0) || !std::isfinite(uv.x.lo) || !std::isfinite(uv.x.hi) || !std::isfinite(uv.y.lo) ||
    !std::isfinite(uv.y.hi))
    return nullptr;
  // The face's 3D extent: the box's sampled points' (the largest size anywhere).
  Box3 box{{INFINITY, -INFINITY}, {INFINITY, -INFINITY}, {INFINITY, -INFINITY}};
  const int N = 8;
  for (int i = 0; i <= N; i++)
    for (int j = 0; j <= N; j++) {
      SurfacePoint q;
      s.eval(uv.x.lo + (uv.x.hi - uv.x.lo) * i / N, uv.y.lo + (uv.y.hi - uv.y.lo) * j / N, 0, q);
      box.x.lo = std::min(box.x.lo, q.p.x), box.x.hi = std::max(box.x.hi, q.p.x);
      box.y.lo = std::min(box.y.lo, q.p.y), box.y.hi = std::max(box.y.hi, q.p.y);
      box.z.lo = std::min(box.z.lo, q.p.z), box.z.hi = std::max(box.z.hi, q.p.z);
    }
  double extent = std::hypot(box.x.hi - box.x.lo, box.y.hi - box.y.lo, box.z.hi - box.z.lo);
  if (!(extent > 0) || !std::isfinite(extent)) extent = 1;
  status = Status::ok;
  // Bounded by derivBound on planes, cylinders, B-splines (each box's own sub-net) and tori; a sphere's deviation
  // exact, a cone's and a torus's closed form first where it holds (distanceBound). A torus's derivative bound covers
  // where its closed form doesn't, its inner half and a spindle torus (whose closed form never holds), so they keep a
  // proof rather than a sample. Elsewhere sampled: on cones |S(x) - L(x)| through the derivatives' magnitudes counts
  // S'''s tangential parts (S_uv round it), which don't take a point off the surface: loose on the long triangles
  // along its lines the metric asks for, and in (u, v) near the apex.
  int kind = m.surfaceKind(m.faceSurface(f));
  bool tight = kind == CBR_SURFACE_PLANE || kind == CBR_SURFACE_CYLINDER || kind == CBR_SURFACE_BSPLINE ||
    kind == CBR_SURFACE_TORUS;
  const double* r = m.surfaceReals(m.faceSurface(f));
  Local::Kind closed = kind == CBR_SURFACE_SPHERE ? Local::Kind::sphere : kind == CBR_SURFACE_CONE ? Local::Kind::cone
    : kind == CBR_SURFACE_TORUS ? Local::Kind::torus : Local::Kind::none;
  Vec3 centre = closed != Local::Kind::none ? Vec3{r[0], r[1], r[2]} : Vec3{};
  Vec3 axis = closed != Local::Kind::none ? Vec3{r[3], r[4], r[5]} : Vec3{};
  double second = closed == Local::Kind::cone ? std::tan(r[10]) : closed == Local::Kind::torus ? r[10] : 0;
  const bool elementary = kind >= CBR_SURFACE_PLANE && kind <= CBR_SURFACE_TORUS;
  return std::make_unique<Local>(s, uv, d, extent, tight, closed, centre, axis, closed != Local::Kind::none ? r[9] : 0,
    second, Tolerances(m).part(), elementary);
}

} // namespace tesscadio
