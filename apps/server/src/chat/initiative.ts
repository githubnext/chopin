import type { Chat as Wire, Request } from "@chopin/protocol";
import type { Socket } from "../wire";
import { fail } from "../wire";
import * as Service from "../plan/service";
import { project } from "../plan/room";
import { instruct, jobReady, type Room } from "./service";
import { initiativeInstruction, judgeInitiative } from "./initiative-judge";
import { createInitiativeSchedule } from "./initiative-schedule";

export function actor(ws: Socket): string {
	return ws.data.actor ? `${ws.data.principalId}:${ws.data.actor.id}` : ws.data.principalId;
}

export type Source = {
	context: Room;
	id: string;
	actor: string;
	sessionId: string;
	focus?: string;
	reviewed?: { revision: number; entry: Wire.Entry | undefined };
};

export function participation(context: Room): Wire.Participation {
	return {
		enabled: !!context.config.agent && !context.rootChannelId,
		// Automatic participation is always on; a pause saved by the retired toggle is ignored.
		paused: false,
	};
}

function available(source: Source): "ready" | "wait" | "drop" {
	let { context } = source;
	let { chat } = context;
	if (
		!participation(context).enabled || chat.closed
		|| !context.initiativePresent?.(source.sessionId, source.actor)
		|| chat.entries.findLast(entry =>
				entry.author.kind === "member"
				|| (entry.author.kind === "agent" && !!entry.text.trim())
			)?.id !== source.id
		|| Service.implementationActive(context.plan)
		|| chat.runs?.some(run => ["running", "waiting", "paused"].includes(run.status))
	) return "drop";
	return chat.busy || chat.pendingSends > 0 || chat.waiting.length > 0 ? "wait" : "ready";
}

export function initiative(context: Room) {
	let { chat } = context;
	if (chat.initiative) return chat.initiative;
	if (!participation(context).enabled) return;
	chat.initiative = createInitiativeSchedule<Source>({
		paused: false,
		groupMs: context.config.conversationInitiativeSilenceMs,
		admit: available,
		async judge(source, signal, turn) {
			let { context } = source;
			if (
				!await context.initiativeAuthorize?.(source.sessionId, source.actor)
				|| signal.aborted || !await jobReady(context, source.sessionId) || signal.aborted
			) return;
			source.reviewed = {
				revision: context.plan.revision,
				entry: context.chat.entries.findLast(entry => entry.author.kind !== "system"),
			};
			return judgeInitiative({
				sourceId: source.id,
				turn: { ...turn, focused: !!source.focus },
				messages: context.chat.entries.flatMap(entry =>
					entry.author.kind === "system" ? [] : [{
						id: entry.id,
						author: entry.author.kind,
						...(entry.author.kind === "member" ? { handle: entry.author.handle } : {}),
						text: entry.text,
					}]
				),
				document: project(context.plan.document),
				unanswered: [...context.plan.records.values()].flatMap(record =>
					record.status === "open" || record.status === "reopened"
						? record.definition.questions.map(question => ({ question: question.question }))
						: []
				),
			}, {
				decide: context.decide,
				model: context.config.conversationInitiativeModel,
				signal,
			});
		},
		async dispatch(source, move, signal, lifecycle) {
			if (!move || signal.aborted || (source.focus && move !== "direct")) return true;
			let { context } = source;
			let { chat } = context;
			let ended!: () => void;
			let finished = new Promise<void>(resolve => ended = resolve);
			let started = false;
			let unavailable = false;
			let fresh = () =>
				source.reviewed?.revision === context.plan.revision
				&& source.reviewed.entry === chat.entries.findLast(entry => entry.author.kind !== "system");
			let accept = async () => {
				if (signal.aborted || available(source) !== "ready" || !fresh()) return;
				let child = source.focus ? await context.children?.resolve(source.focus) : undefined;
				if (source.focus && !child) {
					unavailable = true;
					return;
				}
				if (!await context.initiativeAuthorize?.(source.sessionId, source.actor)) return;
				if (signal.aborted || !await jobReady(context, source.sessionId)) return;
				if (signal.aborted || available(source) !== "ready" || !fresh()) return;
				started = true;
				await instruct(
					context,
					"Chopin",
					initiativeInstruction(move, source.id),
					"",
					{
						signal,
						...(child ? { focus: { channelId: child.id, title: child.title } } : {}),
						spent: () => !lifecycle.current() || !fresh() || available(source) === "drop",
						started: lifecycle.started,
						ended,
					},
				);
			};
			// The saved source and this admission use the same FIFO as explicit messages.
			let accepted = chat.sending.then(accept, accept);
			chat.sending = accepted.then(() => {}, () => {});
			await accepted;
			if (started) await finished;
			return started || unavailable || signal.aborted || available(source) === "drop";
		},
	});
	return chat.initiative;
}

/** Only newly committed room messages reach here. Delivery replay and agent text never do. */
export function contributed(context: Room, ws: Socket, entry: Wire.Entry, focus?: string) {
	if (!context.claimantSessionId) return;
	let scheduler = initiative(context);
	if (!scheduler) return;
	let author = actor(ws);
	scheduler.typing(ws.data.client, author, false);
	scheduler.receive({
		id: entry.id,
		actor: author,
		value: { context, id: entry.id, actor: author, sessionId: context.claimantSessionId, focus },
	});
}

/** Automatic participation cannot be paused; old clients that still ask are refused. */
export function setParticipation(
	_context: Room,
	ws: Socket,
	message: Request<Wire.SetParticipation>,
) {
	fail(ws, message.rid, "automatic participation cannot be paused");
}
