import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BuildPlanButton } from "./build-plan-button";
import { PLANNER_HOW_TO_FIX, plannerStatus } from "./chat/planner-status";
import { MachineButton, MachineGlyph, PlannerNote } from "./machine-button";

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
				createdAt: 0,
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

const AT = "2026-11-04T18:29:00.000Z";

function button(planner: Parameters<typeof plannerStatus>[0], phone = false): string {
	return renderToStaticMarkup(
		createElement(MachineButton, {
			choice: choice(true, true),
			phone,
			planner: plannerStatus(planner, "build-box"),
		}),
	);
}

test("a healthy Planner leaves the button and its machine's dot exactly as they were", () => {
	let healthy = button({ state: "attached", login: "mona" });
	expect(healthy).toContain('aria-label="Runs on build-box"');
	expect(healthy).toContain('data-state="connected"');
	expect(healthy).not.toContain("data-planner");
	expect(healthy).not.toContain("aria-describedby");
});

test("a starting Planner turns the dot into a spinner and says where it is starting", () => {
	let markup = button({ state: "starting", login: "mona" });
	expect(markup).toContain('aria-label="Runs on build-box. Connecting to build-box"');
	expect(markup).toContain('data-tooltip="Runs on build-box. Connecting to build-box"');
	expect(markup).toContain('data-planner="starting"');
	expect(markup).toMatch(/class="status-dot machine-glyph-dot" data-planner="starting"/);
});

test("a Planner that cannot start is a warning dot, its reason the button's description", () => {
	let markup = button({
		state: "starting",
		login: "mona",
		failure: { attempts: 3, reason: "The checkout’s git config sets a credential helper", at: AT },
	});
	expect(markup).toContain(
		'aria-label="Runs on build-box. Can’t connect to build-box."',
	);
	expect(markup).toContain('data-planner="failing"');
	let described = /aria-describedby="([^"]+)"/.exec(markup)![1];
	expect(markup).toMatch(
		new RegExp(
			`<span class="sr-only" id="${described}">The checkout’s git config sets a credential helper. Tried 3 times, last at [^<]+. Still trying.</span>`,
		),
	);
});

test("a disconnected or detached Planner is a muted dot, a missing one changes nothing but the name", () => {
	for (
		let planner of [
			{ state: "disconnected", login: "mona" },
			{ state: "held", login: "mona", until: AT },
		] as const
	) {
		let markup = button(planner, true);
		expect(markup).toContain('data-planner="away"');
		expect(markup).toContain('data-phone="true"');
	}
	let none = button({ state: "none" });
	expect(none).toContain(
		'aria-label="Runs on build-box. No Planner is attached. @chopin needs one to reply."',
	);
	expect(none).toContain('data-planner="none"');
	// No Planner is not a state of the machine, so its dot is the machine's own.
	expect(none).toMatch(/class="status-dot machine-glyph-dot" data-state="connected"/);
});

test("a glyph with a Planner state but no machine still shows the state", () => {
	let markup = renderToStaticMarkup(createElement(MachineGlyph, { planner: "starting" }));
	expect(markup).toContain('data-planner="starting"');
});

test("the top of the menu says why a Planner cannot start, in full, with where to fix it", () => {
	let status = plannerStatus({
		state: "starting",
		login: "mona",
		failure: { attempts: 3, reason: "The checkout’s git config sets a credential helper", at: AT },
	}, "Build box")!;
	let markup = renderToStaticMarkup(createElement(PlannerNote, { status }));
	expect(markup).toContain('role="group"');
	expect(markup).toContain('aria-label="Planner"');
	expect(markup).toContain("Can’t connect to Build box</p>");
	expect(markup).toContain("<p>The checkout’s git config sets a credential helper.</p>");
	expect(markup).toMatch(
		/<p class="machine-planner-detail">Tried 3 times, last at [^<]+\. Still trying\.<\/p>/,
	);
	expect(markup).toContain(`href="${PLANNER_HOW_TO_FIX}"`);
	// A link in a menu is one of its items, so the arrow keys reach it.
	expect(markup).toContain('role="menuitem"');
	expect(markup).toContain('rel="noreferrer"');
	expect(markup).toContain('target="_blank"');
	expect(markup).toContain('role="separator"');
});

test("the top of the menu tells every other state as one sentence, with no link", () => {
	let say = (planner: Parameters<typeof plannerStatus>[0]) =>
		renderToStaticMarkup(
			createElement(PlannerNote, { status: plannerStatus(planner, "Build box")! }),
		);
	expect(say({ state: "starting", login: "mona" })).toContain(
		"<p>Connecting to Build box</p>",
	);
	expect(say({ state: "disconnected", login: "mona" })).toContain(
		"<p>Build box is offline. Its work is kept and picks up when it’s back.</p>",
	);
	expect(say({ state: "none" })).toContain(
		"<p>No Planner is attached. @chopin needs one to reply.</p>",
	);
	expect(say({ state: "none" })).not.toContain("<a");
});
