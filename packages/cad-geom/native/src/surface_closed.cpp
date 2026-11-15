// surface.h's closeInFact: a surface closed where it closes in fact (a direction's two ends one curve, within the
// caller's tol at 9 points), and its sides collapsed within tol reported as pole lines. A wrapper SurfaceImpl over the
// surface: every query takes parameters reduced into the range in a direction it made periodic, and a box or a list
// of breaks over a range crossing the seam is the hull or the union of the pieces either side of it.
#include <algorithm>
#include <cmath>

#include "surface_impl.h"

namespace cadgeom {
namespace surfaces {

namespace {

/** x reduced into [r.lo, r.lo + P). */
double reduce(double x, Range r, double P) {
  double y = x - P * std::floor((x - r.lo) / P);
  return y >= r.lo + P ? r.lo : y;
}

/**
 * The pieces of a range, in a direction of period P over [r.lo, r.hi]: each piece reduced into r, with the shift that
 * takes it back (the range itself where the direction isn't periodic); the whole of r where it spans a period.
 */
struct Piece {
  Range r;
  double shift;
};
std::vector<Piece> pieces(Range a, Range r, double P) {
  if (!(P > 0)) return {{a, 0}};
  if (a.hi - a.lo >= P) return {{r, 0}};
  std::vector<Piece> out;
  double lo = reduce(a.lo, r, P), shift = a.lo - lo, w = a.hi - a.lo;
  if (lo + w <= r.hi) return {{{lo, lo + w}, shift}};
  out.push_back({{lo, r.hi}, shift});
  out.push_back({{r.lo, lo + w - P}, shift + P});
  return out;
}

class Closed final : public SurfaceImpl {
public:
  Closed(std::unique_ptr<SurfaceImpl> s, bool u, bool v, std::vector<Singularity> added)
    : s_(std::move(s)), added_(std::move(added)) {
    dom_ = s_->domain();
    if (u) dom_.uPeriod = dom_.u.hi - dom_.u.lo;
    if (v) dom_.vPeriod = dom_.v.hi - dom_.v.lo;
    newU_ = u, newV_ = v;
  }
  SurfaceDomain domain() const override { return dom_; }
  Status derivs(double u, double v, int order, Vec3* out) const override {
    return s_->derivs(ru(u), rv(v), order, out);
  }
  Status normal(double u, double v, Vec3& out) const override { return s_->normal(ru(u), rv(v), out); }
  void breaks(Range a, Range b, std::vector<double>& us, std::vector<double>& vs) const override {
    // Each direction alone: the base's breaks on each piece, shifted back, the seams between pieces included.
    auto along = [&](Range x, bool isU) {
      std::vector<double> out, one, other;
      Range r = isU ? dom_.u : dom_.v;
      double P = isU ? (newU_ ? dom_.uPeriod : 0) : (newV_ ? dom_.vPeriod : 0);
      if (P > 0 && x.hi - x.lo >= P) {
        // A period or more: every period's breaks.
        double k0 = std::floor((x.lo - r.lo) / P);
        for (double k = k0; r.lo + k * P <= x.hi; k++) {
          Range piece{std::fmax(x.lo, r.lo + k * P), std::fmin(x.hi, r.lo + (k + 1) * P)};
          if (piece.lo > piece.hi) continue;
          Range red{piece.lo - k * P, piece.hi - k * P};
          isU ? s_->breaks(red, b, one, other) : s_->breaks(a, red, other, one);
          for (double t : one) out.push_back(t + k * P);
        }
      } else {
        for (const Piece& p : pieces(x, r, P)) {
          isU ? s_->breaks(p.r, b, one, other) : s_->breaks(a, p.r, other, one);
          for (double t : one) out.push_back(t + p.shift);
        }
      }
      std::sort(out.begin(), out.end());
      out.erase(std::unique(out.begin(), out.end()), out.end());
      return out;
    };
    us = along(a, true), vs = along(b, false);
  }
  Status derivBox(Range a, Range b, int k, int l, Box3& out) const override {
    out = emptyBox();
    for (const Piece& p : pieces(a, dom_.u, newU_ ? dom_.uPeriod : 0))
      for (const Piece& q : pieces(b, dom_.v, newV_ ? dom_.vPeriod : 0)) {
        Box3 x;
        Status s = s_->derivBox(p.r, q.r, k, l, x);
        if (s != Status::ok) return out = x, s;
        out = hull(out, x);
      }
    return Status::ok;
  }
  void singularities(std::vector<Singularity>& out) const override {
    s_->singularities(out);
    out.insert(out.end(), added_.begin(), added_.end());
    std::sort(out.begin(), out.end(), [](const Singularity& x, const Singularity& y) {
      return x.isoU != y.isoU ? x.isoU < y.isoU : x.at < y.at;
    });
  }
  void within(Vec3 p, double d, Range& u, Range& v) const override { s_->within(p, d, u, v); }
  bool footCandidates(Vec3 p, Range u, Range v, double tol, std::vector<Vec2>& out) const override {
    // The base's closed forms take its own periods; one this made periodic has none (it can't be a kind with them).
    if (newU_ || newV_) return false;
    return s_->footCandidates(p, u, v, tol, out);
  }
  char footFamily(Vec3 p) const override { return s_->footFamily(p); }
  bool splitByBoxes() const override { return s_->splitByBoxes(); }

private:
  double ru(double u) const { return newU_ ? reduce(u, dom_.u, dom_.uPeriod) : u; }
  double rv(double v) const { return newV_ ? reduce(v, dom_.v, dom_.vPeriod) : v; }

