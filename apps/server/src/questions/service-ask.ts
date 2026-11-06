import type { Server } from "bun";
import type { Definition } from "@chopin/question";
import type { Plan } from "../plan/service";
import type { SocketData } from "../wire";
import type { Ended } from "./store";
import type { AskPlacement } from "./service-definition";
import * as Store from "./store";
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
	published?: (ids: string[]) => void,
): Promise<Ended[]> {
	if (signal?.aborted) return [];
	let asked = await publishQuestions(plan, server, roomId, definition, {
		placement,
		created,
		awaited: true,
	});
	published?.(asked.map(item => item.id));

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

/** What a decision ended as, when it is no longer open for a process to wait on. */
function endedWithout(plan: Plan, id: string): Ended {
	let closed = plan.questions.closed.get(id)?.result;
	if (closed) return closed;
	let record = plan.records.get(id);
	if (record?.status !== "answered") {
		return { status: "cancelled", resolver: record?.resolver ?? "system" };
	}
	let chosen = record.choices ?? [];
	return {
		status: "answered",
		resolver: record.resolver ?? record.owner ?? "system",
		answers: record.definition.questions.map(question => {
			let options = question.options.filter(option => chosen.includes(option.id));
			let written = record.answers?.[question.id];
			let custom = written !== undefined && written !== options.map(option =>
						option.label
					).join(", ")
				? written
				: undefined;
			return {
				question: question.id,
				choices: options.map(option => option.label),
				optionIds: options.map(option => option.id),
				...(custom === undefined ? {} : { custom }),
				...(record.marks ? { marks: record.marks } : {}),
			};
		}),
	};
}

/**
 * Waits again for decisions a process that has since restarted asked, for the client that asked
 * them and is coming back: answered ones end as they did, open ones wait on the members. An abort
 * withdraws the ones still open, as it does for `ask`.
 */
export async function rejoin(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ids: string[],
	signal?: AbortSignal,
): Promise<Ended[]> {
	let waiting = ids.map(id =>
		Store.rejoin(plan.questions, id) ?? Promise.resolve(endedWithout(plan, id))
	);
	let failed = Promise.withResolvers<never>();
	let closing: Promise<unknown> | undefined;
	let abort = () => {
		closing ??= Promise.all(ids.map(id => withdraw(plan, server, roomId, id, "chopin")));
		void closing.catch(failed.reject);
	};
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	try {
		let ended = await Promise.race([Promise.all(waiting), failed.promise]);
		await closing;
		return ended;
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}
