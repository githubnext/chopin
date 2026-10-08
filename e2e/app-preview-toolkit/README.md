# Local app preview example

Run `bun run preview-toolkit:dev`, then open <http://127.0.0.1:8810>.
The command builds once with pinned Vite and serves static resources. There is
no development compiler running after the build. To review an existing build,
run `bun e2e/app-preview-toolkit/server.ts --built`.

The adjusted frame is served on port 8811 with `sandbox="allow-scripts"`.
The source reference is <http://127.0.0.1:8811/fixture-app/index.html>. Both import
the same billing card, children, theme, bundled mark and local font. Only the
preview adapter maps the controls into card props; the fixture imports no helpers.

Spacing has a slider and numeric input. Hold **Show current** to compare with the
source baseline; releasing restores the chosen values. Reset explicitly chooses
the baseline. Copy and Download produce local JSON, with no shared persistence.

`.built/resources.json` lists the built resources and their SHA-256 checksums;
it excludes its own manifest. This is local example metadata, not a production
integrity policy or an external result schema. Generated files stay uncommitted.

The example transport checks sender identity, origin and request order. The
opaque sandbox requires permissive resource CORS on this loopback-only server.
The ports are fixed and the harness supports one illustrative component. Retry
rebuilds locally and reloads the frame while retaining host-owned chosen values.
