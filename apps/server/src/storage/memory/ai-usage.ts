import { missing } from "../errors";

import type {
	AiAttempt,
	AiAttemptResult,
	AiAttemptStart,
	AiModelTotals,
	AiTokenCounts,
	Lease,
} from "../model";
import type { AiUsageStore } from "../port";

type Stored = AiAttempt & { leaseName: string; fencing: number };

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function copy(value: Stored): AiAttempt {
	let { leaseName: _name, fencing: _fencing, ...attempt } = value;
	return {
		...attempt,
		tokens: { ...attempt.tokens },
		startedAt: new Date(attempt.startedAt),
		...(attempt.completedAt ? { completedAt: new Date(attempt.completedAt) } : {}),
	};
}

function counted(tokens: AiTokenCounts): AiTokenCounts {
	return Object.fromEntries(
		TOKEN_FIELDS.flatMap(field => tokens[field] === undefined ? [] : [[field, tokens[field]]]),
	);
}

export class MemoryAiUsageStore implements AiUsageStore {
	#attempts = new Map<string, Stored>();
	constructor(
		private deps: { userExists: (id: string) => boolean; assertLease: (lease: Lease) => void },
	) {}
	async begin(lease: Lease, value: AiAttemptStart) {
		this.deps.assertLease(lease);
		if (!this.deps.userExists(value.userId)) throw missing(`user ${value.userId} does not exist`);
		if (this.#attempts.has(value.id)) return;
		this.#attempts.set(value.id, {
			id: value.id,
			launchId: value.launchId,
			userId: value.userId,
			provider: value.provider,
			...(value.model ? { model: value.model } : {}),
			startedAt: new Date(value.startedAt),
			outcome: "pending",
			tokens: {},
			leaseName: lease.name,
			fencing: lease.fencing,
		});
	}
	async complete(lease: Lease, id: string, result: AiAttemptResult) {
		this.deps.assertLease(lease);
		let found = this.#attempts.get(id);
		if (!found || found.outcome !== "pending") return false;
		this.#attempts.set(id, {
			...found,
			outcome: result.outcome,
			...(result.status !== undefined ? { status: result.status } : {}),
			...(result.error ? { error: result.error } : {}),
			tokens: counted(result.tokens),
			completedAt: new Date(result.completedAt),
		});
		return true;
	}
	async retire(lease: Lease, at: Date) {
		this.deps.assertLease(lease);
		let retired = 0;
		for (let [id, value] of this.#attempts) {
			if (
				value.outcome !== "pending" || value.leaseName !== lease.name
				|| value.fencing >= lease.fencing
			) continue;
			this.#attempts.set(id, { ...value, outcome: "unknown", completedAt: new Date(at) });
			retired++;
		}
		return retired;
	}
	async get(id: string) {
		let found = this.#attempts.get(id);
		return found && copy(found);
	}
	async summary(userId: string, since: Date) {
		let totals = new Map<string, AiModelTotals>();
		for (let value of this.#attempts.values()) {
			if (value.userId !== userId || value.startedAt < since || value.outcome === "unsent") {
				continue;
			}
			let key = `${value.provider}\n${value.model ?? ""}`;
			let entry = totals.get(key) ?? {
				provider: value.provider,
				...(value.model ? { model: value.model } : {}),
				requests: 0,
				errors: 0,
				unknown: 0,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			entry.requests++;
			if (value.outcome === "error") entry.errors++;
			if (value.outcome === "unknown") entry.unknown++;
			for (let field of TOKEN_FIELDS) entry.tokens[field] += value.tokens[field] ?? 0;
			totals.set(key, entry);
		}
		return [...totals.values()].sort((left, right) =>
			right.requests - left.requests
			|| left.provider.localeCompare(right.provider)
			|| (left.model === undefined ? 1 : right.model === undefined ? -1 : 0)
			|| (left.model ?? "").localeCompare(right.model ?? "")
		);
	}
	async deleteBefore(lease: Lease, before: Date) {
		this.deps.assertLease(lease);
		let removed = 0;
		for (let [id, value] of this.#attempts) {
			if (value.startedAt >= before || value.outcome === "pending") continue;
			this.#attempts.delete(id);
			removed++;
		}
		return removed;
	}
}
