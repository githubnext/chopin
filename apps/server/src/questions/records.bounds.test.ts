import { expect, test } from "bun:test";
import { normalizeRecord } from "./records";

test("conversation thread IDs accept 200 UTF-16 units and reject 201", () => {
	let record = {
		id: "card-1",
		status: "open",
		origin: "conversation",
		threadId: "🧪".repeat(100),
		definition: {
			questions: [{
				id: "question-1",
				header: "Auth",
				question: "Which system?",
				multiple: false,
				options: [],
			}],
		},
	};
	expect(record.threadId).toHaveLength(200);
	expect(normalizeRecord(record).threadId).toBe(record.threadId);
	expect(() => normalizeRecord({ ...record, threadId: record.threadId + "x" }))
		.toThrow("hosted channel has an invalid question record");
});

test("durable option append keys survive record normalization and reject foreign option IDs", () => {
	let record = {
		id: "card-1",
		status: "open",
		definition: {
			questions: [{ id: "question-1", multiple: false, options: [{ id: "option-1" }] }],
		},
		appended: { "key-once-0001": "option-1" },
	};
	expect(normalizeRecord(record).appended).toEqual(record.appended);
	for (
		let appended of [
			{ bad: "option-1" },
			{ "key-once-0001": "foreign-option" },
			{ "key-once-0001": "option-1", "key-once-0002": "option-1" },
			[],
			null,
		]
	) {
		expect(() => normalizeRecord({ ...record, appended }))
			.toThrow("hosted channel has an invalid question record");
	}
});
