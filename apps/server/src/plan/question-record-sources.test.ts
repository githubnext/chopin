import { describe, expect, it } from "bun:test";
import * as Service from "./service";
import { draft, legacyRecord, rejected, stored } from "./question-record.test-fixtures";

// Saved option-source checks from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/plan/service.ts; no classifier or external service is involved.
function sourced() {
	let message = {
		id: "message-1",
		text: "Try 🧪 Cloud next",
		ts: 1,
		author: { kind: "member" as const, handle: "ana" },
	};
	let source = {
		messageId: message.id,
		author: message.author,
		quote: "🧪 Cloud",
		start: 4,
		end: 12,
		role: "option" as const,
	};
	let record = {
		...legacyRecord(),
		optionOrigins: { "saved-a": { origin: "chat" as const, source } },
	};
	return { message, source, record };
}

describe("durable option source restoration", () => {
	it("checks a member's exact UTF-16 quote and preserves its source through close", async () => {
		let { message, record } = sourced();
		let context = await stored([record], [draft()], [message]);
		let plan = context.plan;
		try {
			expect(plan.records.get("saved-card")?.optionOrigins).toEqual(record.optionOrigins);
		} finally {
			await Service.close(plan);
		}
		let reopened = await context.open();
		try {
			expect(reopened.records.get("saved-card")?.optionOrigins).toEqual(record.optionOrigins);
		} finally {
			await Service.close(reopened);
		}
	});

	it("accepts an agent source only when the saved author is also the agent", async () => {
		let { message, source, record } = sourced();
		let author = { kind: "agent" as const };
		let context = await stored(
			[{
				...record,
				optionOrigins: { "saved-a": { origin: "planner", source: { ...source, author } } },
			}],
			[draft()],
			[{ ...message, author }],
		);
		let plan = context.plan;
		try {
			expect(plan.records.get("saved-card")?.optionOrigins["saved-a"]?.source?.author).toEqual(
				author,
			);
		} finally {
			await Service.close(plan);
		}
	});

	it("rejects absent, changed, streaming, or wrongly attributed saved messages", async () => {
		let { message, record } = sourced();
		for (
			let transcript of [
				[],
				[{ ...message, text: "Try another host next" }],
				[{ ...message, streaming: true }],
				[{ ...message, author: { kind: "member" as const, handle: "ben" } }],
				[{ ...message, author: { kind: "agent" } }],
			]
		) {
			expect(await rejected(stored([record], [draft()], transcript))).toBeInstanceOf(Error);
		}
	});
});
