# Licensing and provenance

Notes for anything touching licenses, contributions, or code that could derive from another project. *Not legal advice.*

## The project's licenses

- AGPL-3.0-only (version 3 only) for every package, the viewer and the tools, except `tess-occt`, which stays LGPL-2.1 with the Open CASCADE exception, as OCCT is (it links OCCT itself, hence its own package). Versions before 0.2.0 were Apache-2.0.
- Told the user: AGPL's network clause makes a web application bundling the library AGPL as a whole; dual licensing needs the rights to all the code; the copyright status of AI-written code is unsettled.
- Contributions under a CLA (`CLA.md`, adapted from the Apache ICLA v2.2, the user as Maintainer with the right to sublicense; `CONTRIBUTING.md`). Signed by a pull request comment, recorded by `contributor-assistant/github-action` v2.6.1 (`.github/workflows/cla.yml`) in `signatures/cla.json` on the `cla-signatures` branch. No corporate CLA yet.
- The viewer's build writes `licenses.md` (what it bundles, under which licenses; `vite.config.ts`); new bundled dependencies go in it, and the README's list.
- The demo models (`test_corpus/demo/`) are the user's, CC BY-SA 4.0.

## OCCT and clean-room discipline

OCCT is LGPL-2.1 plus the Open CASCADE exception. A line-by-line translation of OCCT, including asking an AI to "port this function", is a derivative work and LGPL would apply. So:

- Treat OCCT as a behavioural reference and a test oracle (running it carries no obligation), never as source to translate. Copying enough of its special cases in the same order starts to look like copying expression; the risky areas are shape healing, p-curve and tolerance handling, and meshing.
- Have OCCT's behaviour described, then write fresh code from that and the specifications; keep a provenance note of the spec, paper or recommended practice behind each module; don't copy OCCT comments or identifiers (EXPRESS entity names are ISO's); be able to justify every constant independently.
- **Our own tessellator, oracle, healing and interrogation** (`docs/own-tessellator.md`) are clean-room against all three backends, OCCT, truck and SMLib (usd-brep), though truck and SMLib are Apache-2.0: so no future license is closed off by their expression. The *reference* side may read their source and writes behavioural summaries only (prose: what a backend does, its cases and constants; no code, no pseudocode following its structure, no comments or identifiers of theirs; `docs/healing.md` is one). The *implementing* side never reads their source, only those summaries, the specifications and the literature, and is a new session: one whose agents haven't read `third_party/OCCT`, `third_party/truck` or `third_party/usd-brep`, told not to, and saying so in its commits. Running the backends as oracles in tests and checks is fine on both sides.
- Mirroring the entity model is fine (it is ISO's EXPRESS); NURBS math comes from the literature (Piegl & Tiller).
- Patches to OCCT itself (`packages/tess-occt/occt_patches/`) are OCCT's code and stay under its license, in `tess-occt`.

## Other sources

- SMLib (NVIDIA's usd-brep, `third_party/usd-brep`): Apache-2.0, which AGPL-3.0 code may include. `tess-smlib` (AGPL-3.0-only) links it into its module and ships its license beside it (`packages/tess-smlib/LICENSE-SMLib.txt`; usd-brep has no NOTICE file). The builder and wrapper are ours, written from SMLib's headers and its `.agents/` notes; usd-brep's own USD converter (`BREP_SM_USD/src/SmuConvert.cpp`) was read for how its API is used, not copied.
- Libraries for our own tessellator and oracle (`docs/own-tessellator.md`, "Dependencies"; the user's rule, 2026-11-14, keeping future licensing open): permissive licenses (MIT, BSD, ISC, Apache-2.0, Boost, zlib, public domain); MPL-2.0, a file of theirs we modify offered as source; LGPL only as a module a consumer could replace, as `tess-occt` is (its own package and WebAssembly module, loaded through `init`). Not GPL or AGPL, nor non-commercial clauses (Shewchuk's Triangle). Apache-2.0 NOTICE files kept, Rust trees checked transitively.
- stepcode: BSD-3 (keep its notices if code is copied).
- NIST's STP2X3D and SFA: US public domain.
- The MBx-IF recommended practices: free to implement.
- The ISO EXPRESS schemas, behind the generated dictionaries (`packages/step-schemas/dict/`): their terms are still to confirm.
- JT's specifications: see `future.md`.
