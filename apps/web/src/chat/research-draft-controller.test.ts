import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { researchDraftHarness } from "../../../server/src/conversation-plan/research-draft.test-fixtures";
import { ResearchDraftController } from "./research-draft-controller";
import type { Wire } from "../wire";

test("lost edit acknowledgements retain patches for idempotent reconnect replay", async () => {
	let h = researchDraftHarness();
	let lose = false;
	let wire = {
		connected: true,
		send() {},
		async ask<T>(
			_kind: string,
			payload: Omit<ConversationPlan.ResearchEdit, "kind" | "ts">,
		): Promise<T> {
			let result = await h.drafts.edit(payload.offerId, payload.operation, h.actor);
			if (lose && payload.operation.kind === "patch") {
				lose = false;
				throw new Error("lost acknowledgement");
			}
			return result as T;
		},
	} as unknown as Pick<Wire, "ask" | "send" | "connected">;
	let controller = new ResearchDraftController(h.offer());
	controller.configure(wire, true, h.offer());
	await controller.begin();
	lose = true;
	controller.change("Investigate Jev alternatives and costs.");
	await expect(controller.flush()).rejects.toThrow("not synchronized");
	let revision = h.offer().workflow!.revision;
	controller.configure(wire, false, h.offer());
	controller.configure(wire, true, h.offer());
	await controller.flush();
	expect(h.offer().workflow!.revision).toBe(revision);
	expect(controller.get().text).toBe(h.offer().brief);
	expect(controller.get().syncing).toBe(false);
});
