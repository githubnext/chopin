import { describe, expect, it } from "bun:test";

import type { ConversationPlan, Question } from "@chopin/protocol";

import { evidenceCounts, evidenceRows, hasEvidence } from "./evidence";

let source = (
	messageId: string,
	quote: string,
	role: ConversationPlan.SourceRole,
): ConversationPlan.SourceRef => ({
	messageId,
	author: { kind: "member", handle: "mina" },
	quote,
	start: 0,
	end: quote.length,
	role,
});

let contribution = (
	id: string,
	kind: ConversationPlan.Contribution["kind"],
	text: string,
	targetId?: string,
): ConversationPlan.Contribution => ({
	id,
	kind,
	text,
	...(targetId ? { targetId } : {}),
	authoring: "quoted",
	sources: [source(`m-${id}`, text, kind)],
	actor: { kind: "member", handle: "mina" },
});

let stance = (
	participant: string,
	optionId: string | undefined,
	position: ConversationPlan.Stance["position"],
): ConversationPlan.Stance => ({
	id: `${participant}-${optionId}-${position}`,
	participant,
	...(optionId ? { optionId } : {}),
	position,
	sources: [],
	at: 0,
});

const THREAD: ConversationPlan.Thread = {
	id: "t1",
	question: "What auth system should we use?",
	questionSources: [],
	questionAuthoring: "quoted",
	status: "exploring",
	contributions: [
		contribution("auth0", "option", "Auth0"),
		contribution("github", "option", "GitHub Apps"),
		contribution("r1", "reason", "People already have GitHub accounts.", "github"),
		contribution("c1", "constraint", "Must support work organisations.", "t1"),
		contribution("r2", "reason", "The team can maintain it."),
	],
	stances: [
		stance("mina", "github", "support"),
		stance("jules", "github", "support"),
		stance("jules", "github", "support"),
		stance("lee", "auth0", "oppose"),
		stance("sam", "auth0", "neutral"),
		stance("theo", undefined, "support"),
	],
	stanceHistory: [stance("lee", "github", "oppose")],
	decisionHistory: [],
	candidates: [],
	version: 3,
};

const META: Question.CardMeta = {
	status: "open",
	origin: "conversation",
	involved: [],
	history: [],
	optionOrigins: {
		auth0: { origin: "human", rationale: "This must not be shown." },
		github: { origin: "chat", rationale: "This must not be shown either." },
		sso: { origin: "planner", rationale: "Enterprise customers expect SAML." },
	},
	refining: false,
	hasProse: false,
	proseOrphaned: false,
};

describe("evidenceRows", () => {
	it("groups current stances and targeted evidence by option", () => {
		let rows = evidenceRows(THREAD, META);
		expect(rows.map(row => row.label)).toEqual([
			"Auth0",
			"GitHub Apps",
			"What auth system should we use?",
		]);
		let github = rows[1]!;
		expect(github.supporters).toEqual(["mina", "jules"]);
		expect(github.opposers).toEqual([]);
		expect(github.items.map(item => item.text)).toEqual([
			"People already have GitHub accounts.",
		]);
		expect(github.items[0]!.id).toBe("r1");
		expect(github.items[0]!.sources.map(item => item.messageId)).toEqual(["m-r1"]);
		expect(rows[0]!.opposers).toEqual(["lee"]);
		expect(rows[0]!.supporters).toEqual([]);
		expect(rows[0]!.origin).toBe("human");
		expect(rows[0]!.rationale).toBeUndefined();
		expect(rows[2]!.items.map(item => item.text)).toEqual([
			"Must support work organisations.",
			"The team can maintain it.",
		]);
	});

	it("places question-level evidence last and omits an empty general row", () => {
		let rows = evidenceRows(THREAD, META);
		let general = rows.at(-1)!;
		expect(general.optionId).toBeUndefined();
		expect(general.items.map(item => item.kind)).toEqual(["constraint", "reason"]);
		let bare = {
			...THREAD,
			contributions: THREAD.contributions.filter(item => item.kind === "option"),
			stances: [],
		};
		expect(evidenceRows(bare, META).every(row => row.optionId !== undefined)).toBe(true);
	});

	it("follows card order and keeps omitted or unknown option items in the general row", () => {
		let thread: ConversationPlan.Thread = {
			...THREAD,
			contributions: [
				...THREAD.contributions,
				contribution("sso", "option", "Enterprise SSO"),
				contribution("custom", "option", "Custom provider"),
				contribution("r3", "reason", "This option was removed from the card.", "auth0"),
				contribution("r4", "reason", "The old target is unknown.", "gone"),
			],
			stances: [
				...THREAD.stances,
				stance("omitted", "auth0", "support"),
				stance("unknown", "gone", "oppose"),
			],
		};
		let rows = evidenceRows(thread, META, [
			{ id: "sso", label: "Enterprise SSO" },
			{ id: "github", label: "GitHub Apps" },
			{ id: "custom", label: "Custom provider" },
			{ id: "gone", label: "Removed option" },
		]);
		expect(rows.slice(0, 3).map(row => row.optionId)).toEqual(["sso", "github", "custom"]);
		expect(rows[0]).toMatchObject({
			origin: "planner",
			rationale: "Enterprise customers expect SAML.",
		});
		expect(rows[1]!.rationale).toBeUndefined();
		expect(rows[2]!.origin).toBe("chat");
		let general = rows.at(-1)!;
		expect(general.optionId).toBeUndefined();
		expect(general.items.map(item => item.text)).toEqual([
			"Must support work organisations.",
			"The team can maintain it.",
			"This option was removed from the card.",
			"The old target is unknown.",
		]);
		expect(general.supporters).toEqual([]);
		expect(general.opposers).toEqual([]);
	});

	it("shows a sourced Planner option without a conversation contribution", () => {
		let citation = source("m-jevi", "Jev needs access to the release plan.", "option");
		let meta: Question.CardMeta = {
			...META,
			optionOrigins: {
				jev: { origin: "planner", rationale: "Jev can review the plan.", source: citation },
			},
		};
		let thread = { ...THREAD, contributions: [], stances: [] };
		let rows = evidenceRows(thread, meta, [{ id: "jev", label: "Invite Jev" }]);
		expect(rows).toMatchObject([{
			optionId: "jev",
			label: "Invite Jev",
			origin: "planner",
			rationale: "Jev can review the plan.",
			source: citation,
		}]);
		expect(hasEvidence(rows)).toBe(true);
	});

	it("uses one row when a sourced Planner option also has a conversation contribution", () => {
		let citation = source("m-jevi", "Jev needs access to the release plan.", "option");
		let meta: Question.CardMeta = {
			...META,
			optionOrigins: {
				jev: { origin: "planner", rationale: "Jev can review the plan.", source: citation },
			},
		};
		let thread = { ...THREAD, contributions: [contribution("jev", "option", "Invite Jev")] };
		let rows = evidenceRows(thread, meta, [{ id: "jev", label: "Invite Jev" }]);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.source).toEqual(citation);
	});

	it("keeps repository rationale separate from chat quotes", () => {
		let meta: Question.CardMeta = {
			...META,
			optionOrigins: {
				jev: { origin: "planner", rationale: "Repository permissions require it." },
			},
		};
		let thread = { ...THREAD, contributions: [], stances: [] };
		let rows = evidenceRows(thread, meta, [{ id: "jev", label: "Invite Jev" }]);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.rationale).toBe("Repository permissions require it.");
		expect(rows[0]?.source).toBeUndefined();
	});
});

