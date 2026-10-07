import { afterEach, expect, test } from "bun:test";
import { $createParagraphNode, $createTextNode, $getRoot, $nodesOfType } from "lexical";
import * as Y from "yjs";
import { cardStatus, limits, QuestionnaireNode, ulid } from "@chopin/dialect";
import { limits as questionLimits } from "@chopin/question";
import * as QuestionModel from "@chopin/question";
import * as Questions from "../../questions/service";
import * as Store from "../../questions/store";
import * as Plan from "../../plan/service";
import * as Room from "../../plan/room";
import * as Edit from "../../plan/edit";
import * as Comments from "../../comments/service";
import { hostInputRoom } from "../../testing/decisions";
import { peer } from "../../testing/peer";
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
		expect(cardStatus(card)).toBe("expired");
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

test(
	"accepting a comment cannot leave too little room for an open question to expire",
	async () => {
		let f = await fixture();
		let size = () => new TextEncoder().encode(Plan.source(f.plan)).length;
		let quote = "caches tiles for 60 seconds";
		let seeded = Edit.apply(f.plan, f.plan.revision, [{
			op: "replace_root",
			source: `# Plan\n\nThe renderer ${quote}.\n`,
		}]);
		if (!seeded.ok || !seeded.mutation) throw new Error("fixture edit failed");
		await Plan.publish(f.plan, f.server, f.room.id, seeded.mutation);

		let response = f.input.questionnaire({
			questions: [{
				header: "Choice",
				question: "Which?",
				options: [{ label: "A", description: "" }, { label: "B", description: "" }],
			}],
		}, f.options);
		await f.cards(1);

		let replies: any[] = [];
		let ana = {
			data: { handle: "ana", client: "client-ana", room: f.room.id },
			send: (raw: string) => replies.push(JSON.parse(raw)),
			publish() {},
		} as unknown as Parameters<typeof Comments.start>[3];
		await Comments.start(f.plan, f.server, f.room.id, ana, {
			kind: "comment:start",
			rid: "start",
			ts: 0,
			blocks: [1],
			quote,
			offset: 0,
			length: quote.length,
			text: "Too long.",
		});
		let id = replies.findLast(frame => frame.kind === "comment:start")?.thread?.id as string;
		expect(id).toBeString();

		let scratch = await Room.create(Plan.source(f.plan));
		let before = size();
		Room.insertDecision(scratch, {
			id,
			quote,
			by: "ana",
			at: new Date().toISOString(),
			notes: [{ by: "ana", text: "Too long." }],
		});
		let decision = new TextEncoder().encode(Room.project(scratch)).length - before;
		scratch.doc.destroy();

		let target = limits.MAX_SOURCE_BYTES - decision - 10;
		for (let fill = 1; fill > 0;) {
			fill = Math.min(40_000, target - size() - 2);
			if (fill < 1) break;
			let edited = Edit.replace(
				f.plan,
				f.plan.revision,
				`${Plan.source(f.plan)}\n${"x".repeat(fill)}\n`,
			);
			if (!edited.ok) throw new Error(`edit refused: ${edited.reason}`);
			if (edited.mutation) await Plan.publish(f.plan, f.server, f.room.id, edited.mutation);
		}

		let context = {
			chat: f.plan.chat,
			config: { agent: false },
			plan: f.plan,
			room: f.room.id,
			server: f.server,
			auth: {},
			claimantSessionId: "session",
			repository: { id: "repo", owner: "owner", name: "repo", defaultBranch: "main" },
			persist: () => Plan.persist(f.plan),
		} as unknown as Parameters<typeof Comments.accept>[0];
		let complain = console.error;
		console.error = () => {};
		try {
			await Comments.accept(context, ana, { kind: "comment:accept", rid: "accept", ts: 0, id });
		} finally {
			console.error = complain;
		}
		expect(replies.findLast(frame => frame.kind === "comment:accept")).toMatchObject({
			ok: false,
			reason: "invalid",
		});
		expect(f.plan.threads.get(id)?.status).toBe("open");

		for (let { id: open } of Store.outstanding(f.plan.questions)) {
			await Questions.expire(f.plan, f.server, f.room.id, open);
		}
		await response;

		expect(size()).toBeLessThanOrEqual(limits.MAX_SOURCE_BYTES);
		let retitled = Edit.replace(
			f.plan,
			f.plan.revision,
			Plan.source(f.plan).replace("# Plan", "# Pla2"),
		);
		expect(retitled.ok).toBe(true);
	},
	30_000,
);

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function seedDocument(f: Fixture) {
	let seeded = Edit.apply(f.plan, f.plan.revision, [{
		op: "replace_root",
		source: "# Plan\n\nStart.\n",
	}]);
	if (!seeded.ok || !seeded.mutation) throw new Error("fixture edit failed");
	await Plan.publish(f.plan, f.server, f.room.id, seeded.mutation);
}

