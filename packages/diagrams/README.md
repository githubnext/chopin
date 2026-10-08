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

For a browser view, import `Diagram` from `@chopin/diagrams/react` and the scoped
`@chopin/diagrams/styles.css`, then render `<Diagram spec={spec} />`. Each instance owns its
inspection, focus, animation, and SVG resource IDs. The viewer is intended for client rendering;
server-rendered hydration needs a separately verified ID strategy.

Run the development gallery with `CHOPIN_DEV_WEB_PORT=5173 bun run --cwd apps/web dev` and open
`http://127.0.0.1:5173/diagram-gallery`. Its document specimen uses a local slot in the static
document viewer; diagrams are not persisted document nodes.

The development gallery uses `@chopin/diagrams/fixtures` for the 42 upstream examples.
The upstream `loop-terminal` alias is accepted as a loop variant; its `skin: "terminal"` hint
does not change the module's Chopin colour and font styling. Other legacy skin hints are also
presentational no-ops.
See [PROVENANCE.md](PROVENANCE.md) and [LICENSE](LICENSE) for the copied source and licence.
