// The oracle against the reference shapes' facts (packages/cad-brep/test/reference: closed-form lengths and areas,
// each shape at every variant: scaled from 1e-3 to 1e6, mirrored, moved, far from the origin), and its flags on
// models changed to have each defect.

#include <cmath>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "../src/geom_api.h"
#include "brep_models.h"
#include "cad_geom/model.h"
#include "cad_oracle/oracle.h"
#include "check.h"

using namespace cadoracle;
using cadgeom::Model;

namespace {

/** A value within the fact's tolerance, or within 10 times the oracle's own error estimate. */
bool agrees(const Estimate& got, double expected, double tol, double abs) {
  const double d = std::fabs(got.value - expected);
  return d <= std::fmax(tol * std::fabs(expected), abs) || d <= 10 * got.error;
}

bool closedFormKind(int k) {
  return k == CBR_SURFACE_PLANE || k == CBR_SURFACE_CYLINDER || k == CBR_SURFACE_CONE || k == CBR_SURFACE_SPHERE ||
    k == CBR_SURFACE_TORUS;
}
bool sweptKind(int k) { return k == CBR_SURFACE_EXTRUSION || k == CBR_SURFACE_REVOLUTION; }
bool freeKind(int k) {
  return k == CBR_SURFACE_BSPLINE || k == CBR_SURFACE_OFFSET || k == CBR_SURFACE_RECTANGULAR_TRIMMED;
}

/** A writable copy of a reference's buffer (8-byte aligned). */
struct Copy {
  std::vector<double> words;
  explicit Copy(const fixtures::Reference& r) : words((r.size + 7) / 8) { std::memcpy(words.data(), r.data, r.size); }
  uint8_t* bytes() { return reinterpret_cast<uint8_t*>(words.data()); }
  /** The byte offset of a column's data in the buffer, from a view of the original. */
  template <class T> T* at(const fixtures::Reference& r, const T* inOriginal) {
    return reinterpret_cast<T*>(bytes() + (reinterpret_cast<const uint8_t*>(inOriginal) - r.data));
  }
};

} // namespace

TEST_CASE("every reference face's area, by kind, at every variant") {
  std::map<std::string, int> checked, unsupported;
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& r = fixtures::references[i];
    const Model model(r.data, r.size);
    REQUIRE(model.ok());
    Oracle oracle(r.data, r.size);
    REQUIRE(oracle.ok());
    for (int k = 0; k < r.nFaceAreas; k++) {
      const fixtures::FaceArea& fa = r.faceAreas[k];
      const int kind = model.surfaceKind(model.faceSurface(fa.face));
      const FaceMeasure m = oracle.face(fa.face);
      const std::string what = std::string(r.name) + "-" + r.variant + " face " + std::to_string(fa.face);
      if (!closedFormKind(kind) && !sweptKind(kind) && !freeKind(kind)) {
        CHECK(m.area.status == Status::unsupported);
        unsupported[r.name]++;
        continue;
      }
      if (!trusted(m, 1e-9)) {
        ::check::fail(__FILE__, __LINE__, what + ": not trusted: status " + std::to_string(int(m.area.status))
          + ", flags " + std::to_string(m.flags) + ", error " + ::check::show(m.area.error) + ", " + m.why);
        continue;
      }
      if (!agrees(m.area, fa.area, fa.tol, fa.abs)) {
        ::check::fail(__FILE__, __LINE__, what + ": area " + ::check::show(m.area.value) + " vs "
          + ::check::show(fa.area) + " (error " + ::check::show(m.area.error) + ")");
      }
      checked[r.name]++;
    }
  }
  // Every kind the oracle supports is covered, at every variant (7 each).
  for (const char* name : {"box", "cylinder", "cone", "sphere", "torus", "extrusion", "revolution",
    "revolutionSphere", "bsplineCylinder", "bsplineSphere", "bsplineTorus", "offset", "trimmedSurface"}) {
    CHECK(checked[name] >= 7);
  }
  CHECK(unsupported.empty());
}

