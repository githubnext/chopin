import type { Lease } from "../model";
import type { DeferredTurnStore } from "../port";

/**
 * Memory keeps nothing for a Planner that never took a message: it never held one. It answers
 * `retire` as storage with nothing open does, so a process with either adapter starts the same way.
 */
export class MemoryDeferredTurnStore implements DeferredTurnStore {
	constructor(private deps: { assertLease: (lease: Lease) => void }) {}
	async retire(lease: Lease): Promise<number> {
		this.deps.assertLease(lease);
		return 0;
	}
}
