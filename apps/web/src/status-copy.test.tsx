/**
 * The words people read about the Planner's state and the connection. They are plain: none of
 * Chopin's own terms (the Planner, attaching, detaching, holding, Decisions) and no `@chopin`,
 * only what happens to the machine and to the person's work. Every state, glyph and place that
 * says it is walked here, Build's reasons and refusals among them, so a new sentence cannot bring
 * one back.
 */
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";

import { buildLook, CONNECT_MACHINE_TO_BUILD, draftRefusalCopy } from "./build-model";
import { BuildPlanButton } from "./build-plan-button";
import { ChatComposer } from "./chat/composer";
import {
	plannerAnnouncement,
	plannerButtonLabel,
	plannerGlyph,
	plannerPlacement,
	plannerSentence,
	plannerStatus,
} from "./chat/planner-status";
import { MachineButton, MachineGlyph, PlannerNote } from "./machine-button";
import { OFFLINE_MESSAGE, OfflineAnnouncement, OfflineNoticeBody } from "./offline-notice";
import { offlineAnnouncement } from "@chopin/editor";

import type { Session } from "@chopin/protocol";
import type { ImplementationSnapshot } from "@chopin/protocol/implementation";
import type { PlannerGlyph, PlannerStatus } from "./chat/planner-status";
import type { MachineChoice } from "./machine-choice";

/**
 * What an internal concept looks like to a person: any of these in a status is a leak. `detach` is
 * its own word (it contains `tach`, not `attach`), and `attach` takes every form of it.
 */
const INTERNAL = /planner|detach|attach|\bheld\b|\bdecisions?\b|@chopin/i;

const AT = "2026-11-04T18:29:00.000Z";

/** Every state the server reports a document's Planner in, including each way of failing. */
const STATES: Session.PlannerAttachment[] = [
	{ state: "attached", login: "mona" },
	{ state: "none" },
	{ state: "starting", login: "mona" },
	{ state: "starting", login: "mona", failure: { attempts: 1, reason: "exit 127", at: AT } },
	{ state: "starting", login: "mona", failure: { attempts: 5, reason: "no such file", at: AT } },
	{ state: "disconnected", login: "mona" },
	{ state: "held", login: "mona", until: AT },
];

/** The viewer's own machine, named, and someone else's, known only by its owner's login. */
const MACHINES = ["Build box", undefined] as const;

test("the leak check flags every banned term in any form, and none of the plain words", () => {
	let leaks = [
		"Planner",
		"the planner is working",
		"Open your Planner",
		"attach",
		"Attach again",
		"attached",
		"attaching",
		"attachment",
		"reattach",
		"detach",
		"detached",
		"Detached from this document",
		"detaching",
		"held",
		"Held until 10:31 AM",
		"Decision",
		"decisions",
		"Open Decisions stay answerable",
		"@chopin",
		"Ask @Chopin",
	];
	for (let leak of leaks) expect(INTERNAL.test(leak), leak).toBe(true);
	let plain = [
		"Connecting to Build box",
		"Can't connect to Build box",
		"Build box is offline. Your work is kept.",
		"Build box stepped away. Your work is kept until 10:31 AM.",
		"No machine is connected.",
		"Connect a machine to get a reply.",
		"Reconnect the machine to build.",
		"The shelled output was upheld",
		"Chopin",
	];
	for (let words of plain) expect(INTERNAL.test(words), words).toBe(false);
});

function statuses(): PlannerStatus[] {
	return STATES.flatMap(planner =>
		MACHINES.map(machine => plannerStatus(planner, machine)).filter(Boolean) as PlannerStatus[]
	);
}

function choice(): MachineChoice {
	return {
		state: {
			choice: "M_box",
			favorite: null,
			automatic: null,
			machines: [{
				id: "M_box",
				label: "Build box",
				connected: true,
				reauthorize: false,
				createdAt: 0,
				lastSeenAt: 0,
				version: null,
				hostname: null,
				platform: null,
				agent: null,
				service: false,
				planner: false,
			}],
		},
		saving: false,
		choose: async () => {},
		refresh: () => {},
	};
}

