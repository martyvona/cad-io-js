# Contributing to cad-io-js

Thank you for considering a contribution. cad-io-js is licensed under the GNU Affero General Public License, version 3 only ([`LICENSE.txt`](LICENSE.txt)), except `packages/tess-occt`, which is LGPL-2.1 with the Open CASCADE exception, as OCCT is.

## The Contributor License Agreement

Before a pull request can be merged, its author signs the [Contributor License Agreement](CLA.md) (CLA), once. You keep the copyright in your contributions; you grant the maintainer a broad copyright and patent license to them, which includes the right to distribute them under other terms as well as the AGPL (section 4 of the CLA). If your employer has rights in what you write, make sure you have its permission first (section 5).

To sign, comment on your pull request with exactly:

> I have read the CLA Document and I hereby sign the CLA

A GitHub Action (`.github/workflows/cla.yml`) checks every pull request and asks authors who haven't signed; comment `recheck` to have it check again. Signatures are kept on this repository's `cla-signatures` branch.

## Making a Change

- `source env.sh`, then `npm install`; see the README's "Building From Source".
- `npm test` and `npm run typecheck` must pass; add tests for what you change.
- Code lines are at most 120 characters, indented with 2 spaces, and every tracked text file is ASCII (`test/ascii.test.ts` checks).
- [`CLAUDE.md`](CLAUDE.md) records how work is done here and the decisions behind the design, with topic notes in [`docs/`](docs/); read the parts your change touches.
