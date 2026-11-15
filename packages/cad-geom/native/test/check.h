// cad-geom's test harness, no dependency: TEST_CASE("name") { ... } registers a case; CHECK, CHECK_EQ and CHECK_NEAR
// record a failure and go on, REQUIRE ends the case. Each test file is one binary (this header defines main unless
// CHECK_NO_MAIN): `<binary> [--list] [filter...]` runs (or lists) the cases whose name contains any filter, all
// without one. A case named "[hidden] ..." runs only when a filter is its whole name.
// Output, one line each and flushed, which test/native.test.ts parses (keep the two in step):
//   CASE <name>                    a case starts (or, with --list, exists)
//     <file>:<line>: <message>     a failure, indented two spaces
//   PASS <name> | FAIL <name>      it ended
//   DONE <passed> <failed>         all ran; exit 1 if any failed, 0 if none, 2 on a usage error or nothing to run
#pragma once
#include <cmath>
#include <cstdio>
#include <cstring>
#include <exception>
#include <sstream>
#include <string>
#include <vector>

namespace check {

struct Case {
  const char* name;
  void (*fn)();
  const char* file;
  int line;
};
inline std::vector<Case>& registry() {
  static std::vector<Case> cases;
  return cases;
}
struct Register {
  Register(const char* name, void (*fn)(), const char* file, int line) { registry().push_back({name, fn, file, line}); }
};

struct Abort {};             // thrown by REQUIRE, caught by run()
inline int failures = 0;     // in the running case
inline std::string* sink;    // set: failures are appended here, not printed or counted (the harness's own tests)

inline void fail(const char* file, int line, const std::string& message) {
  std::string s = std::string(file) + ":" + std::to_string(line) + ": " + message;
  if (sink) { *sink += s + "\n"; return; }
  ++failures;
  std::printf("  %s\n", s.c_str());
  std::fflush(stdout);
}

template <class T> std::string show(const T& v) {
  std::ostringstream s;
  s.precision(17);
  s << v;
  return s.str();
}

// |a - b| <= max(abs, rel times the larger magnitude), as the reference fixtures' tol and abs: no floor of its own,
// so a scaled model's values are held to rel however small (abs is the caller's, in the model's units). Equal values
// pass (infinities too); NaN, unequal infinities, and a negative or NaN rel or abs fail (fmax would drop a NaN).
inline bool near(double a, double b, double rel, double abs) {
  if (!(rel >= 0) || !(abs >= 0)) return false;
  if (a == b) return true;
  if (!std::isfinite(a) || !std::isfinite(b)) return false;
  return std::fabs(a - b) <= std::fmax(abs, rel * std::fmax(std::fabs(a), std::fabs(b)));
}

inline bool hidden(const Case& c) { return std::strncmp(c.name, "[hidden]", 8) == 0; }

inline bool selected(const Case& c, const std::vector<const char*>& filters) {
  if (filters.empty()) return !hidden(c);
  for (const char* f : filters)
    if (hidden(c) ? std::strcmp(c.name, f) == 0 : std::strstr(c.name, f) != nullptr) return true;
  return false;
}

inline int run(int argc, char** argv) {
  bool list = false;
  std::vector<const char*> filters;
  for (int i = 1; i < argc; i++) {
    if (std::strcmp(argv[i], "--list") == 0) list = true;
    else if (std::strncmp(argv[i], "--", 2) == 0) {
      std::printf("usage: %s [--list] [filter...]\n", argv[0]);
      return 2;
    }
    else filters.push_back(argv[i]);
  }
  const std::vector<Case>& cases = registry();
  for (size_t i = 0; i < cases.size(); i++)
    for (size_t j = 0; j < i; j++)
      if (std::strcmp(cases[i].name, cases[j].name) == 0) {
        std::printf("two cases named \"%s\" (%s:%d)\n", cases[i].name, cases[i].file, cases[i].line);
        return 2;
      }
  int passed = 0, failed = 0;
  for (const Case& c : cases) {
    if (!selected(c, filters)) continue;
    std::printf("CASE %s\n", c.name);
    std::fflush(stdout);
    if (list) { passed++; continue; }
    failures = 0;
    try {
      c.fn();
    } catch (const Abort&) {
    } catch (const std::exception& e) {
      fail(c.file, c.line, std::string("unexpected exception: ") + e.what());
    } catch (...) {
      fail(c.file, c.line, "unexpected exception");
    }
    std::printf("%s %s\n", failures ? "FAIL" : "PASS", c.name);
    std::fflush(stdout);
    (failures ? failed : passed)++;
  }
  if (passed + failed == 0) { std::printf("no case to run\n"); return 2; }
  if (list) return 0;
  std::printf("DONE %d %d\n", passed, failed);
  return failed ? 1 : 0;
}

}  // namespace check

#define CHECK_CAT2(a, b) a##b
#define CHECK_CAT(a, b) CHECK_CAT2(a, b)
// One per line (the line makes the names unique).
#define TEST_CASE(name)                                                                                     \
  static void CHECK_CAT(check_case_, __LINE__)();                                                           \
  static ::check::Register CHECK_CAT(check_register_, __LINE__)(name, CHECK_CAT(check_case_, __LINE__),    \
    __FILE__, __LINE__);                                                                                    \
  static void CHECK_CAT(check_case_, __LINE__)()

#define CHECK(expr) \
  do { if (!(expr)) ::check::fail(__FILE__, __LINE__, "CHECK(" #expr ") failed"); } while (0)
#define REQUIRE(expr) \
  do { if (!(expr)) { ::check::fail(__FILE__, __LINE__, "REQUIRE(" #expr ") failed"); throw ::check::Abort{}; } } \
  while (0)
#define CHECK_EQ(a, b)                                                                                         \
  do {                                                                                                         \
    const auto& check_a = (a); const auto& check_b = (b);                                                      \
    if (!(check_a == check_b))                                                                                 \
      ::check::fail(__FILE__, __LINE__, "CHECK_EQ(" #a ", " #b ") failed: " + ::check::show(check_a) + " != " \
        + ::check::show(check_b));                                                                             \
  } while (0)
#define CHECK_NEAR(a, b, rel, abs)                                                                             \
  do {                                                                                                         \
    const double check_a = (a), check_b = (b), check_r = (rel), check_s = (abs);                               \
    if (!::check::near(check_a, check_b, check_r, check_s))                                                    \
      ::check::fail(__FILE__, __LINE__, "CHECK_NEAR(" #a ", " #b ", " #rel ", " #abs ") failed: "              \
        + ::check::show(check_a) + " vs " + ::check::show(check_b) + ", difference "                           \
        + ::check::show(std::fabs(check_a - check_b)) + ", rel " + ::check::show(check_r) + ", abs "           \
        + ::check::show(check_s));                                                                             \
  } while (0)

#ifndef CHECK_NO_MAIN
int main(int argc, char** argv) { return ::check::run(argc, argv); }
#endif
