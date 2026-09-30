import { RollingNumber } from "@chopin/visuals";
import type { RollingNumberProps } from "@chopin/visuals";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

let integer = new Intl.NumberFormat("en-US");

function columns(markup: string): string[] {
	return [...markup.matchAll(/--cv-rolling-digit:(\d)/g)].map(match => match[1]!);
}

function keyed(value: number, format: Intl.NumberFormat) {
	let element = RollingNumber({ format, value });
	let children = element.props.children[1] as { key: string; props: { className?: string } }[];
	return children.map(child => ({ digit: child.props.className !== undefined, key: child.key }));
}

test("exports RollingNumber and its props from the public package entry", () => {
	let props: RollingNumberProps = { format: integer, value: 42 };

	expect(typeof RollingNumber).toBe("function");
	expect(props.value).toBe(42);
});

test("announces the formatted value once and hides the rolling columns", () => {
	let markup = renderToStaticMarkup(
		<RollingNumber
			className="custom-count"
			data-sample="requests"
			format={integer}
			id="request-count"
			value={1234}
		/>,
	);

	expect(markup.startsWith("<span")).toBe(true);
	expect(markup).toContain('class="cv-rolling-number custom-count"');
	expect(markup).toContain('data-slot="rolling-number"');
	expect(markup).toContain('data-sample="requests"');
	expect(markup).toContain('id="request-count"');
	expect(markup).toContain('<span class="cv-rolling-number-label">1,234</span>');
	// Four digit columns plus the static group separator.
	expect(markup.match(/aria-hidden="true"/g)).toHaveLength(5);
	expect(markup.match(/class="cv-rolling-number-column"/g)).toHaveLength(4);
});

test("gives every digit a full 0-9 column translated to its value", () => {
	let markup = renderToStaticMarkup(<RollingNumber format={integer} value={907} />);

	expect(columns(markup)).toEqual(["9", "0", "7"]);
	expect(markup.match(/<span>\d<\/span>/g)).toHaveLength(30);
});

test("rolls fraction digits and renders separators, signs, and symbols statically", () => {
	let currency = new Intl.NumberFormat("en-US", { currency: "USD", style: "currency" });
	let percent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, style: "percent" });

	let money = renderToStaticMarkup(<RollingNumber format={currency} value={-1234.5} />);
	let share = renderToStaticMarkup(<RollingNumber format={percent} value={0.625} />);

	expect(columns(money)).toEqual(["1", "2", "3", "4", "5", "0"]);
	expect(money).toContain("-$1,234.50</span>");
	for (let char of ["-", "$", ",", "."]) {
		expect(money).toContain(`<span aria-hidden="true">${char}</span>`);
	}
	expect(columns(share)).toEqual(["6", "2", "5"]);
	expect(share).toContain('<span aria-hidden="true">%</span>');
});

test("keys parts from the right so existing columns persist when the number grows", () => {
	let before = keyed(99, integer);
	let after = keyed(100, integer);

	expect(before).toEqual([{ digit: true, key: "2" }, { digit: true, key: "1" }]);
	expect(after).toEqual([
		{ digit: true, key: "3" },
		{ digit: true, key: "2" },
		{ digit: true, key: "1" },
	]);
});

test("renders non-finite values statically without invalid column offsets", () => {
	let markup = renderToStaticMarkup(<RollingNumber format={integer} value={Number.NaN} />);
	let infinite = renderToStaticMarkup(
		<RollingNumber format={integer} value={Number.POSITIVE_INFINITY} />,
	);

	expect(columns(markup)).toEqual([]);
	expect(columns(infinite)).toEqual([]);
	expect(markup).toContain('<span class="cv-rolling-number-label">NaN</span>');
	expect(infinite).toContain('<span class="cv-rolling-number-label">∞</span>');
});

test("moves on shared motion tokens and stops for reduced motion", async () => {
	let css = await Bun.file(new URL("./rolling-number.css", import.meta.url)).text();
	let styles = await Bun.file(new URL("../styles.css", import.meta.url)).text();

	expect(styles).toContain('@import "./ui/rolling-number.css";');
	expect(css).toContain("font-variant-numeric: tabular-nums;");
	expect(css).toContain("transform: translateY(calc(var(--cv-rolling-digit, 0) * -1em));");
	expect(css).toContain("transition: transform var(--duration-linger) var(--motion-smooth-out);");
	expect(css).toMatch(
		/@media \(prefers-reduced-motion: reduce\) {\s*\.cv-rolling-number-column {\s*transition: none;/,
	);
	expect(css).not.toMatch(/\d+m?s\b|cubic-bezier|#[\da-f]{3,8}|(?:oklch|rgb|hsl)\(/i);
});
