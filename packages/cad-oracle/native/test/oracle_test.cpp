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
      if (!closedFormKind(kind) && !sweptKind(kind)) {
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
    "revolutionSphere"}) {
    CHECK(checked[name] >= 7);
  }
  for (const char* name : {"bsplineCylinder", "bsplineSphere", "bsplineTorus", "offset", "trimmedSurface"}) {
    CHECK(unsupported[name] >= 7);
  }
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

TEST_CASE("faceIntegral is unsupported until the free-form method is decided") {
  const fixtures::Reference& r = *fixtures::reference("box", "s1");
  Oracle oracle(r.data, r.size);
  Integrand g{2, [](Vec3, Vec3 n, double* out) { out[0] = cadgeom::norm(n), out[1] = 0; }};
  const std::vector<Estimate> v = oracle.faceIntegral(0, g);
  REQUIRE(v.size() == 2);
  CHECK(v[0].status == Status::unsupported && v[1].status == Status::unsupported);
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