  std::unique_ptr<SurfaceImpl> s_;
  std::vector<Singularity> added_;
  SurfaceDomain dom_;
  bool newU_ = false, newV_ = false;
};

} // namespace

} // namespace surfaces

using namespace surfaces;

std::unique_ptr<Surface> closeInFact(std::unique_ptr<Surface> s, double tol) {
  SurfaceImpl* impl = dynamic_cast<SurfaceImpl*>(s.get());
  if (!impl || !(tol >= 0)) return s;
  SurfaceDomain d = impl->domain();
  auto at = [&](double u, double v) {
    Vec3 q[kPartials];
    impl->derivs(u, v, 0, q);
    return q[0];
  };
  auto y = [](Range r, int k) { return k == 8 ? r.hi : r.lo + (r.hi - r.lo) * k / 8; };
  bool fu = finite(d.u), fv = finite(d.v);
  // Closed in fact: the two ends one curve at 9 points of the other range.
  auto closes = [&](bool isU) {
    if (!fu || !fv || (isU ? d.uPeriod : d.vPeriod) > 0) return false;
    for (int k = 0; k <= 8; k++) {
      Vec3 a = isU ? at(d.u.lo, y(d.v, k)) : at(y(d.u, k), d.v.lo);
      Vec3 b = isU ? at(d.u.hi, y(d.v, k)) : at(y(d.u, k), d.v.hi);
      if (!(norm(a - b) <= tol)) return false;
    }
    return true;
  };
  bool cu = closes(true), cv = closes(false);
  // Collapsed sides: S(x, y_k) within tol of S(x, y_0) for every k; not those the surface reports already.
  std::vector<Singularity> have, added;
  impl->singularities(have);
  auto collapsed = [&](bool isU, double x) {
    Range other = isU ? d.v : d.u;
    if (!finite(other)) return;
    Vec3 a0 = isU ? at(x, y(other, 0)) : at(y(other, 0), x);
    for (int k = 1; k <= 8; k++) {
      Vec3 a = isU ? at(x, y(other, k)) : at(y(other, k), x);
      if (!(norm(a - a0) <= tol)) return;
    }
    for (const Singularity& g : have)
      if (g.kind != Singularity::normalVanishes && g.isoU == isU && g.at == x) return;
    added.push_back({Singularity::pole, isU, x, a0});
  };
  if (fu) collapsed(true, d.u.lo), collapsed(true, d.u.hi);
  if (fv) collapsed(false, d.v.lo), collapsed(false, d.v.hi);
  if (!cu && !cv && added.empty()) return s;
  s.release();
  return std::make_unique<Closed>(std::unique_ptr<SurfaceImpl>(impl), cu, cv, std::move(added));
}

} // namespace cadgeom
