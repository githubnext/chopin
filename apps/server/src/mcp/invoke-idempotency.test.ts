import { afterEach, expect, test } from "bun:test";

import { Admission } from "../auth/admission";
import { Machines } from "../auth/machines";
import { Sessions } from "../auth/session";
import * as Chat from "../chat/service";
import { rooted } from "../testing/rooted";
import { hosted } from "./hosted";
import {
	invocationFingerprint,
	invokeRouted,
	MAX_SYSTEM_TURNS_PER_HOUR,
	SystemTurns,
} from "./invoke";

import type { HostedAuth } from "../auth/routes";
import type { GitHub } from "../github/client";
import type { InvokePlannerInput } from "../mcp";
import type { HostedCaller } from "./hosted";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0)) await cleanup();
});

const ANA = { id: "U_ana", login: "ana", avatarUrl: "" };
const RIVAL = { id: "U_rival", login: "rival", avatarUrl: "" };
const INSTRUCTION = "Summarize the open findings.";

function caller(user: typeof ANA): HostedCaller {
	return { oauthToken: user.login, user };
}

/** `invoke_planner` as `/mcp` serves it, routed to a real root Chat as `main.ts` routes it. */
async function served() {
	let fixture = await rooted({ root: "# Root\n\nRoot prose.\n", child: "# Child\n\nFinding.\n" });
	cleanups.push(fixture.close);
	let { storage } = fixture;
	await storage.users.put({ ...RIVAL, now: new Date() });
	let lease = (await storage.leases.acquire("mcp-writer", "test", 60_000))!;
	let github = {
		repository: async (_token: string, owner: string, name: string) => ({
			id: fixture.repository.id,
			owner,
			name,
			fullName: `${owner}/${name}`,
			private: true,
			url: `https://github.test/${owner}/${name}`,
			defaultBranch: "main",
			permissions: { pull: true, push: true, admin: false },
		}),
	} as unknown as GitHub;
	let config = {
		origin: "http://localhost:8795",
		appSlug: "test",
		clientId: "test",
		encryptionKey: new Uint8Array(32),
	};
	let auth: HostedAuth = {
		config,
		github,
		storage,
		sessions: new Sessions(storage, false),
		clock: () => new Date(),
		admission: new Admission(config, github),
		machines: new Machines(storage, () => new Date(), { origin: config.origin, clientId: "test" }),
		pairings: {},
	};
	let delivered = 0;
	let systemTurns = new SystemTurns();
	let adapter = hosted(auth, { lease: () => lease }, {
		invokePlanner: input => {
			delivered++;
			return invokeRouted({
				channels: storage.channels,
				deleting: () => false,
				transition: (_id, action) => action(),
				open: async () => ({ context: fixture.root.context, release: () => {} }),
				plannerAccount: () => undefined,
				systemTurns,
			}, input);
		},
	});
	let invoke = (input: InvokePlannerInput, user = ANA) =>
		adapter.invoke!.invoke(caller(user), input);
	let posted = (text = INSTRUCTION) =>
		fixture.root.plan.chat.entries.filter(entry => entry.text === text);
	let notices = () =>
		fixture.root.plan.chat.entries.filter(entry => entry.author.kind === "system");
	return {
		...fixture,
		invoke,
		posted,
		notices,
		lease,
		systemTurns,
		delivered: () => delivered,
	};
}

function failing<T extends object, K extends keyof T>(target: T, name: K): () => void {
	let original = target[name];
	target[name] = (async () => {
		throw new Error("storage went away");
	}) as T[K];
	return () => {
		target[name] = original;
	};
}

async function settle(): Promise<void> {
	await Bun.sleep(20);
}

