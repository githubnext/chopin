import { describe, expect, test } from "bun:test";
import { fixture, pending, settle } from "./research-offer.test-fixtures";

// Exact archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2, apps/web/src/chat/research-offer.test.ts.
describe("accepted research offer link observer", () => {
	test("one immediate read and only three delayed reads at 2/5/10 seconds", async () => {
		let f = fixture();
		f.observer.accept(new Set(["offer-1"]));
		expect(f.reads).toEqual(["offer-1"]);
		for (let ms of [2_000, 5_000, 10_000]) {
			f.replies.at(-1)!.resolve(pending());
			await settle();
			expect([...f.timers.values()].map(item => item.ms)).toEqual([ms]);
			f.tick(ms);
		}
		f.replies.at(-1)!.resolve(pending());
		await settle();
		expect(f.reads).toHaveLength(4);
		expect(f.timers.size).toBe(0);
		expect(f.links["offer-1"]).toEqual({ status: "pending", exhausted: true });
		f.observer.dispose();
	});

	test("a change during an unresolved read forces one follow-up", async () => {
		let f = fixture();
		f.observer.accept(new Set(["offer-1"]));
		f.observer.changed();
		f.observer.changed();
		expect(f.reads).toHaveLength(1);
		f.replies[0]!.resolve(pending());
		await settle();
		expect(f.reads).toHaveLength(2);
		f.replies[1]!.resolve({
			kind: "conversation-plan:research-link",
			offerId: "offer-1",
			status: "linked",
			researchRequestId: "request-1",
			ts: 1,
		});
		await settle();
		expect(f.links["offer-1"]).toEqual({ status: "linked", researchRequestId: "request-1" });
		expect(f.timers.size).toBe(0);
		f.observer.changed();
		expect(f.reads).toHaveLength(2);
	});

	test("a later change can read again after the fallback budget ends", async () => {
		let f = fixture();
		f.observer.accept(new Set(["offer-1"]));
		for (let ms of [2_000, 5_000, 10_000]) {
			f.replies.at(-1)!.resolve(pending());
			await settle();
			f.tick(ms);
		}
		f.replies.at(-1)!.resolve(pending());
		await settle();
		expect(f.links["offer-1"]?.exhausted).toBe(true);
		f.observer.changed();
		expect(f.reads).toHaveLength(5);
		f.replies.at(-1)!.resolve(pending());
		await settle();
		expect(f.timers.size).toBe(0);
		f.observer.dispose();
	});

	test("removed offers and disposal ignore stale replies and cancel timers", async () => {
		let f = fixture();
		f.observer.accept(new Set(["offer-1"]));
		f.observer.accept(new Set());
		f.replies[0]!.resolve(pending());
		await settle();
		expect(f.links).toEqual({});
		expect(f.timers.size).toBe(0);
		f.observer.accept(new Set(["offer-1"]));
		f.replies[1]!.resolve(pending());
		await settle();
		expect(f.timers.size).toBe(1);
		f.observer.dispose();
		expect(f.timers.size).toBe(0);
		expect(f.cancelled).toHaveLength(1);
		f.observer.changed();
		expect(f.reads).toHaveLength(2);
	});

	test("mismatched or malformed link replies never become linked", async () => {
		let f = fixture();
		f.observer.accept(new Set(["offer-1"]));
		f.replies[0]!.resolve({
			kind: "conversation-plan:research-link",
			offerId: "other-offer",
			status: "linked",
			researchRequestId: "request-1",
			ts: 1,
		});
		await settle();
		expect(f.links["offer-1"]?.status).toBe("error");
		f.observer.dispose();
	});
});