TEST_CASE("edge lengths against the reference curves' lengths over the same parameters") {
  int matched = 0;
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& r = fixtures::references[i];
    const Model model(r.data, r.size);
    Oracle oracle(r.data, r.size);
    auto* copy = static_cast<uint8_t*>(std::malloc(r.size));
    std::memcpy(copy, r.data, r.size);
    const int32_t h = cg_model_new(copy, static_cast<uint32_t>(r.size));
    REQUIRE(h >= 0);
    for (int k = 0; k < r.nCurveLengths; k++) {
      const fixtures::CurveLength& cl = r.curveLengths[k];
      for (int e = 0; e < model.edges(); e++) {
        double p[2];
        if (model.edgeCurve(e) != cl.curve || cg_edge_params(h, e, p) != 0) continue;
        const double lo = std::fmin(p[0], p[1]), hi = std::fmax(p[0], p[1]);
        const double slack = 1e-12 * (1 + std::fabs(cl.t0) + std::fabs(cl.t1));
        if (std::fabs(lo - cl.t0) > slack || std::fabs(hi - cl.t1) > slack) continue;
        const Estimate L = oracle.edgeLength(e);
        CHECK(L.status == Status::ok);
        CHECK(L.error <= 1e-9 * cl.length);
        if (!agrees(L, cl.length, cl.tol, cl.abs)) {
          ::check::fail(__FILE__, __LINE__, std::string(r.name) + "-" + r.variant + " edge " + std::to_string(e)
            + ": length " + ::check::show(L.value) + " vs " + ::check::show(cl.length));
        }
        matched++;
      }
    }
    cg_model_free(h);
  }
  CHECK(matched >= 7 * 12);
}

TEST_CASE("a box's face perimeters: their edges' lengths from the facts, each counted once per use") {
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& r = fixtures::references[i];
    if (std::strcmp(r.name, "box") != 0) continue;
    const Model model(r.data, r.size);
    Oracle oracle(r.data, r.size);
    std::map<int, double> byCurve;
    for (int k = 0; k < r.nCurveLengths; k++) byCurve[r.curveLengths[k].curve] = r.curveLengths[k].length;
    for (int f = 0; f < model.faces(); f++) {
      double expected = 0;
      for (int l = model.faceFirstLoop(f); l < model.faceFirstLoop(f) + model.faceLoopCount(f); l++)
        for (int c = model.loopFirst(l); c < model.loopFirst(l) + model.loopCount(l); c++)
          expected += byCurve.at(model.edgeCurve(model.coedgeEdge(c)));
      const FaceMeasure m = oracle.face(f);
      CHECK(m.perimeter.status == Status::ok);
      CHECK_NEAR(m.perimeter.value, expected, 1e-12, 1e-12 * r.scale);
    }
  }
}

TEST_CASE("trusted: projectedBoundary and edgesPlaced said, not refused; any other flag refused") {
  // A measure of 1 within 1e-9, its boundary's error known: trusted with either or both of those flags, not with
  // another beside them; and not at a relative bound under its error.
  FaceMeasure m;
  m.area.value = 1, m.area.error = 1e-9, m.area.status = Status::ok, m.boundary = 1e-10;
  for (uint32_t f : {0u, uint32_t(flagProjectedBoundary), uint32_t(flagEdgesPlaced),
         uint32_t(flagProjectedBoundary | flagEdgesPlaced)}) {
    m.flags = f;
    CHECK(trusted(m, 1e-6));
    CHECK(!trusted(m, 1e-10));
    m.flags = f | flagOrientation;
    CHECK(!trusted(m, 1e-6));
  }
}

TEST_CASE("flags: a face turned over, a surface moved off its edges, no loops") {
  const fixtures::Reference& r = *fixtures::reference("box", "s1");
  const Model model(r.data, r.size);
  Oracle oracle(r.data, r.size);
  const FaceMeasure before = oracle.face(0);
  REQUIRE(trusted(before));
  {
    Copy c(r);
    uint8_t* sense = c.at(r, model.u8(CBR_FACE_SAME_SENSE));
    sense[0] = !sense[0];
    Oracle turned(c.bytes(), r.size);
    const FaceMeasure m = turned.face(0);
    CHECK(m.flags == flagOrientation);
    CHECK_NEAR(m.area.value, before.area.value, 1e-12, 0);
  }
  {
    Copy c(r);
    double* plane = c.at(r, model.surfaceReals(model.faceSurface(0)));
    // The origin moved along the normal by the box's size.
    for (int k = 0; k < 3; k++) plane[k] += r.scale * 3 * plane[3 + k];
    Oracle moved(c.bytes(), r.size);
    const FaceMeasure m = moved.face(0);
    CHECK((m.flags & flagOffSurface) != 0);
    CHECK(m.offSurface > kOffSurface);
  }
  {
    Copy c(r);
    int32_t* count = c.at(r, model.i32(CBR_FACE_LOOP_COUNT));
    count[0] = 0;
    Oracle bare(c.bytes(), r.size);
    const FaceMeasure m = bare.face(0);
    CHECK(m.flags == flagNoLoops);
    CHECK(m.area.value == 0);
  }
}

