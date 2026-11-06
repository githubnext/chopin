/**
 * The words people read about the Planner's state and the connection. They are plain: none of
 * Chopin's own terms (the Planner, attaching, holding, Decisions) and no mention of Chopin, only
 * what happens to the machine and to the person's work. Every state, glyph and place that says
 * it is walked here, so a new sentence cannot bring one back.
 */
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";

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
import type { PlannerGlyph, PlannerStatus } from "./chat/planner-status";
import type { MachineChoice } from "./machine-choice";

/** What an internal concept looks like to a person: any of these in a status is a leak. */
const INTERNAL = /planner|attach|\bheld\b|\bdecisions?\b|@chopin/i;

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
	expect([...glyphs].filter(Boolean).sort()).toEqual(["away", "failing", "starting"]);
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
