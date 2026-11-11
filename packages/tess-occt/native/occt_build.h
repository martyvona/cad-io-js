// The native builder's interface (occt_build.cpp): a part's cad-brep buffer as OCCT shapes, in the part's unit.
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
  // Each face's and edge's source id, by the shape it was built as.
  std::unordered_map<const TopoDS_TShape*, int> faceIds, edgeIds;
  // What was left out (a face on a surface OCCT can't hold), said as warnings.
  std::vector<std::string> warnings;
  // Non-empty: the part wasn't built (a kind the builder doesn't do yet, decision 13), and why.
  std::string error;
  // Millimetres per unit; the part's uncertainty (NaN without one).
  double unit = 1.0, uncertainty = NAN;
};

BuiltPart buildPart(const uint8_t* buf, size_t len);