test("a retry after a lost reply returns the first result, posting one message and starting one turn", async () => {
	let { invoke, posted, root, storage, turns } = await served();
	let request = { id: root.channel.id, instruction: INSTRUCTION, idempotencyKey: "hand-off" };
	let first = await invoke(request);
	if (first.kind !== "invoked") throw new Error(`refused: ${first.code}`);
	expect(first.document).toMatchObject({ id: root.channel.id, title: "Root" });
	await turns.started(1);
	await storage.channels.rename({ id: root.channel.id, title: "Renamed root", now: new Date() });
	expect(await invoke(request)).toEqual(first);
	expect(await invoke({ ...request, id: `/documents/octo-org/score/${root.channel.slug}` }))
		.toEqual(first);
	await settle();
	expect(posted()).toHaveLength(1);
	expect(turns.prompts).toHaveLength(1);
	expect(turns.steered).toEqual([]);
	expect(
		await storage.mcpInvocations.get({
			userId: ANA.id,
			channelId: root.channel.id,
			key: "hand-off",
		}),
	).toMatchObject({
		entryId: posted()[0]!.id,
		result: { document: first.document },
		invokedAt: expect.any(Date),
	});
});

for (let as of [undefined, "system" as const]) {
	let kind = as ? "a follow-up" : "an instruction";

	test(`${kind} saved without its start recorded starts its turn on the retry, posted once`, async () => {
		let { invoke, root, storage, turns } = await served();
		let request = {
			id: root.channel.id,
			instruction: INSTRUCTION,
			idempotencyKey: "hand-off",
			...(as ? { as } : {}),
		};
		let restore = failing(storage.mcpInvocations, "complete");
		await expect(invoke(request)).rejects.toThrow("storage went away");
		await settle();
		expect(root.plan.chat.entries).toHaveLength(1);
		expect(turns.prompts).toEqual([]);
		restore();

		let retried = await invoke(request);
		expect(retried).toMatchObject({ kind: "invoked", document: { id: root.channel.id } });
		await turns.started(1);
		expect(await invoke(request)).toEqual(retried);
		await settle();
		expect(root.plan.chat.entries).toHaveLength(1);
		expect(turns.prompts).toHaveLength(1);
	});

	test(`${kind} whose entry could not be saved is posted and started once by the retry`, async () => {
		let { invoke, root, turns } = await served();
		let request = {
			id: root.channel.id,
			instruction: INSTRUCTION,
			idempotencyKey: "hand-off",
			...(as ? { as } : {}),
		};
		let restore = failing(root.context, "persist");
		await expect(invoke(request)).rejects.toThrow("storage went away");
		await settle();
		expect(root.plan.chat.entries).toEqual([]);
		expect(turns.prompts).toEqual([]);
		restore();

		let retried = await invoke(request);
		expect(retried).toMatchObject({ kind: "invoked" });
		await turns.started(1);
		expect(await invoke(request)).toEqual(retried);
		await settle();
		expect(root.plan.chat.entries).toHaveLength(1);
		expect(turns.prompts).toHaveLength(1);
	});
}

/** Makes `complete` save its mark and lose its answer, and makes reading the claim back fail. */
function losingCompletion(store: { complete: unknown; get: unknown }): () => void {
	let target = store as {
		complete: (...args: unknown[]) => Promise<boolean>;
		get: (...args: unknown[]) => Promise<unknown>;
	};
	let { complete, get } = target;
	target.complete = async (...args) => {
		await complete.apply(store, args);
		throw new Error("commit reply lost");
	};
	target.get = async () => {
		throw new Error("storage went away");
	};
	return () => {
		target.complete = complete;
		target.get = get;
	};
}

for (let as of [undefined, "system" as const]) {
	let kind = as ? "a follow-up" : "an instruction";

	test(`${kind} whose start was saved but its answer and read-back lost starts its turn on the retry`, async () => {
		let { invoke, root, storage, turns } = await served();
		let request = {
			id: root.channel.id,
			instruction: INSTRUCTION,
			idempotencyKey: "hand-off",
			...(as ? { as } : {}),
		};
		let scope = { userId: ANA.id, channelId: root.channel.id, key: "hand-off" };
		let restore = losingCompletion(storage.mcpInvocations);
		await expect(invoke(request)).rejects.toThrow("commit reply lost");
		restore();
		await settle();
		expect(await storage.mcpInvocations.get(scope)).toMatchObject({ invokedAt: expect.any(Date) });
		expect(root.plan.chat.entries).toHaveLength(1);
		expect(turns.prompts).toEqual([]);

		expect(await invoke({ ...request, instruction: "Something else." })).toEqual({
			kind: "refused",
			code: "idempotency-conflict",
		});
		let retried = await invoke(request);
		expect(retried).toMatchObject({ kind: "invoked", document: { id: root.channel.id } });
		await turns.started(1);
		expect(await invoke(request)).toEqual(retried);
		await settle();
		expect(root.plan.chat.entries).toHaveLength(1);
		expect(turns.prompts).toHaveLength(1);
	});
}

