import { describe, expect, it } from "bun:test";
import { buildBlockers, buildBlockerSummary } from "./build-blockers";

import type { QuestionnaireEntry } from "@chopin/editor";
import type { Question } from "@chopin/protocol";
import type { ImplementationSnapshot } from "@chopin/protocol/implementation";

let snapshot: ImplementationSnapshot = {
	revision: 1,
	planRevision: 1,
	localAgent: true,
	buildReady: false,
	blockers: ["unanswered questionnaires"],
	lifecycle: { execution: { state: "idle" }, history: [] },
	buildInvestigations: [{ id: "spike", brief: "Measure cold starts", reason: "Choose a cache" }],
};
let entry: QuestionnaireEntry = {
	id: "card",
	value: {
		id: "card",
		questions: [
			{
				id: "answered",
				header: "Scope",
				prompt: "What is cached?",
				multiple: false,
				options: [],
				answer: "Documents",
			},
			{
				id: "open",
				header: "Expiry",
				prompt: "How should the cache expire?",
				multiple: false,
				options: [],
			},
		],
	},
};
let metadata = (status: Question.CardMeta["status"]) =>
	new Map<string, Question.CardMeta>([
		[entry.id, {
			status,
			origin: "planner",
			involved: [],
			history: [],
			optionOrigins: {},
			hasProse: false,
			refining: false,
			proseOrphaned: false,
		}],
	]);

describe("named build blockers", () => {
	it("targets each unanswered question and the required investigation by identity", () => {
		expect(buildBlockers(snapshot, [entry], new Map())).toEqual([
			{ kind: "decision", id: "card", question: "open", title: "How should the cache expire?" },
			{ kind: "investigation", id: "spike", title: "Measure cold starts" },
		]);
	});
	it("honours authoritative settled metadata ahead of an old document projection", () => {
		for (let status of ["decided", "discarded", "expired"] as const) {
			expect(buildBlockers(snapshot, [entry], metadata(status)).map(item => item.kind))
				.toEqual(["investigation"]);
		}
	});
	it("includes previously answered questions when the record reopens a card", () => {
		expect(
			buildBlockers(snapshot, [entry], metadata("reopened"))
				.filter(item => item.kind === "decision").map(item => item.question),
		)
			.toEqual(["answered", "open"]);
	});
	it("only includes decisions when the server reports that they block this build", () => {
		expect(buildBlockers({ ...snapshot, blockers: [] }, [entry], new Map()))
			.toEqual([{ kind: "investigation", id: "spike", title: "Measure cold starts" }]);
		expect(buildBlockers(undefined, [entry], new Map())).toEqual([]);
	});
	it("summarises single, plural and mixed blockers without exposing titles in the capsule", () => {
		let items = buildBlockers(snapshot, [entry], new Map());
		expect(buildBlockerSummary(items.slice(0, 1))).toEqual({
			tone: "decision",
			label: "1 decision left",
		});
		expect(
			buildBlockerSummary([items[1]!, {
				kind: "investigation",
				id: "memory",
				title: "Measure memory",
			}]),
		)
			.toEqual({ tone: "investigation", label: "2 investigations left" });
		expect(buildBlockerSummary(items)).toEqual({ tone: "mixed", label: "2 blockers left" });
	});
});
