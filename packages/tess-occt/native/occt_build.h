// The native builder's interface (occt_build.cpp): a part's cad-brep buffer as OCCT shapes, in millimetres.
#pragma once

#include <TopoDS_Shape.hxx>
#include <TopoDS_TShape.hxx>

#include <cstddef>
#include <cmath>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

struct BuiltPart
{
  TopoDS_Shape shape;
  // Each face's, edge's and loose point's source id, by the shape it was built as (a curve item's edges take the
  // curve's); those without one aren't in them.
  std::unordered_map<const TopoDS_TShape*, uint32_t> faceIds, edgeIds, pointIds;
  // What was left out (a face on a surface OCCT can't hold), said as warnings.
  std::vector<std::string> warnings;
  // Non-empty: the part wasn't built (a kind the builder doesn't do yet, decision 13), and why.
  std::string error;
  // Whether the part has face or surface items (a geometric set's: healing adds no natural bounds there, as the STEP
  // route's doesn't for a geometrically bounded surface representation).
  bool geometricSet = false;
  // The part's uncertainty (NaN without one).
  double uncertainty = NAN;
};

BuiltPart buildPart(const uint8_t* buf, size_t len);
