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
- Have OCCT's behaviour described, then write fresh code from that and the specifications; keep a provenance note of the spec, paper or recommended practice behind each module; don't copy OCCT comments or identifiers (EXPRESS entity names are ISO's); be able to justify every constant independently. Clean-room discipline for healing or meshing, if the project ever goes there.
- Mirroring the entity model is fine (it is ISO's EXPRESS); NURBS math comes from the literature (Piegl & Tiller).
- Patches to OCCT itself (`packages/tess-occt/occt_patches/`) are OCCT's code and stay under its license, in `tess-occt`.

## Other sources

- stepcode: BSD-3 (keep its notices if code is copied).
- NIST's STP2X3D and SFA: US public domain.
- The MBx-IF recommended practices: free to implement.
- The ISO EXPRESS schemas, behind the generated dictionaries (`packages/step-schemas/dict/`): their terms are still to confirm.
- JT's specifications: see `future.md`.
