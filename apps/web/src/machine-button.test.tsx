import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderToStaticMarkupRaw } from "react-dom/server";

import { BuildPlanButton } from "./build-plan-button";
import { PLANNER_HOW_TO_FIX, plannerSentence, plannerStatus } from "./chat/planner-status";
import FixSteps from "./fix-steps";
import {
	CREATOR_DECIDES,
	CreatorNote,
	MachineButton,
	MachineGlyph,
	PlannerNote,
} from "./machine-button";
import { INTERNAL_IN_STATUS } from "@chopin/protocol/plain-words";

import { machineFix } from "./machine-fix";
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
		chosen: 0,
		choose: async () => {},
		refresh: () => {},
		moves: 0,
		endSwitch: () => {},
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

test("the machine button always carries its Planner's state, in its dot and its name: Chat never draws it", () => {
	let status = plannerStatus({ state: "disconnected", login: "mona" }, "build-box")!;
	let markup = renderToStaticMarkup(createElement(MachineButton, {
		choice: choice(true, true),
		planner: status,
	}));
	expect(markup).toContain(`aria-label="Runs on build-box. ${plannerSentence(status)}"`);
	expect(markup).toContain('data-planner="away"');
	expect(markup).toContain("status-dot");
});

test("a healthy Planner leaves the button and its machine's dot exactly as they were", () => {
	let healthy = button({ state: "attached", login: "mona" });
	expect(healthy).toContain('aria-label="Runs on build-box"');
	expect(healthy).toContain('data-state="connected"');
	expect(healthy).not.toContain("data-planner");
	expect(healthy).not.toContain("aria-describedby");
});

test("a starting Planner turns the dot into the connecting dots and says where it is starting", () => {
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
	// No fix-it steps given, nothing to describe it with.
	expect(markup).not.toContain("aria-describedby");
});

test("a Planner with fix-it steps is described by why, in one plain sentence", () => {
	let status = plannerStatus({
		state: "starting",
		login: "mona",
		failure: { attempts: 3, reason: "exit 127: node: No such file or directory", at: AT },
	}, "build-box")!;
	let fix = machineFix(status, { mine: true, choose: true, place: "menu" });
	let markup = renderToStaticMarkup(createElement(MachineButton, {
		choice: choice(true, true),
		fix,
		planner: status,
	}));
	let described = /aria-describedby="([^"]+)"/.exec(markup)![1];
	expect(markup).toContain(
		`<span class="sr-only" id="${described}">A program it needs can't be found on it.</span>`,
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

const FAILING = {
	state: "starting",
	login: "mona",
	failure: { attempts: 3, reason: "The checkout's git config sets a credential helper", at: AT },
} as const;

function steps(fix: ReturnType<typeof machineFix>, menu = false) {
	return renderToStaticMarkup(createElement(FixSteps, { fix: fix!, menu }));
}

test("the fix-it steps: a title, why in a sentence, numbered steps, each command alone with Copy", () => {
	let status = plannerStatus(FAILING, "Build box")!;
	let markup = steps(machineFix(status, { mine: true, choose: true, place: "menu" }));
	expect(markup).toContain('role="group"');
	expect(markup).toContain('aria-label="Can\'t connect to Build box"');
	expect(markup).toContain('<div class="fix-steps-title">Can\'t connect to Build box</div>');
	expect(markup).toContain(
		'<div class="fix-steps-why">It stops each time before it connects.</div>',
	);
	expect(markup).toContain('<ol class="fix-steps-list">');
	expect(markup.match(/<li class="fix-steps-step">/g)).toHaveLength(4);
	expect(markup).toContain(
		'<span>Wait a moment.</span><span class="fix-steps-hint">It connects again by itself once it\'s fixed.</span>',
	);
	// A command is never inline in a sentence: it stands in its own block, with its own Copy.
	expect(markup).toContain(
		'<span>On Build box, see why it stops:</span><div class="fix-steps-command"><span class="fix-steps-code">chopin status</span>',
	);
	expect(markup).toContain('aria-label="Copy chopin status"');
	// The machine's words, folded away, and Learn more at the foot; how often it was tried is never
	// said, there or anywhere.
	expect(markup).toContain(">Show details");
	expect(markup).toContain('aria-expanded="false"');
	expect(markup).not.toMatch(/Tried (once|\d)|\d times|tries|attempt|Still trying/i);
	expect(markup).not.toContain(String.fromCodePoint(0xb7));
	expect(markup).toContain(`href="${PLANNER_HOW_TO_FIX}"`);
	expect(markup).toContain(">Learn more</a>");
	expect(markup).toContain('rel="noreferrer"');
	expect(markup).toContain('target="_blank"');
	// Calm: no alarm colour, no alert.
	expect(markup).not.toContain('role="alert"');
	expect(markup).not.toContain("danger");
});

test("inside the machine menu each of the steps' controls is one of its items, so the arrow keys reach them", () => {
	let status = plannerStatus(FAILING, "Build box")!;
	let fix = machineFix(status, { mine: true, choose: true, place: "menu" });
	let inMenu = steps(fix, true);
	// Copy, Show details and Learn more.
	expect(inMenu.match(/role="menuitem"/g)).toHaveLength(3);
	expect(steps(fix)).not.toContain('role="menuitem"');
});

test("the steps keep a reason exactly as the machine gave it, under Show details", () => {
	let reason = "  path ends in a slash /  ";
	let planner = { ...FAILING, failure: { ...FAILING.failure, attempts: 2, reason } } as const;
	let fix = machineFix(plannerStatus(planner, "Build box"), {
		mine: true,
		choose: false,
		place: "menu",
	});
	// Not trimmed, and no stop added to a path that ends in a slash; when it was last tried under it.
	expect(steps(fix)).toMatch(
		new RegExp(`<pre class="fix-steps-output">${reason}\nLast tried at [^<]+\\.</pre>`),
	);
});

test("the top of the menu tells a state with nothing to fix as one sentence", () => {
	let say = (planner: Parameters<typeof plannerStatus>[0]) =>
		renderToStaticMarkup(
			createElement(PlannerNote, { status: plannerStatus(planner, "Build box")! }),
		);
	expect(say({ state: "starting", login: "mona" })).toContain("<div>Connecting to Build box</div>");
	expect(say({ state: "held", login: "mona", until: AT })).toContain(
		"<div>Build box stepped away.",
	);
	expect(say({ state: "none" })).toContain("<div>No machine is connected.</div>");
	expect(say({ state: "none" })).not.toContain("<a");
	expect(say({ state: "none" })).toContain('role="separator"');
});

test("a person whose choice does not place the document's replies is told whose does, in plain words", () => {
	let note = renderToStaticMarkup(createElement(CreatorNote));
	expect(note).toContain(`<p>${CREATOR_DECIDES}</p>`);
	expect(note).toContain('role="group"');
	expect(CREATOR_DECIDES).toBe(
		"The document's creator chose where its replies come from, so your choice runs your builds and runs.",
	);
	expect(INTERNAL_IN_STATUS.test(CREATOR_DECIDES)).toBe(false);
});
