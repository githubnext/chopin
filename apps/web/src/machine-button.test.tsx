import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderToStaticMarkupRaw } from "react-dom/server";

import { BuildPlanButton } from "./build-plan-button";
import {
	PLANNER_HOW_TO_FIX,
	plannerPlacement,
	plannerSentence,
	plannerStatus,
} from "./chat/planner-status";
import { connectionStep, INITIAL_MEMORY, plannerForBanner } from "./chat/connection-phase";
import { MachineButton, MachineGlyph, PlannerNote } from "./machine-button";

import type { MachineChoice } from "./machine-choice";

/** Markup with the apostrophe React escapes in text written back, so copy reads as typed. */
function renderToStaticMarkup(element: Parameters<typeof renderToStaticMarkupRaw>[0]): string {
	return renderToStaticMarkupRaw(element).replaceAll("&#x27;", "'");
}

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
		read: 1,
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

function button(
	planner: Parameters<typeof plannerStatus>[0],
	phone = false,
	machine: { service: boolean; connected: boolean } = { service: true, connected: true },
): string {
	return renderToStaticMarkup(
		createElement(MachineButton, {
			choice: choice(machine.service, machine.connected),
			phone,
			planner: plannerStatus(planner, "build-box"),
		}),
	);
}

test("a Planner's connection is told by the visible Chat banner, not repeated on the machine button", () => {
	let status = plannerStatus({ state: "disconnected", login: "mona" }, "build-box")!;
	let { view } = connectionStep(INITIAL_MEMORY, {
		socket: "up",
		failures: 0,
		retrying: undefined,
		synced: true,
		current: true,
		turn: undefined,
		messages: 0,
		planner: status,
	});
	expect(view).toMatchObject({ phase: "dropped", layer: "planner", text: plannerSentence(status) });
	let placement = plannerPlacement(status, true, view, true);
	let markup = renderToStaticMarkup(createElement(MachineButton, {
		choice: choice(true, true),
		planner: placement.button,
	}));
	expect(markup).toContain('aria-label="Runs on build-box"');
	expect(markup).toContain('aria-haspopup="menu"');
	expect(markup).not.toContain("status-dot");
	expect(markup).not.toContain(plannerSentence(status));
});

test("no machine is reported by the Chat banner without inventing a connected machine", () => {
	let status = plannerStatus({ state: "none" })!;
	let { view } = connectionStep(INITIAL_MEMORY, {
		socket: "up",
		failures: 0,
		retrying: undefined,
		synced: true,
		current: true,
		turn: undefined,
		messages: 0,
		planner: plannerForBanner(status, false),
	});
	expect(view).toMatchObject({
		phase: "dropped",
		layer: "planner",
		text: "No machine is connected.",
	});
	let noMachine = choice(false, false);
	noMachine.state!.choice = null;
	noMachine.state!.machines = [];
	let markup = renderToStaticMarkup(createElement(MachineButton, {
		choice: noMachine,
		planner: plannerPlacement(status, true, view, true).button,
	}));
	expect(markup).toContain('aria-label="Choose machine"');
	expect(markup).toContain('aria-haspopup="menu"');
	expect(markup).not.toContain("status-dot");
	expect(markup).not.toContain("no machine connected");
});

test("the machine button retains its status when Chat is hidden or the banner tells another cause", () => {
	let status = plannerStatus({ state: "disconnected", login: "mona" }, "build-box")!;
	let plannerView = connectionStep(INITIAL_MEMORY, {
		socket: "up",
		failures: 0,
		retrying: undefined,
		synced: true,
		current: true,
		turn: undefined,
		messages: 0,
		planner: status,
	}).view;
	let socketView = connectionStep(INITIAL_MEMORY, {
		socket: "lost",
		failures: 0,
		retrying: undefined,
		synced: false,
		current: false,
		turn: undefined,
		messages: 0,
		planner: status,
	}).view;
	expect(plannerPlacement(status, true, plannerView, false).button).toBe(status);
	expect(plannerPlacement(status, true, socketView, true).button).toBe(status);
	expect(plannerPlacement(status, true, { phase: "online" }, true).button).toBe(status);
	expect(
		plannerPlacement(
			status,
			true,
			{ phase: "resumed", layer: "planner", text: "Back", caught: "" },
			true,
		).button,
	).toBe(status);
});

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
		failure: { attempts: 3, reason: "The checkout's git config sets a credential helper", at: AT },
	});
	expect(markup).toContain(
		'aria-label="Runs on build-box. Can\'t connect to build-box."',
	);
	expect(markup).toContain('data-planner="failing"');
	let described = /aria-describedby="([^"]+)"/.exec(markup)![1];
	// The reason as given, and what has been tried, each a block of its own for a screen reader.
	expect(markup).toMatch(
		new RegExp(
			`<div class="sr-only" id="${described}"><p>The checkout's git config sets a credential helper</p><p>Tried 3 times, last at [^<]+. Still trying.</p></div>`,
		),
	);
});

