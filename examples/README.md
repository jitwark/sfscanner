# Synthetic workflow examples

These fixtures are authored for this repository. They are synthetic demonstrations, not copied
from an upstream workflow, and contain no credentials, personal data, or production endpoints.
They are useful for trying the scanner and for checking the public extraction boundary.

| Fixture | Purpose |
| --- | --- |
| [`synthetic-safe-workflow.json`](synthetic-safe-workflow.json) | Small local transform with a manual trigger and no deliberately risky node. |
| [`synthetic-risky-workflow.json`](synthetic-risky-workflow.json) | Deliberately reviewable example containing a command node; it is not a recommendation to run it. |

## Validate the fixtures

From the repository root:

```text
node examples/validate.mjs
```

The validator parses every listed JSON file, checks the minimum n8n workflow shape, rejects
credential-like fields and network endpoints, verifies unique node identities, and checks that
connections refer to nodes in the same fixture. It is a fixture-integrity check, not a security
certification.

To scan a fixture with the current local CLI, see [`docs/CLI.md`](../docs/CLI.md). Scanner output
is analysis guidance; a fixture labelled “safe” does not mean that every possible scanner or
runtime would consider it safe.
