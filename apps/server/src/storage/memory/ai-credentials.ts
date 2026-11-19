import { AI_PROVIDERS } from "@chopin/protocol/ai-credentials";

import { conflict, missing } from "../errors";

import type { AiCredentialRecord, AiPlaceholder } from "../model";
import type { AiCredentialStore, AiPlaceholderStore } from "../port";

function hex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function copyCredential(value: AiCredentialRecord): AiCredentialRecord {
	return {
		...value,
		...(value.ciphertext ? { ciphertext: new Uint8Array(value.ciphertext) } : {}),
		updatedAt: new Date(value.updatedAt),
	};
}

function copyPlaceholder(value: AiPlaceholder): AiPlaceholder {
	return {
		...value,
		digest: new Uint8Array(value.digest),
		launchDigest: new Uint8Array(value.launchDigest),
		expiresAt: new Date(value.expiresAt),
	};
}

export class MemoryAiCredentialStore implements AiCredentialStore {
	#records = new Map<string, AiCredentialRecord>();
	constructor(private deps: { userExists: (id: string) => boolean }) {}
	async put(record: AiCredentialRecord) {
		if (!this.deps.userExists(record.userId)) throw missing(`user ${record.userId} does not exist`);
		this.#records.set(`${record.userId}\n${record.provider}`, copyCredential(record));
	}
	async get(userId: string, provider: AiCredentialRecord["provider"]) {
		let found = this.#records.get(`${userId}\n${provider}`);
		return found && copyCredential(found);
	}
	async list(userId: string) {
		return [...this.#records.values()]
			.filter(record => record.userId === userId)
			.sort((left, right) =>
				AI_PROVIDERS.indexOf(left.provider) - AI_PROVIDERS.indexOf(right.provider)
			)
			.map(copyCredential);
	}
	async delete(userId: string, provider: AiCredentialRecord["provider"]) {
		return this.#records.delete(`${userId}\n${provider}`);
	}
}

export class MemoryAiPlaceholderStore implements AiPlaceholderStore {
	#placeholders = new Map<string, AiPlaceholder>();
	constructor(
		private deps: {
			userExists: (id: string) => boolean;
			machineExists: (id: string) => boolean;
			channelExists: (id: string) => boolean;
		},
	) {}
	async put(placeholders: AiPlaceholder[]) {
		let keys = new Set<string>();
		for (let placeholder of placeholders) {
			if (!this.deps.userExists(placeholder.userId)) {
				throw missing(`user ${placeholder.userId} does not exist`);
			}
			if (placeholder.machineId && !this.deps.machineExists(placeholder.machineId)) {
				throw missing(`machine ${placeholder.machineId} does not exist`);
			}
			if (placeholder.channelId && !this.deps.channelExists(placeholder.channelId)) {
				throw missing(`channel ${placeholder.channelId} does not exist`);
			}
			let key = hex(placeholder.digest);
			if (this.#placeholders.has(key) || keys.has(key)) {
				throw conflict("a placeholder already has this digest");
			}
			keys.add(key);
		}
		for (let placeholder of placeholders) {
			this.#placeholders.set(hex(placeholder.digest), copyPlaceholder(placeholder));
		}
	}
	async find(digest: Uint8Array, now: Date) {
		let found = this.#placeholders.get(hex(digest));
		return found && found.expiresAt > now ? copyPlaceholder(found) : undefined;
	}
	async deleteLaunch(launchId: string) {
		return this.#deleteWhere(value => value.launchId === launchId);
	}
	async deleteForMachine(machineId: string) {
		return this.#deleteWhere(value => value.machineId === machineId);
	}
	async deleteExpired(now: Date) {
		return this.#deleteWhere(value => value.expiresAt <= now);
	}
	deleteChannel(channelId: string) {
		this.#deleteWhere(value => value.channelId === channelId);
	}
	#deleteWhere(matches: (value: AiPlaceholder) => boolean) {
		let removed = 0;
		for (let [key, value] of this.#placeholders) {
			if (!matches(value)) continue;
			this.#placeholders.delete(key);
			removed++;
		}
		return removed;
	}
}
