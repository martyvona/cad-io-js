// That the build works: Eigen (the pinned version) solves a linear system, the tests link libcadgeom.a and read
// cad-brep's test models (brep_models.h, from native/test/fixtures.ts), and the harness compares, reports and aborts
// as check.h says. The Eigen guard's own check is in build.sh's test mode.
#include <Eigen/Dense>
#include <cad_geom/curve.h>
#include <cstdlib>
#include <limits>
#include <stdexcept>

#include "brep_models.h"
#include "check.h"

TEST_CASE("Eigen solves a 3x3 linear system") {
  Eigen::Matrix3d a;
  a << 2, 1, -1, -3, -1, 2, -2, 1, 2;
  const Eigen::Vector3d b(8, -11, -3);  // a times (2, 3, -1)
  const Eigen::Vector3d lu = a.partialPivLu().solve(b), qr = a.colPivHouseholderQr().solve(b);
  for (const Eigen::Vector3d& x : {lu, qr}) {
    CHECK_NEAR(x[0], 2, 1e-12, 0);
    CHECK_NEAR(x[1], 3, 1e-12, 0);
    CHECK_NEAR(x[2], -1, 1e-12, 0);
    CHECK((a * x - b).norm() < 1e-12);
  }
  CHECK_NEAR(a.determinant(), -1, 1e-12, 0);
}

TEST_CASE("the pinned Eigen") {
  CHECK_EQ(EIGEN_MAJOR_VERSION, 5);
  CHECK_EQ(EIGEN_MINOR_VERSION, 0);
  CHECK_EQ(EIGEN_PATCH_VERSION, 1);
}

TEST_CASE("the tests link libcadgeom.a: every 3D circle of the test models is 2 pi r long") {
  int circles = 0;
  for (const fixtures::Model& m : fixtures::models) {
    const cadgeom::Model model(m.data, m.size);
    REQUIRE(model.ok());
    for (int i = 0; i < model.curves(); i++) {
      if (model.curveKind(i) != CBR_CURVE_CIRCLE || model.curveDim(i) != 3) continue;
      cadgeom::Status status;
      const std::unique_ptr<cadgeom::Curve> c = cadgeom::makeCurve(model, i, status);
      REQUIRE(c);
      const double r = model.curveReals(i)[9];  // after the placement's 9 reals
      const cadgeom::Estimate length = cadgeom::arcLength(*c, 0, 2 * M_PI, 1e-12);
      CHECK(length.status == cadgeom::Status::ok);
      CHECK_NEAR(length.value, 2 * M_PI * r, 1e-10, 0);
      circles++;
    }
  }
  CHECK_EQ(circles, 5);  // as brepToJson counts them
}

