import type { Investigation } from "@chopin/experiment/records";

type Deps = {
	get: (id: string) => Promise<Investigation | undefined>;
	list: (channelId: string) => Promise<Investigation[]>;
	mutate: (id: string, action: (value: Investigation) => void) => Promise<unknown>;
	/** Start the Planner turn that settles the passage; true once Chat accepted it. */
	start: (channelId: string, value: Investigation) => Promise<boolean>;
};

/**
 * Settles landed spikes. `spike.settle` is persisted with `rendered = completed` and cleared
 * only after Chat accepts the turn, so a landing with no room or no Planner owner stays
 * pending and is retried when the room opens or an owner becomes available.
 */
export function spikeSettler({ get, list, mutate, start }: Deps) {
	let settling = new Set<string>();
	async function settle(channelId: string, id: string): Promise<void> {
		if (settling.has(id)) return;
		settling.add(id);
		try {
			let value = await get(id);
			if (!value?.spike?.settle || value.spike.dismissed || value.documentId !== channelId) return;
			if (!await start(channelId, value)) return;
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
