import { installJobCleanup } from "./job.test-fixtures";
import { expect, test } from "bun:test";
import * as Plan from "../plan/service";
import { cardMemory } from "./job-card-memory.test-fixtures";

installJobCleanup();

for (let kind of ["refine", "suggest", "prose"] as const) {
	test(`current ${kind} Harness profile executes its own durable card tool and reopens without replay`, async () => {
		let h = await cardMemory(kind);
		try {
			await h.run();
			expect(h.plan.conversationPlanJobs).toMatchObject([{ status: "done", attempts: 1 }]);
			let record = h.plan.records.get(h.id)!;
			if (kind === "refine") {
				expect(record.definition.questions[0]?.question).toBe("How should people sign in?");
			}
			if (kind === "suggest") {
				expect(record.definition.questions[0]?.options.map(option => option.label)).toEqual([
					"Passkeys",
				]);
			}
			if (kind === "prose") {
				expect(Plan.source(h.plan)).toContain("We chose GitHub Apps.");
				expect(record.prose).toHaveLength(1);
				expect(record.prose?.[0]?.orphaned).not.toBe(true);
			}
			expect(h.plan.chat.entries).toHaveLength(2);
			expect(h.plan.chat.entries[0]?.text).toBe("We need to choose authentication.");
			expect(h.plan.chat.entries[1]?.author.kind).toBe("system");
			expect(h.plan.chat.entries.some(entry => entry.tools?.length || entry.streaming)).toBe(false);
			expect(
				h.opened.broadcasts.some(frame =>
					frame.kind === "chat:tool" || frame.kind === "chat:delta"
				),
			).toBe(false);
			expect(h.plan.chat.job).toBeUndefined();
			expect(h.errors).toEqual([]);
			await h.close();
			let reopened = await Plan.open(h.opened.channel.id, h.opened.backend, h.opened.server);
			try {
				expect(reopened.records.get(h.id)?.definition).toEqual(record.definition);
				expect(reopened.conversationPlanJobs).toMatchObject([{ status: "done", attempts: 1 }]);
				expect(reopened.chat.waiting).toEqual([]);
				expect(h.driver.starts()).toBe(1);
				if (kind === "prose") expect(Plan.source(reopened)).toContain("We chose GitHub Apps.");
			} finally {
				await Plan.close(reopened);
			}
		} finally {
			if (!h.plan.chat.closed) await h.close();
		}
	});
}
