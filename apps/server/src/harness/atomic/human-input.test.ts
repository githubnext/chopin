import { afterEach, expect, test } from "bun:test";
import * as Question from "@chopin/question";
import * as Questions from "../../questions/service";
import * as Store from "../../questions/store";
import * as Plan from "../../plan/service";
import * as Room from "../../plan/room";
import { MemoryStorage } from "../../storage/memory/adapter";
import * as Edit from "../../plan/edit";
import { createHumanInput } from "./human-input";
import type { Server } from "bun";
import type { HostInputOptions, QuestionParams } from "@bastani/atomic";
import type { Socket, SocketData } from "../../wire";
import type { DocumentRoom } from "../../agent/tools";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(timeoutMs?: number) {
	let storage = new MemoryStorage();
	let now = new Date();
	await storage.users.put({ id: "user", login: "reader", avatarUrl: "", now });
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_test",
		repositoryOwner: "org",
		repositoryName: "repo",
		title: "Questions",
		createdBy: "user",
		now,
	});
	let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
	let frames: any[] = [];
	let server = {
		publish(_topic: string, frame: string) {
			frames.push(JSON.parse(frame));
		},
	} as unknown as Server<SocketData>;
	let plan = await Plan.open(channel.id, {
		storage,
		lease: () => lease,
		fatal: error => {
			throw error;
		},
	}, server);
	let room = {
		id: channel.id,
		plan,
		server,
		anchors() {},
	} as DocumentRoom;
	let ws = {
		data: { handle: "reader", room: channel.id, client: "client" },
		send(frame: string) {
			frames.push(JSON.parse(frame));
		},
		publish(_topic: string, frame: string) {
			frames.push(JSON.parse(frame));
		},
	} as unknown as Socket;
	cleanups.push(() => Plan.close(plan));
	let controller = new AbortController();
	let options: HostInputOptions = {
		requestId: "request",
		sessionId: "session",
		signal: controller.signal,
	};
	let input = createHumanInput(room, timeoutMs);
	async function cards(count: number) {
		await wait(() => Store.outstanding(plan.questions).length === count);
		return Store.outstanding(plan.questions);
	}
	async function answer(id: string, value: number[] | string) {
		let opened = Store.snapshot(plan.questions, id);
		if (!opened.open) throw new Error("question closed");
		let definition = Store.get(plan.questions, id)!.definition;
		let model = Question.restore(opened.model, definition);
		let question = definition.questions[0];
		if (typeof value === "string") {
			model.api.val([question.id, "mode"]).set("custom");
			if (value) model.api.str([question.id, "custom"]).ins(0, value);
		} else if (question.multiple) {
			for (let index of value) {
				model.api.val([question.id, "options", question.options[index]!.id]).set(true);
			}
		} else model.api.val([question.id, "choice"]).set(question.options[value[0]!]!.id);
		let patch = model.api.flush();
		if (patch) {
			await Questions.edit(plan, ws, {
				kind: "question:edit",
				rid: "edit",
				ts: 0,
				id,
				patch: [...patch.toBinary()],
			});
		}
		let current = Store.snapshot(plan.questions, id);
		if (!current.open) throw new Error("question closed");
		await Questions.submit(plan, server, channel.id, ws, {
			kind: "question:submit",
			rid: "submit",
			ts: 0,
			id,
			revision: current.revision,
		});
	}
	return { input, plan, storage, frames, controller, options, cards, answer, ws, server, room };
}

async function wait(ready: () => boolean) {
	for (let i = 0; i < 200; i++) {
		if (ready()) return;
		await Bun.sleep(5);
	}
	throw new Error("question did not arrive");
}

let params: QuestionParams = {
	questions: [
		{
			header: "Choice",
			question: "  Which?  ",
			options: [
				{ label: " A ", description: "  first  ", preview: "preview A" },
				{ label: "B", description: "second" },
			],
		},
		{
			header: "Multiple",
			question: "Select several",
			multiSelect: true,
			options: [
				{ label: "C", description: "" },
				{ label: "D", description: "" },
			],
		},
		{
			header: "Custom",
			question: "Or free text?",
			options: [
				{ label: "E", description: "" },
				{ label: "F", description: "" },
			],
		},
	],
};