test("a start whose read-back keeps failing is recovered by the retry once storage answers", async () => {
	let { invoke, posted, root, storage, turns } = await served();
	let request = { id: root.channel.id, instruction: INSTRUCTION, idempotencyKey: "hand-off" };
	let restore = losingCompletion(storage.mcpInvocations);
	await expect(invoke(request)).rejects.toThrow("commit reply lost");
	await expect(invoke(request)).rejects.toThrow("commit reply lost");
	restore();
	await settle();
	expect(turns.prompts).toEqual([]);

	expect(await invoke(request)).toMatchObject({ kind: "invoked" });
	await turns.started(1);
	await settle();
	expect(posted()).toHaveLength(1);
	expect(turns.prompts).toHaveLength(1);
});

test("a tenth follow-up saved without its start recorded is started by its retry, counted once", async () => {
	let { invoke, notices, root, storage, systemTurns, turns } = await served();
	for (let count = 1; count < MAX_SYSTEM_TURNS_PER_HOUR; count++) systemTurns.take(root.channel.id);
	let request = {
		id: root.channel.id,
		instruction: INSTRUCTION,
		as: "system" as const,
		idempotencyKey: "tenth",
	};
	let restore = failing(storage.mcpInvocations, "complete");
	await expect(invoke(request)).rejects.toThrow("storage went away");
	restore();
	expect(notices()).toHaveLength(1);
	expect(turns.prompts).toEqual([]);

	let retried = await invoke(request);
	expect(retried).toMatchObject({ kind: "invoked" });
	await turns.started(1);
	expect(await invoke(request)).toEqual(retried);
	await turns.finish();
	await root.plan.chat.running;
	expect(await invoke({ ...request, idempotencyKey: "eleventh" })).toEqual({
		kind: "refused",
		code: "system-turn-limited",
	});
	expect(notices()).toHaveLength(1);
	expect(turns.prompts).toHaveLength(1);
});

test("a claim a stopped process left before posting is posted once, under the entry it named", async () => {
	let { invoke, lease, posted, root, storage, turns } = await served();
	let request = { id: root.channel.id, instruction: INSTRUCTION, idempotencyKey: "hand-off" };
	let now = new Date();
	let entryId = "01KLEFTBYASTOPPEDPROCESS0";
	await storage.mcpInvocations.claim(lease, {
		userId: ANA.id,
		channelId: root.channel.id,
		key: "hand-off",
		fingerprint: invocationFingerprint(request, root.channel.id),
		entryId,
		result: { document: { id: root.channel.id, title: "Root", url: "http://localhost:8795/x" } },
		createdAt: now,
		expiresAt: new Date(now.getTime() + 60_000),
	});
	let left = {
		kind: "invoked",
		document: { id: root.channel.id, title: "Root", url: "http://localhost:8795/x" },
	} as const;
	expect(await invoke(request)).toEqual(left);
	await turns.started(1);
	expect(await invoke(request)).toEqual(left);
	await settle();
	expect(posted().map(entry => entry.id)).toEqual([entryId]);
	expect(turns.prompts).toHaveLength(1);
});