TEST_CASE("a sphere's face turned over gives its complement, flagged past a hemisphere") {
  const fixtures::Reference& r = *fixtures::reference("sphere", "s1");
  const Model model(r.data, r.size);
  Oracle oracle(r.data, r.size);
  int seen = 0;
  for (int k = 0; k < r.nFaceAreas; k++) {
    const int f = r.faceAreas[k].face;
    if (model.surfaceKind(model.faceSurface(f)) != CBR_SURFACE_SPHERE || model.faceLoopCount(f) == 0) continue;
    const FaceMeasure m = oracle.face(f);
    REQUIRE(trusted(m));
    const double R = model.surfaceReals(model.faceSurface(f))[9], whole = 4 * M_PI * R * R;
    Copy c(r);
    uint8_t* sense = c.at(r, model.u8(CBR_FACE_SAME_SENSE));
    sense[f] = !sense[f];
    Oracle turned(c.bytes(), r.size);
    const FaceMeasure t = turned.face(f);
    CHECK_NEAR(t.area.value, whole - m.area.value, 1e-9, 0);
    CHECK(((t.flags & flagSphereSide) != 0) == (t.area.value > whole / 2));
    seen++;
  }
  CHECK(seen > 0);
}

namespace {

/** A body's faces (its shells' face uses, all forward in the canonical model), or none if any is past the oracle. */
std::vector<int> bodyFaces(const Model& m, int body) {
  std::vector<int> out;
  const int first = m.i32(CBR_BODY_FIRST)[body], count = m.i32(CBR_BODY_COUNT)[body];
  for (int k = first; k < first + count; k++) {
    const int sh = m.i32(CBR_MEMBER_REF)[k];
    for (int u = m.i32(CBR_SHELL_FIRST)[sh]; u < m.i32(CBR_SHELL_FIRST)[sh] + m.i32(CBR_SHELL_COUNT)[sh]; u++)
      out.push_back(m.i32(CBR_FACE_USE_FACE)[u]);
  }
  return out;
}

/** The reference's similarity applied to a point of its shape's own frame. */
Vec3 placed(const fixtures::Reference& r, Vec3 p) {
  const double* R = r.rotation;
  return {r.scale * (R[0] * p.x + R[3] * p.y + R[6] * p.z) + r.translation[0],
    r.scale * (R[1] * p.x + R[4] * p.y + R[7] * p.z) + r.translation[1],
    r.scale * (R[2] * p.x + R[5] * p.y + R[8] * p.z) + r.translation[2]};
}

} // namespace

TEST_CASE("faceIntegral: every reference body's volume, at every variant, by (p - c) . n / 3 over its faces") {
  std::map<std::string, int> checked, unsupported;
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& r = fixtures::references[i];
    const Model model(r.data, r.size);
    Oracle oracle(r.data, r.size);
    for (int k = 0; k < r.nVolumes; k++) {
      const fixtures::Volume& vf = r.volumes[k];
      const std::vector<int> faces = bodyFaces(model, vf.body);
      // About a point of the body (its first vertex, else the origin), against cancellation far from the origin.
      const Vec3 c = model.vertices() ? model.vertexPoint(0) : Vec3{};
      Integrand g{1, [&](Vec3 p, Vec3 n, double* out) { out[0] = cadgeom::dot(p - c, n) / 3; }, {}};
      double sum = 0, err = 0;
      bool supported = true;
      for (int f : faces) {
        const Estimate e = oracle.faceIntegral(f, g)[0];
        if (e.status == Status::unsupported) supported = false;
        else CHECK(e.status == Status::ok);
        sum += e.value, err += e.error;
      }
      const std::string what = std::string(r.name) + "-" + r.variant + " body " + std::to_string(vf.body);
      if (!supported) {
        unsupported[r.name]++;
        continue;
      }
      if (!(std::fabs(sum - vf.volume) <= std::fmax(std::fmax(vf.tol * std::fabs(vf.volume), vf.abs), 10 * err))) {
        ::check::fail(__FILE__, __LINE__, what + ": volume " + ::check::show(sum) + " vs " + ::check::show(vf.volume)
          + " (error " + ::check::show(err) + ")");
      }
      checked[r.name]++;
    }
  }
  for (const char* name : {"box", "cylinder", "cone", "sphere", "torus", "extrusion", "revolution",
    "revolutionSphere", "bsplineCylinder", "bsplineSphere", "bsplineTorus", "offset"}) {
    CHECK(checked[name] >= 7);
  }
  CHECK(unsupported.empty());
}