test("HostInput appends one ordered questionnaire batch and returns typed answers verbatim", async () => {
	let f = await fixture();
	let edited = Edit.apply(f.plan, f.plan.revision, [{
		op: "replace_root",
		source: "# Existing document\n\nLast paragraph.\n",
	}]);
	if (!edited.ok) throw new Error("fixture edit failed");
	if (edited.mutation) await Plan.publish(f.plan, f.server, f.room.id, edited.mutation);
	let response = f.input.questionnaire(params, f.options);
	let cards = await f.cards(3);
	expect(cards.map(card => card.definition.questions[0].header)).toEqual([
		"Choice",
		"Multiple",
		"Custom",
	]);
	expect(cards[0]!.definition.questions[0].options[0]).toMatchObject({
		label: " A ",
		description: "  first  ",
	});
	let source = Plan.source(f.plan);
	expect(source.indexOf("Last paragraph.")).toBeLessThan(source.indexOf("<Questionnaire"));
	await f.answer(cards[2]!.id, "  typed\n");
	await f.answer(cards[0]!.id, [0]);
	await f.answer(cards[1]!.id, [1, 0]);
	expect(await response).toEqual({
		cancelled: false,
		answers: [
			{
				questionIndex: 0,
				question: "  Which?  ",
				kind: "option",
				answer: " A ",
				preview: "preview A",
			},
			{
				questionIndex: 1,
				question: "Select several",
				kind: "multi",
				selected: ["C", "D"],
				answer: null,
			},
			{ questionIndex: 2, question: "Or free text?", kind: "custom", answer: "  typed\n" },
		],
	});
});

test("maps confirm/select dialogs without treating custom text as approval or a selection", async () => {
	let f = await fixture();
	for (let [value, approved] of [[[0], true], [[1], false], ["Yes", false]] as const) {
		let result = f.input.confirm("Proceed?", "This changes files.", f.options);
		let [card] = await f.cards(1);
		expect(card!.definition.questions[0].question).toBe("Proceed?\n\nThis changes files.");
		await f.answer(card!.id, typeof value === "string" ? value : [...value]);
		expect(await result).toBe(approved);
	}
	let selected = f.input.select("Pick", ["  second  ", "first", "first"], f.options);
	let [card] = await f.cards(1);
	expect(card!.definition.questions[0].options.map(option => option.label)).toEqual([
		"  second  ",
		"first",
		"first",
	]);
	await f.answer(card!.id, [0]);
	expect(await selected).toBe("  second  ");
	let custom = f.input.select("Pick", ["yes", "no"], f.options);
	await f.answer((await f.cards(1))[0]!.id, "yes");
	expect(await custom).toBeUndefined();
});

test("input and editor are editable free-text cards that round-trip through the document", async () => {
	let f = await fixture();
	for (let method of ["input", "editor"] as const) {
		let response = f.input[method]("Title", "  initial or hint\n", f.options);
		let [card] = await f.cards(1);
		let question = card!.definition.questions[0];
		expect(question.options).toEqual([]);
		expect(question.question).toBe("Title\n\n  initial or hint\n");
		let source = Plan.source(f.plan);
		let roundTrip = await Room.create(source);
		expect(Room.project(roundTrip)).toContain(
			`header="${method === "input" ? "Input" : "Editor"}"`,
		);
		expect(Room.project(roundTrip)).not.toContain("<Option");
		roundTrip.doc.destroy();
		await f.answer(card!.id, method === "editor" ? "  edited\n" : "");
		expect(await response).toBe(method === "editor" ? "  edited\n" : "");
	}
});

test("member cancellation retains answered questions and marks the batch cancelled", async () => {
	let f = await fixture();
	let response = f.input.questionnaire(params, f.options);
	let cards = await f.cards(3);
	await f.answer(cards[0]!.id, [1]);
	for (let card of cards.slice(1)) {
		await Questions.cancel(f.plan, f.server, f.room.id, f.ws, {
			kind: "question:cancel",
			ts: 0,
			rid: "cancel",
			id: card.id,
		});
	}
	expect(await response).toEqual({
		cancelled: true,
		answers: [
			{ questionIndex: 0, question: "  Which?  ", kind: "option", answer: "B" },
		],
	});
});

