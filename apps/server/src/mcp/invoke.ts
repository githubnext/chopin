/**
 * Where an MCP `invoke_planner` instruction runs.
 *
 * A root document's instruction runs on its own Chat. A child has no Chat, so
 * its instruction runs on its root's, with the child as the turn's focus. The
 * child's parentage and repository are asked of storage again first; a child
 * that no longer belongs to a live root in the caller's repository is refused.
 *
 * A system invocation is an automatic follow-up nobody typed: Chat shows a
 * notice naming the caller instead of their message. Only the root's creator,
 * or the account whose client holds its Planner, may start one, and each root
 * takes a bounded number an hour.
 *
 * A call made under an idempotency key settles the key against the root's Chat after the caller's
 * authorization and before the hourly limit, which a follow-up whose notice is already posted does
 * not count again; see `IdempotentInvocations`.
 */
import { createHash } from "node:crypto";

import { ulid } from "@chopin/dialect";

import { resolveChild } from "../chat/children";
import * as Chat from "../chat/service";

import type { InvokePlanner, InvokePlannerError } from "../mcp";
import type {
	Lease,
	McpInvocation,
	McpInvocationResult,
	McpInvocationScope,
} from "../storage/model";
import type { ChannelStore, McpInvocationStore } from "../storage/port";
import type { PlannerInvocation } from "./hosted";

export type InvocationRoute = {
	channels: Pick<ChannelStore, "get">;
	deleting: (channelId: string) => boolean;
	/** Serializes the work with the root's archive, restore and delete. */
	transition: <T>(channelId: string, action: () => Promise<T>) => Promise<T>;
	/** Opens the root's room and its Chat for this caller; `release` lets the room go. */
	open: (
		rootId: string,
		input: PlannerInvocation,
	) => Promise<{ context: Chat.Room; release: () => void }>;
	/** The account whose client holds the document's Planner, if one does. */
	plannerAccount: (rootId: string) => string | undefined;
	systemTurns: SystemTurns;
};

export const MAX_SYSTEM_TURNS_PER_HOUR = 10;
const HOUR_MS = 60 * 60_000;

/** When each root's recent system turns were accepted, for its hourly limit. */
export class SystemTurns {
	#accepted = new Map<string, number[]>();
	#now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** Counts one against `rootId`'s limit, or returns false when the limit is spent. */
	take(rootId: string): boolean {
		let now = this.#now();
		let recent = (this.#accepted.get(rootId) ?? []).filter(at => now - at < HOUR_MS);
		if (recent.length >= MAX_SYSTEM_TURNS_PER_HOUR) {
			this.#accepted.set(rootId, recent);
			return false;
		}
		recent.push(now);
		this.#accepted.set(rootId, recent);
		return true;
	}

	/** Gives back the latest one taken, for a turn that was refused after all. */
	refund(rootId: string): void {
		let recent = this.#accepted.get(rootId);
		recent?.pop();
		if (recent?.length === 0) this.#accepted.delete(rootId);
	}
}

export async function invokeRouted(
	route: InvocationRoute,
	input: PlannerInvocation,
): Promise<InvokePlannerError | undefined> {
	let target = await route.channels.get(input.channel.id);
	if (!target || route.deleting(target.id)) return "document-unavailable";
	let rootId = target.parentChannelId ?? target.id;
	// A child call holds the root's transition; child tools recheck under the child's own.
	return route.transition(rootId, async () => {
		let root = await route.channels.get(rootId);
		if (!root || route.deleting(rootId)) return "document-unavailable";
		if (root.archivedAt || target.archivedAt) return "document-archived";
		let focus: Chat.Instruction["focus"];
		if (target.parentChannelId) {
			let child = await resolveChild(route.channels, rootId, input.repository.id, target.id);
			if (!child) return "document-unavailable";
			focus = { channelId: child.id, title: child.title };
		}
		if (
			input.system && input.user.id !== root.createdBy
			&& input.user.id !== route.plannerAccount(rootId)
		) {
			console.warn(`[mcp] @${input.user.login} may not start a system turn on ${rootId}`);
			return "system-turn-forbidden";
		}
		let { context, release } = await route.open(rootId, input);
		let posted = (entryId: string) => context.chat.entries.some(entry => entry.id === entryId);
		let delivery: Chat.InvokedEntry = { entryId: ulid() };
		let charged = false;
		let code: InvokePlannerError | undefined;
		try {
			let reconciled = await input.keyed?.reconcile(posted);
			if (reconciled === "idempotency-conflict") code = reconciled;
			else if (reconciled) delivery = reconciled;
			if (!code && input.system && !posted(delivery.entryId)) {
				charged = route.systemTurns.take(rootId);
				if (!charged) {
					console.warn(`[mcp] system turns on ${rootId} are limited; @${input.user.login} refused`);
					code = "system-turn-limited";
				}
			}
			// Released once the invoked turn itself ends, even when it waits behind others.
			code ??= await Chat.invoke(
				context,
				input.user,
				input.instruction,
				input.checkout,
				focus,
				release,
				input.system ? `Automatic follow-up requested by @${input.user.login}.` : undefined,
				delivery,
			);
		} catch (err) {
			release();
			if (charged && !posted(delivery.entryId)) route.systemTurns.refund(rootId);
			throw err;
		}
		if (!code) {
			if (input.system) {
				console.info(`[mcp] @${input.user.login} started a system turn on ${rootId}`);
			}
			return undefined;
		}
		release();
		if (!posted(delivery.entryId)) {
			if (charged) route.systemTurns.refund(rootId);
			if (code !== "idempotency-conflict") await input.keyed?.unused();
		}
		return code;
	});
}

/** How long a caller's idempotency key keeps its first `invoke_planner` call's result. */
export const INVOCATION_KEY_MS = 7 * 24 * 60 * 60_000;

type Invoked = Awaited<ReturnType<InvokePlanner<unknown>["invoke"]>>;

/** What makes two calls under one key the same request: their instruction, `as` and focus. */
export function invocationFingerprint(
	request: { instruction: string; as?: "system" },
	focus: string,
): string {
	return createHash("sha256")
		.update(JSON.stringify({ instruction: request.instruction, as: request.as ?? null, focus }))
		.digest("hex");
}

/** An `invoke_planner` call's idempotency key, as its route settles it against the root's Chat. */
export type KeyedInvocation = {
	/**
	 * Settles the key against the Chat, whose `posted` says whether it holds an entry: the delivery
	 * this call makes, or a conflict when the key holds a different request whose entry is posted.
	 */
	reconcile(
		posted: (entryId: string) => boolean,
	): Promise<Chat.InvokedEntry | "idempotency-conflict">;
	/** Frees the key: this call was refused, and Chat holds nothing it posted. */
	unused(): Promise<void>;
};

/**
 * `invoke_planner` calls made under an idempotency key, so a caller that lost a reply can ask
 * again and post nothing more, and start no second turn.
 *
 * The first call claims the key before anything is posted, naming the Chat entry its instruction
 * will be and the result it answers. The claim is marked invoked once the instruction's turn has
 * started (or the instruction was given to the turn running), and the call answers only after
 * that: a claim marked invoked is evidence its turn started, so every later call with the same
 * request is given the claim's result, and a different one is refused.
 *
 * A claim not marked invoked says nothing alone: the root's Chat does. When it holds the entry, an
 * earlier call saved it and started no turn, or started one whose start it could not record. A
 * retry starts that turn without posting again, unless this process remembers starting it, when
 * it only records the start. When the Chat does not hold the entry, nothing was kept: a retry posts
 * it, and a different request takes the key. A refusal that kept nothing frees the key, and one
 * that could not is freed by the next call.
 *
 * So a process that stops after a turn started and before its start was recorded, or after
 * recording it failed, leaves a claim whose retry, in the next process, starts the turn again.
 * Calls with one key run one at a time in this process, the only one holding the writer lease.
 */
export class IdempotentInvocations {
	#running = new Map<string, Promise<unknown>>();
	/** The entry of each key's claim whose turn this process started without recording it. */
	#started = new Map<string, string>();

