import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPlannerSession } from "./session";
import { fullPlanner } from "./atomic/full";
import { forgetWorkspaces, rememberCheckout, stateDirectory } from "./atomic/workspace";
import { plannerInstructions } from "../agent/planner";
import { BACKGROUND_TOOL_NAMES, PLANNER_TOOL_NAMES, VISUAL_PLANNER_TOOL_NAMES } from "./tool-names";
import { remotePlanner } from "./remote/registry";
import { hostInputRoom } from "../testing/decisions";
import { limits } from "@chopin/question";

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
	it("uses the visual Planner profile only when the room has Jev routing", async () => {
		let { owner, channel, deps } = fixture();
		let visualOpened = false;
		deps.agent = undefined;
		channel.room = {
			id: "channel",
			plan: {},
			server: {},
			visual: {
				ask: async () => {
					throw new Error("unused");
				},
			},
		} as never;
		deps.visualAgent = {
			createSession: async () => {
				visualOpened = true;
				return { destroy: async () => {} };
			},
		} as never;
		let opened = await openPlannerSession(owner, channel, deps);
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(visualOpened).toBe(true);
		expect(opened.value.activeTools).toEqual(VISUAL_PLANNER_TOOL_NAMES);
		await opened.value.destroy();
	});

	it("registers a remote Planner for its document, with Decisions and run control on the client", async () => {
		let { owner, channel, deps } = fixture();
		let room = await hostInputRoom();
		let sessionId = "";
		let instructions = "";
		deps.agent = {
			createSession: async (options: { sessionId: string }) => {
				sessionId = options.sessionId;
				return { destroy: async () => {} };
			},
			stream: async (call: { options: { instructions: string } }) => {
				instructions = call.options.instructions;
			},
		} as never;
		let opened = await openPlannerSession(owner, {
			...channel,
			room: room.room,
			harness: "remote",
			instructions: workspace => plannerInstructions("owner/repo", "BOOTSTRAP", workspace),
		}, deps);
		if (!opened.ok) throw new Error("Planner unavailable");
		let session = opened.value;
		let registered = remotePlanner(sessionId)!;
		try {
			expect(registered).toMatchObject({ channelId: room.room.id, isolated: false });
			await session.stream("prompt", new AbortController().signal);
			expect(instructions).toContain("You run in a member's own session on their machine");
			expect(instructions).toContain("BOOTSTRAP");

			let delays: unknown[] = [];
			let original = globalThis.setTimeout;
			globalThis.setTimeout = ((handler: () => void, ms?: number) => {
				delays.push(ms);
				return original(handler, ms);
			}) as typeof setTimeout;
			let asked: Promise<unknown>;
			try {
				asked = registered.humanInput!(() => {}).confirm("Ship?", "Now.", room.options);
				await room.cards(1);
			} finally {
				globalThis.setTimeout = original;
			}
			expect(delays).toContain(limits.INPUT_EXPIRY_MS);
			room.controller.abort();
			expect(await asked).toBe(false);

			let seen: unknown[] = [];
			session.watchRuns!(runs => seen.push(runs));
			let runs = { active: ["run"], paused: [], cards: [] };
			registered.runs = runs;
			registered.onRuns!(runs);
			expect(seen).toEqual([runs]);
			expect(session.runs!()).toBe(runs);
			await expect(session.pauseRuns!()).rejects.toThrow("no attached session to control");
			let controls: unknown[] = [];
			registered.control = async (action, runId) => void controls.push([action, runId]);
			await session.pauseRuns!();
			await session.resumeRun!("run");
			expect(controls).toEqual([["stop", undefined], ["resume", "run"]]);
			registered.activeTools = ["read_plan", "bash"];
			expect(session.activeTools).toEqual(["read_plan", "bash"]);
		} finally {
			await session.destroy();
			await room.close();
		}
		expect(remotePlanner(sessionId)).toBeUndefined();
	});

	it("keeps a remote background job isolated, without Decisions or run control", async () => {
		let { owner, channel, deps } = fixture();
		let sessionId = "";
		let instructions = "";
		deps.headingAgent = {
			createSession: async (options: { sessionId: string }) => {
				sessionId = options.sessionId;
				return { destroy: async () => {} };
			},
			stream: async (call: { options: { instructions: string } }) => {
				instructions = call.options.instructions;
			},
		} as never;
		deps.agent = undefined;
		let opened = await openPlannerSession(owner, {
			...channel,
			room: { id: "channel", plan: { chat: { job: { kind: "heading" } } }, server: {} } as never,
			harness: "remote",
			instructions: workspace => plannerInstructions("owner/repo", undefined, workspace),
		}, deps);
		if (!opened.ok) throw new Error("Planner unavailable");
		expect(remotePlanner(sessionId)).toMatchObject({ channelId: "channel", isolated: true });
		expect(remotePlanner(sessionId)!.humanInput).toBeUndefined();
		expect(opened.value.pauseRuns).toBeUndefined();
		expect(opened.value.activeTools).toEqual(BACKGROUND_TOOL_NAMES.heading);
		await opened.value.stream("prompt", new AbortController().signal);
		expect(instructions).toContain("You have no shell");
		await opened.value.destroy();
		expect(remotePlanner(sessionId)).toBeUndefined();
	});

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

	it("opens a document session while GitHub discovery is unresolved", async () => {
		let { owner, channel, deps } = fixture();
		let discovery = Promise.withResolvers<
			Awaited<ReturnType<NonNullable<typeof deps.githubTools>>>
		>();
		let invoked = Promise.withResolvers<void>();
		deps.githubTools = () => {
			invoked.resolve();
			return discovery.promise;
		};
		let pending = openPlannerSession(owner, channel, deps);
		let first = await Promise.race([
			pending.then(() => "opened" as const),
			invoked.promise.then(() => "discovery invoked" as const),
		]);
		discovery.resolve({ ok: true, value: {} });
		let opened = await pending;
		if (opened.ok) await opened.value.destroy();
		expect(opened.ok).toBe(true);
		expect(first).toBe("opened");
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
			expect(instructions).toContain("Chat shows a card for each workflow run you start");
			expect(instructions).toContain("`intercom` tool can reach other sessions");
			expect(instructions).toContain("one working in a checkout of owner/repo");
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
			expect(instructions).toContain("Chat shows a card for each workflow run you start");
			expect(instructions).toContain("one working in a checkout of owner/repo");
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

	it("keeps copilot-sdk Planner sessions isolated, whatever the channel remembers", async () => {
		rememberCheckout("channel", await checkout("workgit:owner/repo.git"));
		for (let harness of ["copilot-sdk", undefined]) {
			let { registered, instructions } = await open("channel", harness);
			expect(registered).toBeUndefined();
			expect(instructions).toContain("You have no shell");
			expect(instructions).not.toContain("proceed on your best judgement");
			expect(instructions).not.toContain("/workflow connect");
			expect(instructions).not.toContain("intercom");
		}
	});
});

it("member Planner sessions include the child tools and background jobs never do", () => {
	for (let name of ["list_children", "read_child", "edit_child", "anchor_child"]) {
		expect(PLANNER_TOOL_NAMES).toContain(name);
		expect(VISUAL_PLANNER_TOOL_NAMES).toContain(name);
		for (let names of Object.values(BACKGROUND_TOOL_NAMES)) expect(names).not.toContain(name);
	}
});
