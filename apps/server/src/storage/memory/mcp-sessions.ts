import type { McpSession } from "../model";
import type { McpSessionStore } from "../port";

function copy(value: McpSession): McpSession {
	return {
		...value,
		createdAt: new Date(value.createdAt),
		lastSeenAt: new Date(value.lastSeenAt),
	};
}

export class MemoryMcpSessionStore implements McpSessionStore {
	#sessions = new Map<string, McpSession>();
	async create(session: McpSession) {
		if (!this.#sessions.has(session.id)) this.#sessions.set(session.id, copy(session));
	}
	async find(id: string) {
		let found = this.#sessions.get(id);
		return found && copy(found);
	}
	async touch(id: string, now: Date) {
		let found = this.#sessions.get(id);
		if (!found) return false;
		if (now > found.lastSeenAt) found.lastSeenAt = new Date(now);
		return true;
	}
	async deleteIdle(before: Date) {
		let removed = 0;
		for (let [id, value] of this.#sessions) {
			if (value.lastSeenAt < before) {
				this.#sessions.delete(id);
				removed++;
			}
		}
		return removed;
	}
}
