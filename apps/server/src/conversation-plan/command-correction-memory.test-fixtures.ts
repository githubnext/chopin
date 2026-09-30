import * as Plan from "../plan/service";
import { handleConversationCommand } from "./commands";
import { excerptAction, excerptCorrectionSetup } from "./service-correction.test-fixtures";
import { memoryProcessor } from "./service-memory.test-fixtures";

import type { ConversationPlan, Request } from "@chopin/protocol";
import type { Room } from "../rooms";
import type { Socket } from "../wire";

export async function correctionCommand() {
	let setup = await memoryProcessor();
	let seed = excerptCorrectionSetup();
	setup.plan.chat.entries = structuredClone(seed.setup.plan.chat.entries);
	setup.plan.conversationPlan = structuredClone(seed.setup.plan.conversationPlan);
	await Plan.persist(setup.plan);
	let processor = setup.start();
	let room: Room = { id: setup.plan.id, plan: setup.plan, members: new Map() };
	let frames: Array<Record<string, unknown>> = [];
	let snapshots: Array<ReturnType<typeof setup.saved>> = [];
	let ws = {
		data: { canEdit: true, handle: "bob", channelArchivedAt: undefined },
		send(value: string) {
			frames.push(JSON.parse(value));
			snapshots.push(setup.saved());
		},
	} as unknown as Socket;
	let deps: Parameters<typeof handleConversationCommand>[3] = {
		enabled: true,
		unavailable: () => false,
		refreshAccess: async () => "allowed",
		chat: () => {
			throw new Error("Correction commands do not claim Planner context");
		},
		// Runtime lookup is a fixture boundary; commands, processor and storage are real.
		runtime: { processor: opened => opened === setup.plan ? processor : undefined } as Parameters<
			typeof handleConversationCommand
		>[3]["runtime"],
	};
	let action = excerptAction(setup.plan.conversationPlan, seed.excerpt, seed.start, seed.end);
	let frame: Request<ConversationPlan.Correct> = {
		kind: "conversation-plan:correct",
		rid: "correction-1",
		ts: 0,
		...action,
	};
	return {
		setup,
		room,
		ws,
		deps,
		frames,
		snapshots,
		frame,
		seed,
		async reopen() {
			await setup.reopen();
			room.plan = setup.plan;
			processor = setup.start();
		},
	};
}
