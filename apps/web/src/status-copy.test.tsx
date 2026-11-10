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
import { SETUP } from "./build-connection-popover";
import { SHARE_DETAIL, YourMachines } from "./experiments/machine-list";
import { ChatComposer } from "./chat/composer";
import { plannerForBanner } from "./chat/connection-phase";
import {
	destinationCue,
	PLANNER_UNAVAILABLE_NOTICE,
	REPLIES_OFF,
	repliesOffNotice,
} from "./chat/references";
import { disconnectedNote, RunStack, runStatusLabel } from "./chat/run-card";
import { Transcript } from "./chat/transcript";
import { destinationLabel } from "./workspace-navigation";
import { documentActivityLabel } from "./document-activity";
import { EvidencePopover } from "./conversation-plan/evidence-popover";
import {
	JOB_RETRY_FAILED,
	PlannerJobDiagnostics,
} from "./conversation-plan/planner-job-diagnostics";
import {
	plannerButtonLabel,
	plannerGlyph,
	plannerSentence,
	plannerStatus,
} from "./chat/planner-status";
import { MachineButton, MachineGlyph, PlannerNote } from "./machine-button";
import { ConnectionAnnouncement, ConnectionBannerView } from "./chat/connection-banner";
import {
	connectionSpeech,
	connectionStep,
	INITIAL_MEMORY,
	NOTHING_SPOKEN,
	OFFLINE_MESSAGE,
} from "./chat/connection-phase";
import type { ConnectionFacts } from "./chat/connection-phase";
import { failureView, sendFailureView } from "./chat/failure";
import { ErrorState } from "./chat/error-state";
import { AgentFace, PlanStatus } from "@chopin/editor";
import { INTERNAL, INTERNAL_IN_STATUS } from "@chopin/protocol/plain-words";

import type { Chat, ConversationPlan, Session } from "@chopin/protocol";
import type { ImplementationSnapshot } from "@chopin/protocol/implementation";
import type { PlannerGlyph, PlannerStatus } from "./chat/planner-status";
import type { MachineChoice } from "./machine-choice";

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

/** The viewer's own machine, named, someone else's, known only by its owner's login, and not known yet. */
const MACHINES = ["Build box", undefined, null] as const;

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
	for (let leak of leaks) expect(INTERNAL_IN_STATUS.test(leak), leak).toBe(true);
	// Decision and Decisions are the product's own word: only text about a machine and its connection
	// must not use them, so the pattern for everything else flags the other terms alone.
	let product = [
		"Decision",
		"decisions",
		"Open Decisions stay answerable",
		"Waiting on 2 Decisions",
	];
	for (let leak of leaks) {
		expect(INTERNAL.test(leak), leak).toBe(!product.includes(leak));
	}
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
	for (let words of [...plain, ...product]) {
		expect(INTERNAL.test(words), words).toBe(false);
	}
	for (let words of plain) expect(INTERNAL_IN_STATUS.test(words), words).toBe(false);
});

function statuses(): PlannerStatus[] {
	return STATES.flatMap(planner =>
		MACHINES.flatMap(machine => [undefined, AT].map(seen => plannerStatus(planner, machine, seen)))
			.filter(Boolean) as PlannerStatus[]
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
		read: 1,
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

/** Text about a machine and its connection: none of Chopin's own terms, Decisions included. */
function expectPlain(label: string, texts: readonly string[]): void {
	for (let text of texts) {
		expect(INTERNAL_IN_STATUS.test(text), `${label}: "${text}"`).toBe(false);
	}
}

/** Any other words a person reads: none of the Planner, attaching, holding or `@chopin`. */
function expectPlainWords(label: string, texts: readonly string[]): void {
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
			told(status),
			...(status.kind === "cant-start" ? [status.title, status.detail] : [status.text]),
			...words(render(createElement(PlannerNote, { status }))),
			...words(render(createElement(MachineButton, { choice: choice(), planner: status }))),
			...words(
				render(createElement(MachineButton, { choice: choice(), phone: true, planner: status })),
			),
		];
		expectPlain(`${status.kind} ${sentence}`, texts);
		// Said once as entered, and every first telling is plain.
		expect(told(status)).toBe(sentence);
	}
});

