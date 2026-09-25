import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ContrastReader } from "./contrast-reader";

let options = [
	{ id: "page", label: "Page", value: { l: 1, c: 0, h: 0 } },
	{ id: "ground", label: "Ground", value: { l: 0.96623, c: 0.0039, h: 95 } },
];

function render(props: Partial<Parameters<typeof ContrastReader>[0]> = {}) {
	return renderToStaticMarkup(
		<ContrastReader
			against="page"
			onAgainstChange={() => {}}
			onPurposeChange={() => {}}
			options={options}
			purpose="graphic"
			value={{ l: 0.6681, c: 0.0105, h: 95 }}
			{...props}
		/>,
	);
}

describe("ContrastReader", () => {
	test("shows the ratio and a passing verdict once", () => {
		let markup = render();
		expect(markup).toContain("3.00:1");
		expect(markup).toContain("Meets 3:1");
		expect(markup).toContain('data-tone="success"');
		expect(markup.match(/3\.00:1/g)!.length).toBe(1);
	});

	test("fails body text with the danger tone", () => {
		let markup = render({ purpose: "text" });
		expect(markup).toContain("Below 4.5:1");
		expect(markup).toContain('data-tone="danger"');
	});

	test("shows the previous ratio only when it differs", () => {
		expect(render({ previous: { l: 0.6681, c: 0.0105, h: 95 } })).not.toContain("was ");
		expect(render({ previous: { l: 0.74029, c: 0.00856, h: 95 } })).toContain("was 2.30:1");
	});

	test("falls back to the first option when the background id is unknown", () => {
		expect(render({ against: "missing" })).toContain("3.00:1");
	});

	test("renders a dash without any background options", () => {
		let markup = render({ options: [] });
		expect(markup).toContain("—");
		expect(markup).not.toContain("Meets");
	});
});
