# Proposed scope: dynamic design-card rendering

The product goal is a visual decision about the user's own app. A local coding
agent authors a preview using that app's components and design system, publishes
it and its controls through MCP, and receives the saved choice for implementation.
Chopin owns the collaboration, controls and attributed decision record.

PR #412 currently supports only a fixed Chopin specimen. It remains a draft.
This proposal narrows the corrected PR to the rendering foundation; it does not
claim the MCP handoff exists yet.

## Rendering foundation in this PR

- Remove the public “Tune decision card” action. Keep specimen creation and
  example content in test fixtures, with no demo offered to production users.
- A card consumes a trusted preview-artifact reference, a decision title, an
  immutable baseline, and a bounded list of named controls.
- Each control has an ID and label. Numeric controls provide minimum, maximum
  and step; colour controls accept #RRGGBB and expose a colour picker with a hex
  field. The schema contains no Chopin-specific padding or colour field names.
- The server validates each patch against that card's immutable definition.
  Collaborators share accepted values; the latest accepted edit wins per control.
- Keep one adjusted preview, hold-to-peek baseline, responsive inspector, Reset,
  and revision-bound attributed Save. Document summaries use the control labels.
- The sandbox bridge sends validated parameter maps rather than the fixed
  specimen tuple. The preview receives no document or repository credentials.
- Artifact references resolve through the trusted server; a preview cannot choose
  the host's fetch target. Preserve the isolated-site deployment gate and bounded
  frame recovery. Public fixtures do not certify private-repository publication.
- Prove the same renderer handles two different fixtures with different names,
  controls and ranges. Cover brief reconnects and retry after a peer edit.

After this PR alone, normal users have no new demo button. A later publisher can
create a record which renders as a dynamic design card in the document/Decisions.

## Next PR: local-agent authoring and MCP publication

Chopin creates a durable preview request tied to the decision and source context.
A connected local coding agent picks it up through MCP, builds using the app and
design system in its checkout, and publishes the immutable preview plus control
definitions back to the request. MCP does not itself launch a local process.
Define pickup/claim/retry/cancellation, artifact publication and retention, and
the returned saved choice. Bind each record to the authored preview and source context. Resolve
access and delivery for artifacts derived from private repositories before
publishing them. Do not let the hosted Planner execute generated frontend code.

An alternative is to include the MCP round trip now. It would close the user flow,
but adds authoring, artifact delivery and privacy work to this already large PR.
The rendering-first split follows Maggie's stated preference to take a smaller step.
