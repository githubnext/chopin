import { spyOn } from "bun:test";

import type { Chat as Wire } from "@chopin/protocol";

import type { JevAnswer, JevRequest, JevResult } from "../conversation-plan/jev";
import type { Socket } from "../wire";
import { installInitiativeCleanup } from "./initiative.test-fixtures";
import { until } from "./job.test-fixtures";
import { createResponder } from "./reaction-reply";
import { react } from "./reactions";
import * as Chat from "./service";
import { respond } from "./reaction-reply";

export function agentEntry(id: string, text: string, extra: object = {}): Wire.Entry {
	return { id, author: { kind: "agent" }, text, ts: 2, ...extra } as Wire.Entry;
}

export function scripted(
	scores?: { intent: string; probability: number; confidence: number; noul: number },
) {
	let requests: JevRequest[] = [];
	let decide = async (request: JevRequest): Promise<JevResult> => {
		requests.push(request);
		let answers: Record<string, JevAnswer> = {};
		for (let key of Object.keys(request.questions)) {
			if (key === "input") answers.input = { type: "noul", noul: 0 };
			if (!key.startsWith("intent:")) continue;
			let id = key.slice("intent:".length);
			let { intent, probability, confidence, noul } = scores
				?? { intent: "confused", probability: 0.9, confidence: 0.88, noul: 0.95 };
			let rest = (1 - probability) / 5;
			answers[key] = {
				type: "choice",
				choice: intent,
				confidence,
				probabilities: Object.fromEntries(
					["confused", "disagree", "approve", "ack", "more", "none"].map(name => [
						name,
						name === intent ? probability : rest,
					]),
				),
			};
			answers[`reply:${id}`] = { type: "noul", noul };
		}
		return {
			model: "fake/classifier",
			answers,
			latencyMs: 1,
			usage: { input_tokens: 1, output_tokens: 1 },
		};
	};
	return { decide, requests };
}

export function installReactionFixtures() {
	let setup = installInitiativeCleanup();
	async function room(options: { decide?: boolean; scores?: Parameters<typeof scripted>[0] } = {}) {
		let h = await setup.harness();
		h.chat.entries.push(
			{
				id: "m0",
				author: { kind: "member", handle: "ana" },
				text: "Plan the harp rollout.",
				ts: 1,
			},
			agentEntry("a1", "I proposed three phases."),
			{ id: "s1", author: { kind: "system" }, text: "ana asked Chopin to draft.", ts: 3 },
		);
		let classifier = scripted(options.scores);
		if (options.decide !== false) h.context.decide = classifier.decide;
		let saved: string[] = [];
		h.context.persist = async () => {
			saved.push(JSON.stringify(h.chat.entries));
		};
		h.chat.reactions = createResponder({ clock: h.clock });
		let claims = spyOn(h.context.auth.storage.channels, "claimAgentOwner");
		return { ...h, requests: classifier.requests, saved, claims };
	}

	return { room };
}

export type Room = Awaited<
	ReturnType<ReturnType<typeof installReactionFixtures>["room"]>
>;

export function person(handle: string): Socket {
	return {
		data: {
			handle,
			principalId: `U_${handle}`,
			sessionId: "session",
			client: `${handle}-tab`,
			canEdit: true,
		},
		send() {},
	} as unknown as Socket;
}

export async function reactAs(h: Room, handle: string, emoji: string, on = true, id = "a1") {
	await react(
		h.context,
		person(handle),
		{ kind: "chat:react", rid: crypto.randomUUID(), ts: 0, id, emoji, on },
		reacted => respond(h.context, reacted),
	);
}

export async function finishTurn(h: Room, text = "Here is another way to see it.") {
	let running = h.chat.turn?.id;
	h.emit("assistant.message_delta", { messageId: `turn-${running}`, deltaContent: text });
	h.emit("assistant.message", { messageId: `turn-${running}` });
	h.emit("session.idle");
	await until(() => !h.chat.busy || h.chat.turn?.id !== running);
}

export const entryA1 = (h: Room) =>
	h.chat.entries.find(entry => entry.id === "a1")! as Wire.Entry & {
		answeredIntents?: string[];
	};

export async function planner(h: Room) {
	await Chat.send(h.context, person("ana"), {
		kind: "chat:send",
		rid: crypto.randomUUID(),
		ts: 0,
		requestId: crypto.randomUUID(),
		to: "planner",
		text: "Keep going.",
	});
	await until(() => h.prompts.length === 1);
}

export function fillers(count: number, from = 0) {
	return Array.from({ length: count }, (_, index) => ({
		id: `filler-${from + index}`,
		handle: "ana",
		text: "queued",
	})) as unknown as Chat.Chat["waiting"];
}
