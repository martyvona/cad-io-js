// The 3D tolerances a part's geometry is judged by, the one rule the face API (cad_geom_api.cpp) and the tessellator
// (tess-cadio) share: an edge's or a face's is the largest of the part's uncertainty (1e-5 mm where it gives none),
// its own tolerance, and a floor of 1e-9 times the part's size (its vertices' box diagonal), so a gap at rounding
// level is within it. A gap above them stays one (healing's to grow).
#pragma once

#include "model.h"

namespace cadgeom {

class Tolerances {
public:
  /** The model's floor and part tolerance, worked out once (its vertices read); the model must outlive this. */
  explicit Tolerances(const Model& m);
  /** 1e-9 times the part's size (0 without vertices). */
  double floor() const { return floor_; }
  /** The larger of the part's uncertainty (else 1e-5) and the floor. */
  double part() const { return part_; }
  /** The face's: the part's, widened by the face's own tolerance. */
  double face(int f) const { return widen(m_.f64(CBR_FACE_TOLERANCE)[f]); }
  /** The edge's: the part's, widened by the edge's own tolerance. */
  double edge(int e) const { return widen(m_.f64(CBR_EDGE_TOLERANCE)[e]); }

private:
  double widen(double t) const { return std::isfinite(t) && t > part_ ? t : part_; }
  const Model& m_;
  double floor_ = 0, part_ = 0;
};

} // namespace cadgeom
