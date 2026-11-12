import { describe, expect, it } from "bun:test";
import { ExperimentError } from "@chopin/experiment";

import { GITHUB_TOKEN_FRESH_MS, launchGitHubToken, machineGitHubToken } from "./machine-github";

import type { InstalledRepository } from "../github/client";
import type { StoredMachine } from "../storage/model";

const MACHINE = { id: "M_1", userId: "U_1" } as StoredMachine;
const NOW = new Date("2026-10-14T12:00:00Z");

/** A machine whose grant expires `left` ms from now and refreshes to a token good for 8 hours. */
function machines(left: number) {
	let grant = { token: "ghu_current", expiresAt: new Date(NOW.getTime() + left) };
	let refreshed = 0;
	return {
		refreshed: () => refreshed,
		use: <T>(_machine: StoredMachine, operation: (token: string) => Promise<T>) =>
			operation(grant.token),
		access: async (_machine: StoredMachine, rejected?: string) => {
			if (rejected === grant.token) {
				refreshed++;
				grant = { token: "ghu_refreshed", expiresAt: new Date(NOW.getTime() + 8 * 3_600_000) };
			}
			return grant;
		},
	};
}

function installed(
	push: boolean,
	writable?: { contents: boolean; pullRequests: boolean },
): InstalledRepository {
	return {
		repository: { fullName: "octo-org/score", permissions: { pull: true, push, admin: false } },
		installation: { id: "1", ...(writable ? { writable } : {}) },
	} as InstalledRepository;
}

async function refused(promise: Promise<unknown>) {
	let error = await promise.then(() => undefined, (caught: unknown) => caught);
	expect(error).toBeInstanceOf(ExperimentError);
	return error as ExperimentError;
}

describe("a machine's GitHub token", () => {
	it("goes out for a repository its owner can push to through an App that can write", async () => {
		let held = machines(2 * 3_600_000);
		let asked: string[] = [];
		let token = await machineGitHubToken(
			{
				machines: held,
				github: {
					installedRepository: async (token: string, owner: string, name: string) => {
						asked.push(`${token} ${owner}/${name}`);
						return installed(true, { contents: true, pullRequests: true });
					},
				},
				clock: () => NOW,
			},
			MACHINE,
			"octo-org/score",
		);
		expect(token).toEqual({ token: "ghu_current", expiresAt: NOW.getTime() + 2 * 3_600_000 });
		expect(asked).toEqual(["ghu_current octo-org/score"]);
		expect(held.refreshed()).toBe(0);
	});

	it("is refreshed first when it would expire within half an hour", async () => {
		let held = machines(GITHUB_TOKEN_FRESH_MS - 60_000);
		let token = await machineGitHubToken(
			{
				machines: held,
				github: {
					installedRepository: async () => installed(true, { contents: true, pullRequests: true }),
				},
				clock: () => NOW,
			},
			MACHINE,
			"octo-org/score",
		);
		expect(token.token).toBe("ghu_refreshed");
		expect(held.refreshed()).toBe(1);
	});

	it("is refused when the App can't write contents and pull requests, or nobody says", async () => {
		for (
			let writable of [
				{ contents: true, pullRequests: false },
				{ contents: false, pullRequests: true },
				undefined,
			]
		) {
			let error = await refused(machineGitHubToken(
				{
					machines: machines(3_600_000),
					github: { installedRepository: async () => installed(true, writable) },
					clock: () => NOW,
				},
				MACHINE,
				"octo-org/score",
			));
			expect(error.code).toBe("app-cannot-push");
			expect(error.message).toContain("octo-org/score");
		}
	});

	it("is refused when the owner can't push or the App isn't installed there", async () => {
		for (let answer of [installed(false, { contents: true, pullRequests: true }), undefined]) {
			let error = await refused(machineGitHubToken(
				{
					machines: machines(3_600_000),
					github: { installedRepository: async () => answer },
					clock: () => NOW,
				},
				MACHINE,
				"octo-org/score",
			));
			expect(error.code).toBe("repository-forbidden");
		}
	});

	it("goes nowhere when GitHub can't be asked", async () => {
		let failure = new Error("GitHub is down");
		let error = await machineGitHubToken(
			{
				machines: machines(3_600_000),
				github: {
					installedRepository: async () => {
						throw failure;
					},
				},
				clock: () => NOW,
			},
			MACHINE,
			"octo-org/score",
		).catch((caught: unknown) => caught);
		expect(error).toBe(failure);
	});
});

