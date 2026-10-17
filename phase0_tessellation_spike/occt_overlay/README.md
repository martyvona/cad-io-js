Overlay headers for the spike OCCT builds. Copied over the forwarding stubs in `<build>/include/opencascade/` after configure (`occt_variant_build.sh <name> "<flags>" "" 1`).

- `AppCont_ContMatrices.pxx`: from OCCT `src/ModelingData/TKGeomBase/AppCont/AppCont_ContMatrices.pxx` at 3d097a0328. `VBernstein` computes Bernstein values at Gauss-Legendre points instead of reading the 840 kB `THE_VBMATRIX_DATA` table. Max abs error against the table: 6.09e-15 over all 104,650 entries.

`test/`:

- `table_test.cpp`: native check of the computed values against the table, using a copy of the function body.
- `instrumented_AppCont_ContMatrices.pxx`: the overlay plus a per-call comparison with the table, printed to stderr as `VBCHECK`, and an optional `VB_CONTROL_MODE` (1 writes the table values, 2 writes them nudged by up to ±4 ulps). To use it, copy it into a build's include dir and rebuild; restore the plain overlay afterwards.
- `appcont_test.cpp`, `run.sh`, `compare.py`: an end-to-end `Approx_FitAndDivide` test. `run.sh <build dir> <name>` writes `<name>.txt`, and `compare.py a.txt b.txt` diffs the poles.
- `results.txt` (patched, control 1 and control 2, each against upstream) and the `.txt` outputs it was made from.

See "Build variants" in `phase0_results.md`.
