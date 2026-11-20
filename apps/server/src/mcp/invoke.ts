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
 * A call made under an idempotency key claims the key, durably, before its instruction is posted,
 * naming the Chat entry the instruction becomes; see `IdempotentInvocations`.
 */
import { createHash } from "node:crypto";

import { ulid } from "@chopin/dialect";

import { resolveChild } from "../chat/children";
import * as Chat from "../chat/service";

import type { InvokePlanner, InvokePlannerError } from "../mcp";
import type { Lease, McpInvocationScope } from "../storage/model";
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
		if (input.system) {
			if (input.user.id !== root.createdBy && input.user.id !== route.plannerAccount(rootId)) {
				console.warn(`[mcp] @${input.user.login} may not start a system turn on ${rootId}`);
				return "system-turn-forbidden";
			}
			if (!route.systemTurns.take(rootId)) {
				console.warn(`[mcp] system turns on ${rootId} are limited; @${input.user.login} refused`);
				return "system-turn-limited";
			}
		}
		let code: InvokePlannerError | undefined;
		try {
			let { context, release } = await route.open(rootId, input);
			if (input.entryId && context.chat.entries.some(entry => entry.id === input.entryId)) {
				release();
				if (input.system) route.systemTurns.refund(rootId);
				return undefined;
			}
			try {
				// Released once the invoked turn itself ends, even when it waits behind others.
				code = await Chat.invoke(
					context,
					input.user,
					input.instruction,
					input.checkout,
					focus,
					release,
					input.system ? `Automatic follow-up requested by @${input.user.login}.` : undefined,
					input.entryId,
				);
			} catch (err) {
				release();
				throw err;
			}
			if (code) release();
		} catch (err) {
			if (input.system) route.systemTurns.refund(rootId);
			throw err;
		}
		if (input.system) {
			if (code) route.systemTurns.refund(rootId);
			else console.info(`[mcp] @${input.user.login} started a system turn on ${rootId}`);
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

/**
 * `invoke_planner` calls made under an idempotency key, so a caller that lost a reply can ask
 * again and post nothing more.
 *
 * The first call claims the key before anything is posted, naming the Chat entry its
 * instruction will be; a crash after the post leaves the claim, and the entry, for the retry to
 * find. A posted instruction completes the claim with its result, which every later call with
 * the same request is given; a different request under the key is refused. A claim this call
 * made is released when its refusal kept nothing. `planner-unavailable` can come after the
 * entry is saved, so its claim stays for the retry, as a claim an earlier call left does.
 * Calls with one key run one at a time in this process, the only one holding the writer lease.
 */
export class IdempotentInvocations {
	#running = new Map<string, Promise<unknown>>();

	constructor(
		private store: McpInvocationStore,
		private lease: () => Lease,
		private clock: () => Date,
	) {}

	run(
		scope: McpInvocationScope,
		fingerprint: string,
		deliver: (entryId: string) => Promise<Invoked>,
	): Promise<Invoked> {
		let key = JSON.stringify([scope.userId, scope.channelId, scope.key]);
		let previous = this.#running.get(key) ?? Promise.resolve();
		let operation = previous.then(() => this.#once(scope, fingerprint, deliver));
		let settled = operation.then(() => {}, () => {});
		this.#running.set(key, settled);
		void settled.then(() => {
			if (this.#running.get(key) === settled) this.#running.delete(key);
		});
		return operation;
	}

	async #once(
		scope: McpInvocationScope,
		fingerprint: string,
		deliver: (entryId: string) => Promise<Invoked>,
	): Promise<Invoked> {
		let now = this.clock();
		let { record, claimed } = await this.store.claim(this.lease(), {
			...scope,
			fingerprint,
			entryId: ulid(),
			createdAt: now,
			expiresAt: new Date(now.getTime() + INVOCATION_KEY_MS),
		});
		if (record.fingerprint !== fingerprint) {
			return { kind: "refused", code: "idempotency-conflict" };
		}
		if (record.result) return { kind: "invoked", document: record.result.document };
		let pending = { ...scope, entryId: record.entryId };
		let outcome = await deliver(record.entryId);
		if (outcome.kind === "invoked") {
			await this.store.complete(this.lease(), pending, { document: outcome.document });
		} else if (claimed && outcome.code !== "planner-unavailable") {
			await this.store.release(this.lease(), pending);
		}
		return outcome;
	}
}
