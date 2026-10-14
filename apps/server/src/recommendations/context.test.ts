import { describe, expect, it } from "bun:test";

import { recommendationContext } from "./context";
import { MAX_RECOMMENDATION_INPUT_BYTES, parseRecommendationInput } from "./schema";

import type { Chat, Comment } from "@chopin/protocol";
import type { Investigation } from "@chopin/experiment/records";
import type { Record as Decision } from "../questions/record-types";
import type { JsonValue } from "../storage/model";

function document(
	sidecar: unknown = { revision: 1 },
	source = "Make open decisions discoverable.",
) {
	return { source, sidecar: JSON.parse(JSON.stringify(sidecar)) as JsonValue };
}

function member(text = "Can I create an open decision?"): Chat.Entry {
	return { id: "feedback", author: { kind: "member", handle: "mona" }, text, ts: 100 };
}

function decision(): Decision {
	return {
		id: "creation",
		definition: {
			questions: [{
				id: "entry-point",
				header: "Creation",
				question: "Where should decision creation appear?",
				multiple: false,
				options: [{ id: "tab", label: "Decisions tab", description: "Use the existing action." }],
			}],
		},
		status: "open",
		origin: "planner",
		history: [],
		optionOrigins: {},
		editors: [],
	};
}

function investigation(
	report = "The current toolbar already offers decision creation.",
): Investigation {
	return {
		id: "00000000-0000-4000-8000-000000000001",
		documentId: "root",
		revision: 1,
		brief: "Check whether open decisions can be created.",
		requester: "mona",
		state: "completed",
		generation: 1,
		expiresAt: 1000,
		createdAt: 100,
		updatedAt: 200,
		progress: "Complete",
		result: {
			schemaVersion: 1,
			report,
			datasets: [],
			views: [],
			evidence: [],
			provenance: { environment: "Local checkout", checks: ["Inspected toolbar"], limitations: [] },
		},
		views: {},
		decisions: [],
		receipts: {},
	};
}

