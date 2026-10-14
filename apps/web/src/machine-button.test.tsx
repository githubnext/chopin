import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MachineButton, MachineGlyph } from "./machine-button";

import type { MachineChoice } from "./machine-choice";

function choice(service: boolean, connected: boolean): MachineChoice {
	return {
		state: {
			choice: "M_box",
			automatic: null,
			machines: [{
				id: "M_box",
				label: "build-box",
				connected,
				reauthorize: false,
				lastSeenAt: 0,
				version: null,
				hostname: null,
				platform: null,
				agent: null,
				service,
				planner: false,
			}],
		},
		saving: false,
		choose: async () => {},
		refresh: () => {},
	};
}

test("the button shows the chosen machine's icon, its state dot and its name", () => {
	let markup = renderToStaticMarkup(createElement(MachineButton, { choice: choice(true, true) }));
	expect(markup).toContain('aria-label="Machine: build-box, connected"');
	expect(markup).toContain('aria-haspopup="menu"');
	expect(markup).toContain('data-state="connected"');
	expect(markup).toContain(">build-box<");
	let offline = renderToStaticMarkup(
		createElement(MachineButton, { choice: choice(false, false), compact: true, phone: true }),
	);
	expect(offline).toContain('aria-label="Machine: build-box, offline"');
	expect(offline).toContain('data-state="offline"');
	// The icon alone on a phone; the name is in the accessible name.
	expect(offline).not.toContain(">build-box<");
});

test("a service runs on the server icon, a computer on the monitor, Automatic without a dot", () => {
	let server = renderToStaticMarkup(
		createElement(MachineGlyph, {
			machine: { service: true, connected: true, reauthorize: false },
		}),
	);
	let computer = renderToStaticMarkup(
		createElement(MachineGlyph, {
			machine: { service: false, connected: true, reauthorize: false },
		}),
	);
	let automatic = renderToStaticMarkup(createElement(MachineGlyph, {}));
	expect(server).not.toBe(computer);
	expect(automatic).toContain("data-automatic");
	expect(automatic).not.toContain("status-dot");
});