test("a claim a stopped process left before posting gives way to a different request", async () => {
	let { invoke, lease, posted, root, storage, turns } = await served();
	let now = new Date();
	await storage.mcpInvocations.claim(lease, {
		userId: ANA.id,
		channelId: root.channel.id,
		key: "hand-off",
		fingerprint: invocationFingerprint({ instruction: "Abandoned." }, root.channel.id),
		entryId: "01KLEFTBYASTOPPEDPROCESS0",
		result: { document: { id: root.channel.id, title: "Root", url: "http://localhost:8795/x" } },
		createdAt: now,
		expiresAt: new Date(now.getTime() + 60_000),
	});
	let request = { id: root.channel.id, instruction: INSTRUCTION, idempotencyKey: "hand-off" };
	let invoked = await invoke(request);
	expect(invoked).toMatchObject({ kind: "invoked", document: { title: "Root" } });
	await turns.started(1);
	expect(await invoke({ ...request, instruction: "Abandoned." })).toEqual({
		kind: "refused",
		code: "idempotency-conflict",
	});
	expect(posted()).toHaveLength(1);
	expect(posted()[0]!.id).not.toBe("01KLEFTBYASTOPPEDPROCESS0");
	expect(posted("Abandoned.")).toEqual([]);
});

test("a different request under a key whose instruction is posted but not started is refused", async () => {
	let { invoke, posted, root, storage, turns } = await served();
	let request = { id: root.channel.id, instruction: INSTRUCTION, idempotencyKey: "hand-off" };
	let restore = failing(storage.mcpInvocations, "complete");
	await expect(invoke(request)).rejects.toThrow("storage went away");
	restore();
	expect(await invoke({ ...request, instruction: "Something else." })).toEqual({
		kind: "refused",
		code: "idempotency-conflict",
	});
	await settle();
	expect(posted()).toHaveLength(1);
	expect(posted("Something else.")).toEqual([]);
	expect(turns.prompts).toEqual([]);
});

test("a different request under a used key is refused and posts nothing", async () => {
	let { delivered, invoke, posted, root, turns } = await served();
	let request = { id: root.channel.id, instruction: INSTRUCTION, idempotencyKey: "hand-off" };
	await invoke(request);
	await turns.started(1);
	let conflict = { kind: "refused", code: "idempotency-conflict" } as const;
	expect(await invoke({ ...request, instruction: "Something else." })).toEqual(conflict);
	expect(await invoke({ ...request, as: "system" })).toEqual(conflict);
	await settle();
	expect(delivered()).toBe(1);
	expect(posted()).toHaveLength(1);
	expect(posted("Something else.")).toEqual([]);
	expect(turns.prompts).toHaveLength(1);
});

test("a refusal that kept nothing leaves the key for a corrected retry", async () => {
	let { invoke, posted, root, turns } = await served();
	let request = { id: root.channel.id, instruction: INSTRUCTION, idempotencyKey: "hand-off" };
	expect(await invoke({ ...request, as: "system" }, RIVAL)).toEqual({
		kind: "refused",
		code: "system-turn-forbidden",
	});
	expect(root.plan.chat.entries).toEqual([]);
	expect(await invoke(request, RIVAL)).toMatchObject({ kind: "invoked" });
	await turns.started(1);
	expect(posted()).toEqual([
		expect.objectContaining({ author: { kind: "member", handle: "rival" } }),
	]);
});

test("a refusal whose key could not be freed still leaves it for a corrected request", async () => {
	let { invoke, posted, root, storage, turns, user } = await served();
	expect(await Chat.invoke(root.context, user, "First")).toBeUndefined();
	await turns.started(1);
	root.context.steers = () => true;
	let request = {
		id: root.channel.id,
		instruction: INSTRUCTION,
		as: "system" as const,
		idempotencyKey: "follow-up",
	};
	let restore = failing(storage.mcpInvocations, "release");
	expect(await invoke(request)).toMatchObject({ kind: "refused", code: "planner-busy" });
	restore();
	expect(await invoke(request)).toMatchObject({ kind: "refused", code: "planner-busy" });
	let { as: _as, ...corrected } = request;
	expect(await invoke(corrected)).toMatchObject({ kind: "invoked" });
	await settle();
	expect(posted()).toHaveLength(1);
	expect(root.plan.chat.entries.filter(entry => entry.author.kind === "system")).toEqual([]);
	expect(turns.prompts).toHaveLength(1);
	expect(turns.steered).toHaveLength(1);
});

