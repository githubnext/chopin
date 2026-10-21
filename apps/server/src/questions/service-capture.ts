import { createHash } from "node:crypto";
import * as Question from "@chopin/question";
import type { Server } from "bun";
import type { Question as Wire, Request } from "@chopin/protocol";
import type { Plan } from "../plan/service";
import type { PositionedQuestion } from "../agent/arguments";
import type { Record } from "./record-types";
import type { Socket, SocketData } from "../wire";
import { fail, reply } from "../wire";
import { identify } from "./service-definition";
import { publishQuestions } from "./service-publish";

type Input = {
	key: string;
	question: string;
	description?: string;
	/** The block the Planner's question concerns, from its latest read of the document. */
	block?: { index: number; digest: string };
};

export type CaptureDecisionsInput = {
	revision: number;
	questions: Array<PositionedQuestion & { key: string }>;
};
export type CaptureDecisionsResult = {
	revision: number;
	decisions: Array<{ key: string; id: string; status: Record["status"] }>;
};

/** A request owns one card across retries, including after reconnect or restart. */
function identity(room: string, actor: string, key: string): string {
	let hash = createHash("sha256").update(JSON.stringify(["decision", room, actor, key]))
		.digest("hex").slice(0, 32);
	let value = BigInt(`0x${hash}`);
	let id = "";
	for (let index = 0; index < 26; index++) {
		id = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Number(value & 31n)] + id;
		value >>= 5n;
	}
	return id;
}

/** Capture a human choice still to make; only human submission can decide it. */
export async function capture(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	input: Input,
	actor: { human: string } | { revision: number },
): Promise<string> {
	if (typeof input.key !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(input.key)) {
		Question.reject("Decision request key is invalid");
	}
	if ("revision" in actor && (!Number.isSafeInteger(actor.revision) || actor.revision < 0)) {
		Question.reject("Document revision is invalid");
	}
	let definition = identify({
		questions: [{
			header: "Decision",
			question: input.question,
			...(input.description === undefined ? {} : { description: input.description }),
			response: "text",
			multiple: false,
			options: [],
		}],
	});
	let id = identity(plan.id, "human" in actor ? `human:${actor.human}` : "planner", input.key);
	await publishQuestions(plan, server, roomId, definition, {
		identity: id,
		...("human" in actor
			? { origin: "human", by: actor.human }
			: {
				revision: actor.revision,
				section: true,
				...(input.block ? { placement: { near: input.block } } : {}),
			}),
	});
	return id;
}

/** Publish independent anchored decisions together, without retaining a turn waiting on them. */
export async function captureDecisions(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	input: CaptureDecisionsInput,
	signal?: AbortSignal,
): Promise<CaptureDecisionsResult> {
	if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
		Question.reject("Document revision is invalid");
	}
	if (
		!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 10
	) {
		Question.reject("Capture between one and ten decisions");
	}
	let keys = new Set<string>();
	for (let question of input.questions) {
		if (
			typeof question.key !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(question.key)
			|| keys.has(question.key)
		) {
			Question.reject("Decision request keys must be valid and unique");
		}
		keys.add(question.key);
	}
	let definition = identify({
		questions: input.questions.map(({ key: _key, blocks: _blocks, ...question }) => question),
	});
	let identities = input.questions.map(question => identity(plan.id, "planner", question.key));
	await publishQuestions(plan, server, roomId, definition, {
		placement: {
			revision: input.revision,
			blocks: input.questions.map(question => question.blocks),
		},
		revision: input.revision,
		capture: { identities, signal },
	});
	return {
		revision: plan.revision,
		decisions: input.questions.map((question, index) => {
			let id = identities[index]!;
			return { key: question.key, id, status: plan.records.get(id)!.status };
		}),
	};
}

export async function createDecision(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.Create.Ask>,
): Promise<void> {
	try {
		let id = await capture(plan, server, roomId, msg, { human: ws.data.handle });
		reply(ws, msg.rid, { kind: "question:create", ts: 0, ok: true, id });
	} catch (error) {
		if (
			error instanceof Question.QuestionError || error instanceof Error
				&& error.message === "implementation is active"
		) {
			reply(ws, msg.rid, {
				kind: "question:create",
				ts: 0,
				ok: false,
				reason: error instanceof Question.QuestionError ? "invalid" : "implementation",
				message: error.message,
			});
		} else fail(ws, msg.rid, "Could not create the decision. Try again.");
	}
}
