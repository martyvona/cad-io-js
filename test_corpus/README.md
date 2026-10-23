# Test corpus

`files.txt` lists 517 real-world Part 21 files (421 MB, 4.9 M instances), one per line, by path relative to
`third_party/`. The files themselves aren't in this repository: `third_party/` is git-ignored except for `pull.sh`.

| Files | Under `third_party/` | Source |
|---|---|---|
| 438 | `gkv311-opencascade-dataset/` | OCCT's test data set (https://github.com/gkv311/opencascade-dataset), including the `bug*` files and `step/Median_cx-fs01_bicycle.stp` |
| 60 | `nist-pmi-models/` | NIST MBE PMI validation and conformance models (CTC, FTC, D2MI; AP203 and AP242), eight zip packages from https://www.nist.gov/ctl/smart-connected-systems-division/smart-connected-manufacturing-systems-group/mbe-pmi-0 |
| 19 | `occt-import-js/` | test files of https://github.com/kovacsv/occt-import-js (`test/testfiles/`) |

## Setup

`third_party/pull.sh` (runnable from any directory) makes the checkouts, or updates them if they exist: the git
repositories are shallow-cloned and later fast-forwarded, and each NIST package is downloaded and extracted again
only when the server's Last-Modified date changes. About 1.5 GB in all.

Then run the corpus checks in `corpus_checks/`, for example `node corpus_checks/writer_corpus.ts`. Each check takes
an optional list file in place of `files.txt`, and stops with a hint to run `pull.sh` if corpus files are missing.

`subsets/` (git-ignored) holds phase 0's per-part subsets of 30 of these files, for two of the checks; `corpus_checks/make_subsets.ts` makes them.

The package tests (`npm test`) don't need the corpus.

## Versions

Updating the checkouts can change the corpus. The results in `../corpus_checks/*.log` (and in `../CLAUDE.md`)
used gkv311 at `ead84b5` (2026-10-06), occt-import-js at `41e4708` (2024-12-03), and the NIST packages with the
Last-Modified dates `pull.sh` records in `third_party/nist-pmi-models/.<name>.last-modified`.

Before 2026-10-17, the 19 occt-import-js files came from its npm package, which ships them with CRLF line endings; the
git checkout has LF. The content is otherwise identical, and 59 other corpus files use CRLF.
