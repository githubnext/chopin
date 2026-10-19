import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BuildPlanButton } from "./build-plan-button";
import { MachineButton, MachineGlyph } from "./machine-button";

import type { MachineChoice } from "./machine-choice";

function choice(service: boolean, connected: boolean): MachineChoice {
	return {
		state: {
			choice: "M_box",
			favorite: null,
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

test("the button is an icon with the machine's state dot, named for where the document runs", () => {
	let markup = renderToStaticMarkup(createElement(MachineButton, { choice: choice(true, true) }));
	expect(markup).toContain('aria-label="Runs on build-box"');
	expect(markup).toContain('data-tooltip="Runs on build-box"');
	expect(markup).toContain('aria-haspopup="menu"');
	expect(markup).toContain('data-state="connected"');
	// Icon only: the name is in the accessible name and tooltip.
	expect(markup).not.toContain(">build-box<");
	let offline = renderToStaticMarkup(
		createElement(MachineButton, { choice: choice(false, false), phone: true }),
	);
	expect(offline).toContain('aria-label="Runs on build-box"');
	expect(offline).toContain('data-state="offline"');
});

test("with no explicit choice the button shows the machine Automatic uses; none is a bare laptop", () => {
	let automatic = choice(true, true);
	automatic.state!.choice = null;
	automatic.state!.automatic = { id: "M_box", label: "build-box" };
	let markup = renderToStaticMarkup(createElement(MachineButton, { choice: automatic }));
	expect(markup).toContain('aria-label="Runs on build-box"');
	expect(markup).toContain('data-state="connected"');
	let none = choice(false, false);
	none.state!.choice = null;
	none.state!.machines = [];
	let bare = renderToStaticMarkup(createElement(MachineButton, { choice: none }));
	expect(bare).toContain('aria-label="Runs on: no machine connected"');
	expect(bare).not.toContain("status-dot");
	expect(bare).not.toContain("machine-offline");
});

test("a service runs on the cloud icon, a computer on the laptop, no machine without a dot", () => {
	let cloud = renderToStaticMarkup(
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
	expect(cloud).not.toBe(computer);
	expect(automatic).toContain("data-automatic");
	expect(automatic).not.toContain("status-dot");
});

test("offline looks the same everywhere: the machine button and Build plan dimmed, never worded", () => {
	let connected = renderToStaticMarkup(
		createElement(MachineButton, { choice: choice(true, true) }),
	);
	expect(connected).not.toContain("machine-offline");
	for (let phone of [false, true]) {
		let button = renderToStaticMarkup(
			createElement(MachineButton, { choice: choice(true, false), phone }),
		);
		// Still a button that opens the menu, dimmed; the state is only in its accessible name.
		expect(button).toContain('class="machine-button machine-offline"');
		expect(button).not.toContain("disabled");
		expect(button.replace(/<[^>]*>/g, "")).not.toMatch(/offline/i);
		expect(button).not.toMatch(/data-tooltip="[^"]*offline/i);
	}
	let build = { look: { kind: "plan" }, press: () => {} } as never;
	let plan = renderToStaticMarkup(
		createElement(BuildPlanButton, {
			build,
			canEdit: true,
			machineOffline: "build-box is offline",
			onHover: () => {},
			onOpen: () => {},
		}),
	);
	expect(plan).toContain('aria-disabled="true"');
	expect(plan).not.toContain(" disabled=");
	expect(plan).toMatch(/class="[^"]*\bbuild-plan\b[^"]*\bmachine-offline\b/);
	expect(plan).toContain(">Build plan</button>");
	expect(plan).not.toContain("data-tooltip");
	// The reason is its accessible description, not text beside it.
	let described = /aria-describedby="([^"]+)"/.exec(plan)![1];
	expect(plan).toContain(`<span class="sr-only" id="${described}">build-box is offline</span>`);
});
