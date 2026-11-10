/**
 * A document's Planner model and thinking level: what the room can choose from, what it chose,
 * and what a turn runs. The harness (or the attached client) owns the catalog; the room owns the
 * choice, stored once per document so everyone sees the same one.
 */

import { refusedChoice, resolveChoice, unavailableNotice } from "@chopin/protocol/model-choice";

import { broadcast, fail, reply } from "../wire";

import type { Chat as Wire, Request } from "@chopin/protocol";
import type { Server, ServerWebSocket } from "bun";
import type { Lease } from "../storage/model";
import type { StorageAdapter } from "../storage/port";
import type { SocketData } from "../wire";

export type ModelChoiceDeps = {
	/** What the document's harness can be set to run now; none where it offers no choice. */
	catalog: (channelId: string) => Promise<Wire.ModelCatalog | undefined>;
	storage: Pick<StorageAdapter, "plannerModelChoices">;
	lease: () => Lease;
	now?: () => Date;
};

/** What a turn runs, and the words for a choice it could not honour. */
export type TurnModel = { model?: string; thinkingLevel?: string; notice?: string };

async function stored(
	deps: ModelChoiceDeps,
	channelId: string,
): Promise<Wire.ModelChoice | undefined> {
	let row = await deps.storage.plannerModelChoices.get(channelId);
	if (!row) return undefined;
	return {
		...(row.model !== undefined ? { model: row.model } : {}),
		...(row.thinkingLevel !== undefined ? { thinkingLevel: row.thinkingLevel } : {}),
	};
}

/** The room's model state: the catalog and the stored choice, whether or not the catalog honours it. */
export async function modelState(
	deps: ModelChoiceDeps,
	channelId: string,
): Promise<Wire.ModelState> {
	let [catalog, choice] = await Promise.all([deps.catalog(channelId), stored(deps, channelId)]);
	return {
		kind: "chat:model",
		ts: 0,
		...(catalog ? { catalog } : {}),
		...(choice ? { choice } : {}),
	};
}

/**
 * What the next turn runs: the stored choice checked against the catalog as it is now. A model or
 * level the catalog no longer offers is left out, the harness's default runs, and `notice` says so.
 */
export async function turnModel(deps: ModelChoiceDeps, channelId: string): Promise<TurnModel> {
	let [catalog, choice] = await Promise.all([deps.catalog(channelId), stored(deps, channelId)]);
	let resolved = resolveChoice(catalog, choice);
	return {
		...(resolved.model !== undefined ? { model: resolved.model } : {}),
		...(resolved.thinkingLevel !== undefined ? { thinkingLevel: resolved.thinkingLevel } : {}),
		...(resolved.unavailable ? { notice: unavailableNotice(catalog, resolved.unavailable) } : {}),
	};
}

/** The fields of a request that are a choice: a field that is not a non-empty string is no choice. */
function requested(frame: Wire.SetModel): Wire.ModelChoice | undefined {
	let { model, thinkingLevel } = frame;
	for (let value of [model, thinkingLevel]) {
		if (value !== undefined && (typeof value !== "string" || value === "" || value.length > 256)) {
			return undefined;
		}
	}
	return {
		...(model !== undefined ? { model } : {}),
		...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
	};
}

/** Sets run one at a time per document, so the room hears the choices in the order they were stored. */
let queues = new Map<string, Promise<unknown>>();

/**
 * Chooses a document's model and thinking level. The catalog reported now must offer the choice;
 * it is stored under the writer lease, and only then answered and broadcast to the room.
 */
export function chooseModel(
	deps: ModelChoiceDeps,
	context: {
		server: Server<SocketData>;
		ws: Pick<ServerWebSocket<unknown>, "send">;
		channelId: string;
		userId: string;
		/** A child document has no Chat, so its root's choice is the only one. */
		child: boolean;
	},
	frame: Request<Wire.SetModel>,
): Promise<void> {
	let run = async () => {
		let { ws, channelId } = context;
		let choice = requested(frame);
		if (!choice) return fail(ws, frame.rid, "That is not a model choice.");
		if (context.child) return fail(ws, frame.rid, "A child document uses its parent's model.");
		let catalog = await deps.catalog(channelId);
		let refusal = refusedChoice(catalog, choice);
		if (refusal) return fail(ws, frame.rid, refusal);
		await deps.storage.plannerModelChoices.put(deps.lease(), {
			channelId,
			...choice,
			userId: context.userId,
			updatedAt: (deps.now ?? (() => new Date()))(),
		});
		let state = await modelState(deps, channelId);
		reply(ws, frame.rid, state);
		broadcast(context.server, channelId, state);
	};
	let previous = queues.get(context.channelId) ?? Promise.resolve();
	let next = previous.then(run, run).catch(error => {
		console.error("[chat] could not save a model choice:", error);
		fail(
			context.ws,
			frame.rid,
			"Couldn't save the model choice. Try again.",
			"temporarily-unavailable",
		);
	});
	queues.set(context.channelId, next);
	void next.finally(() => {
		if (queues.get(context.channelId) === next) queues.delete(context.channelId);
	});
	return next;
}
