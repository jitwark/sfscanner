# Description content contract

> Status: current
> Last verified: 2026-08-17
> Owner: Enrichment and frontend maintainers
> Source of truth: `contracts/index.ts`, `pipeline/enrich/description-contract.ts`, and `app/src/ui/detail/description-sections.tsx`

The published `descriptionContent` object has these fields:

- `headline`: a clear page heading.
- `summary`: one plain-language sentence used in cards and search.
- `outcome`: what the flow helps a person do.
- `beforeAfter.before` and `beforeAfter.after`: the change the JSON supports.
- `exampleScenario`: a clearly labelled hypothetical example.
- `howItWorks`: at least three ordered plain-text steps.
- `limitations`: what the workflow file does not prove.
- `audience`: who benefits and what to understand before import.

The minimum target is 450–600 words when the workflow contains enough evidence; the hard validator floor is 300 words. A short or weakly grounded model answer is rejected for review; it is never replaced with fallback prose in a release package. No generated field may contain URLs, credentials, code, licence names, costs, timings, security verdicts, or an integration absent from the workflow evidence.

Legacy entries without `descriptionContent` remain readable through the plain-text renderer. They are not considered recovered structured enrichment until regenerated and validated.