/** Fill the document until `fits` just holds, leaving a margin smaller than one card's expiry. */
async function crowd(f: Fixture, fits: (scratch: Room.Document) => boolean) {
	let size = () => new TextEncoder().encode(Plan.source(f.plan)).length;
	let base = Plan.source(f.plan);
	let low = 0;
	for (let high = limits.MAX_SOURCE_BYTES; low < high;) {
		let mid = Math.ceil((low + high) / 2);
		let scratch = await Room.create(`${base}\n${"x".repeat(mid)}\n`).catch(() => undefined);
		let ok = scratch ? fits(scratch) : false;
		scratch?.doc.destroy();
		if (ok) low = mid;
		else high = mid - 1;
	}
	let target = size() + low - 10;
	for (let fill = 1; fill > 0;) {
		fill = Math.min(40_000, target - size() - 2);
		if (fill < 1) break;
		let edited = Edit.replace(
			f.plan,
			f.plan.revision,
			`${Plan.source(f.plan)}\n${"x".repeat(fill)}\n`,
		);
		if (!edited.ok) throw new Error(`edit refused: ${edited.reason}`);
		if (edited.mutation) await Plan.publish(f.plan, f.server, f.room.id, edited.mutation);
	}
}

const single = (header: string): QuestionParams => ({
	questions: [{
		header,
		question: "Which?",
		options: [{ label: "A", description: "" }, { label: "B", description: "" }],
	}],
});

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

