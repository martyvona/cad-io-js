// The constrained Delaunay triangulation under mesh2d.cpp: triangles with their neighbours in flat arrays, ghost
// triangles closing the convex hull (one vertex the ghost, kGhost), Bowyer-Watson insertion, segment recovery by
// cavity retriangulation, and in/out labels by parity across the domain's boundary. Private to tess-cadio.
// Sources: Guibas and Stolfi's and Lawson's incremental Delaunay triangulation, in Bowyer's and Watson's cavity form
// with ghost triangles as Shewchuk's lecture notes and "Delaunay Refinement Algorithms for Triangular Mesh
// Generation" (Computational Geometry 22, 2002) describe them; segment insertion by retriangulating the two
// pseudo-polygons the segment cuts (Anglada, "An improved incremental algorithm for constructing restricted Delaunay
// triangulations", Computers & Graphics 21, 1997; Shewchuk and Brown, "Fast segment insertion and incremental
// construction of constrained Delaunay triangulations", Computational Geometry 48, 2015); exact ties broken by
// simulation of simplicity (Edelsbrunner and Muecke, ACM Transactions on Graphics 9, 1990) on the lifting map,
// each point's perturbation ranked by its place in the insertion order.
#pragma once

#include <cstdint>
#include <utility>
#include <vector>

#include "cad_geom/vec.h"

namespace tesscadio {
namespace cdt {

using cadgeom::Vec2;

/**
 * A linear map L with M = L^T L (a metric's Cholesky factor): refinement's cavities are Delaunay in the inserted
 * point's metric, the incircle test run on points mapped by L (Borouchaki, George et al., mesh2d.cpp). Identity: none.
 */
struct Map2 {
  double l11 = 1, l12 = 0, l22 = 1;
  Vec2 operator()(Vec2 p) const { return {l11 * p.x + l12 * p.y, l22 * p.y}; }
};

/** The ghost vertex: a triangle holding it is outside the convex hull. */
constexpr int32_t kGhost = -1;

/** Edge flags: a domain loop's segment (parity changes across it) or an interior segment (it doesn't). */
enum : uint8_t { kFree = 0, kBoundary = 1, kInterior = 2 };

struct Tri {
  /** Counterclockwise (a ghost triangle's two real vertices run along the hull clockwise, seen from inside). */
  int32_t v[3];
  /** n[i] the triangle across the edge opposite v[i] (from v[i+1] to v[i+2]). */
  int32_t n[3];
  /** c[i] the flags of that edge. */
  uint8_t c[3];
  bool dead = false;
  /** Inside the domain (after label()); refinement never enters a triangle outside it. */
  bool inside = true;
  /** Bumped whenever the triangle is replaced, so queued references to it can be told stale. */
  uint32_t gen = 0;
};

/**
 * Indices of the finite points along a Morton curve over their box: consecutive ones close in the plane, so a walk
 * from the last one's triangle to the next (Triangulation::locate) takes a few steps where the given order (a
 * refinement's, by its queue) would cross the mesh each time.
 */
std::vector<int32_t> mortonOrder(const std::vector<Vec2>& points);

class Triangulation {
public:
  /** The points, in the order they will be indexed; rank[i] is point i's simulation-of-simplicity priority. */
  explicit Triangulation(std::vector<Vec2> points);

  /**
   * Inserts every point given so far in a fixed pseudorandom order (biased by blocks for locality). False if the
   * points are all collinear or two coincide (`duplicate` names a pair then).
   */
  bool build(int32_t duplicate[2]);

  /**
   * Makes the segment (a, b) an edge of the triangulation with these flags. False where it can't be without
   * splitting: it crosses a constrained edge (`other` names it as a point pair) or passes through a vertex
   * (`other` holds that vertex and -1).
   */
  bool insertSegment(int32_t a, int32_t b, uint8_t flags, int32_t other[2]);

  /** Labels triangles inside or outside the domain: outside from the ghosts, flipping across each boundary edge. */
  void label();

