// The oracle's C API for the WebAssembly module (src/index.ts): a model by handle, its edges' lengths and its faces'
// measures in flat arrays of doubles. Status, method and flag codes are oracle.h's and result.h's.

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
int32_t co_api_version() { return 1; }

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

} // extern "C"
