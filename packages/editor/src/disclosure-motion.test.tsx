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

test("renders keyed disclosure glyphs for their open state", () => {
	let closed = renderToStaticMarkup(
		createElement(MotionDisclosureIcon, {
			className: "host-feedback",
			closed: "Closed",
			open: false,
			opened: "Opened",
		}),
	);
	let opened = renderToStaticMarkup(
		createElement(MotionDisclosureIcon, {
			className: "host-feedback",
			closed: "Closed",
			open: true,
			opened: "Opened",
		}),
	);

	expect(closed).toContain('data-feedback-icon="closed"');
	expect(closed).toContain('data-motion-feedback="icon"');
	expect(closed).toContain('class="host-feedback inline-flex"');
	expect(closed).toContain("Closed");
	expect(closed).not.toContain("Opened");
	expect(opened).toContain('data-feedback-icon="open"');
	expect(opened).toContain("Opened");
	expect(opened).not.toContain("Closed");
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
