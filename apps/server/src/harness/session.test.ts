import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPlannerSession } from "./session";
import { fullPlanner } from "./atomic/full";
import { forgetWorkspaces, rememberCheckout, stateDirectory } from "./atomic/workspace";
import { plannerInstructions } from "../agent/planner";

import type { ActiveOwnerBinding } from "../agent/active-owner";
import type { PlannerSessionDependencies } from "./session";

function fixture() {
	let owner: ActiveOwnerBinding = {
		channelId: "channel",
		token: "test-token",
		repository: { id: "R_test", owner: "owner", name: "repo", defaultBranch: "main" },
		ownerSessionId: "owner-session",
		ownerGeneration: 1,
		credentialRevision: 1,
		expiresAt: new Date(Date.now() + 60_000),
		signal: new AbortController().signal,
		currentToken: () => "test-token",
		revalidate: async () => true,
		release() {},
	};
	let channel = {
		room: { id: "channel", plan: {}, server: {} } as never,
		repository: owner.repository,
		instructions: "Read this repository",
	};
	let destroyed = { sandbox: 0, session: 0, unregistered: 0 };
	let deps: PlannerSessionDependencies = {
		githubTools: async () => ({ ok: true, value: {} }),
		createSandbox: async () =>
			({
				defaultWorkingDirectory: "/tmp",
				destroy: async () => {
					destroyed.sandbox++;
				},
			}) as never,
		registerCredential: (_id, resolve) => {
			expect(resolve()).toBe("test-token");
			return () => {
				destroyed.unregistered++;
			};
		},
		agent: {
			createSession: async () => ({
				destroy: async () => {
					destroyed.session++;
				},
			}),
		} as never,
	};
	return { owner, channel, deps, destroyed };
}

describe("openPlannerSession", () => {
	it("keeps the credential host-side and destroys the session and sandbox once", async () => {
		let { owner, channel, deps, destroyed } = fixture();
		let opened = await openPlannerSession(owner, channel, deps);
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		await opened.value.destroy();
		await opened.value.destroy();
		expect(destroyed).toEqual({ sandbox: 1, session: 1, unregistered: 1 });
	});

	it("returns Unavailable for an invalid owner without allocating a sandbox", async () => {
		let { owner, channel, deps, destroyed } = fixture();
		owner.revalidate = async () => false;
		let result = await openPlannerSession(owner, channel, deps);
		expect(result).toMatchObject({ ok: false, error: { kind: "Unavailable" } });
		expect(destroyed.sandbox).toBe(0);
	});

	it("preserves a missing GitHub tool error without opening a sandbox", async () => {
		let { owner, channel, deps, destroyed } = fixture();
		deps.githubTools = async () => ({
			ok: false,
			error: { kind: "MissingTool", name: "pull_request_read" },
		});
		let result = await openPlannerSession(owner, channel, deps);
		expect(result).toEqual({
			ok: false,
			error: { kind: "MissingTool", name: "pull_request_read" },
		});
		expect(destroyed.sandbox).toBe(0);
	});

	for (
		let [message, kind] of [
			["capability unsupported", "HarnessCapabilityUnsupported"],
			["harness shutting down", "ShuttingDown"],
		] as const
	) {
		it(`destroys the sandbox on ${kind}`, async () => {
			let { owner, channel, deps, destroyed } = fixture();
			deps.agent = {
				createSession: async () => {
					throw new Error(message);
				},
			} as never;
			let result = await openPlannerSession(owner, channel, deps);
			expect(result).toMatchObject({ ok: false, error: { kind } });
			expect(destroyed).toEqual({ sandbox: 1, session: 0, unregistered: 1 });
		});
	}

	it("times out an unresponsive harness and destroys its sandbox", async () => {
		let { owner, channel, deps, destroyed } = fixture();
		deps.timeoutMs = 1;
		deps.agent = { createSession: () => new Promise(() => {}) } as never;
		let result = await openPlannerSession(owner, channel, deps);
		expect(result).toMatchObject({ ok: false, error: { kind: "Timeout" } });
		expect(destroyed).toEqual({ sandbox: 1, session: 0, unregistered: 1 });
	});
});

