import { MiniBars } from "@chopin/visuals";
import type { MiniBarsProps } from "@chopin/visuals";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

test("exports MiniBars and its props from the public package entry", () => {
	let props: MiniBarsProps = { label: "Traffic", values: [1, 2, 3] };

	expect(typeof MiniBars).toBe("function");
	expect(props.values).toEqual([1, 2, 3]);
});

test("renders an authoritative accessible SVG shell for empty data", () => {
	let markup = renderToStaticMarkup(
		<MiniBars
			aria-label="Ignored label"
			className="custom-bars"
			data-sample="empty"
			id="traffic-bars"
			label="No traffic history"
			role="presentation"
			tone="warning"
			values={[]}
		/>,
	);
	let invalid = renderToStaticMarkup(
		<MiniBars
			label="No finite traffic history"
			values={[Number.NaN, Number.POSITIVE_INFINITY]}
		/>,
	);

	expect(markup.startsWith(["<", "svg"].join(""))).toBe(true);
	expect(markup).toContain('role="img"');
	expect(markup).toContain('aria-label="No traffic history"');
	expect(markup).not.toContain("Ignored label");
	expect(markup).toContain('class="cv-semantic cv-mini-bars custom-bars"');
	expect(markup).toContain('data-slot="mini-bars"');
	expect(markup).toContain('data-tone="warning"');
	expect(markup).toContain('data-sample="empty"');
	expect(markup).toContain('id="traffic-bars"');
	expect(markup).toContain('viewBox="0 0 64 24"');
	expect(markup).not.toContain("<rect");
	expect(invalid).not.toContain("<rect");

	for (let tone of ["neutral", "success", "warning", "danger"] as const) {
		let toneMarkup = renderToStaticMarkup(
			<MiniBars label={`${tone} traffic`} tone={tone} values={[]} />,
		);
		expect(toneMarkup).toContain(`data-tone="${tone}"`);
	}
});

test("renders one extreme finite value as one full-height rounded bar", () => {
	let markup = renderToStaticMarkup(
		<MiniBars label="Peak traffic" values={[Number.MAX_VALUE]} />,
	);

	expect(markup).toContain('<rect height="20" rx="2" width="64" x="0" y="2"');
	expect(markup).not.toMatch(/NaN|Infinity/);
});

test("clamps non-positive values and scales positive bars within the series", () => {
	let markup = renderToStaticMarkup(
		<MiniBars label="Traffic distribution" values={[-2, 0, 5, 10]} />,
	);
	let zeroMarkup = renderToStaticMarkup(
		<MiniBars label="No positive traffic" values={[0, -4]} />,
	);
	let heights = Array.from(
		markup.matchAll(/<rect[^>]*height="([^"]+)"/g),
		([, height]) => Number(height),
	);
	let zeroHeights = Array.from(
		zeroMarkup.matchAll(/<rect[^>]*height="([^"]+)"/g),
		([, height]) => Number(height),
	);

	expect(heights).toEqual([0, 0, 10, 20]);
	expect(zeroHeights).toEqual([0, 0]);
	expect(zeroMarkup).not.toMatch(/NaN|Infinity/);
});

test("filters invalid data before laying out the latest five bars", () => {
	let markup = renderToStaticMarkup(
		<MiniBars
			label="Recent traffic"
			values={[100, 200, Number.NaN, Number.POSITIVE_INFINITY, 1, 2, 3, 4]}
		/>,
	);
	let bars = Array.from(
		markup.matchAll(/<rect[^>]*height="([^"]+)"[^>]*width="([^"]+)"[^>]*x="([^"]+)"/g),
		([, height, width, x]) => ({
			height: Number(height),
			width: Number(width),
			x: Number(x),
		}),
	);

	expect(markup).toContain('viewBox="0 0 64 24"');
	expect(markup).not.toMatch(/NaN|Infinity/);
	expect(bars).toHaveLength(5);
	expect(bars.map(bar => bar.height)).toEqual([20, 0.1, 0.2, 0.3, 0.4]);
	expect(bars[1]!.x - (bars[0]!.x + bars[0]!.width)).toBeCloseTo(2);
	expect(bars.every(bar => bar.x >= 0 && bar.x + bar.width <= 64)).toBe(true);
	expect(markup.match(/rx="2"/g)).toHaveLength(5);
});

test("uses gray 400 for neutral bars and semantic graphic fill for other tones", async () => {
	let css = await Bun.file(new URL("./mini-bars.css", import.meta.url)).text();
	let styles = await Bun.file(new URL("../styles.css", import.meta.url)).text();

	expect(styles).toContain('@import "./ui/mini-bars.css";');
	expect(css).toContain("width: calc(var(--spacing) * 16);");
	expect(css).toContain("height: calc(var(--spacing) * 6);");
	expect(css).toContain("fill: var(--cv-semantic-graphic);");
	expect(css).toMatch(
		/\.cv-mini-bars\[data-tone="neutral"\]\s*\{\s*--cv-semantic-graphic:\s*var\(--color-gray-400\);\s*\}/,
	);
	expect(css).toContain("background: transparent;");
	expect(css).not.toMatch(/#[\da-f]{3,8}|(?:oklch|rgb|hsl)\(/i);
});
