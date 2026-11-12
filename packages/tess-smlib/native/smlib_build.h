// The builder's interface (smlib_build.cpp): a part's cad-brep buffer (cad_brep.h) as SMLib B-reps, in the part's unit.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <unordered_set>
#include <vector>

class SmBrep;
class SmFace;

// One SMLib B-rep made from the model: a shell of a body, a face or surface item, or a face of no loops (its own
// SmBrep, made from its surface's extent). Its faces carry their face row + 1 as user index 1 (0: none).
struct BuiltBrep
{
  SmBrep* brep = nullptr;
  // The faces whose triangles (SMLib winds them about its surface's normal) must be turned over to face along the
  // model face's normal; known after healing, which may turn faces over.
  std::unordered_set<const SmFace*> reverse;
  // The item's transform (12 reals, column-major x, y, z, then t), applied to the mesh; empty for none.
  std::vector<double> transform;
};

// Edge kinds, as the wrapper reports them; an SMLib edge's SM_AI_EDGE_ID attribute is (edge row + 1) x 4 + kind.
enum { EDGE_SHARED = 0, EDGE_SEAM = 1, EDGE_FREE = 2, EDGE_DEGENERATE = 3 };

struct BuiltPart
{
  std::vector<BuiltBrep> breps;
  // Each face row's and edge row's source id (NaN: none), by row; SMLib's edges carry their edge row + 1 as user
  // index 1.
  std::vector<double> faceIds, edgeIds;
  // Wireframe curves (curve items, wire bodies' edges) as polylines with their ids (NaN: none), and loose points (one
  // point each), each with its item's transform (12 reals, or none).
  struct Polyline
  {
    double id;
    std::vector<double> points; // x, y, z, ...
    std::vector<double> transform;
  };
  std::vector<Polyline> curves, points;
  // What was left out or approximated, said as warnings.
  std::vector<std::string> warnings;
  // Non-empty: the part wasn't built, and why.
  std::string error;
  // Millimetres per unit; the part's uncertainty (NaN without one).
  double unit = 1.0, uncertainty = 0.0 / 0.0;
  ~BuiltPart();
};

// Whether to run SMLib's healer on each B-rep made (MakeTopologyFromData's), and the zone tolerance to build at when
// the part has no uncertainty.
struct BuildOptions
{
  bool heal = true;
  // Wireframes' sampling (curve items, wire bodies' edges), in the part's unit and radians.
  double linearDeflection = 0.1, angularDeflection = 0.5;
};

void buildPart(const uint8_t* buf, size_t len, const BuildOptions& options, BuiltPart& out);

// Faces (rows) of a part, each alone in its own B-rep at the transform given (a retry for faces that meshed badly in
// their shell), unhealed.
void buildFaces(const uint8_t* buf, size_t len, const std::vector<int>& faces, const std::vector<double>& transform,
  BuiltPart& out);
