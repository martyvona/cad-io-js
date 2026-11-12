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
  // The face rows given to SMLib: healing removes some (slivers), which then have no SMLib face.
  std::vector<int> rows;
  // The B-rep's lengths are the model's times this; the transform brings its meshes back to the part's size.
  double scale = 1;
  // The placed item it is of (each placement of an item through instances its own; a closed shell one of its own):
  // the B-reps of one, each open shell of a body; their faces' meshes are joined along the edges they share.
  int group = 0;
};

// Edge kinds, as the wrapper reports them; an SMLib edge's SM_AI_EDGE_ID attribute is (edge row + 1) x 4 + kind.
enum { EDGE_SHARED = 0, EDGE_SEAM = 1, EDGE_FREE = 2, EDGE_DEGENERATE = 3 };

struct BuiltPart
{
  std::vector<BuiltBrep> breps;
  // Each face row's and edge row's source id (0: none), by row; SMLib's edges carry their edge row + 1 as user
  // index 1.
  std::vector<uint32_t> faceIds, edgeIds;
  // Each edge row's uses by faces' loops: the face rows, one for each use.
  std::vector<std::vector<int>> edgeFaces;
  // Wireframe curves (curve items, wire bodies' edges) as polylines with their ids (0: none), and loose points (one
  // point each), each with its item's transform (12 reals, or none).
  struct Polyline
  {
    uint32_t id;
    std::vector<double> points; // x, y, z, ...
    std::vector<double> transform;
  };
  std::vector<Polyline> curves, points;
  // What was left out or approximated, said as warnings.
  std::vector<std::string> warnings;
  // Non-empty: the part wasn't built, and why.
  std::string error;
  ~BuiltPart();
};

// Whether to run SMLib's healer on each B-rep made (MakeTopologyFromData's), and the meshing's deflections.
struct BuildOptions
{
  bool heal = true;
  // In the part's unit and radians: wireframes' sampling (curve items, wire bodies' edges), and the linear one decides
  // which surfaces are too large to give SMLib whole (smlib_build.cpp, elementary).
  double linearDeflection = 0.1, angularDeflection = 0.5;
};

// scale: the model built with its lengths times this (SMLib has absolute constants; 1 or more, as SMLib traps
// on parts made small), the options' linear deflection too; what's built is brought back to the part's size by its
// transforms.
void buildPart(const uint8_t* buf, size_t len, const BuildOptions& options, double scale, BuiltPart& out);

// Faces (rows) of a part, each alone in its own B-rep at the transform given (a retry for faces that meshed badly in
// their shell), the transform from the model's own coordinates; scale as buildPart's.
void buildFaces(const uint8_t* buf, size_t len, const std::vector<int>& faces, const std::vector<double>& transform,
  const BuildOptions& options, double scale, BuiltPart& out);
