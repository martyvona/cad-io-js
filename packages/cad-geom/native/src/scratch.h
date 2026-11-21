// A buffer for the hot paths of evaluation: on the stack up to N elements, on the heap only beyond (a degree past
// what real data has), zero-filled as the std::vector it stands for would be, or not where the caller writes every
// element before reading it (Scratch::uninitialized: the fill was a tenth of evaluation's cost). Not copyable: it
// lives in one call. SCRATCH_POISON fills those with NaN instead, so a read before a write shows in the results.
#pragma once

#include <algorithm>
#include <limits>
#include <cstddef>
#include <vector>

namespace cadgeom {

template <class T, size_t N> class Scratch {
public:
  struct Uninitialized {};
  static constexpr Uninitialized uninitialized{};
  Scratch(size_t n, Uninitialized) {
    if (n <= N) {
      p_ = fixed_;
    } else {
      heap_.resize(n);
      p_ = heap_.data();
    }
#ifdef SCRATCH_POISON
    std::fill(p_, p_ + n, std::numeric_limits<T>::quiet_NaN());
#endif
  }
  explicit Scratch(size_t n) {
    if (n <= N) {
      p_ = fixed_;
    } else {
      heap_.resize(n);
      p_ = heap_.data();
    }
    std::fill(p_, p_ + n, T{});
  }
  Scratch(const Scratch&) = delete;
  Scratch& operator=(const Scratch&) = delete;
  T* data() { return p_; }
  T& operator[](size_t i) { return p_[i]; }

private:
  T fixed_[N];
  std::vector<T> heap_;
  T* p_;
};

/** Degrees up to this evaluate without allocating (real models go to about 9; Part 42 sets no limit). */
constexpr int kStackDegree = 15;

} // namespace cadgeom
