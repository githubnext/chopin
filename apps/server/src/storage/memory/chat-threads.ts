import { missing } from "../errors";

import type { ChatSessionState, ChatThreadRecord, Lease } from "../model";
import type { ChatThreadStore } from "../port";

function cloneThread(value: ChatThreadRecord): ChatThreadRecord {
	let cloned = structuredClone(value);
	cloned.updatedAt = new Date(value.updatedAt);
	return cloned;
}

function cloneSession(value: ChatSessionState): ChatSessionState {
	let cloned = structuredClone(value);
	cloned.updatedAt = new Date(value.updatedAt);
	return cloned;
}

export class MemoryChatThreadStore implements ChatThreadStore {
	#threads = new Map<string, Map<string, ChatThreadRecord>>();
	#sessions = new Map<string, ChatSessionState>();

	constructor(
		private deps: {
			channelExists: (id: string) => boolean;
			assertLease: (lease: Lease) => void;
		},
	) {}

	async putThread(lease: Lease, thread: ChatThreadRecord): Promise<void> {
		this.deps.assertLease(lease);
		if (!this.deps.channelExists(thread.channelId)) {
			throw missing(`channel ${thread.channelId} does not exist`);
		}
		let map = this.#threads.get(thread.channelId);
		if (!map) {
			map = new Map();
			this.#threads.set(thread.channelId, map);
		}
		map.set(thread.rootId, cloneThread(thread));
	}

	async getThread(channelId: string, rootId: string): Promise<ChatThreadRecord | undefined> {
		let found = this.#threads.get(channelId)?.get(rootId);
		return found && cloneThread(found);
	}

	async listThreads(channelId: string): Promise<ChatThreadRecord[]> {
		let map = this.#threads.get(channelId);
		if (!map) return [];
		return [...map.values()]
			.sort((left, right) =>
				left.forkedAt - right.forkedAt || left.rootId.localeCompare(right.rootId)
			)
			.map(cloneThread);
	}

	async putSessionState(lease: Lease, state: ChatSessionState): Promise<void> {
		this.deps.assertLease(lease);
		if (!this.deps.channelExists(state.channelId)) {
			throw missing(`channel ${state.channelId} does not exist`);
		}
		this.#sessions.set(state.channelId, cloneSession(state));
	}

	async getSessionState(channelId: string): Promise<ChatSessionState | undefined> {
		let found = this.#sessions.get(channelId);
		return found && cloneSession(found);
	}

	deleteChannel(channelId: string): void {
		this.#threads.delete(channelId);
		this.#sessions.delete(channelId);
	}
}
