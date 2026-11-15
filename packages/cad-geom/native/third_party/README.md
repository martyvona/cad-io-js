# Vendored sources

Code from elsewhere compiled into cad-geom, unmodified. Each entry: where it came from, when, its checksum and its license.

## predicates.c

Jonathan Richard Shewchuk's adaptive-precision floating-point arithmetic and robust geometric predicates (orient2d, incircle, orient3d, insphere), version of May 18, 1996, described in J. R. Shewchuk, "Adaptive Precision Floating-Point Arithmetic and Fast Robust Geometric Predicates", Discrete & Computational Geometry 18(3), 1997 (technical report CMU-CS-96-140).

- Source: https://www.cs.cmu.edu/afs/cs/project/quake/public/code/predicates.c, fetched 2026-11-14 (linked from http://www.cs.cmu.edu/~quake/robust.html).
- SHA-256: `f8662c3f407d1c1c5dcd4dd49ea8b8ddd801a71827d65734206ddc3741792029` (171,536 bytes, ASCII, LF line ends).
- License: placed in the public domain by its author (the file's header says so).
- Unmodified. It's K&R C, so it compiles as C (`-std=gnu11`, not as C++), with `-ffp-contract=off`: its error-free transformations assume each operation rounds once, and a fused multiply-add would break them silently (GNU C contracts by default, clang within an expression). Its warnings are silenced (`-w`), as the file isn't ours to change.
- Used through `src/predicates.cpp` (cad-geom's `predicates.h`), which calls `exactinit()` once before the first predicate. The sign convention is the file's: orient2d positive for counterclockwise points, incircle positive for a point inside the counterclockwise circle.
