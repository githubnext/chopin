import { missing } from "../errors";

import type { Lease, McpInvocation, McpInvocationResult, McpInvocationScope } from "../model";
import type { McpInvocationStore } from "../port";

function copy(value: McpInvocation): McpInvocation {
	return {
		...value,
		result: structuredClone(value.result),
		createdAt: new Date(value.createdAt),
		expiresAt: new Date(value.expiresAt),
		...(value.invokedAt ? { invokedAt: new Date(value.invokedAt) } : {}),
		...(value.uncertainAt ? { uncertainAt: new Date(value.uncertainAt) } : {}),
	};
}

function scopeKey(scope: McpInvocationScope): string {
	return JSON.stringify([scope.userId, scope.channelId, scope.key]);
}

export class MemoryMcpInvocationStore implements McpInvocationStore {
	#records = new Map<string, McpInvocation>();
	constructor(
		private deps: {
			channelExists: (id: string) => boolean;
			assertLease: (lease: Lease) => void;
		},
	) {}
	async claim(lease: Lease, invocation: Omit<McpInvocation, "invokedAt" | "uncertainAt">) {
		this.deps.assertLease(lease);
		if (!this.deps.channelExists(invocation.channelId)) {
			throw missing(`channel ${invocation.channelId} does not exist`);
		}
		let key = scopeKey(invocation);
		let held = this.#records.get(key);
		if (held && held.expiresAt > invocation.createdAt) {
			return { record: copy(held), claimed: false };
		}
		this.#records.set(key, copy(invocation));
		return { record: copy(invocation), claimed: true };
	}
	async complete(
		lease: Lease,
		scope: McpInvocationScope & { entryId: string },
		at: Date,
		result?: McpInvocationResult,
	) {
		this.deps.assertLease(lease);
		let held = this.#records.get(scopeKey(scope));
		if (!held || held.invokedAt || held.uncertainAt || held.entryId !== scope.entryId) return false;
		if (result !== undefined) held.result = structuredClone(result);
		held.invokedAt = new Date(at);
		return true;
	}
	async uncertain(lease: Lease, scope: McpInvocationScope & { entryId: string }, at: Date) {
		this.deps.assertLease(lease);
		let held = this.#records.get(scopeKey(scope));
		if (!held || held.invokedAt || held.uncertainAt || held.entryId !== scope.entryId) return false;
		held.uncertainAt = new Date(at);
		return true;
	}
	async release(lease: Lease, scope: McpInvocationScope & { entryId: string }) {
		this.deps.assertLease(lease);
		let key = scopeKey(scope);
		let held = this.#records.get(key);
		if (!held || held.invokedAt || held.uncertainAt || held.entryId !== scope.entryId) return false;
		this.#records.delete(key);
		return true;
	}
	async get(scope: McpInvocationScope) {
		let held = this.#records.get(scopeKey(scope));
		return held && copy(held);
	}
	async deleteExpired(now: Date) {
		let removed = 0;
		for (let [key, value] of this.#records) {
			if (value.expiresAt <= now) {
				this.#records.delete(key);
				removed++;
			}
		}
		return removed;
	}
	deleteChannel(channelId: string) {
		for (let [key, value] of this.#records) {
			if (value.channelId === channelId) this.#records.delete(key);
		}
	}
}