test(
	"questions that fit when asked still fit when they expire, however the document changed since",
	async () => {
		let f = await fixture();
		let max = limits.MAX_SOURCE_BYTES;
		let low = 0;
		for (let high = max; low < high;) {
			let mid = Math.ceil((low + high) / 2);
			if (Room.fitsExpiry("a".repeat(mid), 1)) low = mid;
			else high = mid - 1;
		}
		let expiry = max - low;
		let quote = "caches tiles for 60 seconds";
		let seeded = Edit.apply(f.plan, f.plan.revision, [{
			op: "replace_root",
			source: `# Plan\n\nThe renderer ${quote}.\n`,
		}]);
		if (!seeded.ok || !seeded.mutation) throw new Error("fixture edit failed");
		await Plan.publish(f.plan, f.server, f.room.id, seeded.mutation);

		let responses = [
			f.input.questionnaire(single("First"), f.options),
			f.input.questionnaire(single("Second"), { ...f.options, requestId: "second" }),
		];
		let [first, second] = await f.cards(2);

		let replies: any[] = [];
		let ana = {
			data: { handle: "ana", client: "client-ana", room: f.room.id },
			send: (raw: string) => replies.push(JSON.parse(raw)),
			publish() {},
		} as unknown as Parameters<typeof Comments.start>[3];
		await Comments.start(f.plan, f.server, f.room.id, ana, {
			kind: "comment:start",
			rid: "start",
			ts: 0,
			blocks: [1],
			quote,
			offset: 0,
			length: quote.length,
			text: "Too long.",
		});
		let thread = replies.findLast(frame => frame.kind === "comment:start")?.thread?.id as string;
		expect(thread).toBeString();
		let context = {
			chat: f.plan.chat,
			config: { agent: false },
			plan: f.plan,
			room: f.room.id,
			server: f.server,
			auth: {},
			claimantSessionId: "session",
			repository: { id: "repo", owner: "owner", name: "repo", defaultBranch: "main" },
			persist: () => Plan.persist(f.plan),
		} as unknown as Parameters<typeof Comments.accept>[0];
		let accept = async () => {
			let complain = console.error;
			console.error = () => {};
			try {
				await Comments.accept(context, ana, {
					kind: "comment:accept",
					rid: `accept-${replies.length}`,
					ts: 0,
					id: thread,
				});
			} finally {
				console.error = complain;
			}
			return replies.findLast(frame => frame.kind === "comment:accept");
		};

		// Planner text edits: two questions are open, so growth stops at their reserve.
		await fillTo(f, max - 2 * expiry);
		let source = Plan.source(f.plan);
		expect(Edit.apply(f.plan, f.plan.revision, [{ op: "insert", index: 0, source: "y" }]))
			.toMatchObject({ ok: false, message: expect.stringContaining("expire") });
		expect(Edit.replace(f.plan, f.plan.revision, `${source}\ny\n`))
			.toMatchObject({ ok: false, message: expect.stringContaining("expire") });
		expect(Plan.source(f.plan)).toBe(source);

		// An option that would take the document into the reserve.
		let label = "Written ".repeat(25);
		let question = first!.definition.questions[0]!;
		let option = await growth(
			f,
			scratch =>
				Room.appendQuestionOption(scratch, first!.id, question.id, {
					id: ulid(),
					label,
					description: "",
				}),
		);
		await fillTo(f, max - 10 - option);
		await expect(f.addOption(first!.id, label)).rejects.toThrow("no room");
		await fillTo(f, max - option - 2 * expiry - 100);
		await f.addOption(first!.id, label);

		// An answer that would do the same, then one that fits.
		let text = "a".repeat(1_500);
		let answered = await growth(
			f,
			scratch =>
				Room.projectAnswer(scratch, first!.id, { [question.id]: text }, {
					by: "reader",
					at: new Date().toISOString(),
				}),
		);
		await fillTo(f, max - 10 - answered);
		await expect(f.answer(first!.id, text)).rejects.toThrow("no room");
		expect(Store.outstanding(f.plan.questions)).toHaveLength(2);
		await fillTo(f, max - answered - expiry - 100);
		await f.answer(first!.id, "");
		expect(Store.outstanding(f.plan.questions).map(open => open.id)).toEqual([second!.id]);

		// An accepted comment becomes a Decision in the document.
		let decision = await growth(f, scratch =>
			Room.insertDecision(scratch, {
				id: thread,
				quote,
				by: "ana",
				at: new Date().toISOString(),
				notes: [{ by: "ana", text: "Too long." }],
			}));
		await fillTo(f, max - 10 - decision);
		expect(await accept()).toMatchObject({ ok: false, reason: "invalid" });
		expect(f.plan.threads.get(thread)?.status).toBe("open");
		await fillTo(f, max - decision - expiry - 100);
		expect(await accept()).toMatchObject({ ok: true });
		expect(f.plan.threads.get(thread)?.status).not.toBe("open");

		// A question that would take the document into the reserve, then one that fits.
		let probe = {
			id: ulid(),
			questions: [{
				id: ulid(),
				header: "Third",
				prompt: "Which?",
				multiple: false,
				options: [{ id: ulid(), label: "A" }, { id: ulid(), label: "B" }],
			}],
		};
		let asked = await growth(f, scratch =>
			Room.insertQuestionnaire(scratch, {
				...probe,
				status: "expired",
				at: new Date().toISOString(),
			}));
		await fillTo(f, max - 10 - asked);
		let refused = f.input.questionnaire(single("Third"), { ...f.options, requestId: "third" });
		expect(
			await Promise.race([
				refused.then(() => "asked", (err: Error) => err.message),
				Bun.sleep(300).then(() => "asked"),
			]),
		).toContain("KiB limit");
		expect(Store.outstanding(f.plan.questions)).toHaveLength(1);
		await fillTo(f, max - asked - expiry - 100);
		responses.push(
			f.input.questionnaire(single("Third"), { ...f.options, requestId: "third-again" }),
		);
		await f.cards(2);

		// A person's text edit: growth into the reserve is refused, shrinking or fitting is not.
		await fillTo(f, max - 2 * expiry);
		let sent: any[] = [];
		let ben = {
			data: { handle: "ben", client: "client-ben", room: f.room.id },
			send: (raw: string) => sent.push(JSON.parse(raw)),
			close() {},
			publish() {},
		} as unknown as Parameters<typeof Plan.submit>[1];
		let type = async (client: ReturnType<typeof peer>, change: () => void) => {
			let before = Y.encodeStateVector(client.doc);
			client.editor.update(change, { discrete: true });
			let rid = `ben-${sent.length}`;
			Plan.submit(
				f.plan,
				ben,
				{
					kind: "plan:update",
					rid,
					ts: 0,
					epoch: f.plan.document.epoch,
					id: rid,
					update: Buffer.from(Y.encodeStateAsUpdate(client.doc, before)).toString("base64"),
				} as Parameters<typeof Plan.submit>[2],
			);
			await Bun.sleep(30);
			await Plan.drain(f.plan);
			return sent.findLast(frame => frame.kind === "plan:ack" && frame.id === rid);
		};
		let grow = () => {
			let paragraph = $createParagraphNode();
			paragraph.append($createTextNode("More text."));
			$getRoot().append(paragraph);
		};
		let epoch = f.plan.document.epoch;
		let before = Plan.source(f.plan);
		let ben1 = peer();
		Y.applyUpdate(ben1.doc, Room.sync(f.plan.document), "remote");
		await Room.settle();
		expect(await type(ben1, grow)).toBeUndefined();
		expect(Plan.source(f.plan)).toBe(before);
		expect(f.plan.document.epoch).not.toBe(epoch);

		let ben2 = peer();
		Y.applyUpdate(ben2.doc, Room.sync(f.plan.document), "remote");
		await Room.settle();
		let shrunk = await type(ben2, () => {
			$getRoot().getChildren().find(node => node.getTextContent().startsWith("qq"))?.remove();
		});
		expect(shrunk).toBeDefined();
		expect(bytes(Plan.source(f.plan))).toBeLessThan(bytes(before));
		let fitted = await type(ben2, grow);
		expect(fitted).toBeDefined();
		expect(Plan.source(f.plan)).toContain("More text.");

		// Both questions expire from a document with exactly their reserve left.
		await fillTo(f, max - 2 * expiry);
		for (let { id } of Store.outstanding(f.plan.questions)) {
			await Questions.expire(f.plan, f.server, f.room.id, id);
		}
		await Promise.allSettled(responses);

		expect(Store.outstanding(f.plan.questions)).toHaveLength(0);
		expect(bytes(Plan.source(f.plan))).toBeLessThanOrEqual(max);
		let retitled = Edit.replace(
			f.plan,
			f.plan.revision,
			Plan.source(f.plan).replace("# Plan", "# Pla2"),
		);
		expect(retitled.ok).toBe(true);
	},
	30_000,
);

