import { expect, test } from "bun:test";
import * as Draft from "@chopin/draft";
import { researchDraftHarness } from "./research-draft.test-fixtures";
import { restoreState } from "./domain";

test("two writers merge edits and the complete draft survives restoration", async () => {
	let h = researchDraftHarness();
	await h.drafts.edit(h.id, { kind: "begin" }, h.actor);
	let original = Draft.restore(h.offer().workflow!.draft!);
	let a = Draft.change(original.fork(), "Investigate fast Jev alternatives.")!;
	let b = Draft.change(original.fork(), "Investigate Jev alternatives and costs.")!;
	await Promise.all([
		h.drafts.edit(h.id, { kind: "patch", patch: a }, h.actor),
		h.drafts.edit(h.id, { kind: "patch", patch: b }, { kind: "member", handle: "bo" }),
	]);
	expect(h.offer().brief).toBe("Investigate fast Jev alternatives and costs.");
	let before = h.offer().workflow!.revision;
	await h.drafts.edit(h.id, { kind: "patch", patch: a }, h.actor);
	expect(h.offer().workflow!.revision).toBe(before);
	expect(restoreState(h.plan.conversationPlan, h.plan.chat.entries)).toEqual(
		h.plan.conversationPlan,
	);
});

test("failed persistence retains the previous editable offer and invalid patches never publish", async () => {
	let h = researchDraftHarness();
	let original = structuredClone(h.offer());
	h.fail();
	await expect(h.drafts.edit(h.id, { kind: "begin" }, h.actor)).rejects.toThrow("storage failed");
	expect(h.offer()).toEqual(original);
	await h.drafts.edit(h.id, { kind: "begin" }, h.actor);
	let before = structuredClone(h.offer());
	await expect(h.drafts.edit(h.id, { kind: "patch", patch: [999] }, h.actor)).rejects.toThrow();
	expect(h.offer()).toEqual(before);
});

test("applying a sourced addition is a shared idempotent CRDT edit", async () => {
	let h = researchDraftHarness();
	await h.drafts.edit(h.id, { kind: "begin" }, h.actor);
	h.offer().workflow!.additions.push({
		id: "addition",
		text: "Include licensing.",
		sources: [h.offer().source],
		status: "pending",
	});
	let operation = {
		kind: "addition" as const,
		id: "addition",
		actionId: "apply-once",
		choice: "apply" as const,
	};
	await h.drafts.edit(h.id, operation, h.actor);
	await h.drafts.edit(h.id, operation, h.actor);
	expect(h.offer().brief).toBe("Investigate Jev alternatives.\n\nInclude licensing.");
	expect(Draft.read(Draft.restore(h.offer().workflow!.draft!))).toBe(h.offer().brief);
	expect(h.offer().workflow!.additions[0]!.actor).toBe("ana");
});
