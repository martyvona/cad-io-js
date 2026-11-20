// Integrals over faces on extrusions and revolutions by Green's theorem in (u, v): the integral of F du dv over the
// face is oint H du with dH/dv = -F. v isn't periodic on either but for a revolution of a closed profile, so H du is
// one form on the surface and a seam needs no term. The boundary is the face API's loops in (u, v) (cg_face_pieces:
// the face on each piece's left, its sense applied; p-curves given, else its projection, flagged), each loop
// unwrapped piece to piece by whole periods; a gap left between pieces (the face API closes loops along pole rows
// without a piece) is run straight in (u, v). v0, where H is zero, is on a pole where there is one, so the loop's run
// along that pole row (the way round it goes is ambiguous by a turn) adds nothing, and a face bounded by loops
// winding the angle and that pole needs no term for it; with a second pole, the same ambiguity there, and a winding
// face's pole being the other one, are multiples of the integral over the whole surface (reduced modulo it by the
// area's). With no pole, a face whose loops wind the angle is flagged. The area (area_swept.cpp) and other integrands
// (integral.cpp) differ only in H.
#pragma once

#include <functional>
#include <vector>

#include "oracle_impl.h"

namespace cadoracle {

/** A piece of a loop in (u, v): its coedge between p-curve parameters, the whole periods added to it. */
struct SweptPiece {
  int coedge, loop;
  double t0, t1;
  double ou = 0, ov = 0;
};

/** A face on an extrusion or revolution, as sweptIntegral takes it. */
struct SweptFace {
  int surface = -1;
  bool extrusion = false;
  /** The profile (the swept curve). */
  const Curve* C = nullptr;
  std::vector<SweptPiece> pieces;
  double Pu = 0, Pv = 0;
  /** Pole rows (v constant), the revolution's: the face API's, and a line profile's axis crossing it doesn't list. */
  std::vector<double> poleV;
  double windU = 0, windV = 0, v0 = 0;
  /** The face's size (its edges' vertices' box). */
  double size = 1;
  /** flagProjectedBoundary, flagWinds. */
  uint32_t flags = 0;
  /** Where the face can't be taken (static storage), with its status; empty when it can. */
  const char* why = "";
  Status status = Status::ok;
};

SweptFace sweptFace(Oracle::Impl& I, int face);

/** The totals of oint H du over the face's loops, K components: H(u, v, out). */
struct SweptTotals {
  std::vector<double> value, error;
  Status status = Status::ok;
  /** The loops' extent in u (for an error that enters every H). */
  double spanU = 0;
  /** A p-curve that couldn't be evaluated: the totals mean nothing. */
  bool failed = false;
};

SweptTotals sweptIntegral(Oracle::Impl& I, const SweptFace& face, int K,
  const std::function<void(double u, double v, double* out)>& H, const std::vector<double>& floor, double relTol);

} // namespace cadoracle
