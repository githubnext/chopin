import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Chat from "./service";
import * as Plan from "../plan/service";
import { openPlan } from "../testing/plan";
import { authenticatedMemory } from "./job-authenticated-memory.test-fixtures";
import { createPlannerAgent } from "../harness/agents";
import { openPlannerSession } from "../harness/session";
import { createScriptedHarness } from "../conversation-plan/scripted-harness.test-driver";
import type { ConversationPlan } from "@chopin/protocol";

export function headingJob(): ConversationPlan.Job {
	return {
		id: "heading:document:m0",
		kind: "heading",
		target: "document",
		trigger: "m0",
		status: "running",
		attempts: 0,
		at: "2026-09-25T10:00:00.000Z",
	};
}

export async function scriptedHeading(script: unknown, held = false) {
	let opened = await openPlan("\n");
	let path = await mkdtemp(join(tmpdir(), "current-scripted-harness-"));
	await writeFile(join(path, "heading.json"), JSON.stringify(script));
	if (held) await writeFile(join(path, "heading.hold"), "hold");
	let identity = await authenticatedMemory(opened);
	let resultCheck: ((output: unknown) => Promise<void>) | undefined;
	let driver = createScriptedHarness(path, opened.plan, {
		onResult: async result => {
			await resultCheck?.(result.output);
		},
	});
	let agent = createPlannerAgent(driver.fake, "heading");
	let setupRequests: Array<{ command: string; directory: string }> = [];
	let unexpectedSandboxRuns = 0;
	let plannerSessionId: string | undefined;
	let sandboxDestroys = 0;
	let credentialReleases = 0;
	identity.context.openPlannerSession = (owner, channel) =>
		openPlannerSession(owner, channel, {
			headingAgent: agent,
			githubTools: async () => ({ ok: true, value: {} }),
			createSandbox: async () =>
				({
					defaultWorkingDirectory: "/tmp",
					async run(
						options: { command: string; env?: Record<string, string>; abortSignal?: AbortSignal },
					) {
						let directory = `/tmp/${encodeURIComponent(driver.fake.harnessId)}-${
							encodeURIComponent(plannerSessionId ?? "")
						}`;
						if (
							plannerSessionId && setupRequests.length === 0
							&& options.command === 'mkdir -p "$WORK_DIR"'
							&& Object.keys(options.env ?? {}).length === 1
							&& options.env?.WORK_DIR === directory
							&& Object.keys(options).every(key => ["command", "env", "abortSignal"].includes(key))
						) {
							setupRequests.push({ command: options.command, directory });
							return { exitCode: 0, stdout: "", stderr: "" };
						}
						unexpectedSandboxRuns++;
						throw new Error("scripted Harness must not execute unexpected sandbox commands");
					},
					async destroy() {
						sandboxDestroys++;
					},
				}) as never,
			registerCredential: sessionId => {
				plannerSessionId = sessionId;
				return () => {
					credentialReleases++;
				};
			},
		});
	let closing: Promise<void> | undefined;
	return {
		opened,
		identity,
		driver,
		context: identity.context,
		onResult(check: (output: unknown) => Promise<void>) {
			resultCheck = check;
		},
		setupRequests,
		plannerSessionId: () => plannerSessionId,
		counts: () => ({
			setupRequests: setupRequests.length,
			unexpectedSandboxRuns,
			sandboxDestroys,
			credentialReleases,
		}),
		async savedSource() {
			let stored = await opened.storage.collaboration.load(opened.channel.id, opened.now);
			if (!stored) throw new Error("missing durable document");
			return (await Plan.readStored(stored)).source;
		},
		run(signal?: AbortSignal) {
			return Chat.job(
				identity.context,
				headingJob(),
				"Draft the title and goal",
				identity.sessionId,
				signal,
			);
		},
		close() {
			return closing ??= (async () => {
				identity.revokeAll();
				try {
					await Plan.close(opened.plan);
				} finally {
					await rm(path, { recursive: true, force: true });
				}
			})();
		},
	};
}