describe("Planner workspaces", () => {
	let roots: string[] = [];
	let previousState = process.env.XDG_STATE_HOME;
	beforeEach(async () => {
		let state = await mkdtemp(join(tmpdir(), "chopin-planner-state-"));
		roots.push(state);
		process.env.XDG_STATE_HOME = state;
	});
	afterEach(async () => {
		forgetWorkspaces();
		if (previousState === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = previousState;
		for (let root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function checkout(origin: string): Promise<string> {
		let root = await mkdtemp(join(tmpdir(), "chopin-planner-checkout-"));
		roots.push(root);
		for (let args of [["init", "--quiet"], ["remote", "add", "origin", origin]]) {
			expect(
				await Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" }).exited,
			).toBe(0);
		}
		return realpath(root);
	}

	/** Open and stream one Planner session, observing what the harness would see. */
	async function open(channelId: string, harness?: string) {
		let { owner, channel, deps } = fixture();
		let sessionId = "";
		let instructions = "";
		let registered: ReturnType<typeof fullPlanner>;
		deps.agent = {
			createSession: async (options: { sessionId: string }) => {
				sessionId = options.sessionId;
				return { destroy: async () => {} };
			},
			stream: async (call: { options: { instructions: string } }) => {
				instructions = call.options.instructions;
				registered = fullPlanner(sessionId);
			},
		} as never;
		let opened = await openPlannerSession(owner, {
			...channel,
			room: { id: channelId, plan: {}, server: {} } as never,
			harness,
			instructions: workspace => plannerInstructions("owner/repo", "BOOTSTRAP", workspace),
		}, deps);
		if (!opened.ok) throw new Error("Planner unavailable");
		await opened.value.stream("prompt", new AbortController().signal);
		await opened.value.destroy();
		expect(fullPlanner(sessionId)).toBeUndefined();
		expect(instructions).toContain("BOOTSTRAP");
		return { registered: registered!, instructions };
	}

	it("reuses a channel's remembered checkout for every later atomic session while it verifies", async () => {
		let path = await checkout("workgit:owner/repo.git");
		rememberCheckout("channel", path);
		for (let attempt of [1, 2]) {
			let { registered, instructions } = await open("channel", "atomic");
			expect({ attempt, cwd: registered?.cwd }).toEqual({ attempt, cwd: path });
			expect(registered?.humanInput.questionnaire).toBeFunction();
			expect(instructions).toContain(`${path}, is a local checkout of owner/repo`);
			expect(instructions).toContain("proceed on your best judgement");
			expect(instructions).toContain("never tell them to use `/workflow connect`");
			expect(instructions).toContain("Chat shows a card for each run");
			expect(instructions).not.toContain("You have no shell");
		}
		let git = Bun.spawn(["git", "-C", path, "remote", "set-url", "origin", "workgit:other/repo"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await git.exited).toBe(0);
		let fallback = await open("channel", "atomic");
		expect(fallback.registered?.cwd).not.toBe(path);
		expect(await readdir(fallback.registered!.cwd)).toEqual([]);
		expect(fallback.instructions).toContain("scratch directory Chopin keeps");
	});

	it("gives each atomic channel without a checkout its own private directory that outlives shutdown", async () => {
		let first = await open("first", "atomic");
		let again = await open("first", "atomic");
		let second = await open("second", "atomic");
		expect(again.registered?.cwd).toBe(first.registered!.cwd);
		expect(second.registered?.cwd).not.toBe(first.registered!.cwd);
		for (
			let [name, { registered, instructions }] of [["first", first], ["second", second]] as const
		) {
			let cwd = registered!.cwd;
			if (process.platform === "linux") expect(cwd).toBe(join(stateDirectory(), "planner", name));
			expect((await stat(cwd)).mode & 0o777).toBe(0o700);
			expect(await readdir(cwd)).toEqual([]);
			expect(registered?.humanInput.questionnaire).toBeFunction();
			expect(instructions).toContain(`${cwd}, is a scratch directory Chopin keeps`);
			expect(instructions).toContain("holds no repository files");
			expect(instructions).toContain("`read_repository_file`");
			expect(instructions).toContain("proceed on your best judgement");
			expect(instructions).toContain("never tell them to use `/workflow connect`");
			expect(instructions).toContain("Chat shows a card for each run");
		}
		forgetWorkspaces();
		expect((await stat(first.registered!.cwd)).isDirectory()).toBe(true);
		expect((await open("first", "atomic")).registered?.cwd).toBe(first.registered!.cwd);
	});

	it("refuses a symlink planted where a channel's directory belongs", async () => {
		if (process.platform !== "linux") return;
		let target = await mkdtemp(join(tmpdir(), "chopin-planner-target-"));
		roots.push(target);
		await mkdir(join(stateDirectory(), "planner"), { recursive: true });
		await symlink(target, join(stateDirectory(), "planner", "planted"));
		await expect(open("planted", "atomic")).rejects.toThrow();
	});

	it("keeps copilot-sdk and pi Planner sessions isolated, whatever the channel remembers", async () => {
		rememberCheckout("channel", await checkout("workgit:owner/repo.git"));
		for (let harness of ["copilot-sdk", "pi", undefined]) {
			let { registered, instructions } = await open("channel", harness);
			expect(registered).toBeUndefined();
			expect(instructions).toContain("You have no shell");
			expect(instructions).not.toContain("proceed on your best judgement");
			expect(instructions).not.toContain("/workflow connect");
		}
	});
});
