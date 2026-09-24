import { Sparkline } from "@chopin/visuals";
import type { SparklineProps } from "@chopin/visuals";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

test("exports Sparkline and its props from the public package entry", () => {
	let props: SparklineProps = { label: "Request trend", values: [1, 2, 3] };

	expect(typeof Sparkline).toBe("function");
	expect(props.values).toEqual([1, 2, 3]);
});

describe("Sparkline geometry", () => {
	test("keeps an empty series as an accessible SVG and forwards SVG props", () => {
		let markup = renderToStaticMarkup(
			<Sparkline
				className="custom-chart"
				data-sample="empty"
				id="request-trend"
				label="No request history"
				values={[]}
			/>,
		);

		expect(markup.startsWith(["<", "svg"].join(""))).toBe(true);
		expect(markup).toContain('role="img"');
		expect(markup).toContain('aria-label="No request history"');
		expect(markup).toContain('class="cv-semantic cv-sparkline custom-chart"');
		expect(markup).toContain('data-tone="neutral"');
		expect(markup).toContain('data-sample="empty"');
		expect(markup).toContain('id="request-trend"');
		expect(markup).not.toContain("<path");
		expect(markup).not.toContain("<circle");
	});

	test("renders one finite value as a centered dot", () => {
		let markup = renderToStaticMarkup(
			<Sparkline label="One request sample" values={[Number.NaN, 8, Number.POSITIVE_INFINITY]} />,
		);

		expect(markup).toContain('<circle cx="36" cy="16" r="1.5"');
		expect(markup).not.toContain("<path");
	});

	test("spans a finite series across a rounded 72 by 32 path", () => {
		let markup = renderToStaticMarkup(
			<Sparkline label="Request trend" tone="success" values={[4, 6, 5, 8]} />,
		);

		expect(markup).toContain('viewBox="0 0 72 32"');
		expect(markup).toContain('<path d="M 0 30');
		expect(markup.match(/ Q /g)).toHaveLength(2);
		expect(markup).toContain('L 72 2"');
		expect(markup).toContain('data-tone="success"');
	});

	test("centers a constant series as a horizontal line", () => {
		let markup = renderToStaticMarkup(
			<Sparkline label="Steady request trend" values={[5, 5, 5]} />,
		);

		expect(markup).toContain('<path d="M 0 16 L 72 16"');
	});

	test("filters non-finite values without leaking invalid SVG coordinates", () => {
		let markup = renderToStaticMarkup(
			<Sparkline
				label="Sanitized request trend"
				values={[4, Number.NaN, 6, Number.NEGATIVE_INFINITY, 5]}
			/>,
		);
		let empty = renderToStaticMarkup(
			<Sparkline
				label="No finite request trend"
				values={[Number.NaN, Number.POSITIVE_INFINITY]}
			/>,
		);
		let extreme = renderToStaticMarkup(
			<Sparkline
				label="Extreme request trend"
				values={[-Number.MAX_VALUE, Number.MAX_VALUE]}
			/>,
		);

		expect(markup).toContain("<path");
		expect(markup).not.toMatch(/NaN|Infinity/);
		expect(empty).not.toContain("<path");
		expect(empty).not.toContain("<circle");
		expect(extreme).not.toMatch(/NaN|Infinity/);
	});

	test("renders a long finite series with a bounded path and retains a narrow peak", () => {
		let values = Array<number>(1_000_000).fill(0);
		values[500_000] = 10;
		let markup = renderToStaticMarkup(<Sparkline label="Long request trend" values={values} />);

		expect(markup).toContain("<path");
		expect(markup).toContain("Q 36 2");
		expect(markup).not.toMatch(/NaN|Infinity/);
		expect(markup.length).toBeLessThan(20_000);
	});
});

test("uses semantic graphic color and existing size tokens", async () => {
	let css = await Bun.file(new URL("./sparkline.css", import.meta.url)).text();
	let styles = await Bun.file(new URL("../styles.css", import.meta.url)).text();

	expect(styles).toContain('@import "./ui/sparkline.css";');
	expect(css).toContain("width: calc(var(--spacing) * 18);");
	expect(css).toContain("height: calc(var(--spacing) * 8);");
	expect(css).toContain("stroke: var(--cv-semantic-graphic);");
	expect(css).toContain("fill: var(--cv-semantic-graphic);");
	expect(css).toContain("stroke-linecap: round;");
	expect(css).toContain("stroke-linejoin: round;");
	expect(css).toContain("background: transparent;");
	expect(css).not.toMatch(/#[\da-f]{3,8}|(?:oklch|rgb|hsl)\(/i);
});
