// Small fixed-size vectors for the interfaces between cad-geom's pieces: plain doubles, trivially copyable, so results
// cross module and language boundaries as they are. Implementations may use Eigen inside; interfaces use these.
#pragma once

#include <cmath>

namespace cadgeom {

struct Vec2 {
  double x = 0, y = 0;
};

struct Vec3 {
  double x = 0, y = 0, z = 0;
};

inline Vec2 operator+(Vec2 a, Vec2 b) { return {a.x + b.x, a.y + b.y}; }
inline Vec2 operator-(Vec2 a, Vec2 b) { return {a.x - b.x, a.y - b.y}; }
inline Vec2 operator-(Vec2 a) { return {-a.x, -a.y}; }
inline Vec2 operator*(double s, Vec2 a) { return {s * a.x, s * a.y}; }
inline Vec2 operator*(Vec2 a, double s) { return {s * a.x, s * a.y}; }
inline double dot(Vec2 a, Vec2 b) { return a.x * b.x + a.y * b.y; }
/** The z component of a x b: positive where b is counterclockwise of a. */
inline double cross(Vec2 a, Vec2 b) { return a.x * b.y - a.y * b.x; }
inline double norm(Vec2 a) { return std::hypot(a.x, a.y); }

inline Vec3 operator+(Vec3 a, Vec3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline Vec3 operator-(Vec3 a, Vec3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline Vec3 operator-(Vec3 a) { return {-a.x, -a.y, -a.z}; }
inline Vec3 operator*(double s, Vec3 a) { return {s * a.x, s * a.y, s * a.z}; }
inline Vec3 operator*(Vec3 a, double s) { return {s * a.x, s * a.y, s * a.z}; }
inline double dot(Vec3 a, Vec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline Vec3 cross(Vec3 a, Vec3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
inline double norm(Vec3 a) { return std::sqrt(a.x * a.x + a.y * a.y + a.z * a.z); }

} // namespace cadgeom
