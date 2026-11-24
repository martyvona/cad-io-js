// Point classification's faces (oracle.h's rayFace): a line against a trimmed face, cad-geom's intersectLine on the
// face's surface as the face API closes it, each contact classified against the face's loops by the face API
// (cg_face_classify), so a ray and a mesh see one face. A crossing on the boundary within the face's tolerance is its
// own kind: the face beside it may or may not see the same crossing, so a parity count can't take it. A broad phase
// goes first: a line missing the face's box (faceBox) skips the face, so on a large shell a ray builds and tests only
// the faces near it (building a face, its p-curves projected, costs far more than its line test).
#include <algorithm>
#include <cmath>

#include "geom_api.h"
#include "oracle_impl.h"

namespace cadoracle {

using cadgeom::LineHit;
using cadgeom::LineIntersection;

const Surface* Oracle::Impl::faceSurface(int face) {
  if (face < 0 || face >= model.faces()) return nullptr;
  if (faceSurfaces_.empty()) faceSurfaces_.resize(model.faces()), faceSurfaceMade_.assign(model.faces(), 0);
  if (!faceSurfaceMade_[face]) {
    faceSurfaceMade_[face] = 1;
    Status st;
    std::unique_ptr<Surface> S = cadgeom::makeSurface(model, model.faceSurface(face), st);
    if (S) faceSurfaces_[face] = cadgeom::closeInFact(std::move(S), tols.face(face));
  }
  return faceSurfaces_[face].get();
}

bool Oracle::Impl::faceBox(int f, cadgeom::Box3& box) {
  if (f < 0 || f >= model.faces()) return false;
  if (faceBoxMade_.empty()) faceBoxes_.resize(model.faces()), faceBoxMade_.assign(model.faces(), 0);
  if (!faceBoxMade_[f]) {
    faceBoxMade_[f] = 2;
    Vec3 lo{INFINITY, INFINITY, INFINITY}, hi{-INFINITY, -INFINITY, -INFINITY};
    auto add = [&](const cadgeom::Box3& b) {
      lo = {std::fmin(lo.x, b.x.lo), std::fmin(lo.y, b.y.lo), std::fmin(lo.z, b.z.lo)};
      hi = {std::fmax(hi.x, b.x.hi), std::fmax(hi.y, b.y.hi), std::fmax(hi.z, b.z.hi)};
    };
    auto point = [&](Vec3 p) { add({{p.x, p.x}, {p.y, p.y}, {p.z, p.z}}); };
    const Surface* S = faceSurface(f);
    if (!S) return false;
    const cadgeom::SurfaceDomain D = S->domain();
    const int kind = model.surfaceKind(model.faceSurface(f));
    bool ok = model.faceLoopCount(f) > 0;
    if (std::isfinite(D.u.lo) && std::isfinite(D.u.hi) && std::isfinite(D.v.lo) && std::isfinite(D.v.hi)) {
      cadgeom::Box3 b;
      ok = S->bound(D.u, D.v, b) == Status::ok;
      if (ok) add(b);
    } else {
      ok = ok && (kind == CBR_SURFACE_PLANE || kind == CBR_SURFACE_CYLINDER || kind == CBR_SURFACE_CONE ||
        kind == CBR_SURFACE_EXTRUSION);
      // A ruling may end at a cone's apex, not on the boundary (a face reaching it as a pole, no vertex there).
      std::vector<cadgeom::Singularity> sing;
      if (ok) S->singularities(sing);
      for (const cadgeom::Singularity& g : sing)
        if (g.kind != cadgeom::Singularity::normalVanishes) point(g.point);
    }
    double tol = tols.face(f);
    for (int l = model.faceFirstLoop(f); ok && l < model.faceFirstLoop(f) + model.faceLoopCount(f); l++) {
      for (int c = model.loopFirst(l); ok && c < model.loopFirst(l) + model.loopCount(l); c++) {
        // (A vertex loop, its rows vertices, stands at a singular point: in the surface's bound, or its apex above.)
        if (model.loopKind(l) == CBR_LOOP_VERTEX) continue;
        const int e = model.coedgeEdge(c);
        if (e < 0) { ok = false; break; }
        tol = std::fmax(tol, tols.edge(e));
        for (int v : {model.edgeStart(e), model.edgeEnd(e)})
          if (v >= 0) point(model.vertexPoint(v));
        double t0, t1;
        const Curve* C = model.edgeCurve(e) >= 0 ? curve(model.edgeCurve(e)) : nullptr;
        cadgeom::Box3 b;
        if (C && edgeParams(e, t0, t1) && C->bound({std::fmin(t0, t1), std::fmax(t0, t1)}, b) == Status::ok) add(b);
        else ok = false;
      }
    }
    const double w = 2 * tol;
    ok = ok && std::isfinite(lo.x + lo.y + lo.z + hi.x + hi.y + hi.z) && std::isfinite(w);
    if (ok) {
      faceBoxMade_[f] = 1;
      faceBoxes_[f] = {{lo.x - w, hi.x + w}, {lo.y - w, hi.y + w}, {lo.z - w, hi.z + w}};
    }
  }
  if (faceBoxMade_[f] != 1) return false;
  box = faceBoxes_[f];
  return true;
}

namespace {

/** Whether o + t d for some t in tr meets the box (slabs; a component of d zero: o's within its slab). */
bool segmentMeets(const cadgeom::Box3& b, Vec3 o, Vec3 d, Range tr) {
  double lo = tr.lo, hi = tr.hi;
  const cadgeom::Interval I[3] = {b.x, b.y, b.z};
  const double O[3] = {o.x, o.y, o.z}, Dd[3] = {d.x, d.y, d.z};
  for (int k = 0; k < 3; k++) {
    if (Dd[k] == 0) {
      if (O[k] < I[k].lo || O[k] > I[k].hi) return false;
      continue;
    }
    double a = (I[k].lo - O[k]) / Dd[k], c = (I[k].hi - O[k]) / Dd[k];
    if (a > c) std::swap(a, c);
    lo = std::fmax(lo, a), hi = std::fmin(hi, c);
    if (lo > hi) return false;
  }
  return true;
}

}  // namespace

RayFace Oracle::Impl::rayFace(int face, Vec3 o, Vec3 d, Range tr) {
  RayFace out;
  const Surface* S = h >= 0 ? faceSurface(face) : nullptr;
  if (!S) return out;
  // The broad phase: a line missing the face's box meets nothing of it (nor is the face API's face made).
  cadgeom::Box3 box;
  if (faceBox(face, box) && !segmentMeets(box, o, d, tr)) {
    out.status = Status::ok;
    return out;
  }
  // The face API's tolerance for the face (its own, widened by its edges'), in 3D.
  double info[16];
  if (cg_face_info(h, face, 0, info) != 0) return out;
  const double tol = info[0];
  const cadgeom::SurfaceDomain D = S->domain();
  const LineIntersection li = intersectLine(*S, o, d, tr, D.u, D.v, tol);
  if (met && (!li.crossings.empty() || !li.tangencies.empty() || !li.overlaps.empty() ||
    li.status != Status::ok)) met->push_back(face);
  if (li.status != Status::ok && li.status != Status::noConvergence) {
    out.status = li.status;
    return out;
  }
  // Classified, each at its own tolerance in 3D: the face's for crossings, widened by half a tangency's span (its
  // cluster stands for that stretch of the line) for tangencies.
  auto side = [&](cadgeom::Vec2 uv, double tol3d) {
    const double p[2] = {uv.x, uv.y};
    uint8_t sd = 0, st = 0;
    double tolUv = 0;
    if (cg_face_classify(h, face, p, 1, tol3d, &sd, &st, &tolUv) != 0 || st != 0) return -1;
    return static_cast<int>(sd);  // cadgeom::Side: in 0, out 1, on 2
  };
  const double dl = std::sqrt(dot(d, d));
  for (const LineHit& c : li.crossings) {
    const int sd = side(c.uv, tol);
    if (sd == 1) continue;
    out.hits.push_back({sd == 0 ? FaceHit::crossing : FaceHit::boundary, c.t, c.span, c.uv, c.point, c.cosine});
    // (A classification that failed is taken as the boundary: the ray can't count it.)
    if (sd < 0) out.hits.back().kind = FaceHit::boundary;
  }
  for (const LineHit& g : li.tangencies) {
    const int sd = side(g.uv, tol + 0.5 * (g.span.hi - g.span.lo) * dl);
    if (sd == 1) continue;
    out.hits.push_back({FaceHit::tangency, g.t, g.span, g.uv, g.point, g.cosine});
  }
  // A line lying in the face's surface: kept whatever the loops (rare along the rays a classification casts, and a
  // ray along it can't be counted in any case).
  for (const Range& r : li.overlaps) {
    FaceHit k;
    k.kind = FaceHit::overlap, k.t = r.lo, k.span = r, k.point = o + r.lo * d;
    out.hits.push_back(k);
  }
  std::sort(out.hits.begin(), out.hits.end(), [](const FaceHit& a, const FaceHit& b) { return a.t < b.t; });
  out.status = li.status;
  return out;
}

std::vector<int> Oracle::Impl::shellFaces(int shell) const {
  std::vector<int> out;
  if (shell < 0 || shell >= model.rows(CBR_SHELL_KIND)) return out;
  const int first = model.i32(CBR_SHELL_FIRST)[shell], count = model.i32(CBR_SHELL_COUNT)[shell];
  for (int i = first; i < first + count; i++) {
    const int f = model.i32(CBR_FACE_USE_FACE)[i];
    if (f >= 0 && f < model.faces()) out.push_back(f);
  }
  return out;
}

bool Oracle::Impl::shellBox(int shell, Vec3& lo, Vec3& hi) {
  lo = {INFINITY, INFINITY, INFINITY}, hi = {-INFINITY, -INFINITY, -INFINITY};
  auto add = [&](const cadgeom::Box3& b) {
    lo = {std::fmin(lo.x, b.x.lo), std::fmin(lo.y, b.y.lo), std::fmin(lo.z, b.z.lo)};
    hi = {std::fmax(hi.x, b.x.hi), std::fmax(hi.y, b.y.hi), std::fmax(hi.z, b.z.hi)};
  };
  for (int f : shellFaces(shell)) {
    const Surface* S = faceSurface(f);
    if (S) {
      const cadgeom::SurfaceDomain D = S->domain();
      cadgeom::Box3 b;
      if (std::isfinite(D.u.lo) && std::isfinite(D.u.hi) && std::isfinite(D.v.lo) && std::isfinite(D.v.hi) &&
        S->bound(D.u, D.v, b) == Status::ok)
        add(b);
    }
    for (int l = model.faceFirstLoop(f); l < model.faceFirstLoop(f) + model.faceLoopCount(f); l++)
      for (int c = model.loopFirst(l); c < model.loopFirst(l) + model.loopCount(l); c++) {
        const int e = model.coedgeEdge(c);
        if (e < 0) continue;
        for (int v : {model.edgeStart(e), model.edgeEnd(e)})
          if (v >= 0) {
            const Vec3 p = model.vertexPoint(v);
            add({{p.x, p.x}, {p.y, p.y}, {p.z, p.z}});
          }
        double t0, t1;
        const Curve* C = model.edgeCurve(e) >= 0 ? curve(model.edgeCurve(e)) : nullptr;
        cadgeom::Box3 b;
        if (C && edgeParams(e, t0, t1) && C->bound({std::fmin(t0, t1), std::fmax(t0, t1)}, b) == Status::ok) add(b);
      }
  }
  return lo.x <= hi.x && std::isfinite(lo.x) && std::isfinite(hi.x) && std::isfinite(lo.y) && std::isfinite(hi.y) &&
    std::isfinite(lo.z) && std::isfinite(hi.z);
}

namespace {

/**
 * The rays' directions: a cube's 6 faces, 12 edges and 8 corners from its middle, turned by a fixed rotation (about
 * (1, 2, 3) by 0.6435 rad) so that none lies along a model's axes, where its faces' edges and planes are.
 */
std::vector<Vec3> rayDirections() {
  std::vector<Vec3> out;
  for (int x = -1; x <= 1; x++)
    for (int y = -1; y <= 1; y++)
      for (int z = -1; z <= 1; z++)
        if (x || y || z)
          out.push_back((1 / std::sqrt(double(x * x + y * y + z * z))) * Vec3{double(x), double(y), double(z)});
  // (Faces first, then edges, then corners: the directions farthest from each other first.)
  std::stable_sort(out.begin(), out.end(), [](Vec3 a, Vec3 b) {
    auto k = [](Vec3 v) { return (v.x != 0) + (v.y != 0) + (v.z != 0); };
    return k(a) < k(b);
  });
  const Vec3 a = (1 / std::sqrt(14.0)) * Vec3{1, 2, 3};
  const double c = std::cos(0.6435), s = std::sin(0.6435);
  for (Vec3& v : out) v = c * v + s * cross(a, v) + (1 - c) * dot(a, v) * a;
  return out;
}

} // namespace

PointClass Oracle::Impl::classify(int shell, Vec3 p) {
  PointClass out;
  Vec3 lo, hi;
  if (!shellBox(shell, lo, hi)) {
    out.why = "the shell has no finite box";
    return out;
  }
  const std::vector<int> faces = shellFaces(shell);
  // Each ray from p to past the box (its far corner's distance, and the box's size again).
  const double far = std::fmax(cadgeom::norm(hi - p), cadgeom::norm(lo - p)) + cadgeom::norm(hi - lo);
  double tol = 0;
  for (int f : faces) tol = std::fmax(tol, tols.face(f));
  static const std::vector<Vec3> dirs = rayDirections();
  int usable = 0, first = -1, nearAll = 0;
  for (size_t k = 0; k < dirs.size() && k < 16; k++) {
    const Vec3 d = far * dirs[k];
    out.tried++;
    int crossings = 0, why = -1;
    for (int f : faces) {
      const RayFace r = rayFace(f, p, d, {0, 1});
      if (r.status != Status::ok) why = rejectedBudget;
      for (const FaceHit& h : r.hits) {
        if (h.kind == FaceHit::boundary) why = why < 0 ? rejectedBoundary : why;
        else if (h.kind == FaceHit::tangency) why = why < 0 ? rejectedTangency : why;
        else if (h.kind == FaceHit::overlap) why = why < 0 ? rejectedOverlap : why;
        else if (h.t * far <= 2 * tol) why = rejectedNear;
        else crossings++;
      }
      if (why >= 0) break;
    }
    if (why >= 0) {
      out.rejected[why]++;
      nearAll += why == rejectedNear;
      if (nearAll == out.tried && out.tried >= 3) {
        out.side = PointClass::on, out.why = "within the tolerance of the shell";
        return out;
      }
      continue;
    }
    usable++;
    if (usable == 1) {
      first = crossings;
      out.dir = dirs[k], out.length = far, out.crossings = crossings;
      out.side = crossings % 2 ? PointClass::inside : PointClass::outside;
      if (!options.checkSecondRay) return out;
    } else {
      out.checked = (crossings % 2) == (first % 2);
      if (!out.checked) out.side = PointClass::unknown, out.why = "rays disagree";
      return out;
    }
  }
  if (usable == 0) out.side = PointClass::unknown, out.why = "no usable ray";
  else out.why = "no second usable ray";  // (checkSecondRay: the first's side kept, unchecked)
  return out;
}

bool Oracle::Impl::interiorPoint(int face, cadgeom::Vec2& uv, Vec3& p, Vec3& n) {
  const Surface* S = faceSurface(face);
  if (!S || h < 0) return false;
  // The loops' (u, v) box from their pieces' p-curves (9 points each), else the surface's domain.
  double ulo = INFINITY, uhi = -INFINITY, vlo = INFINITY, vhi = -INFINITY;
  const int np = cg_face_pieces(h, face);
  if (np < 0) return false;
  std::vector<double> pieces(cg_scratch(), cg_scratch() + 3 * np);
  for (int i = 0; i < np; i++) {
    double t[9], out[9 * 3];
    uint8_t st[9];
    for (int k = 0; k < 9; k++) t[k] = pieces[3 * i + 1] + (pieces[3 * i + 2] - pieces[3 * i + 1]) * k / 8;
    if (cg_coedge_eval(h, static_cast<int32_t>(pieces[3 * i]), t, 9, 0, out, st) != 0) continue;
    for (int k = 0; k < 9; k++)
      if (st[k] == 0) ulo = std::fmin(ulo, out[3 * k]), uhi = std::fmax(uhi, out[3 * k]),
        vlo = std::fmin(vlo, out[3 * k + 1]), vhi = std::fmax(vhi, out[3 * k + 1]);
  }
  const cadgeom::SurfaceDomain D = S->domain();
  // The loops' box first, then the surface's domain where finite (a hemisphere's one loop, its equator, has a box
  // with no height: the face runs from it to the pole).
  if (ulo <= uhi && gridPoint(face, *S, ulo, uhi, vlo, vhi, uv, p, n)) return true;
  return std::isfinite(D.u.lo) && std::isfinite(D.u.hi) && std::isfinite(D.v.lo) && std::isfinite(D.v.hi) &&
    gridPoint(face, *S, D.u.lo, D.u.hi, D.v.lo, D.v.hi, uv, p, n);
}

bool Oracle::Impl::gridPoint(int face, const Surface& surface, double ulo, double uhi, double vlo, double vhi,
  cadgeom::Vec2& uv, Vec3& p, Vec3& n) {
  const Surface* S = &surface;
  if (!std::isfinite(ulo) || !std::isfinite(uhi) || !std::isfinite(vlo) || !std::isfinite(vhi)) return false;
  // A 17 x 17 grid, its points nearest the middle first.
  std::vector<cadgeom::Vec2> grid;
  for (int a = 0; a <= 16; a++)
    for (int b = 0; b <= 16; b++)
      grid.push_back({ulo + (uhi - ulo) * (0.5 + (a - 8) / 17.0), vlo + (vhi - vlo) * (0.5 + (b - 8) / 17.0)});
  const cadgeom::Vec2 m{0.5 * ulo + 0.5 * uhi, 0.5 * vlo + 0.5 * vhi};
  std::stable_sort(grid.begin(), grid.end(), [&](cadgeom::Vec2 x, cadgeom::Vec2 y) {
    const double dx = (x.x - m.x) / (uhi - ulo + 1e-300), dy = (x.y - m.y) / (vhi - vlo + 1e-300);
    const double ex = (y.x - m.x) / (uhi - ulo + 1e-300), ey = (y.y - m.y) / (vhi - vlo + 1e-300);
    return dx * dx + dy * dy < ex * ex + ey * ey;
  });
  std::vector<double> uvs(2 * grid.size());
  for (size_t i = 0; i < grid.size(); i++) uvs[2 * i] = grid[i].x, uvs[2 * i + 1] = grid[i].y;
  // In at the face's tolerance, and well inside: not on at 100, else 10, times it (on is a distance test, sound at any
  // tolerance; classifying at one that large isn't: a joint's pieces near the meeting there span whole sides, and
  // points off the face came out in). In judged at the face's tolerance where that's settled, else at the first of 10
  // and 100 times it that is (loops with gaps wider than the tolerance, invalidModel there, bridged at a larger one).
  // Classified in batches growing from the middle (1, 4, 16, ... points) as the search below reaches them: a point
  // near the boundary costs the most (the face API approximates the pieces near it finely), and the middle's points
  // are mostly well inside. The point found is the one classifying the whole grid at once would find (the face API
  // fails a face whole, at a tolerance, and the first batch takes all three).
  const double ks[3] = {1, 10, 100};
  std::vector<uint8_t> sides[3], st[3];
  std::vector<double> tolUv(grid.size());
  for (int j = 0; j < 3; j++) sides[j].resize(grid.size()), st[j].resize(grid.size());
  size_t done = 0, batch = 1;
  // Points [0, i] classified at the three tolerances; false where the face API fails.
  auto upTo = [&](size_t i) {
    for (; done <= i; done += batch, batch *= 4) {
      batch = std::min(batch, grid.size() - done);
      for (int j = 0; j < 3; j++)
        if (cg_face_classify(h, face, uvs.data() + 2 * done, static_cast<int32_t>(batch), ks[j] * tols.face(face),
              sides[j].data() + done, st[j].data() + done, tolUv.data() + done) != 0)
          return false;
    }
    return true;
  };
  auto in = [&](size_t i) {
    for (int j = 0; j < 3; j++)
      if (st[j][i] == 0) return sides[j][i] == 0;
    return false;
  };
  for (int j : {2, 1}) {
    for (size_t i = 0; i < grid.size(); i++) {
      if (!upTo(i)) return false;
      if (!in(i) || sides[j][i] == 2) continue;
      cadgeom::SurfacePoint q;
      Vec3 nn;
      if (S->eval(grid[i].x, grid[i].y, 0, q) != Status::ok || S->normal(grid[i].x, grid[i].y, nn) != Status::ok)
        continue;
      uv = grid[i], p = q.p, n = model.faceSameSense(face) ? nn : -1.0 * nn;
      return true;
    }
  }
  return false;
}

ShellSide Oracle::Impl::shellSide(int shell, int face, double eps) {
  ShellSide out;
  cadgeom::Vec2 uv;
  Vec3 x, n;
  if (!interiorPoint(face, uv, x, n)) {
    out.why = "no point well inside the face";
    return out;
  }
  out.from = x;
  const std::vector<int> faces = shellFaces(shell);
  const double tol = tols.face(face);
  // An offset clear of the shell's other faces: the segment from the point moved off back through the face to tol
  // beyond meets the face alone, once, at x.
  // (eps's sign the side: negative, against the normal.)
  const double sign = eps < 0 ? -1 : 1;
  // (Not below 10 x the tolerance: an offset less than that is taken as that, its own test the clear one below.)
  for (double a = std::fmax(std::fabs(eps), 10 * tol), tries = 0; tries < 5 && a >= 10 * tol; tries++, a *= 0.5) {
    const Vec3 q = x + (sign * a) * n, d = -(sign * (a + 2 * tol)) * n;
    bool clear = true;
    for (int f : faces) {
      const RayFace r = rayFace(f, q, d, {0, 1});
      if (r.status != Status::ok) clear = false;
      for (const FaceHit& h : r.hits) {
        const bool ours = f == face && h.kind == FaceHit::crossing && cadgeom::norm(h.point - x) <= 2 * tol;
        clear = clear && ours;
      }
      if (!clear) break;
    }
    if (!clear) continue;
    out.point = q, out.eps = sign * a;
    out.classified = classify(shell, q);
    switch (out.classified.side) {
      case PointClass::outside: out.side = ShellSide::outside; break;
      case PointClass::inside: out.side = ShellSide::inside; break;
      default: out.why = out.classified.why[0] ? out.classified.why : "the point moved off the face unknown";
    }
    return out;
  }
  out.why = "no offset clear of the shell's other faces";
  return out;
}

std::vector<int> Oracle::Impl::nesting(int body) {
  std::vector<int> out;
  if (body < 0 || body >= model.rows(CBR_BODY_KIND)) return out;
  const int first = model.i32(CBR_BODY_FIRST)[body], count = model.i32(CBR_BODY_COUNT)[body];
  std::vector<int> shells;
  for (int i = first; i < first + count; i++) {
    const int sh = model.i32(CBR_MEMBER_REF)[i];
    if (sh >= 0 && sh < model.rows(CBR_SHELL_KIND)) shells.push_back(sh);
  }
  const int n = static_cast<int>(shells.size());
  out.assign(n, -1);
  // Per shell points well inside up to 6 of its faces (on it), spread over them, and which others hold all of them. A
  // shell some of whose points are inside another and some outside crosses or overlaps it: that can't be told, -2 (one
  // point per shell would give a depth by whichever face came first).
  std::vector<std::vector<bool>> holds(n, std::vector<bool>(n, false));
  for (int a = 0; a < n; a++) {
    if (model.u8(CBR_SHELL_KIND)[shells[a]] != CBR_SHELL_CLOSED) {
      out[a] = -2;
      continue;
    }
    const std::vector<int> faces = shellFaces(shells[a]);
    std::vector<Vec3> points;
    const size_t want = std::min<size_t>(6, faces.size());
    for (size_t k = 0; k < want; k++) {
      cadgeom::Vec2 uv;
      Vec3 p, nn;
      if (interiorPoint(faces[k * faces.size() / want], uv, p, nn)) points.push_back(p);
    }
    if (points.empty()) {
      out[a] = -2;
      continue;
    }
    for (int b = 0; b < n && out[a] != -2; b++) {
      if (b == a || model.u8(CBR_SHELL_KIND)[shells[b]] != CBR_SHELL_CLOSED) continue;
      int in = 0, outside = 0;
      for (const Vec3& p : points) {
        const PointClass c = classify(shells[b], p);
        in += c.side == PointClass::inside, outside += c.side == PointClass::outside;
      }
      // Held: every point inside. Not held: some outside, none inside (the rest on it: touching from outside). Else
      // (inside and outside: crossing; inside and on, or unknown) it can't be told.
      if (in == static_cast<int>(points.size())) holds[a][b] = true;
      else if (!(outside > 0 && in == 0)) out[a] = -2;
    }
  }
  // The smallest holder: the one held by the most of the others that hold it too (nested shells hold in a chain).
  for (int a = 0; a < n; a++) {
    if (out[a] == -2) continue;
    int best = -1, depth = -1;
    for (int b = 0; b < n; b++) {
      if (!holds[a][b]) continue;
      int d = 0;
      for (int c = 0; c < n; c++) d += holds[b][c];
      if (d > depth) depth = d, best = b;
    }
    out[a] = best;
  }
  return out;
}

PointClass Oracle::classify(int shell, Vec3 p) {
  if (!ok() || shell < 0 || shell >= impl_->model.rows(CBR_SHELL_KIND)) {
    PointClass out;
    out.why = "no such shell";
    return out;
  }
  return impl_->classify(shell, p);
}

ShellSide Oracle::shellSide(int shell, int face, double eps) {
  if (!ok() || shell < 0 || shell >= impl_->model.rows(CBR_SHELL_KIND) || face < 0 || face >= impl_->model.faces()) {
    ShellSide out;
    out.why = "no such shell or face";
    return out;
  }
  // A face with its loops against its sense, its region in doubt: the rays can't be counted where they meet its
  // surface, nor the point taken from inside it. Only those faces are measured (each once), not the whole shell: a
  // measure is a quadrature, the rays' cost many times over on a large free-form shell.
  Impl& I = *impl_;
  std::vector<int> met{face};
  struct Log {
    Impl& I;
    ~Log() { I.met = nullptr; }
  } log{I};
  I.met = &met;
  ShellSide out = I.shellSide(shell, face, eps);
  I.met = nullptr;
  if (I.loopsAgainst.empty()) I.loopsAgainst.assign(I.model.faces(), 2);
  for (int f : met) {
    if (I.loopsAgainst[f] == 2) I.loopsAgainst[f] = (this->face(f).flags & flagOrientation) ? 1 : 0;
    if (I.loopsAgainst[f] == 1) {
      out.side = ShellSide::unknown, out.why = "a face the rays meet has its loops against its sense";
      return out;
    }
  }
  return out;
}

std::vector<int> Oracle::nesting(int body) { return ok() ? impl_->nesting(body) : std::vector<int>{}; }

RayFace Oracle::rayFace(int face, Vec3 o, Vec3 d, Range tr) {
  if (!ok() || face < 0 || face >= impl_->model.faces()) {
    RayFace out;
    out.status = Status::invalidModel;
    return out;
  }
  return impl_->rayFace(face, o, d, tr);
}

} // namespace cadoracle