  /**
   * Inserts a new point p into the triangle t's region (t must hold p inside or on it), the cavity bounded by
   * constrained edges and never entering triangles outside the domain; its index, or -1 if p coincides with a
   * vertex. `created` receives the new triangles.
   */
  int32_t insertPoint(Vec2 p, int32_t t, std::vector<int32_t>& created, const Map2& map = {});

  /**
   * The constrained edges (point pairs) on the boundary of the cavity a point at p would open from t (as insertPoint
   * would, ties counted outside): what p would encroach on, before it's inserted. Returns the cavity's triangles.
   */
  size_t cavityConstraints(Vec2 p, int32_t t, std::vector<std::pair<int32_t, int32_t>>& out, const Map2& map = {})
    const;

  /** A triangle holding p (inside or on it), walking from `hint`; a ghost triangle if p is outside the hull. */
  int32_t locate(Vec2 p, int32_t hint) const;

  /**
   * The first constrained edge (a point pair) the segment from `from`, inside or on triangle t, to `to` crosses or
   * touches, walking straight from t; false if it reaches `to` without one.
   */
  bool firstConstraint(Vec2 from, Vec2 to, int32_t t, std::pair<int32_t, int32_t>& out) const;

  // Predicates with ties broken by simulation of simplicity.
  /** orient2d's sign, exact zero kept (collinearity is a fact the callers act on). */
  int orient(int32_t a, int32_t b, int32_t c) const;
  int orient(int32_t a, int32_t b, Vec2 c) const;
  /** Whether point d is inside the circumcircle of triangle t (a ghost's: its open half-plane and its edge). */
  bool inCircle(int32_t t, int32_t d) const;
  bool inCircle(int32_t t, Vec2 d) const;
  /** incircle(a, b, c, d) > 0 with exact ties broken by the points' ranks (never 0 for distinct points). */
  bool inCircleSoS(int32_t a, int32_t b, int32_t c, int32_t d) const;

  const std::vector<Vec2>& points() const { return pts_; }
  const std::vector<Tri>& tris() const { return tris_; }
  std::vector<Tri>& tris() { return tris_; }
  bool isGhost(int32_t t) const { return tris_[t].v[2] == kGhost; }  // (newTri keeps a ghost's ghost last)
  /** The edge (triangle, index) from a to b if one exists, else {-1, -1}. */
  std::pair<int32_t, int> findEdge(int32_t a, int32_t b) const;

private:
  int32_t newTri(int32_t a, int32_t b, int32_t c);
  void kill(int32_t t);
  /** Links the new triangles to each other and to the cavity's surroundings, by their directed edges. */
  void link(const std::vector<int32_t>& created, const std::vector<std::pair<int32_t, int>>& outside);
  /** A triangle with vertex v (kept per vertex, refreshed lazily). */
  int32_t triOf(int32_t v) const;
  void retriangulate(int32_t a, int32_t b, const std::vector<int32_t>& chain, std::vector<int32_t>& created);
  /**
   * The cavity of a point at p from t in the metric `map` (the triangles whose mapped circumcircle holds mapped p,
   * bounded by constrained edges and the outside), then shrunk until every boundary edge is visible from p, so the
   * new triangles are counterclockwise: the cavity, and its boundary edges as (outside triangle, its edge index).
   */
  void cavity(Vec2 p, int32_t t, const Map2& map, std::vector<int32_t>& cav,
    std::vector<std::pair<int32_t, int>>& outside, std::vector<std::pair<int32_t, int32_t>>& bnd) const;

  /** A fresh stamp for marking triangles in one operation (mark_[t] == stamp: marked), not a cleared array each. */
  uint32_t fresh() const;

  mutable std::vector<uint32_t> mark_;
  mutable uint32_t stamp_ = 0;
  std::vector<Vec2> pts_;
  std::vector<uint32_t> rank_;
  std::vector<Tri> tris_;
  std::vector<int32_t> free_;
  mutable std::vector<int32_t> vtri_;
  int32_t last_ = 0;
};

} // namespace cdt
} // namespace tesscadio