test("abort withdraws only its request's open cards, persists cancellation, and ignores late submission", async () => {
	let f = await fixture();
	let response = f.input.questionnaire(params, f.options);
	let cards = await f.cards(3);
	await f.answer(cards[0]!.id, [1]);
	f.controller.abort();
	expect(await response).toEqual({ answers: [], cancelled: true });
	expect(Store.outstanding(f.plan.questions)).toHaveLength(0);
	expect(f.plan.records.get(cards[0]!.id)?.status).toBe("answered");
	for (let card of cards.slice(1)) {
		expect(f.plan.records.get(card.id)).toMatchObject({ status: "cancelled", resolver: "chopin" });
		expect(Plan.source(f.plan)).not.toContain(card.id);
		expect(f.frames).toContainEqual(
			expect.objectContaining({
				kind: "question:resolved",
				id: card.id,
				status: "cancelled",
				resolver: "chopin",
			}),
		);
		await Questions.submit(f.plan, f.server, f.room.id, f.ws, {
			kind: "question:submit",
			ts: 0,
			rid: "late",
			id: card.id,
			revision: 0,
		});
		expect(f.plan.records.get(card.id)?.status).toBe("cancelled");
	}
	let saved = await Plan.readStored((await f.storage.collaboration.load(f.room.id, new Date()))!);
	expect(saved.source).not.toContain(cards[1]!.id);
});

test("timeout withdraws unanswered dialogs and returns no answer for every HostInput method", async () => {
	let f = await fixture(30);
	for (
		let invoke of [
			() => f.input.questionnaire(params, f.options),
			() => f.input.confirm("Confirm", "Proceed?", f.options),
			() => f.input.select("Select", ["A", "B"], f.options),
			() => f.input.input("Input", undefined, f.options),
			() => f.input.editor("Editor", undefined, f.options),
		]
	) {
		let result = await invoke();
		expect(
			result === undefined || result === false
				|| (typeof result === "object" && result.cancelled && result.answers.length === 0),
		).toBe(true);
		expect(Store.outstanding(f.plan.questions)).toHaveLength(0);
	}
	expect([...f.plan.records.values()].every(record => record.status === "cancelled")).toBe(true);
});

test("workflow identity labels each card while returned question text remains verbatim", async () => {
	let f = await fixture();
	let response = f.input.questionnaire(params, {
		...f.options,
		workflowRunId: "run-123",
		workflowStageId: "review",
	});
	let cards = await f.cards(3);
	for (let card of cards) {
		expect(card.definition.questions[0].question).toContain("Workflow run: run-123; stage: review");
		await f.answer(card.id, [0]);
	}
	expect((await response).answers.map(answer => answer.question)).toEqual(
		params.questions.map(question => question.question),
	);
});

test("abort before presentation creates no card and cancellation waits for durable storage", async () => {
	let f = await fixture();
	let cancelled = new AbortController();
	cancelled.abort();
	expect(await f.input.confirm("Confirm", "Proceed?", { ...f.options, signal: cancelled.signal }))
		.toBe(false);
	expect(f.plan.records.size).toBe(0);
	let settled = false;
	let result = f.input.confirm("Confirm", "Proceed?", f.options).then(value => {
		settled = true;
		return value;
	});
	await f.cards(1);
	let gate = Promise.withResolvers<void>();
	let original = f.storage.collaboration.commit;
	f.storage.collaboration.commit = async input => {
		await gate.promise;
		return original(input);
	};
	f.controller.abort();
	await Bun.sleep(15);
	expect(settled).toBe(false);
	expect(f.frames.filter(frame => frame.kind === "question:resolved")).toHaveLength(0);
	gate.resolve();
	expect(await result).toBe(false);
	expect(f.frames.filter(frame => frame.kind === "question:resolved")).toHaveLength(1);
});

test("blank dialog titles and supplied empty choices remain valid verbatim inputs", async () => {
	let f = await fixture();
	let result = f.input.select("", ["", "  "], f.options);
	let [card] = await f.cards(1);
	await f.answer(card!.id, [0]);
	expect(await result).toBe("");
	let source = Plan.source(f.plan);
	let restored = await Room.create(source);
	expect(Room.project(restored)).toContain('label=""');
	expect(Room.project(restored)).toContain('value=""');
	restored.doc.destroy();
});
