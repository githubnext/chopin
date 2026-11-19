/**
 * Before a person's message starts a Planner turn, Chopin reads what a launch for them would be
 * given: with nothing, the message is refused, saying why; their accounts changing meanwhile is a
 * passing trouble.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { testLease } from "../storage/contract-support";
import { MemoryStorage } from "../storage/memory/adapter";
import { AI_ACCOUNT_UNCHECKED, aiAccountRefusal, NO_AI_ACCOUNT } from "./account-check";
import { AiCredentials } from "./credentials";

let errors: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
	errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errors.mockRestore());

/** A person's AI accounts, with GitHub answering their Copilot access as `copilot` says. */
async function accounts() {
	let now = new Date("2026-11-19T12:00:00.000Z");
	let storage = new MemoryStorage();
	let lease = await testLease(storage);
	let state = {
		copilot: "access" as "access" | "none" | "unreachable",
		signedIn: true,
		exchanges: 0,
	};
	let credentials = new AiCredentials({
		storage,
		key: new Uint8Array(32).fill(5),
		origin: "https://chopin.test",
		clock: () => now,
		githubToken: async () => state.signedIn ? "ghu_ana" : undefined,
		copilotToken: async () => {
			state.exchanges++;
			if (state.copilot === "unreachable") throw new Error("GitHub answered 502");
			return state.copilot === "access"
				? { token: "tid=ana", expiresAt: now.getTime() + 1_800_000 }
				: undefined;
		},
		fetch: (async () => Response.json({ data: [] })) as unknown as typeof fetch,
		lease: () => lease,
	});
	let addKey = async () => {
		await storage.users.put({ id: "U_ana", login: "ana", avatarUrl: "avatar", now });
		await credentials.connect("U_ana", "openai", {
			kind: "api-key",
			secret: "sk-ana-openai-0123456789",
		});
	};
	return { storage, state, credentials, addKey, lease };
}

test("someone with Copilot access is let through", async () => {
	let { credentials } = await accounts();
	expect(await aiAccountRefusal(credentials, "U_ana")).toBeUndefined();
});

test("someone with a key and no Copilot access is let through on the key", async () => {
	let { credentials, state, addKey } = await accounts();
	state.copilot = "none";
	await addKey();
	expect(await credentials.available("U_ana")).toEqual({
		providers: ["openai"],
		withheld: [{ provider: "github-copilot", reason: "no-copilot-access" }],
	});
	expect(await aiAccountRefusal(credentials, "U_ana")).toBeUndefined();
});

test("someone with no Copilot access and no key is refused for good, told they need an AI account", async () => {
	let { credentials, state, storage } = await accounts();
	state.copilot = "none";
	let prepared = spyOn(storage.aiPlaceholders, "put");
	expect(await aiAccountRefusal(credentials, "U_ana")).toEqual({
		message: NO_AI_ACCOUNT,
		code: "no-ai-account",
	});
	expect(NO_AI_ACCOUNT).toBe(
		"chopin needs an AI account to answer, so this message wasn't sent. Add one, then send it again.",
	);
	expect(prepared).not.toHaveBeenCalled();
});

test("someone whose Copilot access couldn't be checked, with no key, is told the check couldn't finish, never that they have no subscription", async () => {
	let { credentials, state } = await accounts();
	state.copilot = "unreachable";
	let refusal = await aiAccountRefusal(credentials, "U_ana");
	expect(refusal).toEqual({ message: AI_ACCOUNT_UNCHECKED, code: "no-ai-account" });
	expect(refusal!.message).toBe(
		"chopin couldn't finish checking your AI accounts, so this message wasn't sent. Send it again in a moment.",
	);
	expect(refusal!.message).not.toMatch(/subscription|no copilot|need/i);

	state.signedIn = false;
	state.copilot = "access";
	expect(await aiAccountRefusal(credentials, "U_ana")).toEqual({
		message: AI_ACCOUNT_UNCHECKED,
		code: "no-ai-account",
	});
});

test("GitHub's answer about Copilot access is kept a few minutes, not asked again for every message", async () => {
	let { credentials, state } = await accounts();
	await aiAccountRefusal(credentials, "U_ana");
	await aiAccountRefusal(credentials, "U_ana");
	expect(state.exchanges).toBe(1);
});

test("accounts that keep changing while they are read are a passing refusal, never a final one", async () => {
	let { credentials, state, storage, addKey, lease } = await accounts();
	state.copilot = "none";
	await addKey();
	let store = storage.aiCredentials;
	let list = store.list.bind(store);
	store.list = async userId => {
		let listed = await list(userId);
		let key = (await store.get(userId, "openai"))!;
		await store.put(lease, { ...key, updatedAt: new Date(key.updatedAt.getTime() + 1) });
		return listed;
	};
	expect(await aiAccountRefusal(credentials, "U_ana")).toEqual({
		message: "chopin couldn't read your AI accounts just now.",
		code: "temporarily-unavailable",
	});
	expect(errors).not.toHaveBeenCalled();

	store.list = list;
	expect(await aiAccountRefusal(credentials, "U_ana")).toBeUndefined();
});

test("storage that fails while the accounts are read is a passing refusal too, and logged", async () => {
	let { credentials, storage } = await accounts();
	storage.aiCredentials.list = async () => {
		throw new Error("connection reset");
	};
	expect(await aiAccountRefusal(credentials, "U_ana")).toMatchObject({
		code: "temporarily-unavailable",
	});
	expect(errors).toHaveBeenCalledTimes(1);
});
