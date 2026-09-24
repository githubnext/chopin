import { CheckIcon } from "@chopin/icons";
import { Badge } from "@chopin/visuals";
import type { BadgeProps } from "@chopin/visuals";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

test("exports Badge and its props from the public package entry", () => {
	let props: BadgeProps = { icon: CheckIcon, label: "Ready" };

	expect(typeof Badge).toBe("function");
	expect(props.label).toBe("Ready");
});

test("composes a noninteractive visible IconLabel inside an authoritative Badge span", () => {
	let markup = renderToStaticMarkup(
		<Badge
			className="custom-badge"
			data-example="ready"
			data-slot="ignored-slot"
			data-tone="danger"
			icon={CheckIcon}
			id="ready-badge"
			label="Ready"
			title="Ready state"
		/>,
	);

	expect(markup.startsWith("<span")).toBe(true);
	expect(markup).not.toContain("<button");
	expect(markup).not.toContain('role="status"');
	expect(markup).not.toContain("aria-live");
	expect(markup).toContain('class="cv-semantic cv-badge custom-badge"');
	expect(markup).toContain('data-slot="badge"');
	expect(markup).not.toContain('data-slot="ignored-slot"');
	expect(markup).toContain('data-tone="neutral"');
	expect(markup).not.toContain('data-tone="danger"');
	expect(markup).toContain('data-example="ready"');
	expect(markup).toContain('id="ready-badge"');
	expect(markup).toContain('title="Ready state"');
	expect(markup).toContain('data-slot="icon-label"');
	expect(markup).toContain('aria-hidden="true"');
	expect(markup).toContain(">Ready</span>");
});

test("renders every protected semantic tone through the Badge and IconLabel", () => {
	for (let tone of ["neutral", "success", "warning", "danger"] as const) {
		let markup = renderToStaticMarkup(
			<Badge
				data-tone="ignored-tone"
				icon={CheckIcon}
				label={`${tone} state`}
				tone={tone}
			/>,
		);

		expect(markup.match(new RegExp(`data-tone="${tone}"`, "g"))).toHaveLength(2);
		expect(markup).not.toContain('data-tone="ignored-tone"');
	}
});

test("uses token-only compact pill styles with bounded label truncation", async () => {
	let css = await Bun.file(new URL("./badge.css", import.meta.url)).text();
	let iconLabelCss = await Bun.file(new URL("./icon-label.css", import.meta.url)).text();
	let styles = await Bun.file(new URL("../styles.css", import.meta.url)).text();

	expect(styles).toContain('@import "./ui/badge.css";');
	expect(css).toContain("display: inline-flex;");
	expect(css).toContain("min-width: 0;");
	expect(css).toContain("max-width: 100%;");
	expect(css).toContain("min-height: calc(var(--spacing) * 6);");
	expect(css).toContain(
		"padding: var(--spacing) calc(var(--spacing) * 2.5) var(--spacing) calc(var(--spacing) * 2);",
	);
	expect(css).toContain("overflow: hidden;");
	expect(css).toContain("border-radius: 999px;");
	expect(css).toContain("background: var(--cv-semantic-surface);");
	expect(css).toContain("border: var(--edge-width) solid");
	expect(css).toContain(
		"color-mix(in srgb, var(--color-current) 12%, var(--cv-semantic-surface));",
	);
	expect(css).toContain("font-size: var(--text-sm);");
	expect(css).toContain("line-height: var(--text-sm--line-height);");
	expect(iconLabelCss).toContain("text-overflow: ellipsis;");
	expect(css).not.toMatch(/#[\da-f]{3,8}|(?:oklch|rgb|hsl)\(/i);
});
