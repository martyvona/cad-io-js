// The parts of cad-geom's C API (packages/cad-geom/native/src/cad_geom_api.cpp, linked from libcadgeom.a) the oracle
// calls: the face API's edge parameters, loops in (u, v) and classification against them, so the oracle takes edges and
// p-curves exactly as every other consumer of the face API does. A handle owns its own copy of the model's bytes.
// Declared here, not included: cad-geom keeps its C API in that one source file; a signature changed there must change
// here.
#pragma once

#include <cstdint>

extern "C" {
int32_t cg_model_new(uint8_t* buffer, uint32_t size);
int32_t cg_model_options(int32_t h, int32_t flags);
void cg_model_free(int32_t h);
double* cg_scratch();
int32_t cg_edge_params(int32_t h, int32_t edge, double* out);
int32_t cg_face_info(int32_t h, int32_t face, double tol3d, double* out);
int32_t cg_face_pieces(int32_t h, int32_t face);
int32_t cg_face_classify(int32_t h, int32_t face, const double* uv, int32_t n, double tol3d, uint8_t* sides,
  uint8_t* status, double* tolUv);
int32_t cg_coedge_breaks(int32_t h, int32_t coedge, double lo, double hi);
int32_t cg_coedge_eval(int32_t h, int32_t coedge, const double* t, int32_t n, int32_t order, double* out,
  uint8_t* status);
int32_t cg_coedge_project(int32_t h, int32_t coedge, double tol, const double* t, int32_t n);
int32_t cg_surface_info(int32_t h, int32_t row, double* out);
int32_t cg_face_eval(int32_t h, int32_t face, const double* uv, int32_t n, int32_t order, double* out,
  uint8_t* status);
}