function decode(text: string): string {
	return text.replaceAll("&#x27;", "'").replaceAll("&amp;", "&");
}

/** What a person reads or hears from markup: its text, and the attributes that name or tip it. */
function words(markup: string): string[] {
	let attributes = [...markup.matchAll(/\b(?:aria-label|data-tooltip|title|alt)="([^"]*)"/g)]
		.map(match => decode(match[1]!));
	let text = markup.replace(/<[^>]*>/g, "\n").split("\n").map(line => decode(line.trim()))
		.filter(Boolean);
	return [...attributes, ...text];
}

function expectPlain(label: string, texts: readonly string[]): void {
	for (let text of texts) {
		expect(INTERNAL.test(text), `${label}: "${text}"`).toBe(false);
	}
}

const COMPOSER = {
	agent: true,
	draftable: true,
	onSubmit: () => {},
	sendDisabled: false,
	sending: false,
	input: {
		mentions: [],
		onChange: () => {},
		onSelect: () => {},
		references: [],
		resetKey: 0,
		value: "",
	},
};

test("every state's sentence, button name, menu note and live-region word is plain", () => {
	let all = statuses();
	expect(all.length).toBeGreaterThanOrEqual(10);
	for (let status of all) {
		let sentence = plannerSentence(status);
		let texts = [
			sentence,
			plannerButtonLabel("Runs on Build box", status),
			plannerAnnouncement(undefined, status),
			...(status.kind === "cant-start" ? [status.title, status.detail] : [status.text]),
			...words(render(createElement(PlannerNote, { status }))),
			...words(render(createElement(MachineButton, { choice: choice(), planner: status }))),
			...words(
				render(createElement(MachineButton, { choice: choice(), phone: true, planner: status })),
			),
		];
		expectPlain(`${status.kind} ${sentence}`, texts);
		// Said once as entered: nothing for a state it was already in, and every first telling is plain.
		expect(plannerAnnouncement(undefined, status)).toBe(sentence);
		expect(plannerAnnouncement(status.kind, status)).toBe("");
	}
	// A state replacing another is told in the same plain words, whichever it replaces.
	for (let from of all) {
		for (let to of all) expectPlain("a change", [plannerAnnouncement(from.kind, to)]);
	}
});

test("every glyph the button's dot takes says nothing, and none of it is an internal term", () => {
	let glyphs = new Set<PlannerGlyph | undefined>(statuses().map(plannerGlyph));
	expect([...glyphs].filter(Boolean).sort()).toEqual(["away", "failing", "none", "starting"]);
	for (let glyph of glyphs) {
		expectPlain(`the ${glyph} dot`, words(render(createElement(MachineGlyph, { planner: glyph }))));
	}
});

test("the composer's strip says every state in plain words, with the button or without", () => {
	for (let status of statuses()) {
		for (let hasButton of [true, false]) {
			let strip = plannerPlacement(status, hasButton).strip;
			if (!strip) continue;
			expectPlain(`strip ${status.kind} ${hasButton}`, [
				strip.text,
				...(strip.detail ?? []),
				strip.link?.label ?? "",
			]);
			// And as the composer draws it, above the field.
			let markup = render(createElement(ChatComposer, { ...COMPOSER, notice: strip }));
			let drawn = markup.slice(
				markup.indexOf("composer-notice-slot"),
				markup.indexOf("composer-surface"),
			);
			expect(drawn.length).toBeGreaterThan(0);
			expectPlain(`drawn ${status.kind} ${hasButton}`, words(drawn));
		}
	}
});

test("a lost connection, its action and its one polite word are plain", () => {
	expect(OFFLINE_MESSAGE).toBe(
		"You're offline. Your changes are kept and will sync when you reconnect.",
	);
	expectPlain("the notice", words(render(createElement(OfflineNoticeBody, { onRetry: () => {} }))));
	expectPlain("the word as it goes", [
		offlineAnnouncement(true, false),
		...words(
			render(createElement(OfflineAnnouncement, { spoken: offlineAnnouncement(true, false) })),
		),
	]);
});

