import { expect, test } from "bun:test";

import { GitHubError, GitHubTokenError } from "../github/client";
import { MemoryStorage } from "../storage/memory/adapter";
import { MachineError, Machines } from "./machines";

import type { GitHubTokenGrant } from "../github/client";

const KEY = new Uint8Array(32).fill(7);

function grant(access: string, refresh: string, accessExpiresIn = 28_800): GitHubTokenGrant {
	return {
		accessToken: access,
		accessExpiresIn,
		refreshToken: refresh,
		refreshExpiresIn: 15_897_600,
	};
}

async function setup() {
	let storage = new MemoryStorage();
	await storage.users.put({ id: "alice", login: "alice", avatarUrl: "", now: new Date() });
	let now = new Date("2026-03-01T00:00:00.000Z");
	let refreshed: string[] = [];
	let github = {
		next: 1,
		refuse: false,
		refresh: async (token: string) => {
			refreshed.push(token);
			if (github.refuse) throw new GitHubTokenError("GitHub rejected the token refresh", 401, true);
			github.next++;
			return grant(`ghu_machine_${github.next}`, `ghr_machine_${github.next}`);
		},
	};
	let admitted = true;
	let create = () =>
		new Machines(storage, () => now, {
			key: KEY,
			origin: "https://chopin.test",
			clientId: "client",
			refresh: token => github.refresh(token),
			authorize: async () => admitted,
		});
	let machines = create();
	let paired = await machines.pair({
		userId: "alice",
		label: "laptop",
		repositories: [{ repositoryId: "R_1", repository: "org/repo", commit: "a".repeat(40) }],
		autoRun: true,
		grant: grant("ghu_machine_1", "ghr_machine_1"),
	});
	return {
		storage,
		machines,
		create,
		paired,
		github,
		refreshed,
		advance: (ms: number) => now = new Date(now.getTime() + ms),
		deny: () => admitted = false,
	};
}

async function failure(promise: Promise<unknown>) {
	let error = await promise.then(() => undefined, err => err);
	expect(error).toBeInstanceOf(MachineError);
	return (error as MachineError).code;
}

test("a paired machine stores only its token hash and ciphertext, and survives a restart", async () => {
	let { storage, create, paired } = await setup();
	expect(paired.token).toMatch(/^chopin_m_[A-Za-z0-9_-]{43}$/);
	let stored = (await storage.machines.get(paired.machine.id))!;
	let raw = new TextDecoder().decode(stored.credentials!.ciphertext);
	for (let secret of [paired.token, "ghu_machine_1", "ghr_machine_1"]) {
		expect(raw).not.toContain(secret);
		expect(JSON.stringify(stored)).not.toContain(secret);
	}
	expect(Buffer.from(stored.tokenHash).toString("utf8")).not.toContain(paired.token);

	// A new process reads the same storage with the same key.
	let restarted = create();
	let machine = await restarted.authenticate(paired.token);
	expect(machine.id).toBe(paired.machine.id);
	expect(await restarted.use(machine, async token => token)).toBe("ghu_machine_1");
});

test("an unknown, malformed, or revoked token is refused as machine-revoked", async () => {
	let { machines, paired } = await setup();
	expect(await failure(machines.authenticate("chopin_m_" + "A".repeat(43)))).toBe(
		"machine-revoked",
	);
	expect(await failure(machines.authenticate("not a token"))).toBe("machine-revoked");
	expect(await machines.revoke(paired.machine.id, "bob")).toBe(false);
	expect(await machines.revoke(paired.machine.id, "alice")).toBe(true);
	expect(await failure(machines.authenticate(paired.token))).toBe("machine-revoked");
	expect(await machines.list("alice")).toEqual([]);
});

test("an expiring access token is refreshed once and the rotation persists", async () => {
	let { machines, create, paired, refreshed, advance } = await setup();
	advance(28_800_000 - 60_000);
	let machine = await machines.authenticate(paired.token);
	let [first, second] = await Promise.all([
		machines.use(machine, async token => token),
		machines.use(machine, async token => token),
	]);
	expect([first, second]).toEqual(["ghu_machine_2", "ghu_machine_2"]);
	expect(refreshed).toEqual(["ghr_machine_1"]);
	let restarted = create();
	expect(await restarted.use(await restarted.authenticate(paired.token), async token => token))
		.toBe("ghu_machine_2");
	expect(refreshed).toEqual(["ghr_machine_1"]);
});

test("a rejected access token is refreshed and the call retried", async () => {
	let { machines, paired } = await setup();
	let machine = await machines.authenticate(paired.token);
	let seen: string[] = [];
	let value = await machines.use(machine, async token => {
		seen.push(token);
		if (token === "ghu_machine_1") throw new GitHubError("Bad credentials", 401);
		return "ok";
	});
	expect(value).toBe("ok");
	expect(seen).toEqual(["ghu_machine_1", "ghu_machine_2"]);
});

test("a refused refresh marks the machine for re-authorization, not revocation", async () => {
	let { machines, storage, paired, github, advance } = await setup();
	github.refuse = true;
	advance(28_800_000);
	let machine = await machines.authenticate(paired.token);
	expect(await failure(machines.use(machine, async token => token))).toBe("machine-reauthorize");
	expect(await failure(machines.authenticate(paired.token))).toBe("machine-reauthorize");
	let stored = (await storage.machines.get(paired.machine.id))!;
	expect(stored.reauthorizeAt).toBeDefined();
	expect(stored.revokedAt).toBeUndefined();
	expect(stored.credentials).toBeUndefined();
	expect((await machines.list("alice")).map(value => value.id)).toEqual([paired.machine.id]);
});

test("a freshly refreshed token GitHub still refuses needs re-authorization", async () => {
	let { machines, paired } = await setup();
	let machine = await machines.authenticate(paired.token);
	expect(
		await failure(machines.use(machine, async () => {
			throw new GitHubError("Bad credentials", 401);
		})),
	).toBe("machine-reauthorize");
});

test("an owner who is no longer admitted loses the machine", async () => {
	let { machines, paired, deny } = await setup();
	deny();
	let machine = await machines.authenticate(paired.token);
	expect(await failure(machines.use(machine, async token => token))).toBe("machine-revoked");
	expect(await failure(machines.authenticate(paired.token))).toBe("machine-revoked");
});
