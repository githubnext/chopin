import { describe, expect, it } from "bun:test";

import {
	displayText,
	duration,
	group,
	summarize,
	waitingCards,
	waitingPrompts,
	waitingText,
	workPhase,
} from "./model";

import type { Chat } from "@chopin/protocol";

function entry(id: string, author: Chat.Author, text = id): Chat.Entry {
	return { id, author, text, ts: 1_700_000_000 };
}

function working(entryOffset = 1) {
	return { id: "turn-1", started: 1_700_000_001, entryOffset };
}

function running(name: string): Chat.Activity[] {
	return [{ id: "tool", name, status: "running" }];
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
				text: "",
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
		expect(JSON.stringify(result)).not.toContain('"working":true');
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

	it("promotes current tool activity without duplicating the work row", () => {
		let result = group(
			[
				{
					...entry("old", { kind: "agent" }, ""),
					ts: 1_699_999_999,
					tools: [{ id: "old-tool", name: "read_plan", status: "running" }],
				},
				entry("prompt", { kind: "member", handle: "ana" }),
				{
					...entry("current", { kind: "agent" }, ""),
					ts: 1_700_000_001,
					tools: [{ id: "new-tool", name: "edit_plan", status: "running" }],
				},
			],
			[],
			working(2),
		);

		expect(result).toMatchObject([
			{ kind: "messages", messages: [{ id: "old" }] },
			{ kind: "messages", messages: [{ id: "prompt" }] },
			{ kind: "messages", messages: [{ id: "current", working: true }] },
		]);
		expect(JSON.stringify(result[0])).not.toContain('"working":true');
		expect(JSON.stringify(result).match(/"working":true/g)).toHaveLength(1);
	});

	it("does not promote historical activity from the same second as a new turn", () => {
		let result = group(
			[
				{
					...entry("old", { kind: "agent" }, ""),
					ts: 1_700_000_001,
					tools: [{ id: "old-tool", name: "read_plan", status: "running" }],
				},
				{ ...entry("prompt", { kind: "member", handle: "ana" }), ts: 1_700_000_001 },
				{ ...entry("room", { kind: "member", handle: "sam" }), ts: 1_700_000_001 },
				{
					...entry("current", { kind: "agent" }, ""),
					ts: 1_700_000_001,
					tools: [{ id: "current-tool", name: "edit_plan", status: "running" }],
				},
			],
			[],
			working(2),
		);

		expect(result.at(-1)).toMatchObject({
			kind: "messages",
			messages: [{ id: "current", working: true, tools: [{ id: "current-tool" }] }],
		});
		expect(JSON.stringify(result[0])).not.toContain('"working":true');
	});

	it("uses streamed prose as the active row instead of adding a second one", () => {
		let result = group(
			[
				entry("prompt", { kind: "member", handle: "ana" }),
				{
					...entry("answer", { kind: "agent" }, "I found it."),
					ts: 1_700_000_001,
					streaming: true,
				},
			],
			[],
			working(),
		);

		expect(result.at(-1)).toMatchObject({
			kind: "messages",
			messages: [{ id: "answer", working: true, streaming: true }],
		});
		expect(JSON.stringify(result)).not.toContain('"id":"turn-1"');
	});

	it("keeps active work on its first entry as later tool entries arrive", () => {
		let result = group(
			[
				entry("prompt", { kind: "member", handle: "ana" }),
				{
					...entry("first-tool", { kind: "agent" }, ""),
					ts: 1_700_000_001,
					tools: [{ id: "read", name: "read_plan", status: "done" }],
				},
				{ ...entry("response", { kind: "agent" }, "I found it."), ts: 1_700_000_002 },
				{
					...entry("later-tool", { kind: "agent" }, ""),
					ts: 1_700_000_003,
					tools: [{ id: "edit", name: "edit_plan", status: "running" }],
				},
			],
			[],
			working(),
		);
		let messages = result.flatMap(item => item.kind === "messages" ? item.messages : []);

		expect(messages.find(item => item.id === "first-tool")).toMatchObject({
			working: true,
			tools: [{ id: "read" }, { id: "edit" }],
		});
		expect(messages.find(item => item.id === "later-tool")?.tools).toBeUndefined();
		expect(messages.filter(item => item.working)).toHaveLength(1);

		let completed = group(
			[
				entry("prompt", { kind: "member", handle: "ana" }),
				{
					...entry("first-tool", { kind: "agent" }, ""),
					ts: 1_700_000_001,
					tools: [{ id: "read", name: "read_plan", status: "done" }],
				},
				{
					...entry("later-tool", { kind: "agent" }, ""),
					ts: 1_700_000_003,
					tools: [{ id: "edit", name: "edit_plan", status: "running" }],
				},
			],
			[],
			undefined,
			[{
				turnId: "turn-1",
				entryOffset: 1,
				endOffset: 3,
				anchorId: "first-tool",
			}],
		);
		let completedMessages = completed.flatMap(item =>
			item.kind === "messages" ? item.messages : []
		);
		expect(completedMessages.find(item => item.id === "first-tool")?.tools).toMatchObject([
			{ id: "read" },
			{ id: "edit" },
		]);
		expect(completedMessages.find(item => item.id === "later-tool")?.tools).toBeUndefined();
	});

	it("keeps completed tools on earlier prose when a later entry owns the call", () => {
		let entries = [
			entry("prompt", { kind: "member", handle: "ana" }),
			entry("prose", { kind: "agent" }, "I will inspect this."),
			{
				...entry("tool-entry", { kind: "agent" }, ""),
				tools: [{ id: "read", name: "read_plan", status: "done" as const }],
			},
		];
		let retained = [{
			turnId: "turn-1",
			entryOffset: 1,
			endOffset: 3,
			anchorId: "prose",
		}];
		let messages = group(entries, [], undefined, retained).flatMap(item =>
			item.kind === "messages" ? item.messages : []
		);
		expect(messages.find(item => item.id === "prose")?.tools).toMatchObject([{ id: "read" }]);
		expect(messages.find(item => item.id === "tool-entry")?.tools).toBeUndefined();
	});

	it("keeps one inspectable work anchor while its connection is offline", () => {
		let entries = [
			entry("prompt", { kind: "member", handle: "ana" }),
			entry("prose", { kind: "agent" }, "I will inspect this."),
			{
				...entry("tool-entry", { kind: "agent" }, ""),
				tools: [{ id: "read", name: "read_plan", status: "running" as const }],
			},
		];
		let suspended = {
			turnId: "turn-1",
			entryOffset: 1,
			endOffset: 3,
			anchorId: "prose",
		};
		let messages = group(entries, [], undefined, [], suspended).flatMap(item =>
			item.kind === "messages" ? item.messages : []
		);
		expect(messages.find(item => item.id === "prose")).toMatchObject({
			workDisconnected: true,
			tools: [{ id: "read" }],
		});
		expect(messages.find(item => item.id === "tool-entry")?.tools).toBeUndefined();
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

describe("work progression", () => {
	it("derives each active stage from real tool and stream events", () => {
		expect(workPhase([], false, true)).toBe("Getting oriented");
		expect(workPhase(running("read_plan"), false, true)).toBe("Gathering context");
		expect(workPhase(running("list_files"), false, true)).toBe("Gathering context");
		expect(workPhase(running("search_code"), false, true)).toBe("Gathering context");
		expect(workPhase(running("ask"), false, true)).toBe("Waiting for an answer");
		expect(workPhase(running("edit_plan"), false, true)).toBe("Making changes");
		expect(workPhase(running("create_anchor"), false, true)).toBe("Making changes");
		expect(workPhase(running("run_tests"), false, true)).toBe("Working through the request");
		expect(workPhase([], true, true)).toBe("Writing a response");
		expect(workPhase(running("read_plan"), true, true)).toBe("Gathering context");
		expect(workPhase([{ id: "tool", name: "read_plan", status: "done" }], false, true))
			.toBe("Reviewing the next step");
		expect(workPhase([], false, false)).toBeUndefined();
	});

	it("counts finished and interrupted actions without claiming turn duration", () => {
		let tools: Chat.Activity[] = [
			{ id: "t1", name: "read_file", status: "done", took: 38 },
			{ id: "t2", name: "edit_plan", status: "failed", took: 1_200 },
			{ id: "t3", name: "ask", status: "running" },
		];
		expect(summarize(tools, true)).toEqual({
			count: 3,
			finished: 2,
			failures: 1,
			interrupted: 0,
			toolTime: 1_238,
		});
		expect(summarize(tools, false)).toEqual({
			count: 3,
			finished: 2,
			failures: 1,
			interrupted: 1,
			toolTime: 1_238,
		});
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

describe("waiting decisions in work progression", () => {
	it("derives pending ask prompts without treating other tools as waits", () => {
		expect(
			waitingPrompts([{
				id: "ask",
				name: "ask",
				status: "running",
				args: JSON.stringify({ questions: [{ question: "Which database?" }] }),
			}]),
		).toEqual(["Which database?"]);
		expect(waitingPrompts([{ id: "read", name: "read_plan", status: "running" }])).toBeUndefined();
		expect(waitingPrompts([{ id: "ask", name: "ask", status: "done" }])).toBeUndefined();
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
});
