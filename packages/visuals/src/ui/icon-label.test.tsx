import { CheckIcon } from "@chopin/icons";
import { IconLabel } from "@chopin/visuals";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

test("renders a visible label and decorative icon through the public API", () => {
	let html = renderToStaticMarkup(
		<IconLabel
			className="custom-label"
			data-example="ready"
			icon={CheckIcon}
			label="Ready"
			title="Ready status"
		/>,
	);

	expect(html).toStartWith("<span");
	expect(html).not.toContain("<button");
	expect(html).toContain('class="cv-semantic cv-icon-label custom-label"');
	expect(html).toContain('data-tone="neutral"');
	expect(html).toContain('data-example="ready"');
	expect(html).toContain('title="Ready status"');
	expect(html).toContain('aria-hidden="true"');
	expect(html).toContain(">Ready</span>");
});

test("renders every semantic tone", () => {
	for (let tone of ["neutral", "success", "warning", "danger"] as const) {
		let html = renderToStaticMarkup(
			<IconLabel icon={CheckIcon} label={`${tone} status`} tone={tone} />,
		);

		expect(html).toContain(`data-tone="${tone}"`);
	}
});
