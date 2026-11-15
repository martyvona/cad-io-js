// A read-only view of one part's B-rep buffer (packages/cad-brep/src/layout.ts, read through cad_brep.h): row counts
// and typed access to each table's columns and its pools. It copies nothing: the buffer must outlive the view and
// everything made from it (curves, surfaces). What a kind keeps in the pools: layout.ts's CURVE_LAYOUTS and
// SURFACE_LAYOUTS; the parameterizations: docs/brep-reference.md.
#pragma once

#include <cmath>
#include <cstddef>
#include <cstdint>

#include "cad_brep.h"
#include "result.h"
#include "vec.h"

namespace cadgeom {

class Model {
public:
  /** A view of `size` bytes at `buf` (8-byte aligned); `ok()` is false if it isn't a buffer of this format. */
  Model(const uint8_t* buf, size_t size) { ok_ = cbr_open(buf, size, views_) == 0; }
  bool ok() const { return ok_; }

  /** Rows of a table, by any of its columns (CBR_CURVE_KIND for curves, ...). */
  int rows(cbr_column column, int width = 1) const { return static_cast<int>(views_[column].count) / width; }
  int curves() const { return rows(CBR_CURVE_KIND); }
  int surfaces() const { return rows(CBR_SURFACE_KIND); }
  int vertices() const { return rows(CBR_VERTEX_ID); }
  int edges() const { return rows(CBR_EDGE_ID); }
  int coedges() const { return rows(CBR_COEDGE_ID); }
  int loops() const { return rows(CBR_LOOP_ID); }
  int faces() const { return rows(CBR_FACE_ID); }

  const uint8_t* u8(cbr_column c) const { return CBR_U8(views_[c]); }
  const int32_t* i32(cbr_column c) const { return CBR_I32(views_[c]); }
  const uint32_t* u32(cbr_column c) const { return CBR_U32(views_[c]); }
  const double* f64(cbr_column c) const { return CBR_F64(views_[c]); }
  /** Elements in a column (rows times width): the pools' sizes, for bounds checks. */
  uint32_t count(cbr_column c) const { return views_[c].count; }

  double uncertainty() const { return count(CBR_PART_UNCERTAINTY) ? f64(CBR_PART_UNCERTAINTY)[0] : NAN; }

  int curveKind(int i) const { return u8(CBR_CURVE_KIND)[i]; }
  int curveDim(int i) const { return u8(CBR_CURVE_DIM)[i]; }
  /** A curve's reals and ints in the pools (pointers to its first; its kind says how many). */
  const double* curveReals(int i) const { return f64(CBR_POOL_CURVE_REAL) + i32(CBR_CURVE_REAL)[i]; }
  const int32_t* curveInts(int i) const { return i32(CBR_POOL_CURVE_INT) + i32(CBR_CURVE_INT)[i]; }
  int surfaceKind(int i) const { return u8(CBR_SURFACE_KIND)[i]; }
  const double* surfaceReals(int i) const { return f64(CBR_POOL_SURFACE_REAL) + i32(CBR_SURFACE_REAL)[i]; }
  const int32_t* surfaceInts(int i) const { return i32(CBR_POOL_SURFACE_INT) + i32(CBR_SURFACE_INT)[i]; }

  Vec3 vertexPoint(int i) const {
    const double* p = f64(CBR_VERTEX_POINT) + 3 * i;
    return {p[0], p[1], p[2]};
  }
  int edgeCurve(int i) const { return i32(CBR_EDGE_CURVE)[i]; }
  int edgeStart(int i) const { return i32(CBR_EDGE_START)[i]; }
  int edgeEnd(int i) const { return i32(CBR_EDGE_END)[i]; }
  bool edgeSameSense(int i) const { return u8(CBR_EDGE_SAME_SENSE)[i] != 0; }
  /** The edge's curve parameters at start and end (NaN both where the source doesn't give them). */
  Range edgeRange(int i) const { return {f64(CBR_EDGE_RANGE)[2 * i], f64(CBR_EDGE_RANGE)[2 * i + 1]}; }
  int coedgeEdge(int i) const { return i32(CBR_COEDGE_EDGE)[i]; }
  int coedgeOrientation(int i) const { return u8(CBR_COEDGE_ORIENTATION)[i]; }
  int coedgePcurve(int i) const { return i32(CBR_COEDGE_PCURVE)[i]; }
  int loopKind(int i) const { return u8(CBR_LOOP_KIND)[i]; }
  int loopFirst(int i) const { return i32(CBR_LOOP_FIRST)[i]; }
  int loopCount(int i) const { return i32(CBR_LOOP_COUNT)[i]; }
  int faceSurface(int i) const { return i32(CBR_FACE_SURFACE)[i]; }
  bool faceSameSense(int i) const { return u8(CBR_FACE_SAME_SENSE)[i] != 0; }
  int faceFirstLoop(int i) const { return i32(CBR_FACE_FIRST_LOOP)[i]; }
  int faceLoopCount(int i) const { return i32(CBR_FACE_LOOP_COUNT)[i]; }

private:
  cbr_view views_[CBR_COLUMN_COUNT] = {};
  bool ok_ = false;
};

} // namespace cadgeom
