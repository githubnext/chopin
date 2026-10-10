# Capabilities and delivery

Inspect the tools, initialization instructions and descriptors actually supplied
in the current session. Use their resource requirements, schemas, identity and
retry semantics for any authorized publication. This skill defines no MCP tool
names, upload envelope, chart API or arbitrary document JSX capability.

When preview pickup or delivery is absent, finish a local build and return its
entry point, resource list and evidence. Explicitly report integration absent.
An available document tool does not establish executable-preview support; use
only its documented document components. Built preview code belongs outside
document evaluation.

The helpers expose `PreviewDefinition`, `Snapshot`, `Result`,
`validateDefinition`, `validateSnapshot` and `createPreview`. Number controls have
`id`, `label`, `unit`, `min`, `max`, `step`; colour controls have `id` and `label`.
Baselines and updates contain exactly one value per control. Number values must
be finite, in range and on the step grid anchored at `min`; colour values use
`#RRGGBB`. Validation rejects a snapshot before invoking its renderer.

`createPreview(definition, render)` returns `Result<Preview>`; a successful value
has `definition`, asynchronous `apply(unknown)` and `reset()`. Calls are serialized
and renderer exceptions become a `render` error. Creation does not render: apply
`definition.baseline` or call `reset()` explicitly. No helper mounts controls,
transports messages or guarantees browser paint.

For a local host, keep chosen values authoritative while rendering a temporary
baseline comparison. Release, cancellation, capture loss, key release, blur and
visibility loss must restore chosen values. Reset deliberately selects baseline.
Copy/download may export local values; they establish no shared Save or decision.
Use the supplied production host when available, following its actual contract.
