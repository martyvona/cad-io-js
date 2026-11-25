// The oracle's C API for the WebAssembly module (src/index.ts): a model by handle, its edges' lengths, its faces'
// measures and their polynomial moments, points against its closed shells, faces' sides of them and its bodies'
// shells nested, in flat arrays of doubles. Status, method, flag, side and rejection codes are oracle.h's and
// result.h's.

#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <memory>
#include <vector>

#include "cad_geom/model.h"
#include "cad_oracle/oracle.h"

using namespace cadoracle;

namespace {

struct Entry {
  uint8_t* buffer;
  std::unique_ptr<Oracle> oracle;
  ~Entry() { std::free(buffer); }
};
std::vector<std::unique_ptr<Entry>> models;

Entry* entry(int32_t h) {
  return h >= 0 && h < static_cast<int32_t>(models.size()) ? models[h].get() : nullptr;
}

void put(double* o, const Estimate& e) {
  o[0] = e.value, o[1] = e.error, o[2] = static_cast<double>(e.status);
}

/** A PointClass into o[0..12]: side, dir (3), length, crossings, tried, rejected (rejectedKinds: 5), checked. */
void putClass(double* o, const PointClass& c) {
  o[0] = c.side, o[1] = c.dir.x, o[2] = c.dir.y, o[3] = c.dir.z, o[4] = c.length, o[5] = c.crossings, o[6] = c.tried;
  for (int k = 0; k < rejectedKinds; k++) o[7 + k] = c.rejected[k];
  o[12] = c.checked;
}

/** The flux integrand about c: (x - cx) n_x, (y - cy) n_y, (z - cz) n_z (co_face_flux, co_face_and_flux). */
Integrand fluxIntegrand(Vec3 c) {
  return {3, [c](Vec3 p, Vec3 nv, double* o) {
    const Vec3 d = p - c;
    o[0] = d.x * nv.x, o[1] = d.y * nv.y, o[2] = d.z * nv.z;
  }, {}};
}

} // namespace

