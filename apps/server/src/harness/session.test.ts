import { describe, expect, it } from "bun:test";
import { openPlannerSession } from "./session";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fullPlanner } from "./atomic/full";
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
	it("registers full Planner input only for verified checkouts and releases it with the session", async () => {
		let cwd = await mkdtemp(join(tmpdir(), "chopin-planner-session-"));
		try {
			for (
				let args of [["init", "--quiet"], ["remote", "add", "origin", "workgit:owner/repo.git"]]
			) {
				expect(
					await Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" }).exited,
				).toBe(0);
			}
			for (let checkouts of [[cwd], []]) {
				let { owner, channel, deps } = fixture();
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
					atomicPlanner: { checkouts },
					instructions: checkout => plannerInstructions("owner/repo", "BOOTSTRAP", checkout),
				}, deps);
				expect(opened.ok).toBe(true);
				if (!opened.ok) throw new Error("Planner unavailable");
				await opened.value.stream("prompt", new AbortController().signal);
				expect(instructions).toContain("BOOTSTRAP");
				if (checkouts.length) {
					expect(fullPlanner(sessionId)?.cwd).toBe(cwd);
					expect(fullPlanner(sessionId)?.humanInput.questionnaire).toBeFunction();
					expect(instructions).toContain(cwd);
					expect(instructions).not.toContain("You have no shell");
				} else {
					expect(fullPlanner(sessionId)).toBeUndefined();
					expect(instructions).toContain("You have no shell");
				}
				await opened.value.destroy();
				expect(fullPlanner(sessionId)).toBeUndefined();
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
