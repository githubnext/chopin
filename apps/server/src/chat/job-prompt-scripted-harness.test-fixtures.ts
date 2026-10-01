import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Chat from "./service";
import * as Plan from "../plan/service";
import * as Questions from "../questions/service";
import { openPlan } from "../testing/plan";
import { authenticatedMemory } from "./job-authenticated-memory.test-fixtures";
import { createPlannerAgent } from "../harness/agents";
import { openPlannerSession } from "../harness/session";
import { PROMPT_FOR } from "../conversation-plan/job-prompts";
import { createPromptScriptedHarness } from "../../../../e2e/harness/scripted-planner";
import type { ConversationPlan } from "@chopin/protocol";

export async function promptScripted(kind: "heading" | "refine", script: unknown) {
	let opened = await openPlan(kind === "heading" ? "\n" : "Opening prose.\n\nLater prose.\n");
	let plan = opened.plan;
	let target = kind === "heading" ? "document" : await Questions.insertConversationCard(
		plan,
		opened.server,
		opened.channel.id,
		{
			threadId: "prompt-thread",
			header: "Authentication",
			question: "What auth should we use?",
			options: [],
		},
	);
	plan.chat.entries.push({
		id: "m1",
		author: { kind: "member", handle: "ana" },
		text: "Choose authentication for a small pilot.",
		ts: 1,
	});
	await Plan.persist(plan);
	await Plan.close(plan);
	plan = await Plan.open(opened.channel.id, opened.backend, opened.server);
	opened.plan = plan;
	let dir = await mkdtemp(join(tmpdir(), "prompt-scripted-sdk-"));
	await writeFile(join(dir, `${kind}.json`), JSON.stringify(script));
	let identity = await authenticatedMemory(opened, kind);
	async function saved() {
		let stored = await opened.storage.collaboration.load(opened.channel.id, opened.now);
		if (!stored) throw new Error("missing durable document");
		let state = stored.sidecar;
		if (
			!state || typeof state !== "object" || Array.isArray(state) || !Array.isArray(state.questions)
		) throw new Error("missing durable questions");
		return {
			source: (await Plan.readStored(stored)).source,
			record: state.questions.map(Questions.normalizeRecord).find(record => record.id === target),
			revision: state.revision,
		};
	}
	let observations: Array<
		{
			toolName: string;
			output: unknown;
			revision: number;
			saved: Awaited<ReturnType<typeof saved>>;
		}
	> = [];
	let driver = createPromptScriptedHarness(dir, {
		onResult: async result => {
			observations.push({
				toolName: result.toolName,
				output: result.output,
				revision: plan.revision,
				saved: await saved(),
			});
		},
	});
	let agent = createPlannerAgent(driver.fake, kind);
	let sessionId: string | undefined;
	let setups: Array<{ command: string; directory: string }> = [];
	let unexpectedCommands = 0;
	let sandboxDestroys = 0;
	let credentialReleases = 0;
	identity.context.openPlannerSession = (owner, channel) =>
		openPlannerSession(owner, channel, {
			headingAgent: kind === "heading" ? agent : undefined,
			refineAgent: kind === "refine" ? agent : undefined,
			githubTools: async () => ({ ok: true, value: {} }),
			createSandbox: async () =>
				({
					defaultWorkingDirectory: "/tmp",
					async run(
						options: { command: string; env?: Record<string, string>; abortSignal?: AbortSignal },
					) {
						let directory = `/tmp/${encodeURIComponent(driver.fake.harnessId)}-${
							encodeURIComponent(sessionId ?? "")
						}`;
						if (
							sessionId && setups.length === 0 && options.command === 'mkdir -p "$WORK_DIR"'
							&& Object.keys(options.env ?? {}).length === 1 && options.env?.WORK_DIR === directory
							&& Object.keys(options).every(key => ["command", "env", "abortSignal"].includes(key))
						) {
							setups.push({ command: options.command, directory });
							return { exitCode: 0, stdout: "", stderr: "" };
						}
						unexpectedCommands++;
						throw new Error("unexpected prompt-scripted sandbox command");
					},
					async destroy() {
						sandboxDestroys++;
					},
				}) as never,
			registerCredential: id => {
				sessionId = id;
				return () => {
					credentialReleases++;
				};
			},
		});
	let job: ConversationPlan.Job = {
		id: `${kind}:${target}:m1`,
		kind,
		target,
		trigger: "m1",
		status: "running",
		attempts: 0,
		at: "2026-09-25T10:00:00.000Z",
	};
	let prompt = PROMPT_FOR[kind]!(plan, job);
	let closing: Promise<void> | undefined;
	return {
		opened,
		plan,
		target,
		identity,
		driver,
		observations,
		job,
		prompt,
		saved,
		counts: () => ({
			setups: setups.length,
			unexpectedCommands,
			sandboxDestroys,
			credentialReleases,
		}),
		run: () => Chat.job(identity.context, job, prompt, identity.sessionId),
		close() {
			return closing ??= (async () => {
				identity.revokeAll();
				try {
					await driver.fake.shutdown();
					await plan.chat.running;
					await Plan.close(plan);
				} finally {
					await rm(dir, { recursive: true, force: true });
				}
			})();
		},
	};
}