TEST_CASE("faceIntegral: |n| is face()'s area; n over a closed body sums to 0") {
  int faces = 0, bodies = 0;
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& r = fixtures::references[i];
    const Model model(r.data, r.size);
    Oracle oracle(r.data, r.size);
    Integrand g{4, [](Vec3, Vec3 n, double* out) { out[0] = cadgeom::norm(n), out[1] = n.x, out[2] = n.y,
      out[3] = n.z; }, {}};
    for (int f = 0; f < model.faces(); f++) {
      const FaceMeasure m = oracle.face(f);
      if (!trusted(m, 1e-9)) continue;
      const Estimate a = oracle.faceIntegral(f, g)[0];
      CHECK(a.status == Status::ok);
      if (!(std::fabs(a.value - m.area.value) <= 1e-9 * m.area.value + 10 * (a.error + m.area.error))) {
        ::check::fail(__FILE__, __LINE__, std::string(r.name) + "-" + r.variant + " face " + std::to_string(f)
          + ": " + ::check::show(a.value) + " vs face()'s " + ::check::show(m.area.value));
      }
      faces++;
    }
    for (int k = 0; k < r.nVolumes; k++) {
      double sum[3] = {0, 0, 0}, scale = 0;
      bool all = true;
      for (int f : bodyFaces(model, r.volumes[k].body)) {
        const std::vector<Estimate> v = oracle.faceIntegral(f, g);
        if (v[0].status != Status::ok) all = false;
        for (int q = 0; q < 3; q++) sum[q] += v[q + 1].value;
        scale += v[0].value;
      }
      if (!all) continue;
      CHECK_NEAR(std::hypot(sum[0], sum[1], sum[2]), 0, 0, 1e-9 * scale);
      bodies++;
    }
  }
  if (faces < 170 || bodies < 60) {
    ::check::fail(__FILE__, __LINE__, "faces " + std::to_string(faces) + ", bodies " + std::to_string(bodies));
  }
}

TEST_CASE("faceIntegral: first moments, the box's and the cylinder's centroids (x^2 / 2 n_x and so on)") {
  for (const char* name : {"box", "cylinder"}) {
    for (int i = 0; i < fixtures::nReferences; i++) {
      const fixtures::Reference& r = fixtures::references[i];
      if (std::strcmp(r.name, name) != 0) continue;
      const Model model(r.data, r.size);
      Oracle oracle(r.data, r.size);
      const Vec3 c = model.vertexPoint(0);
      // int x dV over the solid, about c: oint (x - c)^2 / 2 n_x, per axis; and its volume.
      Integrand g{4, [&](Vec3 p, Vec3 n, double* out) {
        const Vec3 d = p - c;
        out[0] = d.x * d.x / 2 * n.x, out[1] = d.y * d.y / 2 * n.y, out[2] = d.z * d.z / 2 * n.z;
        out[3] = cadgeom::dot(d, n) / 3;
      }, {}};
      double sum[4] = {0, 0, 0, 0};
      for (int f : bodyFaces(model, r.volumes[0].body)) {
        const std::vector<Estimate> v = oracle.faceIntegral(f, g);
        for (int q = 0; q < 4; q++) sum[q] += v[q].value;
      }
      const Vec3 own = std::strcmp(name, "box") == 0 ? Vec3{0.5, 1, 1.5} : Vec3{0, 0, 2.5};
      const Vec3 expected = placed(r, own) - c, got{sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]};
      CHECK_NEAR(cadgeom::norm(got - expected), 0, 0, 1e-9 * r.scale * 3);
    }
  }
}