test("the words for the states the user named are exactly theirs, with plain apostrophes", () => {
	let say = (planner: Session.PlannerAttachment) =>
		plannerSentence(plannerStatus(planner, "Build box")!);
	expect(say({ state: "starting", login: "mona" })).toBe("Connecting to Build box");
	expect(
		say({ state: "starting", login: "mona", failure: { attempts: 3, reason: "x", at: AT } }),
	).toBe("Can't connect to Build box.");
	expect(say({ state: "disconnected", login: "mona" })).toBe(
		"Build box is offline. Your work is kept.",
	);
	expect(say({ state: "none" })).toBe("No machine is connected.");
	expect(say({ state: "held", login: "mona", until: AT })).toMatch(
		/^Build box stepped away\. Your work is kept until \d{1,2}:\d{2}/,
	);
	for (let status of statuses()) expect(plannerSentence(status)).not.toContain("\u2019");
});

/** A document with no tasks yet, so what is left to say about Build plan is why it must wait. */
const DRAFTING = {
	revision: 1,
	planRevision: 4,
	localAgent: false,
	blockers: [],
	buildReady: true,
	lifecycle: { execution: { state: "idle" }, history: [] },
} as ImplementationSnapshot;

test("every reason Build plan waits and every refusal Build shows is plain, machine-first words", () => {
	let reasons: string[] = [];
	for (let planner of [true, false]) {
		for (let connected of [true, false]) {
			for (let hasContent of [true, false]) {
				for (let plannerDetached of [undefined, true]) {
					for (let plannerDisconnected of [undefined, true]) {
						let look = buildLook(DRAFTING, {
							state: { stage: "idle" },
							live: false,
							canEdit: true,
							connected,
							planner,
							plannerDetached,
							plannerDisconnected,
							hasContent,
						});
						if ("blocked" in look && look.blocked) reasons.push(look.blocked);
					}
				}
			}
		}
	}
	// The two reasons that used to name the Planner are among them, so this is not vacuous.
	expect(reasons).toContain(CONNECT_MACHINE_TO_BUILD);
	expect(reasons).toContain("Reconnect the machine to build");
	expectPlain("Build plan's reasons", reasons);

	let refusals = [
		["@mona's machine is offline, so it can't reply now. Your work is kept.", undefined],
		["anything", "planner-not-attached"],
		["Connect a machine to get a reply. Choose one with the machine button.", undefined],
		["accepted comments awaiting plan changes", undefined],
		["implementation is already active", undefined],
		["the queue is full", undefined],
		["Planner is not running", undefined],
		["write access is needed", undefined],
		["this cannot be built", undefined],
	] as const;
	let shown = refusals.map(([message, code]) => draftRefusalCopy(message, code));
	expect(shown.filter(Boolean)).toHaveLength(refusals.length);
	expect(shown).toContain("Reconnect the machine to build.");
	expect(shown).toContain(`${CONNECT_MACHINE_TO_BUILD}.`);
	expectPlain("Build's refusals", shown.filter(Boolean) as string[]);
});

test("Build plan says it plainly and still opens how to connect a machine for that one reason", () => {
	let plan = (blocked: string) =>
		render(
			createElement(BuildPlanButton, {
				build: { look: { kind: "plan", blocked }, press: () => {} } as never,
				canEdit: true,
				documentURL: "http://localhost:8787/githubnext/chopin/cache-plan",
				onHover: () => {},
				onOpen: () => {},
			}),
		);
	// Needing a machine offers to connect one, in place of a button that cannot be pressed.
	let connect = plan(CONNECT_MACHINE_TO_BUILD);
	expect(connect).toContain("Connect Chopin");
	expect(connect).not.toContain('aria-label="Build plan"');
	// Any other reason leaves the inert button with the reason in its tooltip and description.
	let reconnect = plan("Reconnect the machine to build");
	expect(reconnect).toContain('aria-label="Build plan"');
	expect(decode(reconnect)).toContain('data-tooltip="Reconnect the machine to build"');
	expectPlain("Build plan's tooltip", words(reconnect));
});
