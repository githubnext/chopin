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

Live application views can supply `stateKey` to preserve inspection and zoom
across updates to one graph, `nodePresentation` for full accessible labels and
semantic tones, and `renderNodeDetails` for application-owned inspector content.
Change `stateKey` when the graph identity or definition changes. These props are
reader-local presentation and do not extend the saved diagram specification.

Run the development gallery with `CHOPIN_DEV_WEB_PORT=5173 bun run --cwd apps/web dev` and open
`http://127.0.0.1:5173/diagram-gallery`. Its document specimen uses a local slot in the static
document viewer. Real saved documents use a `seecode` code fence containing one JSON spec:

````md
The browser sends a request to the API.

```seecode
{"type":"architecture","nodes":[{"id":"web","label":"Browser","row":0,"col":0},{"id":"api","label":"API","row":0,"col":1}],"edges":[["web","api"]]}
```
````

The fence is collaborative source text. The editor shows a derived viewer beside it and keeps
inspection and playback state local to each reader. Source is capped at 64 KiB before parsing;
`renderDiagram` validates the spec. An incomplete human edit shows an error without hiding its
source. Planner edits that introduce invalid specs fail before changing the document.

The development gallery uses `@chopin/diagrams/fixtures` for the 42 upstream examples.
The upstream `loop-terminal` alias is accepted as a loop variant; its `skin: "terminal"` hint
does not change the module's Chopin colour and font styling. Other legacy skin hints are also
presentational no-ops.
See [PROVENANCE.md](PROVENANCE.md) and [LICENSE](LICENSE) for the copied source and licence.
