import { Visual } from "@chopin/question";
import type { VisualDecision } from "@chopin/protocol";
import * as Service from "../plan/service";
import { fail, reply } from "../wire";
import type { Socket } from "../wire";
import * as State from "./state";
import { changed, claimed, fields, queued, writable } from "./common";
import type { Input, Lifecycle } from "./common";

export async function open(
	plan: Service.Plan,
	ws: Socket,
	msg: Input<"visual-decision:open">,
	lifecycle?: Lifecycle,
): Promise<void> {
	try {
		fields(msg, ["id"]);
		let id = Visual.id(msg.id);
		await queued(plan, async () => {
			let stored = plan.visualDecisions.get(id);
			reply(
				ws,
				msg.rid,
				stored
					? { kind: msg.kind, ts: 0, ok: true, state: State.snapshot(stored) }
					: {
						kind: msg.kind,
						ts: 0,
						ok: false,
						reason: "invalid",
						message: "Visual decision is unavailable",
					},
			);
		}, lifecycle);
	} catch (error) {
		fail(ws, msg.rid, error instanceof Error ? error.message : "Could not open visual decision");
	}
}

export async function edit(
	plan: Service.Plan,
	ws: Socket,
	msg: Input<"visual-decision:edit">,
	lifecycle?: Lifecycle,
): Promise<void> {
	try {
		fields(msg, ["id", "key", "patch"]);
		let id = Visual.id(msg.id);
		let key = State.editKey(msg.key);
		let patch = Visual.patch(msg.patch);
		writable(plan, ws);
		let before = plan.visualDecisions.get(id);
		if (claimed(plan).has(id) && before) {
			reply(ws, msg.rid, {
				kind: msg.kind,
				ts: 0,
				ok: false,
				reason: "saving",
				state: State.snapshot(before),
			});
			return;
		}
		let result: VisualDecision.Result | undefined;
		let accepted = false;
		await queued(plan, async () => {
			writable(plan, ws);
			let stored = plan.visualDecisions.get(id);
			if (!stored) throw new Error("Visual decision is unavailable");
			let state = State.snapshot(stored);
			if (key.sequence <= (stored.edits[key.client] ?? 0)) {
				result = { ok: true, state };
				return;
			}
			if (stored.saved || claimed(plan).has(id)) {
				result = { ok: false, reason: stored.saved ? "saved" : "saving", state };
				return;
			}
			if (
				!Object.hasOwn(stored.edits, key.client)
				&& Object.keys(stored.edits).length >= State.MAX_CLIENTS
			) {
				throw new Error("This visual decision has reached its collaborator session limit");
			}
			let values = Visual.apply(stored.values, patch);
			let moved = JSON.stringify(values) !== JSON.stringify(stored.values);
			let next: State.Stored = {
				...stored,
				values,
				revision: stored.revision + (moved ? 1 : 0),
				edits: { ...stored.edits, [key.client]: key.sequence },
			};
			await Service.publishStaged(
				plan,
				plan.server,
				plan.id,
				{
					...plan,
					visualDecisions: new Map(plan.visualDecisions).set(id, next),
				},
				undefined,
				{ retryRejectedCommit: true },
			);
			result = { ok: true, state: State.snapshot(next) };
			accepted = moved;
		}, lifecycle);
		reply(ws, msg.rid, { kind: msg.kind, ts: 0, ...result! });
		if (accepted && result?.ok) changed(plan, result.state);
	} catch (error) {
		fail(ws, msg.rid, error instanceof Error ? error.message : "Could not save visual draft");
	}
}