test(
	"a new question is refused when the questions already open would no longer have room to expire",
	async () => {
		let f = await fixture();
		await seedDocument(f);
		let first = f.input.questionnaire(single("First"), f.options);
		await f.cards(1);
		let probe = {
			id: ulid(),
			questions: [{
				id: ulid(),
				header: "Second",
				prompt: "Which?",
				multiple: false,
				options: [{ id: ulid(), label: "A" }, { id: ulid(), label: "B" }],
			}],
		};
		await crowd(f, scratch => Room.fitsQuestionnaires(scratch, [probe], 0));

		let second = f.input.questionnaire(single("Second"), { ...f.options, requestId: "second" });
		let outcome = await Promise.race([
			second.then(() => "asked", (err: Error) => err.message),
			Bun.sleep(500).then(() => "asked"),
		]);
		expect(outcome).toContain("KiB limit");
		expect(Store.outstanding(f.plan.questions)).toHaveLength(1);
		f.controller.abort();
		await first;
	},
	30_000,
);

test(
	"an option is refused when the questions open would no longer have room to expire",
	async () => {
		let f = await fixture();
		await seedDocument(f);
		let response = f.input.questionnaire({
			questions: [{
				header: "Choice",
				question: "Which?",
				options: [{ label: "A", description: "" }, { label: "B", description: "" }],
			}],
		}, f.options);
		let [card] = await f.cards(1);
		let question = card!.definition.questions[0]!;
		await crowd(f, scratch => {
			Room.appendQuestionOption(scratch, card!.id, question.id, {
				id: ulid(),
				label: "Another",
				description: "",
			});
			return Room.fitsExpiry(Room.project(scratch), 0);
		});

		await expect(f.addOption(card!.id, "Another")).rejects.toThrow("no room");
		expect(Store.get(f.plan.questions, card!.id)!.definition.questions[0]!.options).toHaveLength(2);
		f.controller.abort();
		await response;
	},
	30_000,
);

test(
	"an answer is refused when the questions still open would no longer have room to expire",
	async () => {
		let f = await fixture();
		await seedDocument(f);
		let first = f.input.questionnaire(single("First"), f.options);
		let second = f.input.questionnaire(single("Second"), { ...f.options, requestId: "second" });
		let [card] = await f.cards(2);
		let answer = "x".repeat(300);
		let question = card!.definition.questions[0]!;
		await crowd(f, scratch => {
			Room.projectAnswer(scratch, card!.id, { [question.id]: answer }, {
				by: "reader",
				at: new Date().toISOString(),
			});
			return Room.fitsExpiry(Room.project(scratch), 0);
		});

		let before = Plan.source(f.plan);
		await expect(f.answer(card!.id, answer)).rejects.toThrow("no room");
		expect(Plan.source(f.plan)).toBe(before);
		expect(Store.outstanding(f.plan.questions)).toHaveLength(2);
		f.controller.abort();
		await Promise.allSettled([first, second]);
	},
	30_000,
);