extern "C" {

/** The format's version of this API, for the TypeScript layer to check. */
int32_t co_api_version() { return 6; }

/**
 * The oracle of `size` bytes at `buffer` (from malloc; owned from now on, freed by co_model_free or here if it isn't
 * a model), with its analysis's `analysisSize` bytes at `analysis` (Options::analysis; none: 0; read here, not kept,
 * the caller's to free), `flags` bit 1 for no projections (Options::projectMissing false), bit 2
 * Options::checkSecondRay: its handle, or -1.
 */
int32_t co_model_new(uint8_t* buffer, uint32_t size, double relTol, const uint8_t* analysis, uint32_t analysisSize,
  int32_t flags) {
  auto e = std::make_unique<Entry>();
  e->buffer = buffer;
  Options o;
  if (relTol > 0) o.relTol = relTol;
  o.checkSecondRay = (flags & 2) != 0;
  if (analysis && analysisSize) o.analysis = analysis, o.analysisSize = analysisSize;
  o.projectMissing = (flags & 1) == 0;
  e->oracle = std::make_unique<Oracle>(buffer, size, o);
  if (!e->oracle->ok()) return -1;
  for (size_t i = 0; i < models.size(); i++)
    if (!models[i]) {
      models[i] = std::move(e);
      return static_cast<int32_t>(i);
    }
  models.push_back(std::move(e));
  return static_cast<int32_t>(models.size() - 1);
}

void co_model_free(int32_t h) {
  if (entry(h)) models[h].reset();
}

/** Edge `edge`'s length into out[0..2] (value, error, status); 0, or -1 for a bad handle. */
int32_t co_edge_length(int32_t h, int32_t edge, double* out) {
  Entry* e = entry(h);
  if (!e) return -1;
  put(out, e->oracle->edgeLength(edge));
  return 0;
}

/**
 * Face `face`'s measure into out[0..9]: area (value, error, status), perimeter (the same), method, flags, offSurface,
 * boundary;
 * its `why` (a static string) into *why. 0, or -1 for a bad handle.
 */
int32_t co_face(int32_t h, int32_t face, double* out, const char** why) {
  Entry* e = entry(h);
  if (!e) return -1;
  FaceMeasure m = e->oracle->face(face);
  put(out, m.area), put(out + 3, m.perimeter);
  out[6] = static_cast<double>(m.method), out[7] = static_cast<double>(m.flags), out[8] = m.offSurface;
  out[9] = m.boundary;
  *why = m.why;
  return 0;
}

/** Monomials of degree at most this, at most (co_face_moments). */
constexpr int32_t kMaxMomentDegree = 4;

/**
 * Face `face`'s moments about (cx, cy, cz) (oracle.h's faceIntegral): the integral of (p - c)^(a, b, c) n_j for every
 * exponent of degree at most `degree` (by degree, then a, then b, both descending) and j = x, y, z, each into
 * out[3 (3 m + j) ..] as (value, error, status). 0, -1 for a bad handle, -2 for a degree past kMaxMomentDegree.
 */
int32_t co_face_moments(int32_t h, int32_t face, double cx, double cy, double cz, int32_t degree, double* out) {
  Entry* e = entry(h);
  if (!e) return -1;
  if (degree < 0 || degree > kMaxMomentDegree) return -2;
  std::vector<std::array<int, 3>> exps;
  for (int t = 0; t <= degree; t++)
    for (int a = t; a >= 0; a--)
      for (int b = t - a; b >= 0; b--) exps.push_back({a, b, t - a - b});
  const int n = static_cast<int>(exps.size());
  const Vec3 c{cx, cy, cz};
  Integrand g{3 * n, [&](Vec3 p, Vec3 nv, double* o) {
    const Vec3 d = p - c;
    for (int m = 0; m < n; m++) {
      const double w = std::pow(d.x, exps[m][0]) * std::pow(d.y, exps[m][1]) * std::pow(d.z, exps[m][2]);
      o[3 * m] = w * nv.x, o[3 * m + 1] = w * nv.y, o[3 * m + 2] = w * nv.z;
    }
  }, {}};
  const std::vector<Estimate> v = e->oracle->faceIntegral(face, g);
  for (int k = 0; k < 3 * n; k++) put(out + 3 * k, v[k]);
  return 0;
}

/**
 * Face `face`'s flux of p - c by components (oracle.h's faceIntegral): the integrals of (p - c)_j n_j for j = x, y, z,
 * into out[3 j ..] as (value, error, status); a closed shell's signed volume is their sum over its faces / 3. The same
 * three of co_face_moments' degree 1, but integrated alone (its other nine components set the quadrature's work).
 * 0, or -1 for a bad handle.
 */
int32_t co_face_flux(int32_t h, int32_t face, double cx, double cy, double cz, double* out) {
  Entry* e = entry(h);
  if (!e) return -1;
  const Integrand g = fluxIntegrand({cx, cy, cz});
  const std::vector<Estimate> v = e->oracle->faceIntegral(face, g);
  for (int k = 0; k < 3; k++) put(out + 3 * k, v[k]);
  return 0;
}

/**
 * co_face's measure into out[0..9], and where it comes with the area's pass (oracle.h's face with an integrand: a
 * free-form face) co_face_flux's components about (cx, cy, cz) into out[10..18], the same bits, out[19] 1; else
 * out[19] 0. Its `why` into *why. 0, or -1 for a bad handle.
 */
int32_t co_face_and_flux(int32_t h, int32_t face, double cx, double cy, double cz, double* out, const char** why) {
  Entry* e = entry(h);
  if (!e) return -1;
  const Integrand g = fluxIntegrand({cx, cy, cz});
  std::vector<Estimate> v;
  FaceMeasure m = e->oracle->face(face, g, v);
  put(out, m.area), put(out + 3, m.perimeter);
  out[6] = static_cast<double>(m.method), out[7] = static_cast<double>(m.flags), out[8] = m.offSurface;
  out[9] = m.boundary;
  out[19] = v.size() == 3 ? 1 : 0;
  for (int k = 0; k < 3 && out[19]; k++) put(out + 10 + 3 * k, v[k]);
  *why = m.why;
  return 0;
}

/** Point (px, py, pz) against closed shell `shell` (oracle.h's classify) into out[0..12] (putClass), its why. */
int32_t co_classify(int32_t h, int32_t shell, double px, double py, double pz, double* out, const char** why) {
  Entry* e = entry(h);
  if (!e) return -1;
  const PointClass c = e->oracle->classify(shell, {px, py, pz});
  putClass(out, c);
  *why = c.why;
  return 0;
}

/**
 * Face `face`'s side of closed shell `shell` (oracle.h's shellSide) into out[0..20]: side, from (3), point (3), eps,
 * then the point's classification (putClass) from out[8]; its why. 0, or -1 for a bad handle.
 */
int32_t co_shell_side(int32_t h, int32_t shell, int32_t face, double eps, double* out, const char** why) {
  Entry* e = entry(h);
  if (!e) return -1;
  const ShellSide s = e->oracle->shellSide(shell, face, eps);
  out[0] = s.side, out[1] = s.from.x, out[2] = s.from.y, out[3] = s.from.z, out[4] = s.point.x, out[5] = s.point.y;
  out[6] = s.point.z, out[7] = s.eps;
  putClass(out + 8, s.classified);
  *why = s.why;
  return 0;
}

/**
 * Body `body`'s shells nested (oracle.h's nesting) into out, at most `max` of them: their count (more than `max`:
 * call again with room), or -1 for a bad handle.
 */
int32_t co_nesting(int32_t h, int32_t body, int32_t* out, int32_t max) {
  Entry* e = entry(h);
  if (!e) return -1;
  const std::vector<int> n = e->oracle->nesting(body);
  for (int32_t i = 0; i < static_cast<int32_t>(n.size()) && i < max; i++) out[i] = n[i];
  return static_cast<int32_t>(n.size());
}

} // extern "C"
