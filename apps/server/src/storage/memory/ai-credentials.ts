import { AI_PROVIDERS } from "@chopin/protocol/ai-credentials";

import { conflict, missing } from "../errors";

import type { AiCutoffs } from "../ai-cutoffs";
import type { AiCredentialRecord, AiPlaceholder, Lease } from "../model";
import type { AiCredentialStore, AiPlaceholderStore } from "../port";

function hex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function copyCredential(value: AiCredentialRecord): AiCredentialRecord {
	return {
		...value,
		...(value.ciphertext ? { ciphertext: new Uint8Array(value.ciphertext) } : {}),
		...(value.tokens ? { tokens: new Uint8Array(value.tokens) } : {}),
		updatedAt: new Date(value.updatedAt),
		...(value.lastUsedAt ? { lastUsedAt: new Date(value.lastUsedAt) } : {}),
		...(value.rejectedAt ? { rejectedAt: new Date(value.rejectedAt) } : {}),
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
	constructor(
		private deps: {
			userExists: (id: string) => boolean;
			/** Throws unless `lease` is held now, as every cutoff must be written under it. */
			assertLease: (lease: Lease) => void;
			cutoffs: AiCutoffs;
		},
	) {}
	async put(lease: Lease, record: AiCredentialRecord) {
		this.deps.assertLease(lease);
		if (!this.deps.userExists(record.userId)) throw missing(`user ${record.userId} does not exist`);
		this.#records.set(`${record.userId}\n${record.provider}`, copyCredential(record));
		this.deps.cutoffs.cut(record.userId);
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
	async delete(lease: Lease, userId: string, provider: AiCredentialRecord["provider"]) {
		this.deps.assertLease(lease);
		let removed = this.#records.delete(`${userId}\n${provider}`);
		this.deps.cutoffs.cut(userId);
		return removed;
	}
	async used(record: AiCredentialRecord, at: Date) {
		let found = this.#same(record);
		if (found && (!found.lastUsedAt || found.lastUsedAt < at)) found.lastUsedAt = new Date(at);
	}
	async rejected(record: AiCredentialRecord, at: Date) {
		let found = this.#same(record);
		if (!found || found.rejectedAt || !sameBytes(found.tokens, record.tokens)) return false;
		found.rejectedAt = new Date(at);
		this.deps.cutoffs.cut(record.userId);
		return true;
	}
	async refreshed(lease: Lease, record: AiCredentialRecord, tokens: Uint8Array) {
		this.deps.assertLease(lease);
		let found = this.#same(record);
		if (!found || !sameBytes(found.tokens, record.tokens)) return false;
		found.tokens = new Uint8Array(tokens);
		return true;
	}
	async signedIn(
		lease: Lease,
		record: AiCredentialRecord,
		replaced: AiCredentialRecord | undefined,
	) {
		this.deps.assertLease(lease);
		if (!this.deps.userExists(record.userId)) throw missing(`user ${record.userId} does not exist`);
		let key = `${record.userId}\n${record.provider}`;
		let current = replaced ? this.#same(replaced) !== undefined : !this.#records.has(key);
		if (current) this.#records.set(key, copyCredential(record));
		this.deps.cutoffs.cut(record.userId);
		return current;
	}
	/** The stored row while it is still the credential `record` was read as. */
	#same(record: AiCredentialRecord) {
		let found = this.#records.get(`${record.userId}\n${record.provider}`);
		if (!found || found.updatedAt.getTime() !== record.updatedAt.getTime()) return undefined;
		return sameBytes(found.ciphertext, record.ciphertext) ? found : undefined;
	}
	version(userId: string) {
		return this.deps.cutoffs.person(userId);
	}
}

function sameBytes(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
	return left && right ? Buffer.from(left).equals(right) : !left && !right;
}

export class MemoryAiPlaceholderStore implements AiPlaceholderStore {
	#placeholders = new Map<string, AiPlaceholder>();
	constructor(
		private deps: {
			userExists: (id: string) => boolean;
			/** Throws unless `lease` is held now, as every cutoff must be written under it. */
			assertLease: (lease: Lease) => void;
			machineExists: (id: string) => boolean;
			channelExists: (id: string) => boolean;
			/** A document's archive generation while it is open, else undefined. */
			generation: (channelId: string) => number | undefined;
			cutoffs: AiCutoffs;
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
		if (
			placeholders.some(placeholder =>
				placeholder.channelId
				&& this.deps.generation(placeholder.channelId) !== placeholder.generation
			)
		) return false;
		for (let placeholder of placeholders) {
			this.#placeholders.set(hex(placeholder.digest), copyPlaceholder(placeholder));
		}
		return true;
	}
	async generation(channelId: string) {
		return this.deps.generation(channelId);
	}
	async find(digest: Uint8Array, now: Date) {
		let found = this.#placeholders.get(hex(digest));
		return found && found.expiresAt > now ? copyPlaceholder(found) : undefined;
	}
	async findLaunch(launchDigest: Uint8Array, now: Date) {
		for (let value of this.#placeholders.values()) {
			if (value.expiresAt > now && sameBytes(value.launchDigest, launchDigest)) {
				return copyPlaceholder(value);
			}
		}
		return undefined;
	}
	async owned(now: Date) {
		let launches = new Map<string, Pick<AiPlaceholder, "launchId" | "owner" | "channelId">>();
		for (let value of this.#placeholders.values()) {
			if (!value.owner || value.expiresAt <= now || launches.has(value.launchId)) continue;
			launches.set(value.launchId, {
				launchId: value.launchId,
				owner: value.owner,
				...(value.channelId ? { channelId: value.channelId } : {}),
			});
		}
		return [...launches.values()];
	}
	async deleteLaunch(lease: Lease, launchId: string) {
		this.deps.assertLease(lease);
		return this.#cut(this.#deleteWhere(value => value.launchId === launchId));
	}
	async deleteHeldLaunch(lease: Lease, launchDigest: Uint8Array, machineId: string) {
		this.deps.assertLease(lease);
		return this.#cut(
			this.#deleteWhere(value =>
				value.machineId === machineId && sameBytes(value.launchDigest, launchDigest)
			),
		);
	}
	async deleteForMachine(lease: Lease, machineId: string) {
		this.deps.assertLease(lease);
		return this.#cut(this.#deleteWhere(value => value.machineId === machineId));
	}
	async deleteExpired(now: Date) {
		return this.#deleteWhere(value => value.expiresAt <= now);
	}
	deleteChannel(channelId: string) {
		this.#cut(this.#deleteWhere(value => value.channelId === channelId));
	}
	cutoffs() {
		return this.deps.cutoffs.all();
	}
	#cut(removed: number) {
		this.deps.cutoffs.cut();
		return removed;
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