TEST_CASE("CHECK_NEAR: within max(abs, rel times the larger magnitude), and what never passes") {
  const double inf = std::numeric_limits<double>::infinity(), nan = std::numeric_limits<double>::quiet_NaN();
  // Relative, either sign and order.
  CHECK(check::near(1e6, 1e6 + 0.9, 1e-6, 0));
  CHECK(!check::near(1e6, 1e6 + 1.1, 1e-6, 0));
  CHECK(check::near(-1e6, -1e6 - 0.9, 1e-6, 0));
  CHECK(check::near(1e6 + 0.9, 1e6, 1e-6, 0));
  // Relative holds at small magnitudes too: no floor of its own (a model scaled by 1e-3).
  CHECK(check::near(1e-3, 1e-3 + 0.9e-15, 1e-12, 0));
  CHECK(!check::near(1e-3, 1e-3 + 1e-14, 1e-12, 0));
  // Scaled by the larger magnitude whichever side it's on; at the bound itself (exact in binary).
  CHECK(check::near(0, 3, 1, 0));
  CHECK(check::near(3, 0, 1, 0));
  CHECK(!check::near(0, 3.5, 0.5, 0));
  CHECK(check::near(0, 0.5, 0, 0.5));
  // Absolute, near 0 where a relative one asks for equality.
  CHECK(check::near(0, 0.9e-6, 0, 1e-6));
  CHECK(!check::near(0, 1.1e-6, 0, 1e-6));
  CHECK(!check::near(0, 1e-300, 1e-6, 0));
  // The larger of the two, not their sum: 1.15 and 1 allow 1.5 only if summed.
  CHECK(check::near(10, 11.1, 0.1, 1));
  CHECK(check::near(10, 11.1, 0, 1.1));
  CHECK(!check::near(10, 11.5, 0.1, 1));
  // Equality, infinities, NaN, and tolerances that aren't (a caller's bug fails rather than passes).
  CHECK(check::near(2, 2, 0, 0));
  CHECK(!check::near(2, std::nextafter(2.0, 3.0), 0, 0));
  CHECK(check::near(inf, inf, 0, 0));
  CHECK(!check::near(inf, -inf, 1, 1));
  CHECK(!check::near(inf, 1e308, 1, 1));
  CHECK(!check::near(nan, nan, 1, 1));
  CHECK(!check::near(1, nan, 1, 1));
  CHECK(!check::near(1, 1.5, nan, 1));
  CHECK(!check::near(1, 1.5, 1, nan));
  CHECK(!check::near(1, 1, nan, 0));
  CHECK(!check::near(1, 1, 0, nan));
  CHECK(!check::near(1, 1, -1, 0));
  CHECK(!check::near(1, 1, 0, -1));
  CHECK(!check::near(1, 1.5, -1, 1));
}

TEST_CASE("failures name the file, the line and both values; REQUIRE ends the case") {
  std::string out;
  check::sink = &out;
  const int before = check::failures;
  CHECK_NEAR(1.5, 2.25, 1e-3, 0.5);
  const int near_line = __LINE__ - 1;
  CHECK_EQ(3 + 4, 8);
  const int eq_line = __LINE__ - 1;
  CHECK(1 > 2);
  bool after = false, aborted = false;
  try {
    REQUIRE(false);
    after = true;
  } catch (const check::Abort&) {
    aborted = true;
  }
  CHECK_NEAR(1, 1, 0, 0);
  CHECK_EQ(2, 2);
  CHECK(true);
  check::sink = nullptr;
  const int failed = check::failures - before;
  CHECK_EQ(failed, 0);
  CHECK(aborted);
  CHECK(!after);
  const std::string file = __FILE__;
  CHECK(out.find(file + ":" + std::to_string(near_line) + ": CHECK_NEAR(1.5, 2.25, 1e-3, 0.5) failed: 1.5 vs 2.25, "
    "difference 0.75, rel 0.001, abs 0.5\n") != std::string::npos);
  CHECK(out.find(file + ":" + std::to_string(eq_line) + ": CHECK_EQ(3 + 4, 8) failed: 7 != 8\n") != std::string::npos);
  CHECK(out.find("CHECK(1 > 2) failed\n") != std::string::npos);
  CHECK(out.find("REQUIRE(false) failed\n") != std::string::npos);
  size_t lines = 0;
  for (char c : out) lines += c == '\n';
  CHECK_EQ(lines, 4u);
}

TEST_CASE("each CHECK is evaluated once") {
  int n = 0;
  CHECK_EQ(++n, 1);
  CHECK_NEAR(++n, 2, 0, 0);
  CHECK(++n == 3);
  CHECK_EQ(n, 3);
}

// Run by test/native.test.ts by its name, to see a failing binary end to end: its output and exit code.
TEST_CASE("[hidden] planted failures") {
  CHECK_NEAR(1.0, 1.1, 1e-9, 0);
  CHECK_EQ(2, 3);
  throw std::runtime_error("planted");
}

// Run after the one above: a case after a failing one starts with no failures.
TEST_CASE("[hidden] passes after a failure") { CHECK(true); }

// A crash after a failure: the failure line must already be out (check.h flushes each line).
TEST_CASE("[hidden] crashes after a failure") {
  CHECK(1 + 1 == 3);
  std::abort();
}