	constructor(
		private store: McpInvocationStore,
		private lease: () => Lease,
		private clock: () => Date,
	) {}

	run(
		scope: McpInvocationScope,
		fingerprint: string,
		result: McpInvocationResult,
		deliver: (keyed: KeyedInvocation) => Promise<Invoked>,
	): Promise<Invoked> {
		let key = JSON.stringify([scope.userId, scope.channelId, scope.key]);
		let previous = this.#running.get(key) ?? Promise.resolve();
		let operation = previous.then(() => this.#once(key, scope, fingerprint, result, deliver));
		let settled = operation.then(() => {}, () => {});
		this.#running.set(key, settled);
		void settled.then(() => {
			if (this.#running.get(key) === settled) this.#running.delete(key);
		});
		return operation;
	}

	async #once(
		key: string,
		scope: McpInvocationScope,
		fingerprint: string,
		result: McpInvocationResult,
		deliver: (keyed: KeyedInvocation) => Promise<Invoked>,
	): Promise<Invoked> {
		let lease = this.lease();
		let claim = async () => {
			let now = this.clock();
			let claimed = await this.store.claim(lease, {
				...scope,
				fingerprint,
				entryId: ulid(),
				result,
				createdAt: now,
				expiresAt: new Date(now.getTime() + INVOCATION_KEY_MS),
			});
			return claimed.record;
		};
		let record = await claim();
		if (record.invokedAt) {
			if (record.fingerprint !== fingerprint) {
				return { kind: "refused", code: "idempotency-conflict" };
			}
			return { kind: "invoked", document: record.result.document };
		}
		if (record.fingerprint === fingerprint && this.#started.get(key) === record.entryId) {
			return this.#record(key, lease, record);
		}
		let outcome = await deliver({
			reconcile: async posted => {
				if (record.fingerprint !== fingerprint) {
					if (posted(record.entryId)) return "idempotency-conflict";
					await this.store.release(lease, record);
					record = await claim();
					if (record.invokedAt || record.fingerprint !== fingerprint) {
						return "idempotency-conflict";
					}
				}
				return { entryId: record.entryId };
			},
			unused: async () => {
				await this.store.release(lease, record).catch(err => {
					console.error("[mcp] could not free an idempotency key after a refusal:", err);
				});
			},
		});
		if (outcome.kind !== "invoked") return outcome;
		return this.#record(key, lease, record);
	}

	/**
	 * Marks `claim` invoked, its turn having started, and answers its result. When that can't be
	 * saved the call fails, and this process remembers the turn it started, so a retry here records
	 * it and starts none.
	 */
	async #record(key: string, lease: Lease, claim: McpInvocation): Promise<Invoked> {
		try {
			await this.store.complete(lease, claim, this.clock());
		} catch (err) {
			this.#started.set(key, claim.entryId);
			throw err;
		}
		if (this.#started.get(key) === claim.entryId) this.#started.delete(key);
		return { kind: "invoked", document: claim.result.document };
	}
}
