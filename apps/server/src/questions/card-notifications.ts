import { appendCardAction, captureCardAction } from "./card-actions";

import * as Prose from "./prose";

import * as Store from "./store";
import * as Jobs from "../conversation-plan/jobs";
import { writeup } from "../conversation-plan/prose-job";

import { broadcast } from "../wire";
import type { Server } from "bun";
import type { Question as Wire } from "@chopin/protocol";

import type { Plan } from "../plan/service";
import type { SocketData } from "../wire";

import type { Record } from "./records";

import { involved } from "./card-involved";
import type { CardEvent } from "./card-event";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations; import/export wrappers only.
const listeners = new WeakMap<Plan, Set<(event: CardEvent) => void>>();

export function listen(plan: Plan, listener: (event: CardEvent) => void): () => void {
	let set = listeners.get(plan);
	if (!set) listeners.set(plan, set = new Set());
	set.add(listener);
	return () => set.delete(listener);
}

export function emit(plan: Plan, event: CardEvent): void {
	for (let listener of listeners.get(plan) ?? []) {
		try {
			listener(event);
		} catch (err) {
			console.error("[questions] a card listener failed:", err);
		}
	}
}

export function pending(
	plan: Plan,
	record: Record,
	event: CardEvent,
	at = Math.floor(Date.now() / 1_000),
	text?: string,
) {
	return appendCardAction(plan.pendingCardActions, captureCardAction(record, event, at, text));
}

function cardStatus(record: Record): Wire.CardStatus {
	if (record.status === "answered") return "decided";
	if (record.status === "cancelled") return "discarded";
	return record.status;
}

export function meta(plan: Plan, record: Record): Wire.CardMeta {
	let prose = record.prose ?? [];
	let decided = record.status === "answered";
	let suggested = Store.get(plan.questions, record.id)?.suggested;
	let written = writeup(plan, record);
	return {
		status: cardStatus(record),
		origin: record.origin,
		...(record.threadId ? { thread: record.threadId } : {}),
		...(decided && record.owner ? { owner: record.owner } : {}),
		...(decided && record.decidedAt !== undefined ? { decidedAt: record.decidedAt } : {}),
		...(record.resolver ? { resolver: record.resolver } : {}),
		involved: involved(plan, record),
		...(suggested ? { suggested } : {}),
		history: record.history,
		optionOrigins: record.optionOrigins,
		refining: Jobs.refining(plan.conversationPlanJobs, record.id),
		hasProse: prose.length > 0 && !Prose.orphaned(prose),
		proseOrphaned: Prose.orphaned(prose),
		...(written ? { writeup: written } : {}),
	};
}

export function announce(plan: Plan, server: Server<SocketData>, roomId: string, id: string): void {
	let record = plan.records.get(id);
	if (record) {
		broadcast(server, roomId, { kind: "question:meta", ts: 0, id, meta: meta(plan, record) });
	}
}
