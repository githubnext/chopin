import { useSyncExternalStore } from "react";

import type { ConversationPlan } from "@chopin/protocol";
import type { Wire } from "../wire";

type Snapshot = { enabled: boolean; state?: ConversationPlan.State; jobs: ConversationPlan.Job[] };

/** One room-owned subscription. A new socket connection cannot retain old cards. */
export class ConversationPlanStore {
	#snapshot: Snapshot = { enabled: false, jobs: [] };
	#listeners = new Set<() => void>();
	#room: string;
	#generation = 0;

	constructor(room: string) {
		this.#room = room;
	}

	get = (): Snapshot => this.#snapshot;
	subscribe = (listener: () => void): () => void => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	reset(): void {
		this.#generation++;
		this.#snapshot = { enabled: false, jobs: [] };
		this.#emit();
	}

	listen(wire: Wire): () => void {
		this.reset();
		let receive = (frame: ConversationPlan.Snapshot | ConversationPlan.Changed) => {
			if (frame.state.revision < (this.#snapshot.state?.revision ?? -1)) return;
			this.#snapshot = {
				enabled: true,
				state: frame.state,
				jobs: frame.kind === "conversation-plan:snapshot"
					? frame.jobs ?? []
					: this.#snapshot.jobs,
			};
			this.#emit();
		};
		let receiveJobs = (frame: ConversationPlan.Jobs) => {
			this.#snapshot = { ...this.#snapshot, enabled: true, jobs: frame.jobs };
			this.#emit();
		};
		let off = [
			wire.on<ConversationPlan.Snapshot>("conversation-plan:snapshot", receive),
			wire.on<ConversationPlan.Changed>("conversation-plan:changed", receive),
			wire.on<ConversationPlan.Jobs>("conversation-plan:jobs", receiveJobs),
		];
		return () => {
			for (let unsubscribe of off) unsubscribe();
			this.reset();
		};
	}

	get generation(): number {
		return this.#generation;
	}

	get room(): string {
		return this.#room;
	}

	#emit(): void {
		for (let listener of this.#listeners) listener();
	}
}

export function useConversationPlan(store: ConversationPlanStore): Snapshot {
	return useSyncExternalStore(store.subscribe, store.get, store.get);
}