describe("persisted recommendation context", () => {
	it("requires a canonical revision and useful document or human discussion", () => {
		expect(recommendationContext(document({ revision: -1 }))).toBeUndefined();
		expect(recommendationContext(document({}, "Intent"))).toBeUndefined();
		expect(recommendationContext(document({ revision: 0 }, ""))).toBeUndefined();
		expect(recommendationContext(document({ revision: 0 }, "# Untitled document\n\n")))
			.toBeUndefined();
		expect(recommendationContext(document({ revision: 0, transcript: [member()] }, "")))
			.toMatchObject({ planRevision: 0, evidence: [{ kind: "discussion" }] });
	});

	it("human direction changes invalidate advice, including text outside the supplied excerpt", () => {
		let context = (text: string) =>
			recommendationContext(document({ revision: 1, transcript: [member(text)] }))!;
		let first = context("Improve the decision creation entry point.");
		expect(context("Leave creation alone; clarify the open status.").key).not.toBe(first.key);
		let long = "a".repeat(2000);
		let before = context(`${long} Broader onboarding.`);
		let after = context(`${long} Only the status label.`);
		expect(before.evidence).toEqual(after.evidence);
		expect(before.key).not.toBe(after.key);
	});

	it("answered and reopened decisions bind different advice without a document revision change", () => {
		let open = decision();
		let answered: Decision = {
			...open,
			status: "answered",
			choices: ["tab"],
			decidedAt: 200,
			answers: { "entry-point": "Decisions tab" },
			history: [{ choices: ["tab"], owner: "mona", at: 200 }],
		};
		let reopened: Decision = { ...answered, status: "reopened" };
		let contexts = [open, answered, reopened].map(value =>
			recommendationContext(document({ revision: 1, questions: [value] }))!
		);
		expect(new Set(contexts.map(value => value.key)).size).toBe(3);
		expect(contexts[1]!.evidence.find(item => item.kind === "decision")?.detail)
			.toContain("Decisions tab");
	});

	it("investigation contradiction, revision and omitted report changes all invalidate advice", () => {
		let base = investigation();
		let context = (value: Investigation) => recommendationContext(document(), [value])!;
		expect(context(investigation("Decision creation is unavailable to read-only members.")).key)
			.not.toBe(context(base).key);
		expect(context({ ...base, revision: 2 }).key).not.toBe(context(base).key);
		let before = investigation(`${"a".repeat(5000)} Creation is available.`);
		let after = investigation(`${"a".repeat(5000)} Creation is unavailable.`);
		expect(context(before).evidence).toEqual(context(after).evidence);
		expect(context(before).key).not.toBe(context(after).key);
	});

	it("research contradiction, revision and omitted source changes all invalidate advice", () => {
		let base = {
			id: "research",
			title: "Decision entry points",
			revision: 1,
			source: "People found the toolbar action.",
		};
		let context = (item: typeof base) => recommendationContext(document(), [], [item])!;
		expect(context({ ...base, source: "People could not find the toolbar action." }).key)
			.not.toBe(context(base).key);
		expect(context({ ...base, revision: 2 }).key).not.toBe(context(base).key);
		let before = context({ ...base, source: `${"a".repeat(6000)} Success.` });
		let after = context({ ...base, source: `${"a".repeat(6000)} Failure.` });
		expect(before.evidence).toEqual(after.evidence);
		expect(before.key).not.toBe(after.key);
	});

	it("canonical source edits outside the worker's excerpt still change the context key", () => {
		let source = "a".repeat(23_000);
		let before = recommendationContext(document({ revision: 1 }, `${source} Broad onboarding.`))!;
		let after = recommendationContext(document({ revision: 1 }, `${source} Status label only.`))!;
		expect(before.evidence).toEqual(after.evidence);
		expect(before.key).not.toBe(after.key);
		expect(parseRecommendationInput(before)).toEqual(before);
	});

	it("document chunk boundaries preserve complete Unicode characters", () => {
		let source = `${"a".repeat(5499)}🧭${"b".repeat(5499)}🧭`;
		let context = recommendationContext(document({ revision: 1 }, source))!;
		expect(context.evidence).toHaveLength(3);
		expect(context.evidence.every(item => item.detail.isWellFormed())).toBe(true);
		expect(context.evidence[1]!.detail).toContain("🧭");
		expect(context.evidence[2]!.detail).toContain("🧭");
		expect(parseRecommendationInput(context)).toEqual(context);
	});

	it("draft answers and streaming agent prose or running tools do not change committed context", () => {
		let transcript = [member()];
		let before = recommendationContext(document({ revision: 1, transcript }))!;
		let agent: Chat.Entry = {
			id: "agent",
			author: { kind: "agent" },
			text: "Provisional claim",
			ts: 200,
			streaming: true,
			tools: [{
				id: "read",
				name: "get_file_contents",
				status: "running",
				result: "Partial output",
			}],
		};
		let after = recommendationContext(
			document({
				revision: 1,
				transcript: [...transcript, agent],
				drafts: [{ id: "creation", answers: { "entry-point": "Unsubmitted answer" } }],
				busy: true,
				turn: { id: "live-turn" },
			}),
		)!;
		expect(after).toEqual(before);
	});

	it("authored claims and observed repository results remain distinct evidence kinds", () => {
		let tool: Chat.Activity = {
			id: "toolbar-read",
			name: "read_repository_file",
			status: "done",
			args: "apps/web/src/decisions.tsx",
			result: "Only the toolbar exposes creation.",
		};
		let agent: Chat.Entry = {
			id: "agent",
			author: { kind: "agent" },
			text: "I think it is available everywhere.",
			ts: 200,
			tools: [tool],
		};
		let context = recommendationContext(
			document({ revision: 1, transcript: [agent] }, "Creation is available everywhere."),
		)!;
		expect(context.evidence.map(item => item.kind)).toEqual(["document", "repository"]);
		expect(context.evidence[0]!.detail).toContain("Authored intent, not verified implementation");
		expect(context.evidence[1]!.detail).toContain("Previously observed tool output");
		expect(context.evidence[1]!.detail).toContain("Only the toolbar");
		expect(context.evidence.some(item => item.detail.includes("I think"))).toBe(false);
	});

	it("long decision definitions cannot hide the saved answer or chosen option", () => {
		let record = decision();
		record.status = "answered";
		record.definition.questions[0]!.options = Array.from({ length: 10 }, (_, index) => ({
			id: `choice-${index}`,
			label: index === 9 ? "Keep the existing entry point" : `Alternative ${index}`,
			description: "Background context. ".repeat(50),
		}));
		record.choices = ["choice-9"];
		record.answers = { "entry-point": "Clarify status without moving creation." };
		let context = recommendationContext(document({ revision: 1, questions: [record] }))!;
		let detail = context.evidence.find(item => item.kind === "decision")!.detail;
		expect(detail).toContain('"status":"answered"');
		expect(detail).toContain("Where should decision creation appear?");
		expect(detail).toContain("Clarify status without moving creation.");
		expect(detail).toContain("Keep the existing entry point");
		expect(parseRecommendationInput(context)).toEqual(context);
		record.definition.questions[0]!.options[0]!.description += " Different omitted rationale.";
		let changed = recommendationContext(document({ revision: 1, questions: [record] }))!;
		expect(changed.evidence).toEqual(context.evidence);
		expect(changed.key).not.toBe(context.key);
	});

	it("long investigation briefs cannot hide their Build requirement or contradictory findings", () => {
		let value = investigation(
			"Observed result: the creation action is inaccessible to keyboard users.",
		);
		value.brief = "Background context. ".repeat(400);
		value.buildBlocker = "Resolve keyboard access to the existing creation action.";
		let context = recommendationContext(document(), [value])!;
		let detail = context.evidence.find(item => item.kind === "investigation")!.detail;
		expect(detail).toContain("completed");
		expect(detail).toContain(value.buildBlocker);
		expect(detail).toContain(value.result!.report);
		expect(detail).toContain("[Excerpt; remaining text omitted.]");
		expect(parseRecommendationInput(context)).toEqual(context);
		value.brief = `${value.brief.slice(0, -1)}?`;
		let changed = recommendationContext(document(), [value])!;
		expect(changed.evidence).toEqual(context.evidence);
		expect(changed.key).not.toBe(context.key);
	});

	it("late human comment direction survives long earlier notes and later Planner replies", () => {
		let notes: Comment.Note[] = [
			{ id: "first", author: "member", handle: "mona", ts: 100, text: "🧭".repeat(2000) },
			{ id: "pause", author: "member", handle: "octo", ts: 200, text: "Pause this build." },
			...Array.from({ length: 10 }, (_, index): Comment.Note => ({
				id: `planner-${index}`,
				author: "planner",
				ts: 300 + index,
				text: "Planner suggestion: ship the original scope. ".repeat(80),
			})),
		];
		let thread = { id: "direction", status: "open", quote: "🧭".repeat(2000), notes };
		let context = () => recommendationContext(document({ revision: 1, threads: [thread] }))!;
		let before = context();
		let detail = before.evidence.find(item => item.id === "comment:direction")!.detail;
		expect(detail).toContain("Pause this build.");
		expect(detail).toContain('"author":"member"');
		expect(detail).toContain('"handle":"octo"');
		expect(detail).toContain('"ts":200');
		expect(detail).not.toContain("Planner suggestion");
		expect(parseRecommendationInput(before)).toEqual(before);
		thread.notes[1]!.text = "Build only the existing entry point.";
		let changed = context();
		expect(changed.key).not.toBe(before.key);
		expect(changed.evidence.find(item => item.id === "comment:direction")!.detail)
			.toContain("Build only the existing entry point.");
		thread.notes[0]!.text += " Omitted early direction changed.";
		let omittedChange = context();
		expect(omittedChange.evidence).toEqual(changed.evidence);
		expect(omittedChange.key).not.toBe(changed.key);
	});

	it("every selected evidence class retains its fields under escaped Unicode byte limits", () => {
		let dense = '🧭"\\\n\u0000'.repeat(5000);
		let records = Array.from({ length: 10 }, (_, recordIndex) => {
			let value = decision();
			value.id = `decision-${recordIndex}`;
			value.status = "answered";
			value.definition.questions = Array.from({ length: 10 }, (_, questionIndex) => ({
				id: `question-${questionIndex}`,
				header: "First step",
				question: `${questionIndex}: ${dense}`,
				multiple: true,
				options: [{
					id: `option-${questionIndex}`,
					label: `CHOICE-${questionIndex} ${dense}`,
					description: dense,
				}],
			}));
			value.choices = value.definition.questions.map(question => question.options[0]!.id);
			value.answers = Object.fromEntries(
				value.definition.questions.map((question, questionIndex) => [
					question.id,
					`ANSWER-${recordIndex}-${questionIndex} ${dense}`,
				]),
			);
			return value;
		});
		let investigations = Array.from({ length: 6 }, (_, index) => ({
			...investigation(`FINDING-${index} ${dense}`),
			id: `investigation-${index}`,
			brief: dense,
			buildBlocker: `BLOCKER-${index} ${dense}`,
		}));
		let discussion = Array.from({ length: 12 }, (_, index) => ({
			...member(`HUMAN-${index} ${dense}`),
			id: `human-${index}`,
		}));
		let repository: Chat.Entry = {
			id: "repository",
			author: { kind: "agent" },
			text: "",
			ts: 200,
			tools: Array.from({ length: 6 }, (_, index) => ({
				id: `read-${index}`,
				name: "read_repository_file",
				status: "done",
				args: dense,
				result: `REPOSITORY-${index} ${dense}`,
			})),
		};
		let comments = Array.from({ length: 4 }, (_, index) => ({
			id: `thread-${index}`,
			status: "open",
			quote: dense,
			notes: [
				{ id: "early", author: "member", handle: "mona", ts: 100, text: dense },
				{
					id: "pause",
					author: "member",
					handle: "octo",
					ts: 200,
					text: `PAUSE-${index} ${dense}`,
				},
				{ id: "planner", author: "planner", ts: 300, text: dense },
			],
		}));
		let research = Array.from({ length: 4 }, (_, index) => ({
			id: `report-${index}`,
			title: dense,
			source: `RESEARCH-${index} ${dense}`,
			revision: 1,
		}));
		let context = recommendationContext(
			document({
				revision: 1,
				questions: records,
				transcript: [...discussion, repository],
				threads: comments,
			}, dense),
			investigations,
			research,
		)!;
		expect(context.evidence).toHaveLength(46);
		for (
			let [prefix, count] of Object.entries({
				document: 4,
				discussion: 12,
				decision: 10,
				comment: 4,
				repository: 6,
				investigation: 6,
				research: 4,
			})
		) {
			expect(context.evidence.filter(item => item.id.startsWith(`${prefix}:`))).toHaveLength(count);
		}
		for (let [index, record] of records.entries()) {
			let detail = context.evidence.find(item => item.id === `decision:${record.id}`)!.detail;
			expect(detail).toContain("9:");
			expect(detail).toContain(`ANSWER-${index}-9`);
			expect(detail).toContain("CHOICE-9");
		}
		for (let [index, item] of investigations.entries()) {
			let detail = context.evidence.find(value => value.id === `investigation:${item.id}`)!.detail;
			expect(detail).toContain(`BLOCKER-${index}`);
			expect(detail).toContain(`FINDING-${index}`);
		}
		for (let index = 0; index < 6; index++) {
			expect(context.evidence.find(item => item.id === `repository:read-${index}`)!.detail)
				.toContain(`REPOSITORY-${index}`);
		}
		for (let index = 0; index < 4; index++) {
			expect(context.evidence.find(item => item.id === `comment:thread-${index}`)!.detail)
				.toContain(`PAUSE-${index}`);
			expect(context.evidence.find(item => item.id === `research:report-${index}`)!.detail)
				.toContain(`RESEARCH-${index}`);
		}
		for (let index = 0; index < 12; index++) {
			expect(context.evidence.find(item => item.id === `discussion:human-${index}`)!.detail)
				.toContain(`HUMAN-${index}`);
		}
		for (
			let [prefix, budget] of Object.entries({
				document: 16_000,
				discussion: 12_000,
				decision: 24_000,
				comment: 5000,
				repository: 10_000,
				investigation: 16_000,
				research: 13_000,
			})
		) {
			let bytes = context.evidence.filter(item => item.id.startsWith(`${prefix}:`))
				.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item)), 0);
			expect(bytes).toBeLessThanOrEqual(budget);
		}
		expect(context.evidence.every(item => item.detail.length <= 6000)).toBe(true);
		expect(context.evidence.every(item => item.detail.isWellFormed() && item.label.isWellFormed()))
			.toBe(true);
		expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(MAX_RECOMMENDATION_INPUT_BYTES);
		expect(parseRecommendationInput(context)).toEqual(context);
	});

	it("actual production repository reads change context identity when their observed result changes", () => {
		for (
			let name of [
				"read_repository_file",
				"list_repository_tree",
				"search_repository",
				"repository_history",
			]
		) {
			let entry: Chat.Entry = {
				id: "repository",
				author: { kind: "agent" },
				text: "",
				ts: 200,
				tools: [{ id: "observed", name, status: "done", result: "Existing action is accessible." }],
			};
			let before = recommendationContext(document({ revision: 1, transcript: [entry] }))!;
			entry.tools![0]!.result = "Existing action is inaccessible.";
			let after = recommendationContext(document({ revision: 1, transcript: [entry] }))!;
			expect(before.key).not.toBe(after.key);
			expect(after.evidence.find(item => item.kind === "repository")?.detail).toContain(
				"inaccessible",
			);
		}
	});
});
