// Integrals over faces on the other surfaces cad-geom evaluates (B-splines, offsets, rectangular trims) by Green's
// theorem in (u, v) with H numeric (inner.h): the integral of F du dv over the face is oint H du, dH/dv = -F, taken in
// a frame (a, t) of the surface's parameters: a the outer direction, t = (b - b0) dir along the inner one, b u where
// only v is periodic (so the inner integral runs along a direction that isn't, and H du is one form on the surface),
// else v. The boundary is the face API's loops (cg_face_pieces, unwrapped as swept.h's), a gap between pieces (a pole
// row the face API closes loops along) run straight in (u, v). b0, where H is zero:
// - a pole row the face holds: the one on the face's side of loops winding a (their net winding says which), so its
//   own term vanishes, as swept.h's (a joint along a pole row the face API's loops close is run the shorter way round,
//   right where it's under half a turn; past that, the unwrapped loop winds a instead);
// - else the face's lowest b, so H's strips from b0 to the boundary stay within the face's extent in b;
// - where both directions are periodic, a cut: a row in the largest gap of the loops' b, near its top (just below the
//   face there, so the strips stay short), the loops unwrapped across it. H then jumps by the whole period's inner
//   integral W(a) where a loop crosses the cut, so each crossing ends a piece of the loop (H on either side from the
//   cut's own copy) and the cut's stretches inside the face add the integral of W along them, as the top edge of the
//   face cut open.
// Where two poles close the inner direction, or both directions are periodic, the result is known modulo the integral
// over the whole surface (the joints along the far pole's row, or the cut's stretches, being ambiguous by a turn),
// reduced by the area's as swept.h's. The surface must be sound on H's strips: where an evaluation there is singular or
// an offset folds (its normal against its basis's), the inner direction is cut into bands, each band's H from its own
// bottom row, its top row taken as the cut's (a row's stretches inside the face, by its crossings with the loops, or
// the face API's classification where a periodic row has none), doubling the bands until the strips are sound
// (flagCells). The area (Oracle::Impl::freeForm) and other integrands (integral.cpp) differ only in F.
#pragma once

#include <array>
#include <cmath>
#include <functional>
#include <vector>

#include "inner.h"
#include "oracle_impl.h"

namespace cadoracle {

/** freeIntegral's totals: the face's integral per component (its loops' sense applied), what it measured. */
struct FreeTotals {
  std::vector<double> value, error;
  Status status = Status::ok;
  /**
   * flagProjectedBoundary, flagWinds, flagSphereSide, flagCells, flagOffSurface; flagNoLoops where nothing bounds an
   * open surface.
   */
  uint32_t flags = 0;
  /**
   * The largest distance of the surface at a coedge's ends (its pieces' first start and last end) from its edge's
   * vertices, over the loops' size: a p-curve, or a projection, that doesn't reach the edge's ends; NaN without
   * vertices.
   */
  double offSurface = NAN;
  /** Where the face can't be taken (static storage); empty when it can. */
  const char* why = "";
};

/**
 * The integral of f over the face, K components: f(p, n, out) at the surface's point p with n = S_u x S_v (the
 * surface's, the face's sense not applied); component `area` is |n|, which says the multiple of the whole surface's
 * integral where the result is known modulo it. floorFor(in, samples) gives each component's floor (inner.h's floors;
 * the samples (a, t0, t), in.P their points).
 */
FreeTotals freeIntegral(Oracle::Impl& I, int face, int K, int area,
  const std::function<void(Vec3 p, Vec3 n, double* out)>& f,
  const std::function<std::vector<double>(const Inner& in, const std::vector<std::array<double, 3>>& samples)>&
    floorFor,
  double relTol);

/**
 * freeIntegral of faceIntegral's integrand g (oracle.h) on a free-form face: g's k components at the face's sense, the
 * area |n| riding along as component k. faceIntegral's results on such a face are freeEstimates of it, and
 * Oracle::face(f, g, ...)'s area is its component k, so the two agree to the bit.
 */
FreeTotals freeWith(Oracle::Impl& I, int face, const Integrand& g);

/** g's k components as faceIntegral gives them from freeWith's totals (failed ones NaN, at the totals' status). */
std::vector<Estimate> freeEstimates(const FreeTotals& T, int k);

} // namespace cadoracle
