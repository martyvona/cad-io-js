// What the oracle's sources share: the model's views (cad-geom's Model, and a face API handle on its own copy), the
// curves and surfaces made once per row, and each edge's parameters. Not part of the contract (oracle.h).
#pragma once

#include <memory>
#include <vector>

#include "cad_geom/curve.h"
#include "cad_geom/model.h"
#include "cad_geom/surface.h"
#include "cad_oracle/oracle.h"

namespace cadoracle {

using cadgeom::Curve;
using cadgeom::Model;
using cadgeom::Range;
using cadgeom::Surface;

struct Oracle::Impl {
  Impl(const uint8_t* buf, size_t size, Options options);
  ~Impl();

  const Model model;
  const Options options;
  /** The face API's handle (cg_model_new), -1 where the model didn't open. */
  int32_t h = -1;
  /** Faces that are items in no shell (loose), by row. */
  std::vector<bool> loose;

  /** The curve at a row, made once; null where it can't be (status in curveStatus). */
  const Curve* curve(int row);
  /** The edge's parameters at its start and end as the face API takes them; false where there are none. */
  bool edgeParams(int edge, double& t0, double& t1);
  /** The edge's length between them (oracle.h's edgeLength). */
  Estimate edgeLength(int edge);
  /** The face's perimeter: its edge loops' coedges' edges' lengths summed. */
  Estimate perimeter(int face);

  FaceMeasure closedForm(int face);
  FaceMeasure swept(int face);

private:
  std::vector<std::unique_ptr<Curve>> curves_;
  std::vector<uint8_t> made_;
  std::vector<Estimate> lengths_;
  std::vector<uint8_t> lengths_done_;
};

/** Status codes the face API returns beyond result.h's Status, as one phrase (FaceMeasure::why). */
const char* faceStatusWhy(int32_t code);

} // namespace cadoracle