test("a forbidden follow-up leaves its key for a corrected request", async () => {
	let { invoke, posted, root, turns } = await served();
	let request = {
		id: root.channel.id,
		instruction: INSTRUCTION,
		as: "system" as const,
		idempotencyKey: "hand-off",
	};
	let forbidden = { kind: "refused", code: "system-turn-forbidden" } as const;
	expect(await invoke(request, RIVAL)).toEqual(forbidden);
	expect(await invoke(request, RIVAL)).toEqual(forbidden);
	let { as: _as, ...corrected } = request;
	expect(await invoke(corrected, RIVAL)).toMatchObject({ kind: "invoked" });
	await turns.started(1);
	expect(posted()).toHaveLength(1);
});

test("a passing refusal is retried under the same key once the trouble passes", async () => {
	let { invoke, root, turns, user } = await served();
	expect(await Chat.invoke(root.context, user, "First")).toBeUndefined();
	await turns.started(1);
	let request = {
		id: root.channel.id,
		instruction: INSTRUCTION,
		as: "system" as const,
		idempotencyKey: "follow-up",
	};
	expect(await invoke(request)).toMatchObject({ kind: "refused", code: "planner-busy" });
	await turns.finish();
	await root.plan.chat.running;
	let invoked = await invoke(request);
	expect(invoked).toMatchObject({ kind: "invoked" });
	await turns.started(2);
	expect(await invoke(request)).toEqual(invoked);
	await settle();
	expect(turns.prompts).toHaveLength(2);
	expect(root.plan.chat.entries.filter(entry => entry.author.kind === "system")).toHaveLength(1);
});

test("a key belongs to its caller and document, so others' use of it posts their own", async () => {
	let { child, invoke, posted, root, storage, turns } = await served();
	root.context.steers = () => true;
	let key = "shared-key";
	let ana = await invoke({ id: root.channel.id, instruction: INSTRUCTION, idempotencyKey: key });
	await turns.started(1);
	let rival = await invoke(
		{ id: root.channel.id, instruction: INSTRUCTION, idempotencyKey: key },
		RIVAL,
	);
	let focused = await invoke({
		id: child.channel.id,
		instruction: INSTRUCTION,
		idempotencyKey: key,
	});
	for (let result of [ana, rival, focused]) expect(result).toMatchObject({ kind: "invoked" });
	expect(focused).toMatchObject({ document: { id: child.channel.id } });
	expect(posted().map(entry => entry.author)).toEqual([
		{ kind: "member", handle: "ana" },
		{ kind: "member", handle: "rival" },
		{ kind: "member", handle: "ana" },
	]);
	expect(
		await invoke({ id: root.channel.id, instruction: INSTRUCTION, idempotencyKey: key }, RIVAL),
	)
		.toEqual(rival);
	expect(await invoke({ id: child.channel.id, instruction: INSTRUCTION, idempotencyKey: key }))
		.toEqual(focused);
	expect(posted()).toHaveLength(3);
	expect(await storage.mcpInvocations.get({ userId: RIVAL.id, channelId: child.channel.id, key }))
		.toBeUndefined();
});

test("concurrent calls with one key post once and all return its result", async () => {
	let { invoke, posted, root, turns } = await served();
	root.context.steers = () => true;
	let request = { id: root.channel.id, instruction: INSTRUCTION, idempotencyKey: "hand-off" };
	let results = await Promise.all(Array.from({ length: 5 }, () => invoke(request)));
	await turns.started(1);
	await settle();
	expect(results[0]).toMatchObject({ kind: "invoked" });
	for (let result of results) expect(result).toEqual(results[0]!);
	expect(posted()).toHaveLength(1);
	expect(turns.prompts).toHaveLength(1);
	expect(turns.steered).toEqual([]);
});

test("a call without a key keeps posting each time, as before", async () => {
	let { invoke, posted, root, storage, turns } = await served();
	root.context.steers = () => true;
	await invoke({ id: root.channel.id, instruction: INSTRUCTION });
	await turns.started(1);
	await invoke({ id: root.channel.id, instruction: INSTRUCTION });
	expect(posted()).toHaveLength(2);
	expect(await storage.mcpInvocations.deleteExpired(new Date(8.64e15))).toBe(0);
});
