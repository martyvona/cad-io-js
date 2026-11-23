// What the oracle's sources share: the model's views (cad-geom's Model, and a face API handle on its own copy), the
// curves and surfaces made once per row, and each edge's parameters. Not part of the contract (oracle.h).
#pragma once

#include <memory>
#include <vector>

#include "cad_geom/curve.h"
#include "cad_geom/model.h"
#include "cad_geom/surface.h"
#include "cad_geom/tolerance.h"
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
  /** The face API's tolerances (tolerance.h): a face's surface closes in fact at its face's. */
  const cadgeom::Tolerances tols;
  const Options options;
  /** The face API's handle (cg_model_new), -1 where the model didn't open. */
  int32_t h = -1;
  /** Faces that are items in no shell (loose), by row. */
  std::vector<bool> loose;
  /** Per coedge, its p-curve's deviation where healing made it (the analysis's), else NaN (measured when asked). */
  std::vector<double> healedDeviation;

  /** The curve at a row, made once; null where it can't be (status in curveStatus). */
  const Curve* curve(int row);
  /** The edge's parameters at its start and end as the face API takes them; false where there are none. */
  bool edgeParams(int edge, double& t0, double& t1);
  /** The edge's length between them (oracle.h's edgeLength). */
  Estimate edgeLength(int edge);
  /** The face's perimeter: its edge loops' coedges' edges' lengths summed. */
  Estimate perimeter(int face);
  /**
   * FaceMeasure::boundary of a face: its uses' p-curves' deviations (the face API's loops: swept and free-form
   * faces) and its edges' vertex gaps; with `closedForm`, the gaps alone (integrated along the 3D curves).
   */
  double boundary(int face, bool closedForm = false);
  /** The larger distance of an edge's vertices from its curve's ends (its edgeParams' points); NaN where unknown. */
  double vertexGap(int edge);
  /** A given p-curve's deviation from its edge's curve, by its own parameter along the use (oracle.h's
   * FaceMeasure::boundary); NaN where it can't be had. */
  double pcurveDeviation(int face, int coedge);

  FaceMeasure closedForm(int face);
  FaceMeasure swept(int face);
  FaceMeasure freeForm(int face);
  /** faceIntegral (oracle.h), on the faces closedForm, swept and freeForm measure. */
  std::vector<Estimate> integral(int face, const Integrand& g);
  /** The face's surface as the face API closes it in fact (at its tolerance), made once; null where it can't be. */
  const Surface* faceSurface(int face);
  /** rayFace (oracle.h). */
  RayFace rayFace(int face, Vec3 o, Vec3 d, Range tr);
  /** classify, shellSide, nesting (oracle.h). */
  PointClass classify(int shell, Vec3 p);
  ShellSide shellSide(int shell, int face, double eps);
  std::vector<int> nesting(int body);
  /** A shell's faces (its face uses' faces), and a box holding them (vertices, edges' curves, finite surfaces). */
  std::vector<int> shellFaces(int shell) const;
  bool shellBox(int shell, Vec3& lo, Vec3& hi);
  /**
   * A point well inside the face: of a grid over its loops' (u, v) box (its surface's domain where it has none), the
   * one nearest the box's middle that the face API classifies in at 100 times the face's tolerance, else at 10 times;
   * false where none is.
   */
  bool interiorPoint(int face, cadgeom::Vec2& uv, Vec3& p, Vec3& n);
  /** Per face, 1 where its measure is flagged orientation, 0 where not, 2 not yet measured (Oracle::shellSide's). */
  std::vector<uint8_t> loopsAgainst;
  /** interiorPoint's grid over a (u, v) box. */
  bool gridPoint(int face, const Surface& surface, double ulo, double uhi, double vlo, double vhi, cadgeom::Vec2& uv,
    Vec3& p, Vec3& n);

private:
  std::vector<std::unique_ptr<Surface>> faceSurfaces_;
  std::vector<uint8_t> faceSurfaceMade_;
  std::vector<std::unique_ptr<Curve>> curves_;
  std::vector<uint8_t> made_;
  std::vector<Estimate> lengths_;
  std::vector<uint8_t> lengths_done_;
};

/** Status codes the face API returns beyond result.h's Status, as one phrase (FaceMeasure::why). */
const char* faceStatusWhy(int32_t code);

} // namespace cadoracle
