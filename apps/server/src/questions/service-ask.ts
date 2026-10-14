import type { Server } from "bun";
import type { Definition } from "@chopin/question";
import type { Plan } from "../plan/service";
import type { SocketData } from "../wire";
import type { Ended } from "./store";
import type { AskPlacement } from "./service-definition";
import { withdraw } from "./service-cancel";
import { type AskNear, publishQuestions } from "./service-publish";

export type { AskNear } from "./service-publish";

/**
 * Ask each decision independently; register its record before publishing its node.
 *
 * The cards wait until members answer them, however long that takes; an abort
 * withdraws the ones still open.
 */
export async function ask(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	definition: Definition,
	placement?: AskPlacement | AskNear,
	created?: () => void,
	signal?: AbortSignal,
): Promise<Ended[]> {
	if (signal?.aborted) return [];
	let asked = await publishQuestions(plan, server, roomId, definition, { placement, created });

	let failed = Promise.withResolvers<never>();
	let closing: Promise<unknown> | undefined;
	let abort = () => {
		closing ??= Promise.all(
			asked.map(item => withdraw(plan, server, roomId, item.id, "chopin")),
		);
		void closing.catch(failed.reject);
	};
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	try {
		let ended = await Promise.race([Promise.all(asked.map(item => item.waiting)), failed.promise]);
		await closing;
		return ended;
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}
