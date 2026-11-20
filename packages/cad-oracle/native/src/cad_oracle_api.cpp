// The oracle's C API for the WebAssembly module (src/index.ts): a model by handle, its edges' lengths, its faces'
// measures and their polynomial moments in flat arrays of doubles. Status, method and flag codes are oracle.h's and
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

} // namespace

extern "C" {

/** The format's version of this API, for the TypeScript layer to check. */
int32_t co_api_version() { return 2; }

/**
 * The oracle of `size` bytes at `buffer` (from malloc; owned from now on, freed by co_model_free or here if it isn't
 * a model): its handle, or -1.
 */
int32_t co_model_new(uint8_t* buffer, uint32_t size, double relTol) {
  auto e = std::make_unique<Entry>();
  e->buffer = buffer;
  Options o;
  if (relTol > 0) o.relTol = relTol;
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
 * Face `face`'s measure into out[0..8]: area (value, error, status), perimeter (the same), method, flags, offSurface;
 * its `why` (a static string) into *why. 0, or -1 for a bad handle.
 */
int32_t co_face(int32_t h, int32_t face, double* out, const char** why) {
  Entry* e = entry(h);
  if (!e) return -1;
  FaceMeasure m = e->oracle->face(face);
  put(out, m.area), put(out + 3, m.perimeter);
  out[6] = static_cast<double>(m.method), out[7] = static_cast<double>(m.flags), out[8] = m.offSurface;
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

} // extern "C"
