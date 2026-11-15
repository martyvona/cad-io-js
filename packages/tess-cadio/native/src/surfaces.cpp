// surfaces.h: closed in fact where the surface at the range's two ends of a direction is one curve, within the
// part's uncertainty (else 1e-9 of the surface's size) at 9 points across the other direction.
#include "surfaces.h"

#include <algorithm>
#include <cmath>

namespace tesscadio {

using namespace cadgeom;

namespace {

/** A surface whose closed directions are periodic over its range: queries reduced into it. */
class Closed : public Surface {
public:
  Closed(std::unique_ptr<Surface> s, bool u, bool v) : s_(std::move(s)), d_(s_->domain()) {
    if (u) d_.uPeriod = d_.u.hi - d_.u.lo;
    if (v) d_.vPeriod = d_.v.hi - d_.v.lo;
  }
  SurfaceDomain domain() const override { return d_; }
  Status eval(double u, double v, int order, SurfacePoint& out) const override {
    return s_->eval(reduce(u, d_.u, d_.uPeriod), reduce(v, d_.v, d_.vPeriod), order, out);
  }
  Status normal(double u, double v, Vec3& out) const override {
    return s_->normal(reduce(u, d_.u, d_.uPeriod), reduce(v, d_.v, d_.vPeriod), out);
  }
  void breaks(Range ru, Range rv, std::vector<double>& us, std::vector<double>& vs) const override {
    // (Within one period, by its shift there; across more, the whole range's, the caller's ends kept.)
    double su = 0, sv = 0;
    Range a = into(ru, d_.u, d_.uPeriod, su), b = into(rv, d_.v, d_.vPeriod, sv);
    s_->breaks(a, b, us, vs);
    for (double& x : us) x += su;
    for (double& x : vs) x += sv;
    if (!us.empty()) us.front() = ru.lo, us.back() = ru.hi;
    if (!vs.empty()) vs.front() = rv.lo, vs.back() = rv.hi;
  }
  Status bound(Range ru, Range rv, Box3& out) const override {
    double su, sv;
    return s_->bound(into(ru, d_.u, d_.uPeriod, su), into(rv, d_.v, d_.vPeriod, sv), out);
  }
  Status derivBound(Range ru, Range rv, int order, double out[3]) const override {
    double su, sv;
    return s_->derivBound(into(ru, d_.u, d_.uPeriod, su), into(rv, d_.v, d_.vPeriod, sv), order, out);
  }
  void singularities(std::vector<Singularity>& out) const override { s_->singularities(out); }
  const Surface& base() const { return *s_; }

private:
  static double reduce(double x, Range r, double P) {
    if (!(P > 0) || (x >= r.lo && x <= r.hi)) return x;
    double y = r.lo + std::fmod(x - r.lo, P);
    return y < r.lo ? y + P : y;
  }
  /** A range in the domain's: shifted by whole periods where it fits in one (`shift` added back), else the whole. */
  static Range into(Range x, Range r, double P, double& shift) {
    shift = 0;
    if (!(P > 0) || (x.lo >= r.lo && x.hi <= r.hi)) return x;
    if (x.hi - x.lo > P) return r;
    double k = std::floor((x.lo - r.lo) / P);
    Range y{x.lo - k * P, x.hi - k * P};
    if (y.hi > r.hi) return r;  // across the seam: the whole range
    shift = k * P;
    return y;
  }
  std::unique_ptr<Surface> s_;
  SurfaceDomain d_;
};

} // namespace

const Surface& baseSurface(const Surface& s) {
  const Closed* c = dynamic_cast<const Closed*>(&s);
  return c ? c->base() : s;
}

std::unique_ptr<Surface> faceSurface(const Model& m, int row, Status& status) {
  std::unique_ptr<Surface> s = makeSurface(m, row, status);
  if (!s) return s;
  SurfaceDomain d = s->domain();
  auto finite = [](Range r) { return std::isfinite(r.lo) && std::isfinite(r.hi) && r.hi > r.lo; };
  if (!finite(d.u) || !finite(d.v)) return s;
  auto at = [&](double u, double v) {
    SurfacePoint q;
    s->eval(u, v, 0, q);
    return q.p;
  };
  Vec3 c0 = at(d.u.lo, d.v.lo), c1 = at(d.u.hi, d.v.hi);
  double size = norm(c1 - c0) + norm(at(d.u.lo, d.v.hi) - at(d.u.hi, d.v.lo));
  double u = m.uncertainty(), tol = std::isfinite(u) && u > 0 ? u : 1e-9 * std::max(size, 1.0);
  auto closes = [&](bool alongU) {
    for (int k = 0; k <= 8; k++) {
      double w = alongU ? d.v.lo + (d.v.hi - d.v.lo) * k / 8 : d.u.lo + (d.u.hi - d.u.lo) * k / 8;
      Vec3 a = alongU ? at(d.u.lo, w) : at(w, d.v.lo), b = alongU ? at(d.u.hi, w) : at(w, d.v.hi);
      if (norm(a - b) > tol) return false;
    }
    return true;
  };
  bool cu = !(d.uPeriod > 0) && closes(true), cv = !(d.vPeriod > 0) && closes(false);
  if (!cu && !cv) return s;
  return std::make_unique<Closed>(std::move(s), cu, cv);
}

} // namespace tesscadio
