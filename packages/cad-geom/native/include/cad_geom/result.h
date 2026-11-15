// What every query in cad-geom returns besides its value: whether it succeeded, how sure it is, how accurate. No query
// hides an ambiguity or a failure in a single number (docs/own-tessellator.md, "Degenerate and ambiguous cases").
#pragma once

#include <cstdint>
#include <limits>

namespace cadgeom {

enum class Status : uint8_t {
  ok,
  /** The kind or case isn't handled (yet): not an error in the model. */
  unsupported,
  /** A parameter outside the curve's or surface's natural range. */
  outOfDomain,
  /** At a singular place (a pole, an apex, a zero normal or speed) where the quantity asked for is undefined. */
  singular,
  /** An iteration that didn't reach its tolerance; the value returned is the best found. */
  noConvergence,
  /** The model's rows don't make the geometry (a bad reference, a count that doesn't fit). */
  invalidModel,
};

/** How many answers a search found within its tolerance. */
enum class Certainty : uint8_t {
  /** One, separated from every other candidate by more than the tolerance. */
  unique,
  /** Several within the tolerance of the best: the result lists the others. */
  ambiguous,
  /** None (with `Status::ok`: e.g. no foot point inside the range asked). */
  none,
};

/** Where a value in the model or the analysis came from, so nothing computed passes for the source's. */
enum class Provenance : uint8_t { given = 0, measured = 1, healed = 2 };

/** A point against a region: inside, outside, or on its boundary within the tolerance. */
enum class Side : uint8_t { in, out, on };

/**
 * A computed real with an a posteriori estimate of its error: |value - exact| <= error is expected but not
 * guaranteed (the rigor decided for the project; guaranteed bounds are the Interval type's).
 */
struct Estimate {
  double value = std::numeric_limits<double>::quiet_NaN();
  double error = std::numeric_limits<double>::infinity();
  Status status = Status::unsupported;
};

/** A parameter interval, lo <= hi; infinite ends as +/-infinity. */
struct Range {
  double lo = 0, hi = 0;
};

} // namespace cadgeom