test("every glyph the button's dot takes says nothing, and none of it is an internal term", () => {
	let glyphs = new Set<PlannerGlyph | undefined>(statuses().map(plannerGlyph));
	expect([...glyphs].filter(Boolean).sort()).toEqual(["away", "failing", "none", "starting"]);
	for (let glyph of glyphs) {
		expectPlain(`the ${glyph} dot`, words(render(createElement(MachineGlyph, { planner: glyph }))));
	}
});

test("the banner at the composer says every state in plain words, with the button or without", () => {
	for (let status of statuses()) {
		for (let hasButton of [true, false]) {
			let view = connectionStep(INITIAL_MEMORY, {
				...WELL,
				planner: plannerForBanner(status, hasButton),
			}).view;
			if (view.phase === "online") continue;
			let markup = render(createElement(ConnectionBannerView, { onRetry: () => {}, view }));
			expect(markup.length).toBeGreaterThan(0);
			expectPlain(`banner ${status.kind} ${hasButton}`, words(markup));
			// And as the composer draws it, above the field.
			let drawn = render(
				createElement(ChatComposer, {
					...COMPOSER,
					banner: {
						id: "b",
						node: createElement(ConnectionBannerView, { onRetry: () => {}, view }),
					},
				}),
			);
			expectPlain(
				`drawn ${status.kind} ${hasButton}`,
				words(
					drawn.slice(
						drawn.indexOf('<div class="composer-notice"'),
						drawn.indexOf("composer-surface"),
					),
				),
			);
		}
	}
});

test("a lost connection, its action, its return and its one polite word are plain", () => {
	expect(OFFLINE_MESSAGE).toBe(
		"You're offline. Your changes are kept and will sync when you reconnect.",
	);
	let phases = [
		connectionStep(INITIAL_MEMORY, { ...WELL, socket: "lost", failures: 1 }),
		connectionStep(INITIAL_MEMORY, { ...WELL, socket: "lost", failures: 4 }),
		connectionStep(INITIAL_MEMORY, { ...WELL, synced: false }),
	];
	let lost = connectionStep(INITIAL_MEMORY, { ...WELL, socket: "lost", turn: "t", messages: 1 });
	phases.push(connectionStep(lost.memory, { ...WELL, turn: "t", messages: 3 }));
	phases.push(connectionStep(lost.memory, { ...WELL, turn: undefined, messages: 3 }));
	for (let { view } of phases) {
		if (view.phase === "online") continue;
		expectPlain(
			`the ${view.phase} banner`,
			words(render(createElement(ConnectionBannerView, { onRetry: () => {}, view }))),
		);
		let speech = connectionSpeech(NOTHING_SPOKEN, view);
		expectPlain(`the ${view.phase} word`, [
			speech?.said ?? "",
			...words(render(createElement(ConnectionAnnouncement, { spoken: speech?.said ?? "" }))),
		]);
	}
});

