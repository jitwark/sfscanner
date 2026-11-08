# Where this repository comes from

The standalone scanner, website and pipeline are developed in a private working repository and selected for publication by scripts/extract-public-repo.mjs. The extractor uses an explicit allowlist and content/privacy checks; private history is not pushed. Send contributions as pull requests here, as described in [CONTRIBUTING.md](CONTRIBUTING.md).

## Public release identity

| Scope | Qualified identity |
| --- | --- |
| Release | [v0.2.1](https://github.com/jitwark/sfscanner/releases/tag/v0.2.1), published November 8, 2026 |
| Product/tag commit | 6313d89097c09faad499f54deeee33c6571109d5 |
| Qualified Pages delivery commit | 1d9f4ad7dff09fd880c7397feeeecfb2893383ad |
| Source count at the preceding documentation checkpoint | 2,198 selected source files; 2,199 tracked public files including accepted Action metadata, verified at 8e2a6f10b144d79cc147f09453f202deb0f39193 |

Later main commits can update documentation or the currently authorized UI. They do not replace the immutable npm 0.2.1 tarball or retrospectively qualify new bytes. Use the [release record](https://github.com/jitwark/sfscanner/releases/download/v0.2.1/release-record.json), exact commit and [programme status](docs/scanner/programme-status.md) for the relevant scope. Current file counts are derived from a fresh selected manifest and git inventory, not the historical table above.

## What is deliberately absent

- Private corpus bodies, generated native evidence and the local data/ and app/public/data/ build inputs. The [published V4 dataset](docs/DATA-AVAILABILITY.md) is a separate qualified link-only artifact with its own licence.
- Internal audit packets, unreleased decision inputs, private OpenSpec plans and session context. Public architecture decisions remain in [docs/decisions](docs/decisions/).
- Local agent/editor configuration, caches, secrets, capture-only fixtures and private Git history.

Run npm run gates:source and npm run test:source for the supported source-only CI path. A complete site build or corpus-dependent suite also needs the appropriate verified build inputs; absence of private input is not a reason to weaken source or privacy gates.

## Historical extraction note

The former September 5, 2026 extraction recorded upstream commit f8e871aef7b8a096e3d962bb04aa518ce191bba9 and 1,370 files. Those values describe that earlier extraction, not the November release or current main.
