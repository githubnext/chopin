import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
	disclosureAccessibility,
	MotionDisclosure,
	MotionDisclosureIcon,
} from "./disclosure-motion";

let motion = {
	className: "motion-collapse",
	closeDuration: 250,
	contentClassName: "contract-collapse-content",
	iconClassName: "contract-disclosure-icon",
};

test("renders open disclosure content with the supplied motion contract", () => {
	let markup = renderToStaticMarkup(
		createElement(
			MotionDisclosure,
			{
				children: "Details",
				id: "details",
				immediately: false,
				motion,
				open: true,
				surface: "sidebar",
			},
		),
	);

	expect(markup).toContain('id="details"');
	expect(markup).toContain('data-motion-disclosure="sidebar"');
	expect(markup).toContain('class="contract-collapse-content"');
});

test("renders disclosure icons with the supplied motion contract", () => {
	let markup = renderToStaticMarkup(
		createElement(MotionDisclosureIcon, { children: "Icon", motion, open: true }),
	);

	expect(markup).toContain('class="contract-disclosure-icon"');
	expect(markup).toContain('data-open=""');
});

test("renders closed disclosures without retained content", () => {
	let markup = renderToStaticMarkup(
		createElement(
			MotionDisclosure,
			{
				children: "Details",
				id: "details",
				immediately: true,
				motion,
				open: false,
				surface: "sidebar",
			},
		),
	);

	expect(markup).toBe("");
});

test("hides closing content from assistive technology and interaction", () => {
	expect(disclosureAccessibility("closing")).toEqual({
		ariaHidden: "true",
		inert: true,
	});
});
