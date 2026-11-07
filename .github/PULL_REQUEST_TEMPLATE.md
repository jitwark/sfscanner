<!--
Keep this short and about substance. See CONTRIBUTING.md for the full review norms — this
template is the minimum a reviewer needs to start, not a form to fill mechanically.
-->

## What changed

<!-- One or two sentences. Link the issue/OpenSpec change if there is one. -->

## Why

<!-- The reason for the change, not a restatement of the diff. -->

## What verifies it

<!-- Which tests cover this, and which commands you ran locally. -->

- [ ] `npm run gates` (or the narrower relevant subset — say which, and why the rest wasn't needed)
- [ ] Added/updated a focused test for the changed behavior

## Boundaries touched

<!-- Check any that apply. Each one needs the corresponding specialist review per
     CONTRIBUTING.md — a passing test suite does not substitute for it. -->

- [ ] Workflow bodies, provenance, or licence/redistribution state
- [ ] Privacy, redaction, or secret handling
- [ ] Security (scanner findings, CSP, or another control described in `docs/SECURITY.md`)
- [ ] Release integrity (build, hashes, notices, rollback)
- [ ] A public claim (a number, a licence statement, or similar) shown on the site or in docs

## Residual risk

<!-- Anything you know is still incomplete, deferred, or worth a reviewer's attention. "None" is
     a fine answer if it's true. -->

<!--
Do not include secrets, credentials, or private workflow content in this pull request. If the
change requires discussing something sensitive, use the private channel in SECURITY.md instead.
-->
