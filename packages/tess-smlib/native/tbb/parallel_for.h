// Serial stand-in for the parts of oneTBB that SMLib uses (parallel_for over an index range, task_arena::execute):
// our modules are single-threaded, one per worker (docs/backends.md, "Threads and SharedArrayBuffer").
#pragma once
#include <cstddef>
namespace tbb {
template <typename I, typename F> void parallel_for(I first, I last, const F &f) {
  for (I i = first; i < last; ++i) f(i);
}
struct task_arena {
  template <typename F> auto execute(const F &f) -> decltype(f()) { return f(); }
};
} // namespace tbb
