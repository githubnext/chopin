import type { Server } from "bun";
import type { Definition } from "@chopin/question";
import type { Plan } from "../plan/service";
import type { SocketData } from "../wire";
import type { Ended } from "./store";
import type { AskPlacement } from "./service-definition";
import { expire, withdraw } from "./service-cancel";
import { publishQuestions } from "./service-publish";

/**
 * Ask each decision independently; register its record before publishing its node.
 *
 * An abort withdraws the cards still open. After `expiresInMs` without an answer
 * they expire instead, and stay in the document marked as such.
 */
export async function ask(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	definition: Definition,
	placement?: AskPlacement,
	created?: () => void,
	signal?: AbortSignal,
	expiresInMs?: number,
): Promise<Ended[]> {
	if (signal?.aborted) return [];
	let asked = await publishQuestions(plan, server, roomId, definition, { placement, created });

	let failed = Promise.withResolvers<never>();
	let closing: Promise<unknown> | undefined;
	let close = (status: "cancelled" | "expired") => {
		closing ??= Promise.all(
			asked.map(item =>
				status === "expired"
					? expire(plan, server, roomId, item.id)
					: withdraw(plan, server, roomId, item.id, "chopin")
			),
		);
		void closing.catch(failed.reject);
	};
	let abort = () => close("cancelled");
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	let timer = expiresInMs === undefined
		? undefined
		: setTimeout(() => close("expired"), expiresInMs);
	try {
		let ended = await Promise.race([Promise.all(asked.map(item => item.waiting)), failed.promise]);
		await closing;
		return ended;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}