TEST_CASE("faceIntegral: an integrand oscillating along v, the cylinder's int cos(k z) dV by x cos(k z) n_x") {
  // In the cylinder's own frame (radius 2, z from 0 to 5): div (x cos(k z), 0, 0) = cos(k z), so the faces' integrals
  // of x cos(k z) n_x add up to pi r^2 sin(k h) / k; about ten periods along the side's v, past the inner rule's
  // first panels. Placed: q = R^T (p - t) / s, the field s q_x cos(k q_z) along the placed x axis.
  const double rr = 2, hh = 5, k = 12;
  int seen = 0;
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& r = fixtures::references[i];
    if (std::strcmp(r.name, "cylinder") != 0) continue;
    const Model model(r.data, r.size);
    Oracle oracle(r.data, r.size);
    const double* R = r.rotation;
    const Vec3 ex{R[0], R[1], R[2]}, ez{R[6], R[7], R[8]}, t{r.translation[0], r.translation[1], r.translation[2]};
    Integrand g{1, [&](Vec3 p, Vec3 n, double* out) {
      const Vec3 d = p - t;
      out[0] = cadgeom::dot(d, ex) * std::cos(k * cadgeom::dot(d, ez) / r.scale) * cadgeom::dot(ex, n);
    }, {}};
    double sum = 0;
    for (int f : bodyFaces(model, r.volumes[0].body)) {
      const Estimate e = oracle.faceIntegral(f, g)[0];
      CHECK(e.status == Status::ok);
      sum += e.value;
    }
    const double s3 = r.scale * r.scale * r.scale;
    CHECK_NEAR(sum, s3 * M_PI * rr * rr * std::sin(k * hh) / k, 0, 1e-9 * s3 * M_PI * rr * rr * hh);
    seen++;
  }
  CHECK(seen >= 7);
}

TEST_CASE("faceIntegral: a component zero on a tilted plane but for rounding, whatever n, converges") {
  // ((p - o) . m)(n . m) on a plane face through o with normal m: rounding on the face for every n, so its tolerance
  // must come from the integrand's size near the face (or no tolerance relative to rounding is ever met).
  int seen = 0;
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& r = fixtures::references[i];
    if (std::strcmp(r.name, "box") != 0) continue;
    const Model model(r.data, r.size);
    Oracle oracle(r.data, r.size);
    for (int f = 0; f < model.faces(); f++) {
      const int s = model.faceSurface(f);
      if (model.surfaceKind(s) != CBR_SURFACE_PLANE) continue;
      const double* R = model.surfaceReals(s);
      const Vec3 o{R[0], R[1], R[2]}, m{R[3], R[4], R[5]};
      Integrand g{2, [&](Vec3 p, Vec3 n, double* out) {
        out[0] = cadgeom::dot(p - o, m) * cadgeom::dot(n, m), out[1] = cadgeom::norm(n);
      }, {}};
      const std::vector<Estimate> v = oracle.faceIntegral(f, g);
      CHECK(v[0].status == Status::ok);
      CHECK_NEAR(v[0].value, 0, 0, 1e-9 * v[1].value * r.scale);
      seen++;
    }
  }
  CHECK(seen >= 40);
}

TEST_CASE("faceIntegral: bad faces invalid") {
  const fixtures::Reference& r = *fixtures::reference("bsplineCylinder", "s1");
  Oracle oracle(r.data, r.size);
  Integrand g{2, [](Vec3, Vec3 n, double* out) { out[0] = cadgeom::norm(n), out[1] = 0; }, {}};
  CHECK(oracle.faceIntegral(-1, g)[0].status == Status::invalidModel);
}

TEST_CASE("a model that isn't one, and rows out of range") {
  const uint8_t junk[16] = {};
  Oracle bad(junk, sizeof junk);
  CHECK(!bad.ok());
  CHECK(bad.face(0).area.status == Status::invalidModel);
  const fixtures::Reference& r = *fixtures::reference("box", "s1");
  Oracle oracle(r.data, r.size);
  CHECK(oracle.face(-1).area.status == Status::invalidModel);
  CHECK(oracle.edgeLength(1 << 20).status == Status::invalidModel);
}
