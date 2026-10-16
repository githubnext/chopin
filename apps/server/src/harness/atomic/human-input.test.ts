import { afterEach, expect, test } from "bun:test";
import { $nodesOfType } from "lexical";
import { limits, QuestionnaireNode, ulid } from "@chopin/dialect";
import * as QuestionModel from "@chopin/question";
import * as Questions from "../../questions/service";
import * as Store from "../../questions/store";
import * as Plan from "../../plan/service";
import * as Room from "../../plan/room";
import * as Edit from "../../plan/edit";
import { hostInputRoom, laterTimers } from "../../testing/decisions";
import type { QuestionParams } from "@bastani/atomic";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
	let f = await hostInputRoom();
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
		description: "  first  \n\npreview A",
	});
	expect(cards[0]!.definition.questions[0].options[1]).toMatchObject({
		label: "B",
		description: "second",
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

test("input and editor are cards with no options, answered by an option a member adds", async () => {
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
		let projected = Room.project(roundTrip);
		let own = projected.slice(projected.indexOf(`<Questionnaire id="${card!.id}"`));
		expect(own.slice(0, own.indexOf("</Questionnaire>"))).not.toContain("<Option");
		roundTrip.doc.destroy();
		let written = method === "editor" ? "Ship the refund rules first" : "Q4";
		await f.answer(card!.id, [await f.addOption(card!.id, written)]);
		expect(await response).toBe(written);
	}
});

test("an option a member adds comes back as a written answer, never as one Atomic offered", async () => {
	let f = await fixture();
	let response = f.input.questionnaire(params, f.options);
	let cards = await f.cards(3);
	await f.answer(cards[0]!.id, [await f.addOption(cards[0]!.id, "Neither")]);
	await f.answer(cards[1]!.id, [0, await f.addOption(cards[1]!.id, "G")]);
	await f.answer(cards[2]!.id, [await f.addOption(cards[2]!.id, "Something else")]);
	expect((await response).answers).toEqual([
		{ questionIndex: 0, question: "  Which?  ", kind: "chat", answer: "Neither" },
		{ questionIndex: 1, question: "Select several", kind: "chat", answer: "C, G" },
		{ questionIndex: 2, question: "Or free text?", kind: "custom", answer: "Something else" },
	]);
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

test("a withdrawal removes every card and answers no HostInput method", async () => {
	let f = await fixture();
	for (
		let [invoke, expected, count] of [
			[options => f.input.questionnaire(params, options), { answers: [], cancelled: true }, 3],
			[options => f.input.confirm("Confirm", "Proceed?", options), false, 1],
			[options => f.input.select("Select", ["A", "B"], options), undefined, 1],
			[options => f.input.input("Input", undefined, options), undefined, 1],
			[options => f.input.editor("Editor", undefined, options), undefined, 1],
		] as Array<[(options: typeof f.options) => Promise<unknown>, unknown, number]>
	) {
		let controller = new AbortController();
		let response = invoke({ ...f.options, signal: controller.signal });
		await f.cards(count);
		controller.abort();
		expect(await response).toEqual(expected);
		expect(Store.outstanding(f.plan.questions)).toHaveLength(0);
	}
	let records = [...f.plan.records.values()];
	expect(records).toHaveLength(7);
	for (let record of records) {
		expect(record).toMatchObject({ status: "cancelled", resolver: "chopin" });
		expect(f.frames).toContainEqual(
			expect.objectContaining({
				kind: "question:resolved",
				id: record.id,
				status: "cancelled",
				resolver: "chopin",
			}),
		);
	}
	let saved = await Plan.readStored((await f.storage.collaboration.load(f.room.id, new Date()))!);
	expect(await documentCards(saved.source)).toEqual([]);
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
		status: "cancelled",
		resolver: "chopin",
	});
	expect(f.plan.records.get(records[0]!.id)?.status).toBe("cancelled");
});

test("host input stays open past half an hour and returns the member's answer", async () => {
	let f = await fixture();
	let clock = laterTimers();
	try {
		let settled = false;
		let response = f.input.confirm("Confirm", "Proceed?", f.options).finally(() => {
			settled = true;
		});
		let [card] = await f.cards(1);
		await clock.pass(31 * 60 * 1_000);
		await clock.pass(24 * 60 * 60 * 1_000);
		expect(settled).toBe(false);
		expect(Store.outstanding(f.plan.questions).map(open => open.id)).toEqual([card!.id]);
		expect(f.plan.records.get(card!.id)?.status).toBe("open");
		expect(Plan.source(f.plan)).toContain(card!.id);
		await f.answer(card!.id, [0]);
		expect(await response).toBe(true);
	} finally {
		clock.restore();
	}
});

test("host input open past half an hour is withdrawn when its Planner stops", async () => {
	let f = await fixture();
	let clock = laterTimers();
	try {
		let response = f.input.questionnaire(params, f.options);
		let cards = await f.cards(3);
		await clock.pass(31 * 60 * 1_000);
		expect(Store.outstanding(f.plan.questions)).toHaveLength(3);
		f.controller.abort();
		expect(await response).toEqual({ answers: [], cancelled: true });
		expect(Store.outstanding(f.plan.questions)).toHaveLength(0);
		for (let card of cards) {
			expect(f.plan.records.get(card.id)).toMatchObject({
				status: "cancelled",
				resolver: "chopin",
			});
			expect(Plan.source(f.plan)).not.toContain(card.id);
		}
	} finally {
		clock.restore();
	}
});

test("a workflow card shows its question as asked, without run or stage ids", async () => {
	let f = await fixture();
	let response = f.input.questionnaire(params, {
		...f.options,
		workflowRunId: "run-123",
		workflowStageId: "review",
	});
	let cards = await f.cards(3);
	for (let card of cards) {
		expect(params.questions.map(question => question.question)).toContain(
			card.definition.questions[0].question,
		);
		expect(card.definition.questions[0].question).not.toContain("run-123");
		await f.answer(card.id, [0]);
	}
	expect((await response).answers.map(answer => answer.question)).toEqual(
		params.questions.map(question => question.question),
	);
});

/** A document of a title and two sections, whose first section is block 1. */
async function sections() {
	let f = await fixture();
	let edited = Edit.apply(f.plan, f.plan.revision, [{
		op: "replace_root",
		source: "# Existing document\n\nStorage section.\n\nDeployment section.\n",
	}]);
	if (!edited.ok) throw new Error("fixture edit failed");
	if (edited.mutation) await Plan.publish(f.plan, f.server, f.room.id, edited.mutation);
	expect(Room.digests(f.plan.document)).toHaveLength(3);
	return f;
}

test("a question that names its block is placed beside that block and linked to it", async () => {
	let f = await sections();
	let response = f.input.questionnaire({ questions: [params.questions[1]!] }, {
		...f.options,
		block: { index: 1, digest: Room.digests(f.plan.document)[1]! },
	});
	let [card] = await f.cards(1);
	let source = Plan.source(f.plan);
	expect(source.indexOf("Storage section.")).toBeLessThan(source.indexOf("<Questionnaire"));
	expect(source.indexOf("<Questionnaire")).toBeLessThan(source.indexOf("Deployment section."));
	let record = f.plan.records.get(card!.id)!;
	let question = record.definition.questions[0]!.id;
	expect(record.anchors?.questions[question]?.anchors).toHaveLength(1);
	await f.answer(card!.id, [0]);
	expect((await response).cancelled).toBe(false);
});

test("a question whose named block changed stays unlinked at the end of the document", async () => {
	let f = await sections();
	let response = f.input.questionnaire({ questions: [params.questions[1]!] }, {
		...f.options,
		block: { index: 1, digest: `sha256:${"0".repeat(64)}` },
	});
	let [card] = await f.cards(1);
	let source = Plan.source(f.plan);
	expect(source.indexOf("Deployment section.")).toBeLessThan(source.indexOf("<Questionnaire"));
	expect(f.plan.records.get(card!.id)!.anchors).toBeUndefined();
	await f.answer(card!.id, [0]);
	await response;
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

test("a workflow question at the length limit is stored verbatim", async () => {
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
	expect(card!.definition.questions[0].question).toBe(question);
	expect(await documentQuestionnaires(Plan.source(f.plan))).toMatchObject([{ prompt: question }]);
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

test("an answer that would make the document too large leaves it unchanged and the question open", async () => {
	let f = await fixture();
	let edited = Edit.apply(f.plan, f.plan.revision, [{
		op: "replace_root",
		source: "# Plan\n\n" + ("Prose paragraph. ".repeat(60) + "\n\n").repeat(100),
	}]);
	if (!edited.ok) throw new Error("fixture edit failed");
	if (edited.mutation) await Plan.publish(f.plan, f.server, f.room.id, edited.mutation);
	let response = f.input.questionnaire({
		questions: [{ header: "Input", question: "Write the brief", options: [] }],
	}, f.options);
	let [card] = await f.cards(1);
	let question = card!.definition.questions[0]!;
	// Each edit stays under the per-edit limit; together they outgrow the document.
	for (let chunk = 0; chunk < 4; chunk++) {
		let opened = Store.snapshot(f.plan.questions, card!.id);
		if (!opened.open) throw new Error("question closed");
		let model = QuestionModel.restore(
			opened.model,
			Store.get(f.plan.questions, card!.id)!.definition,
		);
		if (chunk === 0) model.api.val([question.id, "mode"]).set("custom");
		let text = model.api.str([question.id, "custom"]);
		text.ins(text.length(), "x".repeat(50_000));
		await Questions.edit(f.plan, f.ws, {
			kind: "question:edit",
			rid: `edit-${chunk}`,
			ts: 0,
			id: card!.id,
			patch: [...model.api.flush()!.toBinary()],
		});
	}
	let before = Plan.source(f.plan);
	let current = Store.snapshot(f.plan.questions, card!.id);
	if (!current.open) throw new Error("question closed");
	await Questions.submit(f.plan, f.server, f.room.id, f.ws, {
		kind: "question:submit",
		rid: "submit",
		ts: 0,
		id: card!.id,
		revision: current.revision,
	});
	expect(Plan.source(f.plan)).toBe(before);
	expect(new TextEncoder().encode(Plan.source(f.plan)).length).toBeLessThanOrEqual(
		limits.MAX_SOURCE_BYTES,
	);
	expect(Store.outstanding(f.plan.questions).map(open => open.id)).toEqual([card!.id]);
	f.controller.abort();
	expect((await response).cancelled).toBe(true);
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function seedDocument(f: Fixture) {
	let seeded = Edit.apply(f.plan, f.plan.revision, [{
		op: "replace_root",
		source: "# Plan\n\nStart.\n",
	}]);
	if (!seeded.ok || !seeded.mutation) throw new Error("fixture edit failed");
	await Plan.publish(f.plan, f.server, f.room.id, seeded.mutation);
}

const single = (header: string): QuestionParams => ({
	questions: [{
		header,
		question: "Which?",
		options: [{ label: "A", description: "" }, { label: "B", description: "" }],
	}],
});

const MAX = limits.MAX_SOURCE_BYTES;
const bytes = (value: string) => new TextEncoder().encode(value).length;
const FILLER = /\n\nq{10,}(?=\n)/g;

/** Resize the Planner's filler paragraphs until the document is exactly `target` bytes. */
async function fillTo(f: Fixture, target: number) {
	let size = () => bytes(Plan.source(f.plan));
	let aim = target;
	for (let pass = 0; pass < 3 && size() !== target; pass++) {
		let base = Plan.source(f.plan).replace(FILLER, "");
		let paragraphs: string[] = [];
		let room = aim - bytes(base);
		for (; room > 40_002; room -= 40_002) paragraphs.push("q".repeat(40_000));
		if (room > 0) {
			if (room < 12) throw new Error("filler would be too small");
			paragraphs.push("q".repeat(room - 2));
		}
		let edited = Edit.replace(
			f.plan,
			f.plan.revision,
			base + paragraphs.map(text => `\n${text}\n`).join(""),
		);
		if (!edited.ok) {
			throw new Error(`fill refused: ${"message" in edited ? edited.message : edited.reason}`);
		}
		if (edited.mutation) await Plan.publish(f.plan, f.server, f.room.id, edited.mutation);
		aim += target - size();
	}
	expect(size()).toBe(target);
}

/** What one step adds to the document, measured on a copy without the filler. */
async function growth(f: Fixture, step: (scratch: Room.Document) => void) {
	let scratch = await Room.create(Plan.source(f.plan).replace(FILLER, ""));
	let before = bytes(Room.project(scratch));
	step(scratch);
	let after = bytes(Room.project(scratch));
	scratch.doc.destroy();
	return after - before;
}

/** A size refusal names the document's limit and never an expiry. */
function sizeRefusal(message: string) {
	expect(message).toContain(`${MAX / 1024} KiB limit`);
	expect(message).not.toMatch(/expir/i);
}

test(
	"with a question open, Planner edits may fill the document to its exact size limit and no further",
	async () => {
		let f = await fixture();
		await seedDocument(f);
		let response = f.input.questionnaire(single("First"), f.options);
		await f.cards(1);
		await fillTo(f, MAX - 1);
		let filled = Edit.replace(
			f.plan,
			f.plan.revision,
			Plan.source(f.plan).replace("# Plan", "# Plans"),
		);
		expect(filled.ok).toBe(true);
		if (filled.ok && filled.mutation) {
			await Plan.publish(f.plan, f.server, f.room.id, filled.mutation);
		}
		expect(bytes(Plan.source(f.plan))).toBe(MAX);
		let source = Plan.source(f.plan);
		for (
			let refused of [
				Edit.apply(f.plan, f.plan.revision, [{ op: "insert", index: 0, source: "y" }]),
				Edit.replace(f.plan, f.plan.revision, source.replace("# Plans", "# Planss")),
			]
		) {
			expect(refused).toMatchObject({ ok: false, reason: "invalid" });
			sizeRefusal("message" in refused ? refused.message ?? "" : "");
		}
		expect(Plan.source(f.plan)).toBe(source);
		f.controller.abort();
		await response;
	},
	30_000,
);

test(
	"a new question fits a document up to its exact size limit while another is open",
	async () => {
		let f = await fixture();
		await seedDocument(f);
		let responses = [f.input.questionnaire(single("First"), f.options)];
		await f.cards(1);
		let asked = await growth(f, scratch =>
			Room.insertQuestionnaire(scratch, {
				id: ulid(),
				questions: [{
					id: ulid(),
					header: "Second",
					prompt: "Which?",
					multiple: false,
					options: [{ id: ulid(), label: "A" }, { id: ulid(), label: "B" }],
				}],
			}));

		await fillTo(f, MAX - asked + 1);
		let refused = f.input.questionnaire(single("Second"), { ...f.options, requestId: "past" });
		sizeRefusal(
			await Promise.race([
				refused.then(() => "asked", (err: Error) => err.message),
				Bun.sleep(500).then(() => "asked"),
			]),
		);
		expect(Store.outstanding(f.plan.questions)).toHaveLength(1);

		await fillTo(f, MAX - asked);
		responses.push(f.input.questionnaire(single("Second"), { ...f.options, requestId: "fits" }));
		await f.cards(2);
		expect(bytes(Plan.source(f.plan))).toBe(MAX);
		f.controller.abort();
		await Promise.allSettled(responses);
	},
	30_000,
);

test(
	"an option fits a document up to its exact size limit while questions are open",
	async () => {
		let f = await fixture();
		await seedDocument(f);
		let responses = [
			f.input.questionnaire(single("First"), f.options),
			f.input.questionnaire(single("Second"), { ...f.options, requestId: "second" }),
		];
		let [card] = await f.cards(2);
		let question = card!.definition.questions[0]!;
		let label = "Written answer";
		let option = await growth(
			f,
			scratch =>
				Room.appendQuestionOption(scratch, card!.id, question.id, {
					id: ulid(),
					label,
					description: "",
				}),
		);
		let options = () => Store.get(f.plan.questions, card!.id)!.definition.questions[0]!.options;

		await fillTo(f, MAX - option + 1);
		await expect(f.addOption(card!.id, label)).rejects.toThrow("no room");
		expect(options()).toHaveLength(2);

		await fillTo(f, MAX - option);
		await f.addOption(card!.id, label);
		expect(options()).toHaveLength(3);
		expect(bytes(Plan.source(f.plan))).toBe(MAX);
		f.controller.abort();
		await Promise.allSettled(responses);
	},
	30_000,
);

test(
	"an answer fits a document up to its exact size limit while another question is open",
	async () => {
		let f = await fixture();
		await seedDocument(f);
		let responses = [
			f.input.questionnaire(single("First"), f.options),
			f.input.questionnaire(single("Second"), { ...f.options, requestId: "second" }),
		];
		let [card, other] = await f.cards(2);
		let question = card!.definition.questions[0]!;
		let text = "a".repeat(1_500);
		let answered = await growth(
			f,
			scratch =>
				Room.projectAnswer(scratch, card!.id, { [question.id]: text }, {
					by: "reader",
					at: new Date().toISOString(),
				}),
		);

		await fillTo(f, MAX - answered + 1);
		let before = Plan.source(f.plan);
		sizeRefusal(await f.answer(card!.id, text).then(() => "", (err: Error) => err.message));
		expect(Plan.source(f.plan)).toBe(before);
		expect(Store.outstanding(f.plan.questions)).toHaveLength(2);

		// The refused text is still the shared draft, so submitting again sends it as it is.
		await fillTo(f, MAX - answered);
		await f.answer(card!.id, "");
		expect(Store.outstanding(f.plan.questions).map(open => open.id)).toEqual([other!.id]);
		expect(bytes(Plan.source(f.plan))).toBe(MAX);
		f.controller.abort();
		await Promise.allSettled(responses);
	},
	30_000,
);

test("a workflow question's answer is returned only after its paused run is released", async () => {
	let release!: () => void;
	let gate = new Promise<void>(resolve => {
		release = resolve;
	});
	let held: string[] = [];
	let f = await hostInputRoom(async runId => {
		held.push(runId);
		await gate;
	});
	cleanups.push(f.close);
	let settled = false;
	let response = f.input.questionnaire(
		{ questions: [params.questions[0]!] },
		{ ...f.options, workflowRunId: "run-1", workflowStageId: "stage-1" },
	).then(result => {
		settled = true;
		return result;
	});
	let [card] = await f.cards(1);
	await f.answer(card!.id, [0]);
	await Bun.sleep(20);
	expect(held).toEqual(["run-1"]);
	expect(settled).toBe(false);
	release();
	expect((await response).answers).toMatchObject([{ kind: "option", answer: " A " }]);
});