test("a failed reply says what happened in plain words, in the banner and as it is offered again", () => {
	for (let kind of ["error", "refused", "tool", "timed-out", "unreachable"] as const) {
		let view = failureView({ kind })!;
		expectPlain(
			`the ${kind} failure`,
			words(
				render(
					createElement(ErrorState, {
						kind: view.kind,
						onRetry: () => {},
						title: view.title,
					}),
				),
			),
		);
		expectPlain(
			`the retrying ${kind} failure`,
			words(
				render(createElement(ErrorState, { retrying: true, title: view.title })),
			),
		);
	}
	expectPlain("the machine link", [
		sendFailureView({ text: "Message not sent." }, "planner-not-attached").link!.label,
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
	expect(plannerSentence(plannerStatus({ state: "disconnected", login: "mona" }, "Build box", AT)!))
		.toMatch(/^Build box is offline\. Last seen .+\.$/);
	expect(say({ state: "none" })).toBe("No machine is connected.");
	expect(say({ state: "held", login: "mona", until: AT })).toMatch(
		/^Build box stepped away\. Your work is kept until \d{1,2}:\d{2}/,
	);
	for (let status of statuses()) expect(plannerSentence(status)).not.toContain("\u2019");
});

test("a server whose agent is off says so in plain words, and says nothing of it while the page is offline", () => {
	let strip = repliesOffNotice(false)!;
	expect(strip.text).toBe(REPLIES_OFF);
	expectPlain("the strip and the notice after a send", [strip.text, PLANNER_UNAVAILABLE_NOTICE]);
	// And as the composer draws it, above the field.
	let markup = render(createElement(ChatComposer, { ...COMPOSER, agent: false, notice: strip }));
	let drawn = markup.slice(
		markup.indexOf("composer-notice-slot"),
		markup.indexOf("composer-surface"),
	);
	expect(drawn.length).toBeGreaterThan(0);
	expectPlain("drawn", words(drawn));
	// The page's connection banner is the one thing said about the connection.
	expect(repliesOffNotice(true)).toBeUndefined();
});

test("the busy labels, the agent's face and the composer's picker hints are plain", () => {
	let activities = [{ unread: 0, busy: false }, { unread: 3, busy: false }, {
		unread: 0,
		busy: true,
	}, { unread: 3, busy: true }];
	for (let destination of ["chat", "plan", "build"] as const) {
		for (let activity of activities) {
			for (let writing of [undefined, "writing", "unseen"] as const) {
				expectPlainWords(
					`the ${destination} tab`,
					[destinationLabel(destination, 2, activity, writing)],
				);
			}
		}
	}
	expectPlainWords(
		"the document tab",
		["writing", "unseen", undefined].map(state => documentActivityLabel(state as never)),
	);
	let working = render(createElement(PlanStatus, { busy: true, synced: true }));
	expect(working).toContain("Chopin is working");
	expectPlainWords("the document's status", words(working));
	expectPlainWords("the agent's face", words(render(createElement(AgentFace, {}))));
	for (let text of ["", "should we ask about auth first?", "@chopin draft the auth section"]) {
		let cue = destinationCue(text, [], true);
		if (cue) expectPlainWords("a picker hint", [cue.text]);
	}
	expect(destinationCue("should we ask about auth first?", [], true)?.text)
		.toBe("Sent to people here. Type @ to ask Chopin");
	let empty = render(createElement(Transcript, {
		active: true,
		emptyHint: { planner: true, references: true },
		entries: [],
		handle: "ana",
		onWithdraw: () => {},
		queued: [],
	}));
	expect(empty).toContain("to ask Chopin");
	expectPlainWords("the empty Chat", words(empty));
});

test("a workflow run's status, notes and controls are plain, connected or away", () => {
	let statuses = [
		"running",
		"waiting",
		"paused",
		"finished",
		"blocked",
		"failed",
		"stopped",
	] as const;
	let run = (status: (typeof statuses)[number], away?: true): Chat.Run => ({
		id: `run-${status}`,
		name: `a-${status}-run`,
		status,
		started: 1,
		updated: 2,
		waiting: status === "waiting" ? 2 : 0,
		stages: [],
		...(away ? { disconnected: true } : {}),
	} as Chat.Run);
	for (let status of statuses) {
		for (let away of [undefined, true] as const) {
			let item = run(status, away);
			expectPlainWords(`a ${status} run's label`, [runStatusLabel(item)]);
			expectPlain(`a ${status} run's note about its machine`, [disconnectedNote(item)]);
			for (let offline of [false, true]) {
				let markup = render(createElement(RunStack, {
					offline,
					onPause: () => {},
					onResume: () => {},
					onShowDecisions: () => {},
					runs: [item],
				}));
				expectPlainWords(`a ${status} run card`, words(markup));
				// While the page's connection banner shows, nothing on a card is about the machine.
				if (offline) {
					expect(decode(markup), `a ${status} run card offline`).not.toMatch(
						/disconnected|machine|reconnect|Last reported/i,
					);
				}
			}
		}
	}
	let away = render(createElement(RunStack, { onPause: () => {}, runs: [run("running", true)] }));
	expect(decode(away)).toContain("Pause a-running-run when the machine reconnects");
	expect(decode(away)).toContain("It carries on when the machine reconnects.");
	let asking = render(
		createElement(RunStack, { onShowDecisions: () => {}, runs: [run("waiting")] }),
	);
	expect(asking).toContain("Waiting on 2 Decisions");
});

test("what a message's analysis, its evidence and a failed background job say is plain", () => {
	let rows = [{
		optionId: "sso",
		label: "Enterprise SSO",
		origin: "planner",
		supporters: [],
		opposers: [],
		items: [],
		rationale: "Enterprise customers expect SAML.",
		source: {
			author: { kind: "agent" },
			quote: "Enterprise customers expect SAML.",
			messageId: "m",
			start: 0,
			end: 1,
		},
	}];
	let evidence = render(createElement(EvidencePopover, { rows, onSource: () => {} } as never));
	expect(evidence).toContain("Chopin suggested");
	expectPlainWords("the evidence", words(evidence));
	let jobs = render(createElement(PlannerJobDiagnostics, {
		canEdit: true,
		jobs: [{ id: "j", kind: "refine", status: "failed", reason: "x" }] as ConversationPlan.Job[],
		onRetryJob: async () => {},
	}));
	expectPlainWords("the background jobs", [...words(jobs), JOB_RETRY_FAILED]);
});

test("the setup Build plan offers and the Machines page speak of machines, replies and teammates' work, not of Planners", () => {
	expectPlain("the setup", [...Object.values(SETUP), SHARE_DETAIL]);
	expect(SETUP.label).toBe("Connect a machine");
	let machine = {
		id: "m1",
		label: "build-box",
		autoRun: false,
		createdAt: 1,
		lastSeenAt: 2,
		connected: true,
		reauthorize: false,
		version: "0.1.5",
		hostname: "build-box.local",
		platform: { os: "linux", arch: "x64" },
		agent: { name: "GitHub Copilot CLI", version: "1.0.97" },
		service: true,
		planner: true,
		favorite: false,
		shared: true,
	};
	let table = render(createElement(YourMachines, {
		owner: { login: "ada" },
		machines: { machines: [machine], teammates: [], error: "", recommended: null } as never,
	}));
	expect(table).toContain("Can reply");
	expectPlain("the Machines table", words(table));
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
		["the reply queue is full", undefined],
		["Planner is not running", undefined],
		["Chopin is not running", undefined],
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
	expect(connect).toContain("Connect a machine");
	expect(connect).not.toContain('aria-label="Build plan"');
	// Any other reason leaves the inert button with the reason in its tooltip and description.
	let reconnect = plan("Reconnect the machine to build");
	expect(reconnect).toContain('aria-label="Build plan"');
	expect(decode(reconnect)).toContain('data-tooltip="Reconnect the machine to build"');
	expectPlain("Build plan's tooltip", words(reconnect));
});

const WELL: ConnectionFacts = {
	socket: "up",
	failures: 0,
	retrying: undefined,
	synced: true,
	current: true,
	turn: undefined,
	messages: 0,
	planner: undefined,
};

/** What the live region says as a Planner state is entered from healthy. */
function told(status: ReturnType<typeof statuses>[number]): string {
	let { view } = connectionStep(INITIAL_MEMORY, { ...WELL, planner: status });
	return connectionSpeech(NOTHING_SPOKEN, view)?.said ?? "";
}
