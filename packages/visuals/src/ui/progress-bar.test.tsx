import { ProgressBar } from "@chopin/visuals";
import type { ProgressBarProps } from "@chopin/visuals";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

test("exports ProgressBar and its props from the public package entry", () => {
	let props: ProgressBarProps = { label: "Upload progress", value: 42 };

	expect(typeof ProgressBar).toBe("function");
	expect(props.value).toBe(42);
});

test("renders an authoritative accessible shell and forwards span props", () => {
	let markup = renderToStaticMarkup(
		<ProgressBar
			aria-label="Ignored label"
			aria-valuemax={800}
			aria-valuemin={-10}
			aria-valuenow={700}
			className="custom-progress"
			data-sample="upload"
			data-slot="ignored-slot"
			id="upload-progress"
			label="Upload progress"
			role="presentation"
			value={42}
		/>,
	);

	expect(markup.startsWith("<span")).toBe(true);
	expect(markup).toContain('role="progressbar"');
	expect(markup).toContain('aria-label="Upload progress"');
	expect(markup).toContain('aria-valuemin="0"');
	expect(markup).toContain('aria-valuemax="100"');
	expect(markup).toContain('aria-valuenow="42"');
	expect(markup).not.toContain("Ignored label");
	expect(markup).not.toContain('aria-valuemax="800"');
	expect(markup).not.toContain('aria-valuemin="-10"');
	expect(markup).not.toContain('aria-valuenow="700"');
	expect(markup).toContain('class="cv-progress-bar custom-progress"');
	expect(markup).toContain('data-sample="upload"');
	expect(markup).toContain('data-slot="progress-bar"');
	expect(markup).not.toContain('data-slot="ignored-slot"');
	expect(markup).toContain('id="upload-progress"');
	expect(markup).toContain('class="cv-progress-bar-track"');
	expect(markup).toContain('class="cv-progress-bar-fill"');
	expect(markup).toContain('class="cv-progress-bar-value">42%</span>');
	expect(markup.match(/aria-hidden="true"/g)).toHaveLength(3);
});

test("normalizes every numeric input without emitting invalid progress values", () => {
	let cases = [
		[42, 42],
		[37.5, 37.5],
		[0, 0],
		[100, 100],
		[-1, 0],
		[101, 100],
		[Number.MAX_VALUE, 100],
		[-Number.MAX_VALUE, 0],
		[Number.NaN, 0],
		[Number.POSITIVE_INFINITY, 0],
		[Number.NEGATIVE_INFINITY, 0],
	] as const;

	for (let [value, normalized] of cases) {
		let markup = renderToStaticMarkup(
			<ProgressBar label={`Progress ${normalized}`} value={value} />,
		);

		expect(markup).toContain(`aria-valuenow="${normalized}"`);
		expect(markup).toContain(`style="width:${normalized}%"`);
		expect(markup).toContain(`class="cv-progress-bar-value">${normalized}%</span>`);
		expect(markup).not.toMatch(/NaN|Infinity/);
	}
});

test("uses only existing tokens for the compact progress treatment", async () => {
	let css = await Bun.file(new URL("./progress-bar.css", import.meta.url)).text();
	let styles = await Bun.file(new URL("../styles.css", import.meta.url)).text();

	expect(styles).toContain('@import "./ui/progress-bar.css";');
	expect(css).toContain("width: calc(var(--spacing) * 17);");
	expect(css).toContain("height: calc(var(--spacing) * 2.5);");
	expect(css).toContain("overflow: hidden;");
	expect(css).toContain("border-radius: var(--radius-xl);");
	expect(css).toContain("background: var(--color-brand);");
	expect(css).toContain("font-size: var(--text-sm);");
	expect(css).toContain("line-height: var(--text-sm--line-height);");
	expect(css).toContain("font-variant-numeric: tabular-nums;");
	expect(css).not.toMatch(/#[\da-f]{3,8}|(?:oklch|rgb|hsl)\(/i);
});
