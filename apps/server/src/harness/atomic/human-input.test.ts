import { afterEach, expect, test } from "bun:test";
import { $nodesOfType } from "lexical";
import { limits, QuestionnaireNode, unanswered } from "@chopin/dialect";
import { limits as questionLimits } from "@chopin/question";
import * as Questions from "../../questions/service";
import * as Store from "../../questions/store";
import * as Plan from "../../plan/service";
import * as Room from "../../plan/room";
import * as Edit from "../../plan/edit";
import { hostInputRoom } from "../../testing/decisions";
import type { QuestionParams } from "@bastani/atomic";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(expiresInMs?: number) {
	let f = await hostInputRoom(expiresInMs);
	cleanups.push(f.close);
	return f;
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

test("Atomic's own HostInput validator accepts every answer a member can give", async () => {
	let { HostInputBridge, getHostQuestionnaire } = await import(
		new URL("./core/extensions/host-input.js", import.meta.resolve("@bastani/atomic")).href
	);
	let f = await fixture();
	let bridge = new HostInputBridge(() => "session", () => undefined);
	bridge.bind(f.input, "chopin");
	let questionnaire = getHostQuestionnaire(bridge.wrap({}));
	let [preview, multiple, plain] = params.questions;
	for (
		let [question, value, expected] of [
			[preview!, [1], { kind: "option", answer: "B" }],
			[preview!, [0], { kind: "option", answer: " A ", preview: "preview A" }],
			[preview!, "  typed\n", { kind: "chat", answer: "  typed\n" }],
			[multiple!, [1, 0], { kind: "multi", answer: null, selected: ["C", "D"] }],
			[multiple!, "several\n", { kind: "chat", answer: "several\n" }],
			[plain!, [1], { kind: "option", answer: "F" }],
			[plain!, " own ", { kind: "custom", answer: " own " }],
		] as const
	) {
		let response = questionnaire({ questions: [question] }, new AbortController().signal);
		let [card] = await f.cards(1);
		await f.answer(card!.id, typeof value === "string" ? value : [...value]);
		expect(await response).toEqual({
			cancelled: false,
			answers: [{ questionIndex: 0, question: question.question, ...expected }],
		});
	}
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

test("expiry keeps every unanswered card in Decisions, marked expired, and answers no HostInput method", async () => {
	let f = await fixture(30);
	for (
		let [invoke, expected] of [
			[() => f.input.questionnaire(params, f.options), { answers: [], cancelled: true }],
			[() => f.input.confirm("Confirm", "Proceed?", f.options), false],
			[() => f.input.select("Select", ["A", "B"], f.options), undefined],
			[() => f.input.input("Input", undefined, f.options), undefined],
			[() => f.input.editor("Editor", undefined, f.options), undefined],
		] as Array<[() => Promise<unknown>, unknown]>
	) {
		expect(await invoke()).toEqual(expected);
		expect(Store.outstanding(f.plan.questions)).toHaveLength(0);
	}
	let records = [...f.plan.records.values()];
	expect(records).toHaveLength(7);
	for (let record of records) {
		expect(record).toMatchObject({ status: "expired", resolver: "chopin" });
		expect(record.at).toBeNumber();
		expect(f.frames).toContainEqual(
			expect.objectContaining({
				kind: "question:resolved",
				id: record.id,
				status: "expired",
				resolver: "chopin",
			}),
		);
	}
	let saved = await Plan.readStored((await f.storage.collaboration.load(f.room.id, new Date()))!);
	let cards = await documentCards(saved.source);
	expect(cards.map(card => card.id)).toEqual(records.map(record => record.id));
	for (let card of cards) {
		expect(card.status).toBe("expired");
		expect(card.at).toBeString();
		expect(card.by).toBeUndefined();
		expect(unanswered(card)).toEqual([]);
	}
	await Questions.submit(f.plan, f.server, f.room.id, f.ws, {
		kind: "question:submit",
		ts: 0,
		rid: "late",
		id: records[0]!.id,
		revision: 0,
	});
	expect(f.frames.findLast(frame => frame.rid === "late")).toMatchObject({
		ok: false,
		reason: "resolved",
		status: "expired",
		resolver: "chopin",
	});
	expect(f.plan.records.get(records[0]!.id)?.status).toBe("expired");
});

test("an abort still withdraws its cards rather than expiring them", async () => {
	let f = await fixture(60_000);
	let response = f.input.confirm("Confirm", "Proceed?", f.options);
	let [card] = await f.cards(1);
	f.controller.abort();
	expect(await response).toBe(false);
	expect(f.plan.records.get(card!.id)).toMatchObject({ status: "cancelled", resolver: "chopin" });
	expect(Plan.source(f.plan)).not.toContain(card!.id);
	expect(f.frames.filter(frame => frame.kind === "question:resolved")).toMatchObject([
		{ kind: "question:resolved", id: card!.id, status: "cancelled", resolver: "chopin" },
	]);
});

test("host input waits the shared 30-minute limit before expiring by default", async () => {
	let f = await fixture();
	let delays: number[] = [];
	let original = globalThis.setTimeout;
	globalThis.setTimeout = ((handler: () => void, delay?: number, ...rest: unknown[]) => {
		if (delay !== undefined) delays.push(delay);
		return original(handler, delay, ...rest);
	}) as typeof setTimeout;
	try {
		let response = f.input.confirm("Confirm", "Proceed?", f.options);
		await f.cards(1);
		expect(questionLimits.INPUT_EXPIRY_MS).toBe(30 * 60 * 1_000);
		expect(delays).toContain(questionLimits.INPUT_EXPIRY_MS);
		f.controller.abort();
		expect(await response).toBe(false);
	} finally {
		globalThis.setTimeout = original;
	}
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

/** Re-import the canonical document, proving the dialect accepts every card it holds. */
async function documentCards(source: string) {
	let document = await Room.create(source);
	try {
		return document.editor.getEditorState().read(() =>
			$nodesOfType(QuestionnaireNode).map(node => node.getQuestionnaire())
		);
	} finally {
		document.doc.destroy();
	}
}

async function documentQuestionnaires(source: string) {
	return (await documentCards(source)).map(card => card.questions[0]!);
}

test("dialogs beyond the Planner's per-field limits become verbatim cards and answers", async () => {
	let f = await fixture();
	let initial = "Keep this line of the plan.\n".repeat(180);
	let edited = `${initial}${"Add this reviewed line.\n".repeat(60)}`;
	let editor = f.input.editor("Edit plan", initial, f.options);
	let [card] = await f.cards(1);
	expect(initial.length).toBeGreaterThan(5_000);
	expect(card!.definition.questions[0].question).toBe(`Edit plan\n\n${initial}`);
	await f.answer(card!.id, edited);
	expect(edited.length).toBeGreaterThan(6_000);
	expect(await editor).toBe(edited);

	let message = "This workflow step rewrites generated files. ".repeat(30);
	let confirmed = f.input.confirm("Proceed?", message, f.options);
	[card] = await f.cards(1);
	await f.answer(card!.id, [0]);
	expect(await confirmed).toBe(true);

	let choices = Array.from({ length: 25 }, (_, index) => `Choice ${index}`);
	choices[24] = `The long choice ${"x".repeat(250)}`;
	let selected = f.input.select("Pick one", choices, f.options);
	[card] = await f.cards(1);
	expect(card!.definition.questions[0].options.map(option => option.label)).toEqual(choices);
	await f.answer(card!.id, [24]);
	expect(await selected).toBe(choices[24]);

	let rollout = "Explain the rollout, its owners, and its checks. ".repeat(40);
	let asked = f.input.questionnaire({
		questions: [{
			header: "Rollout",
			question: "Which rollout?",
			options: [{ label: "Staged", description: rollout }, { label: "All", description: "" }],
		}],
	}, f.options);
	[card] = await f.cards(1);
	await f.answer(card!.id, [0]);
	expect((await asked).answers[0]).toMatchObject({ kind: "option", answer: "Staged" });

	expect(await documentQuestionnaires(Plan.source(f.plan))).toMatchObject([
		{ header: "Editor", prompt: `Edit plan\n\n${initial}`, options: [], answer: edited },
		{ header: "Confirm", prompt: `Proceed?\n\n${message}`, answer: "Yes" },
		{
			header: "Select",
			prompt: "Pick one",
			options: choices.map(label => ({ label })),
			answer: choices[24],
		},
		{
			header: "Rollout",
			options: [{ label: "Staged", description: rollout }, { label: "All" }],
			answer: "Staged",
		},
	]);
});

test("a workflow label never pushes a verbatim question into a rejection", async () => {
	let f = await fixture();
	let question = "Should the review stage accept this change? ".repeat(23).slice(0, 990);
	let long: QuestionParams = {
		questions: [{
			header: "Review",
			question,
			options: [{ label: "Ship", description: "" }, { label: "Hold", description: "" }],
		}],
	};
	let response = f.input.questionnaire(long, {
		...f.options,
		workflowRunId: "run-123",
		workflowStageId: "review",
	});
	let [card] = await f.cards(1);
	let labelled = `${question}\n\nWorkflow run: run-123; stage: review`;
	expect(card!.definition.questions[0].question).toBe(labelled);
	expect(await documentQuestionnaires(Plan.source(f.plan))).toMatchObject([{ prompt: labelled }]);
	await f.answer(card!.id, [0]);
	expect(await response).toEqual({
		cancelled: false,
		answers: [{ questionIndex: 0, question, kind: "option", answer: "Ship" }],
	});
});

test("a dialog that cannot fit in the document fails loudly without leaving a card", async () => {
	let f = await fixture();
	let edited = Edit.apply(f.plan, f.plan.revision, [{
		op: "replace_root",
		source: `${"Existing prose in the document. ".repeat(3_000)}\n`,
	}]);
	if (!edited.ok || !edited.mutation) throw new Error("fixture edit failed");
	await Plan.publish(f.plan, f.server, f.room.id, edited.mutation);
	let before = Plan.source(f.plan);
	await expect(
		f.input.editor("Too large", "x".repeat(limits.MAX_SOURCE_BYTES - 90_000), f.options),
	).rejects.toThrow(`${limits.MAX_SOURCE_BYTES / 1024} KiB`);
	expect(Store.outstanding(f.plan.questions)).toHaveLength(0);
	expect(f.plan.records.size).toBe(0);
	expect(Plan.source(f.plan)).toBe(before);
});
