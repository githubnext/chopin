import { describe, expect, it } from "bun:test";
import * as Question from "@chopin/question";
import * as Service from "./service";
import * as Store from "../questions/store";
import { definition, draft, legacyRecord, rejected, stored } from "./question-record.test-fixtures";

// Restoration contract extracted from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/plan/service.ts; these tests exercise current MemoryStorage open/close.
describe("durable question record restoration", () => {
	it("fills legacy defaults and persists them through open, close and reopen", async () => {
		let context = await stored([legacyRecord()], [draft()]);
		let plan = context.plan;
		try {
			expect(plan.records.get("saved-card")).toMatchObject({
				origin: "planner",
				history: [],
				optionOrigins: {},
				editors: [],
			});
			expect(Store.snapshot(plan.questions, "saved-card")).toMatchObject({
				open: true,
				definition: definition(),
			});
		} finally {
			await Service.close(plan);
		}
		let saved = await context.storage.collaboration.load(context.channel.id, context.now);
		expect(saved?.sidecar).toMatchObject({
			questions: [{ origin: "planner", history: [], optionOrigins: {}, editors: [] }],
		});
		let reopened = await context.open();
		try {
			expect(reopened.records.get("saved-card")?.definition).toEqual(definition());
		} finally {
			await Service.close(reopened);
		}
	});

	it("persists owner and decision time derived from a legacy answered record", async () => {
		let record = {
			...legacyRecord(),
			status: "answered",
			answers: { "saved-question": "Cloud" },
			resolver: "ana",
			at: 123,
		};
		let context = await stored([record], []);
		try {
			expect(context.plan.records.get("saved-card")).toMatchObject({
				...record,
				origin: "planner",
				history: [],
				optionOrigins: {},
				editors: [],
				owner: "ana",
				decidedAt: 123,
			});
		} finally {
			await Service.close(context.plan);
		}
		let saved = await context.storage.collaboration.load(context.channel.id, context.now);
		expect(saved?.sidecar).toMatchObject({ questions: [{ owner: "ana", decidedAt: 123 }] });
		let reopened = await context.open();
		try {
			expect(reopened.records.get("saved-card")).toMatchObject({ owner: "ana", decidedAt: 123 });
		} finally {
			await Service.close(reopened);
		}
	});

	it("restores open and reopened pending definitions with their original empty draft", async () => {
		for (let status of ["open", "reopened"] as const) {
			let value = definition();
			value.questions[0]!.options = [];
			let record = {
				...legacyRecord(value),
				status,
				origin: "conversation" as const,
				threadId: "saved-thread",
				history: [],
				optionOrigins: {},
				editors: [],
			};
			let context = await stored([record], [draft(value)]);
			let plan = context.plan;
			try {
				expect(plan.records.get("saved-card")).toMatchObject(record);
				let entry = Store.get(plan.questions, "saved-card")!;
				expect(Question.read(entry.model, entry.definition)["saved-question"]).toEqual({
					mode: "choices",
					choice: null,
					custom: "",
					options: {},
				});
			} finally {
				await Service.close(plan);
			}
			let reopened = await context.open();
			try {
				expect(reopened.records.get("saved-card")?.status).toBe(status);
			} finally {
				await Service.close(reopened);
			}
		}
	});

	it("restores a reopened card's suggestion without changing the shared draft", async () => {
		let suggested = { optionId: "saved-b", messageIds: ["message-1"], revision: 2 };
		let context = await stored([{ ...legacyRecord(), status: "reopened" }], [{
			...draft(),
			revision: 2,
			suggested,
		}]);
		let plan = context.plan;
		try {
			let entry = Store.get(plan.questions, "saved-card")!;
			expect(entry.suggested).toEqual(suggested);
			expect(Question.read(entry.model, entry.definition)["saved-question"]?.choice).toBeNull();
		} finally {
			await Service.close(plan);
		}
		let reopened = await context.open();
		try {
			expect(Store.get(reopened.questions, "saved-card")?.suggested).toEqual(suggested);
		} finally {
			await Service.close(reopened);
		}
	});

	it("rejects malformed durable records and noncanonical saved definitions", async () => {
		for (
			let change of [
				{ origin: "unknown" },
				{ editors: ["ana", "ana"] },
				{ choices: ["missing-option"] },
				{ history: [{ choices: [], owner: "ana", at: 1 }] },
				{ definition: { questions: [{ ...definition().questions[0]!, header: "" }] } },
			]
		) {
			expect(await rejected(stored([{ ...legacyRecord(), ...change }], [draft()]))).toBeInstanceOf(
				Error,
			);
		}
	});

	it("rejects an orphan draft rather than restoring it without its record", async () => {
		expect(await rejected(stored([], [draft()]))).toBeInstanceOf(Error);
	});

	it("requires identical saved question IDs, option IDs, order and display text", async () => {
		for (
			let field of [
				"question-id",
				"question",
				"header",
				"multiple",
				"option-id",
				"label",
				"description",
				"order",
			]
		) {
			let value = definition();
			let question = value.questions[0]!;
			if (field === "question-id") question.id = "different-question";
			if (field === "question") question.question = "A different question?";
			if (field === "header") question.header = "Different header";
			if (field === "multiple") question.multiple = true;
			if (field === "option-id") question.options[0]!.id = "different-option";
			if (field === "label") question.options[0]!.label = "Different label";
			if (field === "description") question.options[0]!.description = "Different description";
			if (field === "order") question.options.reverse();
			expect(await rejected(stored([legacyRecord()], [draft(value)]))).toBeInstanceOf(Error);
		}
	});
});
