# Composed Jev assessment

This follow-up evaluates small Jev decisions around one tool-free generator. It does not
change hosted Planner routing. The three development inputs are two original RFC passages
and one short issue opening, frozen locally with source snapshots, byte offsets, hashes,
and separate provisional review annotations. The source and raw results stay under ignored
`data/visual-selection/composed/`.

The direct path lets the same model choose from the six existing output forms. The composed
path asks Jev whether a passage has a visual opportunity, asks for a supported
representation when yes, then gives that type or a prose abstention to the same generator.
The opportunity threshold is fixed at 0.5; the raw probability is recorded without
claiming calibration.
Actual table and diagram candidates receive two separate Jev checks: source support and
explanatory added value. Those checks inspect structured text, not pixels. Renderer
validation and visual inspection remain separate.

The runner enforces three cases, at most six primary model generations, and at most
20 Jev calls. It writes a new JSONL file and never retries silently. Any mechanical repair,
post-repair checks, or synthetic critic controls must be recorded separately. Do not treat
the three development cases as a held-out accuracy estimate.

From the repository root, after placing the frozen public development directory locally:

```bash
bun apps/server/src/visual-selection-eval/composed-run.ts --dry-run
bun apps/server/src/visual-selection-eval/composed-run.ts \
  --jev-env /path/to/project/.env \
  --output data/visual-selection/composed/baseline.jsonl
```

The run requests `gpt-6-luna` through an isolated Copilot SDK `HarnessAgent` and reads
the existing `gh` login or environment token. This approximates a Planner generation
decision; it is not a hosted Planner turn. The corrected output contract accepts diagram
specs as JSON objects. A valid diagram still has to satisfy the SeeCode renderer.
