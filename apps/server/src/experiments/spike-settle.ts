import { serverInstruction } from "../chat/server-instruction";

import type { Instruction, ServerInstructionDeps } from "../chat/server-instruction";
import type * as Service from "../plan/service";
import type { Investigation } from "@chopin/experiment/records";

type Deps = {
	get: (id: string) => Promise<Investigation | undefined>;
	list: (channelId: string) => Promise<Investigation[]>;
	mutate: (id: string, action: (value: Investigation) => void) => Promise<unknown>;
	/**
	 * Start the Planner turn that settles the passage: true once Chat accepted it, false to keep
	 * it pending, `drop` when it can never run (a child document has no Planner of its own).
	 */
	start: (channelId: string, value: Investigation) => Promise<boolean | "drop">;
};

/**
 * Settles landed spikes. `spike.settle` is persisted with `rendered = completed` and cleared
 * only after Chat accepts the turn, so a landing with no Planner owner (or, under the remote
 * harness, no attached Planner) stays pending and is retried when an owner appears or a Planner
 * attaches. A settle that can never run is dropped instead of retried forever.
 */
export function spikeSettler({ get, list, mutate, start }: Deps) {
	let settling = new Set<string>();
	async function settle(channelId: string, id: string): Promise<void> {
		if (settling.has(id)) return;
		settling.add(id);
		try {
			let value = await get(id);
			if (!value?.spike?.settle || value.spike.dismissed || value.documentId !== channelId) return;
			if (await start(channelId, value) === false) return;
			await mutate(id, item => {
				delete item.spike!.settle;
			});
		} finally {
			settling.delete(id);
		}
	}
	return {
		settle,
		async pending(channelId: string): Promise<void> {
			for (let value of await list(channelId)) {
				if (value.spike?.settle && !value.spike.dismissed) await settle(channelId, value.id);
			}
		},
	};
}

/**
 * Start a landed spike's settling turn. A child document has no Planner of its own, so its
 * settle is dropped. Under the remote harness only an attached Planner may take the turn;
 * otherwise, and without an owner, it stays pending. It never claims an owner.
 */
export async function startSettle(
	deps: {
		instruction: ServerInstructionDeps;
		channel: (channelId: string) => Promise<{ parentChannelId?: string } | undefined>;
		/** Present under the remote harness: whether a Planner is attached to the document. */
		attached?: (channelId: string) => Promise<boolean>;
	},
	channelId: string,
	compose: (plan: Service.Plan) => Instruction | undefined,
): Promise<boolean | "drop"> {
	let channel = await deps.channel(channelId);
	if (!channel || channel.parentChannelId) return "drop";
	if (deps.attached && !await deps.attached(channelId)) return false;
	return serverInstruction(deps.instruction, channelId, compose);
}