describe("an App installation token for a launch on a machine", () => {
	const BOT = { login: "chopin-test[bot]", id: 900, nodeId: "BOT_900" };
	const PEOPLE: Record<string, { login: string; id: number; nodeId: string; name?: string }> = {
		alice: { login: "alice", id: 11, nodeId: "U_alice", name: "Alice Example" },
		bob: { login: "bob", id: 12, nodeId: "U_bob" },
	};

	/** A GitHub App whose installation on octo-org/score has `permissions`, and who can push there. */
	function app(
		permissions: Record<string, string> = {
			contents: "write",
			pull_requests: "write",
			metadata: "read",
		},
		pushers = new Set(["alice"]),
	) {
		let calls: string[] = [];
		let revoked: string[] = [];
		let minted = 0;
		return {
			calls,
			revoked,
			installation: async (owner: string, name: string) => {
				calls.push(`installation ${owner}/${name}`);
				return owner === "octo-org" && name === "score"
					? { id: "77", suspended: false, permissions }
					: undefined;
			},
			token: async (installation: string, name: string, wanted: Record<string, string>) => {
				calls.push(`token ${installation} ${name} ${JSON.stringify(wanted)}`);
				minted++;
				return {
					token: `ghs_${minted}`,
					expiresAt: NOW.getTime() + 3_600_000,
					permissions: wanted,
				};
			},
			revoke: async (token: string) => {
				revoked.push(token);
			},
			account: async (token: string, login: string) => {
				calls.push(`account ${token} ${login}`);
				return login === BOT.login ? BOT : PEOPLE[login];
			},
			canPush: async (token: string, owner: string, name: string, login: string) => {
				calls.push(`canPush ${token} ${owner}/${name} ${login}`);
				return pushers.has(login);
			},
		};
	}

	function deps(
		github: ReturnType<typeof app> | undefined,
		options: {
			run?: { kind: "build" | "investigation" | "spike"; starter: string; machineId?: string };
			push?: boolean;
		} = {},
	) {
		let logged: string[] = [];
		return {
			logged,
			value: {
				machines: machines(3_600_000),
				github: {
					installedRepository: async () =>
						installed(options.push ?? true, { contents: true, pullRequests: true }),
				},
				...(github ? { app: github } : {}),
				slug: "chopin-test",
				run: async (id: string) =>
					id === "run-1" && options.run
						? { repository: "octo-org/score", ...options.run }
						: undefined,
				user: async (id: string) =>
					PEOPLE[id] ? { id: PEOPLE[id].nodeId, login: PEOPLE[id].login } : undefined,
				log: (line: string) => logged.push(line),
				clock: () => NOW,
			},
		};
	}

	it("goes to a build as the App's bot, for its one repository, crediting who started it", async () => {
		let github = app();
		let { value, logged } = deps(github, {
			run: { kind: "build", starter: "alice", machineId: "M_1" },
		});
		let grant = await launchGitHubToken(value, MACHINE, {
			repository: "octo-org/score",
			purpose: "run",
			run: "run-1",
			document: "D_1",
		});
		expect(grant).toEqual({
			token: "ghs_1",
			expiresAt: NOW.getTime() + 3_600_000,
			kind: "installation",
			permissions: { contents: "write", pull_requests: "write", metadata: "read" },
			identity: {
				login: "chopin-test[bot]",
				id: 900,
				name: "chopin-test[bot]",
				email: "900+chopin-test[bot]@users.noreply.github.com",
			},
			starter: {
				login: "alice",
				id: 11,
				name: "Alice Example",
				email: "11+alice@users.noreply.github.com",
			},
		});
		expect(github.calls).toContain(
			'token 77 score {"contents":"write","pull_requests":"write","metadata":"read"}',
		);
		expect(github.calls).toContain("canPush ghs_1 octo-org/score alice");
		expect(logged).toEqual([
			"chopin: GitHub App token (run build) for machine M_1 in octo-org/score, run run-1, "
			+ "document D_1, for alice",
		]);
		expect(logged.join("\n")).not.toContain("ghs_1");
	});

	it("may push workflow files where the App can", async () => {
		let github = app({
			contents: "write",
			pull_requests: "write",
			metadata: "read",
			workflows: "write",
		});
		let grant = await launchGitHubToken(
			deps(github, { run: { kind: "build", starter: "alice" } }).value,
			MACHINE,
			{ repository: "octo-org/score", purpose: "run", run: "run-1" },
		);
		expect(grant).toMatchObject({ permissions: { contents: "write", workflows: "write" } });
	});

	it("lets an investigation push, and a prototype only read", async () => {
		for (
			let [kind, wanted] of [
				["investigation", { contents: "write", pull_requests: "write", metadata: "read" }],
				["spike", { contents: "read", metadata: "read" }],
			] as const
		) {
			let github = app();
			let grant = await launchGitHubToken(
				deps(github, { run: { kind, starter: "alice" } }).value,
				MACHINE,
				{ repository: "octo-org/score", purpose: "run", run: "run-1" },
			);
			expect(grant).toMatchObject({ permissions: wanted });
		}
	});

	it("goes to a Planner for the machine's owner, checked with their own grant", async () => {
		let github = app();
		let grant = await launchGitHubToken(
			{ ...deps(github).value, user: async () => ({ id: "U_bob", login: "bob" }) },
			MACHINE,
			{ repository: "octo-org/score", purpose: "planner", document: "D_1" },
		);
		expect(grant).toMatchObject({
			permissions: { contents: "write", pull_requests: "write" },
			starter: { login: "bob", name: "bob", email: "12+bob@users.noreply.github.com" },
		});
		expect(github.calls.some(call => call.startsWith("canPush"))).toBe(false);
	});

	it("is refused for a Planner whose machine's owner can't push", async () => {
		let github = app();
		let error = await refused(launchGitHubToken(
			deps(github, { push: false }).value,
			{ ...MACHINE, userId: "alice" },
			{ repository: "octo-org/score", purpose: "planner" },
		));
		expect(error.code).toBe("starter-cannot-push");
		expect(error.message).toBe(
			"alice can't push to octo-org/score, so this machine gets no token for it.",
		);
		expect(github.calls.some(call => call.startsWith("token"))).toBe(false);
	});

	it("is refused, and the token it minted given back, when who started the run can't push", async () => {
		let github = app(undefined, new Set());
		let error = await refused(launchGitHubToken(
			deps(github, { run: { kind: "build", starter: "bob" } }).value,
			MACHINE,
			{ repository: "octo-org/score", purpose: "run", run: "run-1" },
		));
		expect(error.code).toBe("starter-cannot-push");
		expect(error.message).toBe(
			"bob can't push to octo-org/score, so their run there gets no token.",
		);
		expect(github.revoked).toEqual(["ghs_1"]);
	});

	it("is refused when the login now names someone else", async () => {
		let github = app();
		let error = await refused(launchGitHubToken(
			{
				...deps(github, { run: { kind: "build", starter: "alice" } }).value,
				user: async () => ({ id: "U_old_alice", login: "alice" }),
			},
			MACHINE,
			{ repository: "octo-org/score", purpose: "run", run: "run-1" },
		));
		expect(error.code).toBe("starter-cannot-push");
		expect(github.revoked).toEqual(["ghs_1"]);
	});

	it("is refused for a run Chopin doesn't know, gave another machine, or is elsewhere", async () => {
		for (
			let [run, request] of [
				[undefined, { run: "run-1" }],
				[{ kind: "build", starter: "alice", machineId: "M_other" }, { run: "run-1" }],
				[{ kind: "build", starter: "alice" }, { run: "run-2" }],
			] as const
		) {
			let github = app();
			let error = await refused(launchGitHubToken(
				deps(github, run ? { run } : {}).value,
				MACHINE,
				{ repository: "octo-org/score", purpose: "run", ...request },
			));
			expect(error.code).toBe("run-unknown");
			expect(error.message).toContain("octo-org/score");
			expect(github.calls).toEqual([]);
		}
	});

	it("is refused when the App isn't installed there or can't push", async () => {
		let missing = await refused(launchGitHubToken(
			deps(app(), { run: { kind: "build", starter: "alice" } }).value,
			MACHINE,
			{ repository: "octo-org/other", purpose: "planner" },
		));
		expect(missing).toMatchObject({
			code: "app-cannot-push",
			message: "Chopin's GitHub App isn't installed on octo-org/other.",
		});
		let readOnly = await refused(launchGitHubToken(
			deps(app({ contents: "write", pull_requests: "read" })).value,
			MACHINE,
			{ repository: "octo-org/score", purpose: "planner" },
		));
		expect(readOnly).toMatchObject({
			code: "app-cannot-push",
			message: "Chopin's GitHub App can't push to octo-org/score (it needs Contents and Pull "
				+ "requests write).",
		});
	});

	it("is refused as no-grant when this server has no App key", async () => {
		let error = await refused(launchGitHubToken(
			deps(undefined).value,
			MACHINE,
			{ repository: "octo-org/score", purpose: "planner" },
		));
		expect(error.code).toBe("no-grant");
		expect(error.message).toContain("octo-org/score");
	});

	it("only says whether it would go out when asked to check", async () => {
		let github = app();
		expect(
			await launchGitHubToken(
				{ ...deps(github).value, user: async () => ({ id: "U_bob", login: "bob" }) },
				MACHINE,
				{ repository: "octo-org/score", purpose: "check" },
			),
		).toEqual({ ok: true });
		expect(github.calls).toEqual(["installation octo-org/score"]);
		let refusedCheck = await refused(launchGitHubToken(
			deps(app({ contents: "read" })).value,
			MACHINE,
			{ repository: "octo-org/score", purpose: "check" },
		));
		expect(refusedCheck.code).toBe("app-cannot-push");
	});
});
