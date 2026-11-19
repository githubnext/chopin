/**
 * A person with no AI account chopin can use is told so before their message starts a turn: the
 * message is refused with its own code, nothing is saved or shown to the room, and no turn starts.
 */
import { expect, test } from "bun:test";

import * as Chat from "./service";
import { harness, installJobCleanup, member, until } from "./job.test-fixtures";

import type { Chat as Wire, Request } from "@chopin/protocol";
import type { AiAccountRefusal } from "../ai/account-check";
import type { Socket } from "../wire";

installJobCleanup();

type Frame = { kind: string; [key: string]: unknown };

const NO_ACCOUNT: AiAccountRefusal = {
	message:
		"chopin needs an AI account to answer, so this message wasn't sent. Add one, then send it again.",
	code: "no-ai-account",
};

function speaking(handle: string, frames: Frame[] = []): Socket {
	return {
		data: { handle, principalId: `U_${handle}`, client: `${handle}-tab`, canEdit: true },
		send: (raw: string) => frames.push(JSON.parse(raw) as Frame),
	} as unknown as Socket;
}

function retrying(message: string): Request<Wire.Retry> {
	return { kind: "chat:retry", rid: crypto.randomUUID(), ts: 0, message };
}

/** A harness whose sender's AI accounts are what `accounts` says for each person asked about. */
function withAccounts(accounts: (userId: string) => AiAccountRefusal | undefined) {
	let h = harness();
	let asked: string[] = [];
	h.context.aiAccount = async userId => {
		asked.push(userId);
		return accounts(userId);
	};
	return { ...h, asked };
}

test("a message to chopin from someone with no AI account is refused with its code, saved nowhere and starts no turn", async () => {
	let h = withAccounts(() => NO_ACCOUNT);
	let frames: Frame[] = [];
	await Chat.send(h.context, speaking("ana", frames), member("@chopin outline the rollout"));
	expect(frames).toEqual([
		expect.objectContaining({
			kind: "session:error",
			message: NO_ACCOUNT.message,
			code: "no-ai-account",
		}),
	]);
	expect(h.asked).toEqual(["U_ana"]);
	expect(h.chat.entries).toEqual([]);
	expect(h.frames.filter(frame => frame.kind === "chat:message")).toEqual([]);
	expect(h.prompts).toEqual([]);
	expect(h.chat.busy).toBe(false);
});

test("a message to the room is not checked: only work for chopin needs an AI account", async () => {
	let h = withAccounts(() => NO_ACCOUNT);
	let frames: Frame[] = [];
	await Chat.send(h.context, speaking("ana", frames), { ...member("lunch?"), to: "room" });
	expect(frames).toEqual([expect.objectContaining({ kind: "chat:send" })]);
	expect(h.asked).toEqual([]);
	expect(h.chat.entries.map(entry => entry.text)).toEqual(["lunch?"]);
});

test("accounts that could not be read just now are a passing refusal, and the same message is taken once they can", async () => {
	let refusal: AiAccountRefusal | undefined = {
		message: "chopin couldn't read your AI accounts just now.",
		code: "temporarily-unavailable",
	};
	let h = withAccounts(() => refusal);
	let ask = member("@chopin outline the rollout");
	let frames: Frame[] = [];
	await Chat.send(h.context, speaking("ana", frames), ask);
	expect(frames.at(-1)).toMatchObject({ kind: "session:error", code: "temporarily-unavailable" });
	expect(h.chat.entries).toEqual([]);

	refusal = undefined;
	await Chat.send(h.context, speaking("ana", frames), { ...ask, rid: crypto.randomUUID() });
	expect(frames.at(-1)).toMatchObject({ kind: "chat:send", id: ask.requestId });
	await until(() => h.prompts.length === 1);
	expect(h.chat.entries.map(entry => entry.id)).toEqual([ask.requestId]);
});

test("each sender's own AI accounts decide: one person's refusal does not refuse another", async () => {
	let h = withAccounts(userId => userId === "U_ana" ? NO_ACCOUNT : undefined);
	let ana: Frame[] = [];
	await Chat.send(h.context, speaking("ana", ana), member("@chopin outline it"));
	expect(ana.at(-1)).toMatchObject({ code: "no-ai-account" });
	let bo: Frame[] = [];
	await Chat.send(h.context, speaking("bo", bo), member("@chopin outline it"));
	expect(bo.at(-1)).toMatchObject({ kind: "chat:send" });
	await until(() => h.prompts.length === 1);
	expect(h.asked).toEqual(["U_ana", "U_bo"]);
});

test("a Retry from someone who has no AI account now is refused with the same code, and the failure stays", async () => {
	let account: AiAccountRefusal | undefined;
	let h = withAccounts(() => account);
	let ask = member("@chopin outline it");
	await Chat.send(h.context, speaking("ana"), ask);
	await until(() => h.prompts.length === 1);
	h.emit("session.error", { message: "503 Service Unavailable" });
	await until(() => !h.chat.busy);
	let before = h.chat.entries.map(entry => entry.id);

	account = NO_ACCOUNT;
	let frames: Frame[] = [];
	await Chat.retry(h.context, speaking("ana", frames), retrying(ask.requestId));
	expect(frames).toEqual([
		expect.objectContaining({ kind: "session:error", code: "no-ai-account" }),
	]);
	expect(h.chat.entries.map(entry => entry.id)).toEqual(before);
	expect(h.prompts).toHaveLength(1);
});
