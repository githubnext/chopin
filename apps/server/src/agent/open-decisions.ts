import * as Questions from "../questions/service";
import { implementationActive } from "../plan/service";
import { openDecisions } from "./arguments";
import { documentView } from "./document-ops";

import type { ActiveOwnerBinding } from "./active-owner";
import type { DocumentRoom } from "./tools";

export async function capture(
	room: DocumentRoom,
	raw: unknown,
	abortSignal?: AbortSignal,
	owner?: Pick<ActiveOwnerBinding, "signal" | "revalidate">,
) {
	if (room.focusedChild?.() || room.plan.chat.actingChannel) {
		return { ok: false, reason: "child-decision-unavailable" };
	}
	if (implementationActive(room.plan)) return { ok: false, reason: "locked" };
	let signals = [abortSignal, owner?.signal, room.turnSignal?.()].filter(
		(signal): signal is AbortSignal => !!signal,
	);
	let signal = AbortSignal.any(signals);
	if (signal.aborted) throw new Error("Decision capture was interrupted.");
	if (owner && !await owner.revalidate()) throw new Error("Planner access could not be confirmed.");
	if (signal.aborted) throw new Error("Decision capture was interrupted.");
	let input = openDecisions(raw);
	let result = await Questions.captureDecisions(room.plan, room.server, room.id, input, signal);
	room.anchors();
	return { ...result, current_plan: await documentView(room.plan) };
}
