# Third-party notices

The project's own source is MIT licensed under [LICENSE](LICENSE). Workflow-source rights and attribution are described separately in [ATTRIBUTIONS.md](ATTRIBUTIONS.md) and [docs/LICENSING.md](docs/LICENSING.md); code notices do not relicense workflow bodies.

This inventory was reconciled on November 3, 2026 against the installed manifests and exact lockfile versions. It includes the scanner's observed bundled modules and the application's framework/UI dependencies. Verbatim upstream texts are included below `docs/third-party/`, including the vendor notices distributed with the locked Next.js framework. Inventory inclusion does not assert that every module is inlined into every artifact. The final scanner SBOM/source maps determine the npm bundle's observed closure; the static site carries a combined notices file.

| Component | Version | License | Text |
| --- | --- | --- | --- |
| `@humanwhocodes/momoa` | 3.3.10 | Apache-2.0 | [License](docs/third-party/humanwhocodes-momoa-3.3.10-LICENSE.txt) |
| `@noble/hashes` | 2.4.0 | MIT | [License](docs/third-party/noble-hashes-2.4.0-LICENSE.txt) |
| `acorn` | 8.17.0 | MIT | [License](docs/third-party/acorn-8.17.0-LICENSE.txt) |
| `@lezer/common` | 1.5.2 | MIT | [License](docs/third-party/lezer-common-1.5.2-LICENSE.txt) |
| `@lezer/highlight` | 1.2.3 | MIT | [License](docs/third-party/lezer-highlight-1.2.3-LICENSE.txt) |
| `@lezer/lr` | 1.4.10 | MIT | [License](docs/third-party/lezer-lr-1.4.10-LICENSE.txt) |
| `@lezer/python` | 1.1.19 | MIT | [License](docs/third-party/lezer-python-1.1.19-LICENSE.txt) |
| `next` | 16.4.3 | MIT | [License](docs/third-party/next-16.4.3-LICENSE.txt) |
| `react` | 19.2.8 | MIT | [License](docs/third-party/react-19.2.8-LICENSE.txt) |
| `react-dom` | 19.2.8 | MIT | [License](docs/third-party/react-dom-19.2.8-LICENSE.txt) |
| `scheduler` | 0.27.0 | MIT | [License](docs/third-party/scheduler-0.27.0-LICENSE.txt) |
| `lucide-react` | 0.469.0 | ISC | [License](docs/third-party/lucide-react-0.469.0-LICENSE.txt) |
| `minisearch` | 7.2.0 | MIT | [License](docs/third-party/minisearch-7.2.0-LICENSE.txt) |
| `@swc/helpers` | 0.5.23 | Apache-2.0 | [License](docs/third-party/swc-helpers-0.5.23-LICENSE.txt) |
| `styled-jsx` | 5.1.6 | MIT | [License](docs/third-party/styled-jsx-5.1.6-LICENSE.txt) |
| `tslib` | 2.8.1 | 0BSD | [License](docs/third-party/tslib-2.8.1-LICENSE.txt) |
| `caniuse-lite` | 1.0.30001809 | CC-BY-4.0 | [License](docs/third-party/caniuse-lite-1.0.30001809-LICENSE.txt) |

Next.js bundled vendor texts are retained in `docs/third-party/next-vendor-*.txt`. `@hub/*` modules are this project's MIT source. The npm package contains its own `THIRD_PARTY_NOTICES.md` and all seven observed scanner dependency texts.

Build tooling and platform-native dependencies installed by npm retain their upstream licenses. The public source does not redistribute `node_modules`, and the static site/npm scanner artifacts do not ship sharp/libvips native binaries. If a future distribution includes those binaries, its distributor must satisfy their own Apache/LGPL notice and corresponding-source obligations; upstream publication does not transfer that responsibility away.