test(
	"a Planner edit is refused when the open question would no longer have room to expire",
	async () => {
		let f = await fixture();
		await seedDocument(f);
		let response = f.input.questionnaire(single("First"), f.options);
		await f.cards(1);
		await crowd(f, scratch => Room.fitsExpiry(Room.project(scratch), 1));

		let before = Plan.source(f.plan);
		let grown = Edit.apply(f.plan, f.plan.revision, [{
			op: "insert",
			index: 0,
			source: "y".repeat(30),
		}]);
		expect(grown).toMatchObject({
			ok: false,
			reason: "invalid",
			message: expect.stringContaining("expire"),
		});
		expect(Plan.source(f.plan)).toBe(before);

		let retitled = Edit.apply(f.plan, f.plan.revision, [{
			op: "replace",
			index: 0,
			source: "# Pla2",
		}]);
		expect(retitled.ok).toBe(true);
		f.controller.abort();
		await response;
	},
	30_000,
);

test(
	"a replaced plan is refused when the open question would no longer have room to expire",
	async () => {
		let f = await fixture();
		await seedDocument(f);
		let response = f.input.questionnaire(single("First"), f.options);
		await f.cards(1);
		await crowd(f, scratch => Room.fitsExpiry(Room.project(scratch), 1));

		let before = Plan.source(f.plan);
		let grown = Edit.replace(f.plan, f.plan.revision, `${before}\n${"y".repeat(30)}\n`);
		expect(grown).toMatchObject({
			ok: false,
			reason: "invalid",
			message: expect.stringContaining("expire"),
		});
		expect(Plan.source(f.plan)).toBe(before);

		let retitled = Edit.replace(f.plan, f.plan.revision, before.replace("# Plan", "# Pla2"));
		expect(retitled.ok).toBe(true);
		f.controller.abort();
		await response;
	},
	30_000,
);

/** A document already inside the reserve of its open questions, as one that has two open but room for one. */
async function overcommitted(f: Fixture) {
	await seedDocument(f);
	let response = f.input.questionnaire(single("First"), f.options);
	let [card] = await f.cards(1);
	await crowd(f, scratch => Room.fitsExpiry(Room.project(scratch), 1));
	void Store.ask(f.plan.questions, ulid(), Store.get(f.plan.questions, card!.id)!.definition);
	expect(Room.fitsExpiry(Plan.source(f.plan), f.plan.questions.open.size)).toBe(false);
	return { response };
}

test(
	"a Planner block edit that shrinks the document is accepted even inside the expiry reserve",
	async () => {
		let f = await fixture();
		let { response } = await overcommitted(f);
		let before = new TextEncoder().encode(Plan.source(f.plan)).length;

		let grown = Edit.apply(f.plan, f.plan.revision, [{
			op: "insert",
			index: 0,
			source: "y".repeat(30),
		}]);
		expect(grown).toMatchObject({
			ok: false,
			reason: "invalid",
			message: expect.stringContaining("expire"),
		});

		let shrunk = Edit.apply(f.plan, f.plan.revision, [{ op: "delete", index: 1 }]);
		expect(shrunk.ok).toBe(true);
		let trimmed = Edit.apply(f.plan, f.plan.revision, [{
			op: "replace",
			index: 0,
			source: "# P",
		}]);
		expect(trimmed.ok).toBe(true);
		if (trimmed.ok && trimmed.mutation) {
			await Plan.publish(f.plan, f.server, f.room.id, trimmed.mutation);
		}
		expect(new TextEncoder().encode(Plan.source(f.plan)).length).toBeLessThan(before);
		f.controller.abort();
		await response;
	},
	30_000,
);

test(
	"a replaced plan that shrinks the document is accepted even inside the expiry reserve",
	async () => {
		let f = await fixture();
		let { response } = await overcommitted(f);
		let before = Plan.source(f.plan);

		let grown = Edit.replace(f.plan, f.plan.revision, `${before}\n${"y".repeat(30)}\n`);
		expect(grown).toMatchObject({
			ok: false,
			reason: "invalid",
			message: expect.stringContaining("expire"),
		});

		let shrunk = Edit.replace(f.plan, f.plan.revision, before.replace("Start.", "S"));
		expect(shrunk.ok).toBe(true);
		f.controller.abort();
		await response;
	},
	30_000,
);

test("a workflow question's answer is returned only after its paused run is released", async () => {
	let release!: () => void;
	let gate = new Promise<void>(resolve => {
		release = resolve;
	});
	let held: string[] = [];
	let f = await hostInputRoom(undefined, async runId => {
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
