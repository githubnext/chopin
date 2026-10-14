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
		favor: async () => {},
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

test("offline looks the same everywhere: the machine button and Build plan dimmed, never worded", () => {
	let connected = renderToStaticMarkup(
		createElement(MachineButton, { choice: choice(true, true) }),
	);
	expect(connected).not.toContain("machine-offline");
	for (let compact of [false, true]) {
		let button = renderToStaticMarkup(
			createElement(MachineButton, { choice: choice(true, false), compact }),
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

test("in Chat, a Planner another account holds makes the button read-only", () => {
	let held = choice(true, true);
	held.state!.planner = { state: "held", login: "rival", machine: null };
	let markup = renderToStaticMarkup(createElement(MachineButton, { choice: held, planner: true }));
	expect(markup).toContain('aria-label="Planner held by @rival"');
	expect(markup).toContain('aria-disabled="true"');
	expect(markup).not.toContain("aria-haspopup");
	expect(markup).toContain(">Held by @rival<");
	// Build plan's button still chooses the machine.
	let build = renderToStaticMarkup(createElement(MachineButton, { choice: held }));
	expect(build).toContain('aria-haspopup="menu"');
	let starting = choice(true, true);
	starting.state!.planner = { state: "starting", login: null, machine: "M_box" };
	let shown = renderToStaticMarkup(
		createElement(MachineButton, { choice: starting, planner: true }),
	);
	expect(shown).toContain('aria-label="Machine: build-box, starting the Planner"');
	expect(shown).toContain(">Starting…<");
});
