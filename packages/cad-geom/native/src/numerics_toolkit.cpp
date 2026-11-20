// numerics.h's B-spline toolkit, from Piegl and Tiller, "The NURBS Book", 2nd ed.: knot insertion (algorithm A5.1),
// decomposition into Bezier pieces (A5.6) and degree elevation (A5.9, with the binomial blending of eq. 5.36). All
// three work on homogeneous poles (coordinates times weight, then the weight), as the book's do, so rational curves
// stay exact; a polynomial curve's weights are 1 throughout. Coordinates are taken relative to the first pole and
// moved back at the end, so blending poles near 1e6 doesn't round away what their differences (the derivatives)
// hold, as in eval. Every operation leaves the curve the same (the tests
// check it at many parameters against the evaluation before and against the reference shapes' exact points).
#include <algorithm>
#include <cmath>

#include "cad_geom/numerics.h"

namespace cadgeom {
namespace bspline {

namespace {

/** Poles in homogeneous form relative to origin, rows of dim + 1 (w (x - ox), w (y - oy), ..., w). */
struct Homogeneous {
  int dim;
  std::vector<double> rows;
  double origin[3] = {};
  int width() const { return dim + 1; }
  int count() const { return static_cast<int>(rows.size()) / width(); }
  double* row(int i) { return rows.data() + i * width(); }
  const double* row(int i) const { return rows.data() + i * width(); }
};

Homogeneous toHomogeneous(const BSpline& c) {
  Homogeneous h{c.dim, {}};
  int n = c.poleCount(), w = c.dim + (c.rational ? 1 : 0);
  for (int a = 0; a < c.dim && a < 3; a++) h.origin[a] = c.poles[a];
  h.rows.reserve(n * (c.dim + 1));
  for (int i = 0; i < n; i++) {
    const double* P = c.poles.data() + i * w;
    double wt = c.rational ? P[c.dim] : 1.0;
    for (int a = 0; a < c.dim; a++) h.rows.push_back((P[a] - h.origin[a]) * wt);
    h.rows.push_back(wt);
  }
  return h;
}

/** Back to the curve's form: coordinates divided by the weight, the weight kept if rational. */
std::vector<double> fromHomogeneous(const Homogeneous& h, bool rational) {
  std::vector<double> out;
  out.reserve(h.count() * (h.dim + (rational ? 1 : 0)));
  for (int i = 0; i < h.count(); i++) {
    const double* H = h.row(i);
    double wt = H[h.dim];
    for (int a = 0; a < h.dim; a++) out.push_back((rational ? H[a] / wt : H[a]) + h.origin[a]);
    if (rational) out.push_back(wt);
  }
  return out;
}

/** dst = alpha * a + (1 - alpha) * b, rows of `width`. */
void blend(double* dst, double alpha, const double* a, const double* b, int width) {
  for (int k = 0; k < width; k++) dst[k] = alpha * a[k] + (1 - alpha) * b[k];
}

bool wellFormed(const BSpline& c) {
  int n = c.poleCount(), p = c.degree, w = c.dim + (c.rational ? 1 : 0);
  if (c.dim < 1 || c.dim > 3 || p < 1 || n < p + 1 || static_cast<int>(c.poles.size()) != n * w) return false;
  if (static_cast<int>(c.knots.size()) != n + p + 1) return false;
  for (size_t i = 1; i < c.knots.size(); i++)
    if (!(c.knots[i - 1] <= c.knots[i])) return false;  // also rejects NaN
  return c.knots[p] < c.knots[n];
}

double binomial(int n, int k) {
  double b = 1;
  for (int i = 1; i <= k; i++) b = b * (n - k + i) / i;
  return b;
}

} // namespace

Status insertKnot(BSpline& c, double t, int times) {
  if (!wellFormed(c) || times < 0) return Status::invalidModel;
  if (times == 0) return Status::ok;
  const int p = c.degree, n = c.poleCount();
  const std::vector<double>& U = c.knots;
  // Inside the range only: at its ends the knot is already there p + 1 times.
  if (!(t > U[p] && t < U[n])) return Status::outOfDomain;
  const int k = findSpan(p, U, n, t);
  int s = 0;
  for (double u : U) s += u == t;
  // Beyond multiplicity p the curve would split (C^-1): not the same curve, so refused.
  if (s + times > p) return Status::invalidModel;
  Homogeneous P = toHomogeneous(c);
  const int wd = P.width();
  Homogeneous Q{c.dim, std::vector<double>((n + times) * wd)};
  std::copy(P.origin, P.origin + 3, Q.origin);
  // A5.1: the poles before and after the affected ones are copied, the p - s + 1 affected ones blended r times.
  for (int i = 0; i <= k - p; i++) std::copy(P.row(i), P.row(i) + wd, Q.row(i));
  for (int i = k - s; i <= n - 1; i++) std::copy(P.row(i), P.row(i) + wd, Q.row(i + times));
  std::vector<double> R((p - s + 1) * wd);
  for (int i = 0; i <= p - s; i++) std::copy(P.row(k - p + i), P.row(k - p + i) + wd, R.data() + i * wd);
  int L = 0;
  for (int j = 1; j <= times; j++) {
    L = k - p + j;
    for (int i = 0; i <= p - j - s; i++) {
      double alpha = (t - U[L + i]) / (U[i + k + 1] - U[L + i]);
      blend(R.data() + i * wd, alpha, R.data() + (i + 1) * wd, R.data() + i * wd, wd);
    }
    std::copy(R.data(), R.data() + wd, Q.row(L));
    std::copy(R.data() + (p - j - s) * wd, R.data() + (p - j - s + 1) * wd, Q.row(k + times - j - s));
  }
  for (int i = L + 1; i < k - s; i++) std::copy(R.data() + (i - L) * wd, R.data() + (i - L + 1) * wd, Q.row(i));
  std::vector<double> knots(U.begin(), U.begin() + k + 1);
  knots.insert(knots.end(), times, t);
  knots.insert(knots.end(), U.begin() + k + 1, U.end());
  c.knots = std::move(knots);
  c.poles = fromHomogeneous(Q, c.rational);
  return Status::ok;
}

std::vector<BSpline> toBezier(const BSpline& c) {
  if (!wellFormed(c)) return {};
  const int p = c.degree, n = c.poleCount(), m = n + p;  // m: the last knot's index, as the book's
  const std::vector<double>& U = c.knots;
  // An interior knot of multiplicity above p splits the curve; A5.6 assumes it doesn't.
  for (int i = p + 1; i < n;) {
    int j = i;
    while (j + 1 < n && U[j + 1] == U[i]) j++;
    if (j - i + 1 > p) return {};
    i = j + 1;
  }
  Homogeneous P = toHomogeneous(c);
  const int wd = P.width();
  Homogeneous blank{c.dim, std::vector<double>((p + 1) * wd)};
  std::copy(P.origin, P.origin + 3, blank.origin);
  std::vector<Homogeneous> pieces(1, blank);
  std::vector<double> starts{U[p]}, ends;
  for (int i = 0; i <= p; i++) std::copy(P.row(i), P.row(i) + wd, pieces[0].row(i));
  std::vector<double> alphas(p + 1);
  int a = p, b = p + 1;
  while (b < m) {
    int i = b;
    while (b < m && U[b + 1] == U[b]) b++;
    int mult = b - i + 1;
    Homogeneous& Q = pieces.back();
    Homogeneous next = blank;
    if (mult < p) {
      // The knot U[b] inserted until its multiplicity is p, the poles for the next piece set aside.
      double numer = U[b] - U[a];
      for (int j = p; j > mult; j--) alphas[j - mult - 1] = numer / (U[a + j] - U[a]);
      int r = p - mult;
      for (int j = 1; j <= r; j++) {
        int save = r - j, s = mult + j;
        for (int k = p; k >= s; k--) blend(Q.row(k), alphas[k - s], Q.row(k), Q.row(k - 1), wd);
        if (b < m) std::copy(Q.row(p), Q.row(p) + wd, next.row(save));
      }
    }
    ends.push_back(U[b]);
    if (b < m) {
      for (int k = p - mult; k <= p; k++) std::copy(P.row(b - p + k), P.row(b - p + k) + wd, next.row(k));
      pieces.push_back(std::move(next));
      starts.push_back(U[b]);
      a = b;
      b++;
    }
  }
  std::vector<BSpline> out;
  for (size_t k = 0; k < pieces.size(); k++) {
    BSpline z;
    z.degree = p;
    z.dim = c.dim;
    z.rational = c.rational;
    z.knots.assign(p + 1, starts[k]);
    z.knots.insert(z.knots.end(), p + 1, ends[k]);
    z.poles = fromHomogeneous(pieces[k], c.rational);
    out.push_back(std::move(z));
  }
  return out;
}

Status elevateDegree(BSpline& c, int by) {
  if (!wellFormed(c) || by < 0) return Status::invalidModel;
  if (by == 0) return Status::ok;
  const int p = c.degree, n = c.poleCount() - 1, m = n + p + 1;  // the book's n and m: last indices
  const int t = by, ph = p + t, ph2 = ph / 2;
  const std::vector<double>& U = c.knots;
  for (int i = p + 1; i <= n;) {
    int j = i;
    while (j + 1 <= n && U[j + 1] == U[i]) j++;
    if (j - i + 1 > p) return Status::invalidModel;  // a split curve: A5.9 assumes none
    i = j + 1;
  }
  Homogeneous P = toHomogeneous(c);
  const int wd = P.width();
  // The coefficients raising a Bezier piece of degree p to ph (eq. 5.36), symmetric about ph / 2.
  std::vector<double> bez((ph + 1) * (p + 1), 0.0);
  auto B = [&](int i, int j) -> double& { return bez[i * (p + 1) + j]; };
  B(0, 0) = B(ph, p) = 1;
  for (int i = 1; i <= ph2; i++) {
    double inv = 1 / binomial(ph, i);
    for (int j = std::max(0, i - t); j <= std::min(p, i); j++) B(i, j) = inv * binomial(p, j) * binomial(t, i - j);
  }
  for (int i = ph2 + 1; i <= ph - 1; i++)
    for (int j = std::max(0, i - t); j <= std::min(p, i); j++) B(i, j) = B(ph - i, p - j);
  // Upper bounds on the new counts: each distinct interior knot gains t, the ends t each.
  int distinct = 0;
  for (int i = 1; i <= m; i++) distinct += U[i] != U[i - 1];
  std::vector<double> Uh((m + 1) + (distinct + 2) * t + 1);
  Homogeneous Q{c.dim, std::vector<double>((n + 1 + (distinct + 2) * t + 1) * wd)};
  std::copy(P.origin, P.origin + 3, Q.origin);
  std::vector<double> bpts((p + 1) * wd), ebpts((ph + 1) * wd), next((p + 1) * wd), alfs(p + 1);
  auto row = [&](std::vector<double>& v, int i) { return v.data() + i * wd; };
  int mh = ph, kind = ph + 1, r = -1, a = p, b = p + 1, cind = 1;
  double ua = U[0];
  std::copy(P.row(0), P.row(0) + wd, Q.row(0));
  for (int i = 0; i <= ph; i++) Uh[i] = ua;
  for (int i = 0; i <= p; i++) std::copy(P.row(i), P.row(i) + wd, row(bpts, i));
  while (b < m) {
    int i = b;
    while (b < m && U[b] == U[b + 1]) b++;
    int mul = b - i + 1;
    mh += mul + t;
    double ub = U[b];
    int oldr = r;
    r = p - mul;
    int lbz = oldr > 0 ? (oldr + 2) / 2 : 1, rbz = r > 0 ? ph - (r + 1) / 2 : ph;
    if (r > 0) {
      // ub inserted r times into the current piece; its right poles kept for the next.
      double numer = ub - ua;
      for (int k = p; k > mul; k--) alfs[k - mul - 1] = numer / (U[a + k] - ua);
      for (int j = 1; j <= r; j++) {
        int save = r - j, s = mul + j;
        for (int k = p; k >= s; k--) blend(row(bpts, k), alfs[k - s], row(bpts, k), row(bpts, k - 1), wd);
        std::copy(row(bpts, p), row(bpts, p) + wd, row(next, save));
      }
    }
    // The piece's degree raised.
    for (int k = lbz; k <= ph; k++) {
      double* E = row(ebpts, k);
      std::fill(E, E + wd, 0.0);
      for (int j = std::max(0, k - t); j <= std::min(p, k); j++)
        for (int q = 0; q < wd; q++) E[q] += B(k, j) * row(bpts, j)[q];
    }
    if (oldr > 1) {
      // The knot ua, inserted oldr times for the previous piece, removed again oldr - 1 times.
      int first = kind - 2, last = kind;
      double den = ub - ua, bet = (ub - Uh[kind - 1]) / den;
      for (int tr = 1; tr < oldr; tr++) {
        int ii = first, jj = last, kj = jj - kind + 1;
        while (jj - ii > tr) {
          if (ii < cind) {
            double alf = (ub - Uh[ii]) / (ua - Uh[ii]);
            blend(Q.row(ii), alf, Q.row(ii), Q.row(ii - 1), wd);
          }
          if (jj >= lbz) {
            if (jj - tr <= kind - ph + oldr) {
              double gam = (ub - Uh[jj - tr]) / den;
              blend(row(ebpts, kj), gam, row(ebpts, kj), row(ebpts, kj + 1), wd);
            } else {
              blend(row(ebpts, kj), bet, row(ebpts, kj), row(ebpts, kj + 1), wd);
            }
          }
          ii++;
          jj--;
          kj--;
        }
        first--;
        last++;
      }
    }
    if (a != p)
      for (int k = 0; k < ph - oldr; k++) Uh[kind++] = ua;
    for (int j = lbz; j <= rbz; j++) std::copy(row(ebpts, j), row(ebpts, j) + wd, Q.row(cind++));
    if (b < m) {
      for (int j = 0; j < r; j++) std::copy(row(next, j), row(next, j) + wd, row(bpts, j));
      for (int j = std::max(r, 0); j <= p; j++) std::copy(P.row(b - p + j), P.row(b - p + j) + wd, row(bpts, j));
      a = b;
      b++;
      ua = ub;
    } else {
      for (int k = 0; k <= ph; k++) Uh[kind + k] = ub;
    }
  }
  const int nh = mh - ph - 1;  // the new last pole's index
  Uh.resize(mh + 1);
  Q.rows.resize((nh + 1) * wd);
  c.degree = ph;
  c.knots = std::move(Uh);
  c.poles = fromHomogeneous(Q, c.rational);
  return Status::ok;
}

} // namespace bspline
} // namespace cadgeom
