# `@chopin/diagrams`

SeeCode-derived diagram rendering for resolved, declarative specifications. `renderDiagram(input)`
returns either a deterministic SVG fragment, geometry, motion and graph metadata, or structured
problems. It does not load files, fetch URLs, or create an SVG element. The React adapter wraps and
scopes the fragment for the browser.

```ts
import { renderDiagram } from "@chopin/diagrams";

const result = renderDiagram({
	type: "architecture",
	nodes: [
		{ id: "web", label: "Web", row: 0, col: 0 },
		{ id: "api", label: "API", row: 0, col: 1 },
	],
	edges: [["web", "api"]],
});
```

The development gallery uses `@chopin/diagrams/fixtures` for the 42 upstream examples.
The upstream `loop-terminal` alias is accepted as a loop variant; its `skin: "terminal"` hint
does not change the module's Chopin colour and font styling. Other legacy skin hints are also
presentational no-ops.
See [PROVENANCE.md](PROVENANCE.md) and [LICENSE](LICENSE) for the copied source and licence.
