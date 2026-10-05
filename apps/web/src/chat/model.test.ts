import { describe, expect, it } from "bun:test";

import {
	displayText,
	duration,
	group,
	runningLabel,
	summarize,
	waitingCards,
	waitingText,
} from "./model";

import type { Chat } from "@chopin/protocol";

function entry(id: string, author: Chat.Author, text = id): Chat.Entry {
	return { id, author, text, ts: 1_700_000_000 };
}

function working() {
	return { id: "turn-1", started: 1_700_000_001 };
}

function reference(): Chat.Reference {
	return {
		id: "reference-one",
		kind: "document",
		channelId: "channel-one",
		start: 4,
		end: 9,
		label: "#Plan",
		href: "/documents/octo-org/score/plan",
		repositoryId: "repository-one",
		observedRevision: 3,
		observedSourceHash: "sha256:plan",
	};
}

describe("transcript groups", () => {
	it("adds one temporary Planner message while a turn has no response", () => {
		expect(group([], [], working())).toEqual([{
			kind: "messages",
			author: { kind: "agent" },
			messages: [{
				id: "turn-1",
				author: { kind: "agent" },
				text: "Working on it",
				ts: 1_700_000_001,
				queued: false,
				working: true,
			}],
			queued: false,
		}]);
	});

	it("replaces the temporary Planner message when a response arrives", () => {
		let result = group([entry("a1", { kind: "agent" }, "I found it.")], []);

		expect(result).toMatchObject([{
			kind: "messages",
			messages: [{ id: "a1", text: "I found it." }],
		}]);
		expect(JSON.stringify(result)).not.toContain("Working on it");
	});

	it("does not keep a temporary Planner message after a turn stops", () => {
		expect(group([], [])).toEqual([]);
	});

	it("places the temporary Planner message before queued requests", () => {
		let result = group(
			[entry("m1", { kind: "member", handle: "ana" })],
			[{ id: "q1", handle: "ana", text: "Then compare options." }],
			working(),
		);

		expect(result.map(item => {
			if (item.kind === "system") return item.kind;
			return item.messages[0]!.id;
		})).toEqual(["m1", "turn-1", "q1"]);
	});

	it("puts consecutive messages from one author in one group", () => {
		let result = group([
			entry("m1", { kind: "member", handle: "ana" }),
			entry("m2", { kind: "member", handle: "ana" }),
			entry("m3", { kind: "agent" }),
		], []);

		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({
			kind: "messages",
			messages: [{ id: "m1" }, { id: "m2" }],
		});
	});

	it("starts a new group when a system line interrupts an author", () => {
		let result = group([
			entry("m1", { kind: "member", handle: "ana" }),
			entry("s1", { kind: "system" }),
			entry("m2", { kind: "member", handle: "ana" }),
		], []);

		expect(result.map(item => item.kind)).toEqual(["messages", "system", "messages"]);
	});

	it("groups queued messages separately from sent messages", () => {
		let result = group(
			[entry("m1", { kind: "member", handle: "ana" })],
			[
				{ id: "q1", handle: "ana", text: "one" },
				{ id: "q2", handle: "ana", text: "two" },
			],
		);

		expect(result).toHaveLength(2);
		expect(result[1]).toMatchObject({ queued: true, messages: [{ id: "q1" }, { id: "q2" }] });
	});

	it("carries persisted references through entries and queued messages", () => {
		let sent = { ...entry("m1", { kind: "member", handle: "ana" }), references: [reference()] };
		let result = group(
			[sent],
			[{ id: "q1", handle: "ana", text: "See #Plan", references: [reference()] }],
		);

		expect(result).toMatchObject([
			{ kind: "messages", messages: [{ id: "m1", references: [{ id: "reference-one" }] }] },
			{ kind: "messages", messages: [{ id: "q1", references: [{ id: "reference-one" }] }] },
		]);
	});
});

describe("rail copy", () => {
	it("removes addressing symbols while leaving email addresses alone", () => {
		expect(displayText("@chopin ask @sam; email me@site.dev"))
			.toBe("ask Sam; email me@site.dev");
	});

	it("formats subsecond and second durations compactly", () => {
		expect([duration(38), duration(1_200), duration(9_200)]).toEqual(["38ms", "1.2s", "9.2s"]);
	});
});

describe("tool-run summaries", () => {
	it("names the live tool in sentence case", () => {
		expect(summarize([
			{ id: "t1", name: "read_file", status: "done", took: 38 },
			{ id: "t2", name: "edit_plan", status: "running" },
		])).toEqual({ state: "running", label: "Editing the document", completed: 1 });
		expect(runningLabel("read_repository_file")).toBe("Reading a file");
		expect(runningLabel("github/get_file_contents")).toBe("Reading a GitHub file");
		expect(runningLabel("github/unknown_tool")).toBe("Using GitHub");
		expect(runningLabel("write_decision_prose")).toBe("Writing decision prose");
		expect(runningLabel("bash")).toBe("Using bash");
	});

	it("treats a live ask as waiting on people, with the prompts it asked", () => {
		let args = JSON.stringify({
			revision: 3,
			questions: [{ question: "Which database?" }, { question: "Which region?" }],
		});
		expect(summarize([
			{ id: "t1", name: "read_plan", status: "done", took: 38 },
			{ id: "t2", name: "ask", status: "running", args },
		])).toEqual({ state: "waiting", prompts: ["Which database?", "Which region?"] });
		expect(summarize([{ id: "t1", name: "ask", status: "running", args: "{" }]))
			.toEqual({ state: "waiting", prompts: [] });
	});

	it("matches distinct open cards when any of their questions was asked", () => {
		let cards = [
			{ id: "old", prompts: ["Which database?"], open: true },
			{ id: "pair", prompts: ["Which cache?", " Which database? "], open: true },
			{ id: "region", prompts: ["Which region?"], open: false },
		];
		expect(waitingCards(["Which database?", "Which region?"], cards))
			.toEqual({ ids: ["old", "pair"], count: 2 });
		expect(waitingCards(["Which cache?", "Which database?"], [cards[1]!]))
			.toEqual({ ids: ["pair"], count: 1 });
	});

	it("counts distinct asked prompts until a card arrives", () => {
		expect(waitingCards(["Which region?", " Which region?", "Which cache?"], []))
			.toEqual({ ids: [], count: 2 });
	});

	it("words the wait for one or several decisions", () => {
		expect(waitingText(1)).toBe("Waiting on your decision");
		expect(waitingText(0)).toBe("Waiting on your decision");
		expect(waitingText(3)).toBe("Waiting on 3 decisions");
	});

	it("reports counts, failures and elapsed time after the run", () => {
		expect(summarize([
			{ id: "t1", name: "read_file", status: "done", took: 38 },
			{ id: "t2", name: "edit_plan", status: "failed", took: 1_200 },
		])).toEqual({ state: "finished", count: 2, failures: 1, elapsed: 1_238 });
	});
});

it("preserves decision metadata and timestamp on system groups", () => {
	let prompt = {
		...entry("decision-prompt", { kind: "system" }, "Ready to decide"),
		decision: { questionnaireId: "card-1", kind: "prompt" as const, generation: 2 },
	};

	expect(group([prompt], [])).toEqual([{
		kind: "system",
		id: "decision-prompt",
		text: "Ready to decide",
		ts: 1_700_000_000,
		decision: prompt.decision,
	}]);
});
