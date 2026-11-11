/**
 * A document's Planner model and thinking level: what the room can choose from, what it chose,
 * and what a turn runs. The harness (or the attached client) owns the catalog; the room owns the
 * choice, stored once per document so everyone sees the same one.
 */

import {
	catalogModel,
	modelReadsImages,
	refusedChoice,
	resolveChoice,
	unavailableNotice,
} from "@chopin/protocol/model-choice";

import { broadcast, fail, reply } from "../wire";

import type { Chat as Wire, Request } from "@chopin/protocol";
import type { Server, ServerWebSocket } from "bun";
import type { Lease } from "../storage/model";
import type { StorageAdapter } from "../storage/port";
import type { SocketData } from "../wire";

export type ModelChoiceDeps = {
	/** What the document's harness can be set to run now; none where it offers no choice. */
	catalog: (channelId: string) => Promise<Wire.ModelCatalog | undefined>;
	/**
	 * The commands the document's harness offers beyond Chopin's own, read each time: a remote
	 * Planner's are its attached client's alone, so none outlive that client. Absent means none.
	 */
	commands?: (channelId: string) => Promise<Wire.CommandOption[] | undefined>;
	/**
	 * Whether what the harness offers is known now, which may be nothing: false while a remote
	 * Planner has no client to ask, or one that has yet to report. The stored choice is then not
	 * told to the room with no catalog, since it is neither gone nor honored. Absent means known.
	 */
	known?: (channelId: string) => boolean;
	/**
	 * A turn fell back on a saved choice with no catalog to check it against while `known` was
	 * false: the harness is to treat what it offers as known (nothing), and the room is to be told
	 * the choice, since what the turn did is now a fact. Called once per such turn.
	 */
	fellBack?: (channelId: string) => void;
	storage: Pick<StorageAdapter, "plannerModelChoices">;
	lease: () => Lease;
	now?: () => Date;
};

/** What a turn runs, and the words for a choice it could not honour. */
export type TurnModel = { model?: string; thinkingLevel?: string; notice?: string };

async function stored(
	deps: ModelChoiceDeps,
	channelId: string,
): Promise<{ choice?: Wire.ModelChoice; modelName?: string }> {
	let row = await deps.storage.plannerModelChoices.get(channelId);
	if (!row) return {};
	return {
		choice: {
			...(row.model !== undefined ? { model: row.model } : {}),
			...(row.thinkingLevel !== undefined ? { thinkingLevel: row.thinkingLevel } : {}),
		},
		...(row.modelName ? { modelName: row.modelName } : {}),
	};
}

/**
 * The room's model state: the catalog and the stored choice, whether or not the catalog honours it.
 * Where the harness offers nothing, the choice is still told, so the composer can say it fell back
 * to the default, but not while what the harness offers is unknown (`known`).
 */
export async function modelState(
	deps: ModelChoiceDeps,
	channelId: string,
): Promise<Wire.ModelState> {
	let [catalog, saved, commands] = await Promise.all([
		deps.catalog(channelId),
		stored(deps, channelId),
		// Commands are an extra: a harness that cannot list them never stops the model state.
		deps.commands?.(channelId).catch((error): undefined => {
			console.error("[chat] could not read the document's commands:", error);
			return undefined;
		}),
	]);
	let told = saved.choice && (catalog || (deps.known?.(channelId) ?? true));
	return {
		kind: "chat:model",
		ts: 0,
		...(catalog ? { catalog } : {}),
		...(told
			? { choice: saved.choice, ...(saved.modelName ? { modelName: saved.modelName } : {}) }
			: {}),
		...(commands?.length ? { commands } : {}),
	};
}

/**
 * What the next turn runs: the stored choice checked against the catalog as it is now. A model or
 * level the catalog no longer offers is left out, the harness's default runs, and `notice` says so.
 */