describe("objections", () => {
	let objection = (participant: string, optionId: string | undefined, quote: string) => ({
		...stance(participant, optionId, "oppose"),
		sources: [source(`m-${participant}`, quote, "objection")],
	});

	it("lists a quoted objection under its option and decision-wide ones last", () => {
		let thread: ConversationPlan.Thread = {
			...THREAD,
			stances: [
				...THREAD.stances,
				objection("ravi", "github", "GitHub Apps lock us to one forge."),
				objection("suki", undefined, "I object: we should not decide this yet."),
			],
		};
		let rows = evidenceRows(thread, META);
		let github = rows.find(row => row.optionId === "github")!;
		expect(github.opposers).toEqual(["ravi"]);
		expect(github.items.at(-1)).toMatchObject({
			kind: "objection",
			text: "GitHub Apps lock us to one forge.",
			by: "ravi",
		});
		let general = rows.at(-1)!;
		expect(general.optionId).toBeUndefined();
		expect(general.items.at(-1)).toMatchObject({
			kind: "objection",
			text: "we should not decide this yet.",
			by: "suki",
		});
		expect(evidenceCounts(rows)).toEqual({ reasons: 2, constraints: 1, objections: 2 });
	});

	it("keeps an unquoted opposition as a stance only", () => {
		let rows = evidenceRows(THREAD, META);
		expect(rows[0]!.opposers).toEqual(["lee"]);
		expect(rows.flatMap(row => row.items).some(item => item.kind === "objection")).toBe(false);
	});
});

describe("hasEvidence", () => {
	it("only returns true when a row has visible evidence", () => {
		let bare = {
			...THREAD,
			contributions: THREAD.contributions.filter(item => item.kind === "option"),
			stances: [],
		};
		expect(hasEvidence(evidenceRows(bare, META))).toBe(false);
		expect(hasEvidence(evidenceRows(THREAD, META))).toBe(true);
	});

	it("does not treat an empty Planner rationale as visible evidence", () => {
		let plannerOption: ConversationPlan.Thread = {
			...THREAD,
			contributions: [contribution("sso", "option", "Enterprise SSO")],
			stances: [],
		};
		let plannerMeta: Question.CardMeta = {
			...META,
			optionOrigins: { sso: { origin: "planner", rationale: "Enterprise customers expect SAML." } },
		};
		let emptyRationaleMeta: Question.CardMeta = {
			...plannerMeta,
			optionOrigins: { sso: { origin: "planner", rationale: "" } },
		};
		expect(hasEvidence(evidenceRows(plannerOption, plannerMeta))).toBe(true);
		expect(hasEvidence(evidenceRows(plannerOption, emptyRationaleMeta))).toBe(false);
	});
});
