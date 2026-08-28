# distribution/

Files bundled into every release artifact by `pipelines/solution-release.yml`.

On a release run (`betaNumber >= 1`) the pipeline copies `LICENSE` and `NOTICE` from this
folder into the `solution` build artifact next to the exported zips, and writes
`SHA256SUMS.txt` (sha256sum format) over every zip in the artifact. Nothing here is read at
build or runtime by the engine itself.

| File      | Purpose                                                                  |
| --------- | ------------------------------------------------------------------------ |
| `LICENSE` | Apache License 2.0, verbatim, with the appendix copyright line filled in. |
| `NOTICE`  | Product attribution notice shipped alongside the license.                 |

## How these relate to the root `LICENSE` and `NOTICE`

There are two licensed surfaces and each needs its own pair of files.

- **`/LICENSE` and `/NOTICE`** cover the **source distribution**: this repository, published
  at <https://github.com/ascentix-software/Ascentix-Rules-Engine> under Apache-2.0. Their
  audience is someone reading, forking or building the source. The root `NOTICE` names the
  third-party components and points at the per-package license texts in
  `client/node_modules/<package>/LICENSE`, which a source consumer gets from `npm ci`.

- **`distribution/LICENSE` and `distribution/NOTICE`** ship **inside the release artifact**:
  the managed solution zip that a customer imports. That artifact is a binary: the customer
  never sees `node_modules`, so `distribution/NOTICE` must be self-contained and reproduces
  the third-party license texts in full (the SIL Open Font License for the embedded Manrope
  font, the MIT permission notice, the Apache-2.0 notice for `@swc/helpers`) rather than
  linking to them.

`distribution/LICENSE` is byte-identical to the root `LICENSE`. The two `NOTICE` files are
deliberately different in depth but must never disagree on facts. When a bundled dependency
changes, update both.

The `Copy-Item` steps in `pipelines/solution-release.yml` reference `distribution/LICENSE` and
`distribution/NOTICE` by path, so both filenames and this folder are load-bearing.