export async function turnModel(deps: ModelChoiceDeps, channelId: string): Promise<TurnModel> {
	let [catalog, saved] = await Promise.all([deps.catalog(channelId), stored(deps, channelId)]);
	let resolved = resolveChoice(catalog, saved.choice);
	// The turn runs the default for a choice nothing could check, where the harness had not yet said
	// what it offers: from now on that is known, and the composer is told what the turn did.
	if (resolved.unavailable && !catalog && deps.known?.(channelId) === false) {
		deps.fellBack?.(channelId);
	}
	return {
		...(resolved.model !== undefined ? { model: resolved.model } : {}),
		...(resolved.thinkingLevel !== undefined ? { thinkingLevel: resolved.thinkingLevel } : {}),
		...(resolved.unavailable
			? { notice: unavailableNotice(catalog, resolved.unavailable, saved.modelName) }
			: {}),
	};
}

/**
 * Whether the model the next turn would run reads images: the stored choice, checked against the
 * catalog as it is now, or the harness's default. False where no catalog says so.
 */
export async function turnReadsImages(deps: ModelChoiceDeps, channelId: string): Promise<boolean> {
	let [catalog, saved] = await Promise.all([deps.catalog(channelId), stored(deps, channelId)]);
	return modelReadsImages(catalog, saved.choice);
}

/**
 * The fields of a request that are a choice: a string is one, whatever it holds, and a field of
 * any other type is no choice. Only the catalog says what is offered (`refusedChoice`), so a model
 * or level it lists is chosen as it was written, however it is spelled or how long it is.
 */
function requested(frame: Wire.SetModel): Wire.ModelChoice | undefined {
	let { model, thinkingLevel } = frame;
	for (let value of [model, thinkingLevel]) {
		if (value !== undefined && typeof value !== "string") return undefined;
	}
	return {
		...(model !== undefined ? { model } : {}),
		...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
	};
}

/**
 * Everything that tells a document's room its model state runs one at a time, in the order it was
 * asked: a choice (store, then tell), an announcement that the catalog changed, and the state sent
 * to a person who joins. The state is read inside its turn, so what a turn tells is never older
 * than a choice stored before it, and a read that began before a choice was stored cannot answer
 * after the room heard it. A turn that fails does not hold up the ones behind it.
 */
let queues = new Map<string, Promise<unknown>>();

function inOrder<T>(channelId: string, run: () => Promise<T>): Promise<T> {
	let previous = queues.get(channelId) ?? Promise.resolve();
	let result = previous.then(run);
	let settled = result.then(() => {}, () => {});
	queues.set(channelId, settled);
	void settled.then(() => {
		if (queues.get(channelId) === settled) queues.delete(channelId);
	});
	return result;
}

/**
 * Reads the document's model state when it is this call's turn and gives it to `deliver`, which
 * tells the room, or the one person who joined. Rejects if the state cannot be read.
 */
export function publishModelState(
	deps: ModelChoiceDeps,
	channelId: string,
	deliver: (state: Wire.ModelState) => void,
): Promise<void> {
	return inOrder(channelId, async () => deliver(await modelState(deps, channelId)));
}

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
	return inOrder(context.channelId, async () => {
		try {
			let { ws, channelId } = context;
			let choice = requested(frame);
			if (!choice) return fail(ws, frame.rid, "That is not a model choice.");
			if (context.child) return fail(ws, frame.rid, "A child document uses its parent's model.");
			let catalog = await deps.catalog(channelId);
			let refusal = refusedChoice(catalog, choice);
			if (refusal) return fail(ws, frame.rid, refusal);
			let modelName = catalogModel(catalog, choice.model)?.name;
			await deps.storage.plannerModelChoices.put(deps.lease(), {
				channelId,
				...choice,
				...(modelName ? { modelName } : {}),
				userId: context.userId,
				updatedAt: (deps.now ?? (() => new Date()))(),
			});
			let state = await modelState(deps, channelId);
			reply(ws, frame.rid, state);
			broadcast(context.server, channelId, state);
		} catch (error) {
			console.error("[chat] could not save a model choice:", error);
			fail(
				context.ws,
				frame.rid,
				"Couldn't save the model choice. Try again.",
				"temporarily-unavailable",
			);
		}
	});
}