test("a Planner that is disconnected or has stepped away is a muted dot", () => {
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
});

test("with no machine connected the button is the bare icon with no dot, as with no machine at all", () => {
	let none = button({ state: "none" });
	expect(none).toContain('aria-label="Runs on build-box. No machine is connected."');
	expect(none).toContain('data-planner="none"');
	// Not the machine's own green: this document has nothing running on it, whatever the machine is.
	expect(none).not.toContain("status-dot");
	// The same quiet icon in tertiary ink as the button of a person who has no machine.
	expect(none).toContain("data-automatic");
	let bare = renderToStaticMarkup(createElement(MachineGlyph, {}));
	expect(bare).toContain("data-automatic");
	expect(bare).not.toContain("status-dot");
});

/** Every way the Planner can be unwell, which is every state but a healthy one. */
const UNWELL = [
	{ state: "none" },
	{ state: "starting", login: "mona" },
	{ state: "starting", login: "mona", failure: { attempts: 3, reason: "exit 127", at: AT } },
	{ state: "disconnected", login: "mona" },
	{ state: "held", login: "mona", until: AT },
] as const;

test("whatever is wrong with the Planner, the machine's connected green is never drawn", () => {
	for (let service of [true, false]) {
		for (let phone of [false, true]) {
			// Whatever the machine's own state is, its dot is not the Planner's to borrow.
			for (let connected of [true, false]) {
				for (let planner of UNWELL) {
					let markup = button(planner, phone, { service, connected });
					let drawn = `${planner.state}${"failure" in planner ? " (failing)" : ""}`;
					expect(markup, drawn).not.toContain('data-state="connected"');
				}
			}
		}
	}
	// And a healthy Planner leaves the machine's own green exactly as it was.
	expect(button({ state: "attached", login: "mona" })).toContain('data-state="connected"');
});

test("a glyph with a Planner state but no machine still shows the state", () => {
	let markup = renderToStaticMarkup(createElement(MachineGlyph, { planner: "starting" }));
	expect(markup).toContain('data-planner="starting"');
});

test("the top of the menu says why a Planner cannot start, in full, with where to fix it", () => {
	let status = plannerStatus({
		state: "starting",
		login: "mona",
		failure: { attempts: 3, reason: "The checkout's git config sets a credential helper", at: AT },
	}, "Build box")!;
	let markup = renderToStaticMarkup(createElement(PlannerNote, { status }));
	expect(markup).toContain('role="group"');
	expect(markup).toContain('aria-label="Connection"');
	expect(markup).toContain("Can't connect to Build box</p>");
	expect(markup).toContain("<p>The checkout's git config sets a credential helper</p>");
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
		"<p>Build box is offline. Your work is kept.</p>",
	);
	expect(say({ state: "none" })).toContain(
		"<p>No machine is connected.</p>",
	);
	expect(say({ state: "none" })).not.toContain("<a");
});

test("the menu and the button's description keep a reason exactly as the machine gave it", () => {
	let reason = "  path ends in a slash /  ";
	let planner = {
		state: "starting",
		login: "mona",
		failure: { attempts: 2, reason, at: AT },
	} as const;
	let note = renderToStaticMarkup(
		createElement(PlannerNote, { status: plannerStatus(planner, "Build box")! }),
	);
	// Not trimmed, and no stop added to a path that ends in a slash.
	expect(note).toContain(`<p>${reason}</p>`);
	expect(button(planner)).toContain(`<p>${reason}</p>`);
});
