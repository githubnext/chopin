import * as Chat from "../chat/service";
import * as Plan from "../plan/service";
import * as Questions from "../questions/service";
import * as Jobs from "./jobs";
import { authenticatedMemory } from "../chat/job-authenticated-memory.test-fixtures";
import { ActiveOwnerBindings } from "../agent/active-owner";
import { createPlannerAgent } from "../harness/agents";
import { openPlannerSession } from "../harness/session";
import { createPlannerJobs } from "./planner-jobs";
import { createScriptedHarness } from "./scripted-harness.test-driver";
import { PROMPT_FOR } from "./job-prompts";
import type { openPlan } from "../testing/plan";

type Opened = Awaited<ReturnType<typeof openPlan>>;

export async function scriptedRefine(
	opened: Opened,
	dir: string,
	id: string,
	authentication?: Awaited<ReturnType<typeof authenticatedMemory>>,
) {
	let plan = opened.plan;
	async function saved() {
		let stored = await opened.storage.collaboration.load(opened.channel.id, opened.now);
		if (!stored) throw new Error("missing durable document");
		let state = stored.sidecar;
		if (!state || typeof state !== "object" || Array.isArray(state)) {
			throw new Error("missing durable sidecar");
		}
		if (!Array.isArray(state.questions) || !Array.isArray(state.transcript)) {
			throw new Error("missing durable card or transcript");
		}
		Jobs.restore(state.conversationPlanJobs);
		return {
			source: (await Plan.readStored(stored)).source,
			record: state.questions.map(Questions.normalizeRecord).find(record => record.id === id),
			jobs: structuredClone(state.conversationPlanJobs ?? []) as typeof plan.conversationPlanJobs,
			transcript: state.transcript,
		};
	}
	let latest = await saved();
	let commits: Array<typeof latest> = [];
	let commit = opened.storage.collaboration.commit;
	opened.storage.collaboration.commit = async input => {
		let result = await commit(input);
		latest = await saved();
		commits.push(latest);
		return result;
	};
	let publications: Array<{ frame: Record<string, unknown>; saved: typeof latest }> = [];
	let publish = opened.server.publish;
	opened.server.publish = (...args) => {
		publications.push({
			frame: JSON.parse(String(args[1])),
			saved: structuredClone(latest),
		});
		return publish(...args);
	};
	let identity = authentication ?? await authenticatedMemory(opened, "refine");
	let owners = new ActiveOwnerBindings(identity.context.auth);
	let context: Chat.Room = {
		...identity.context,
		plan,
		chat: plan.chat,
		persist: () => Plan.persist(plan),
		activeOwner: () => owners.resolve(opened.channel.id),
	};
	let resultSnapshots: Array<
		Promise<{ output: unknown; saved: Awaited<ReturnType<typeof saved>> }>
	> = [];
	let driver = createScriptedHarness(dir, plan, {
		onResult: async result => {
			let snapshot = saved().then(saved => ({ output: result.output, saved }));
			resultSnapshots.push(snapshot);
			await snapshot;
		},
	});
	let agent = createPlannerAgent(driver.fake, "refine");
	let sessionId: string | undefined;
	let setups = 0;
	let unexpectedCommands = 0;
	let sandboxDestroys = 0;
	let credentialReleases = 0;
	context.openPlannerSession = (owner, channel) =>
		openPlannerSession(owner, channel, {
			refineAgent: agent,
			githubTools: async () => ({ ok: true, value: {} }),
			createSandbox: async () =>
				({
					defaultWorkingDirectory: "/tmp",
					async run(options: {
						command: string;
						env?: Record<string, string>;
						abortSignal?: AbortSignal;
					}) {
						let directory = `/tmp/${encodeURIComponent(driver.fake.harnessId)}-${
							encodeURIComponent(sessionId ?? "")
						}`;
						if (
							sessionId && setups === 0 && options.command === 'mkdir -p "$WORK_DIR"'
							&& Object.keys(options.env ?? {}).length === 1
							&& options.env?.WORK_DIR === directory
							&& Object.keys(options).every(key => ["command", "env", "abortSignal"].includes(key))
						) {
							setups++;
							return { exitCode: 0, stdout: "", stderr: "" };
						}
						unexpectedCommands++;
						throw new Error("unexpected scripted sandbox command");
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
	let errors: unknown[] = [];
	let jobs = createPlannerJobs({
		plan,
		exclusive: action => Plan.exclusive(plan, action),
		persist: () => Plan.persistExclusive(plan),
		runner: (job, prompt, signal) => Chat.job(context, job, prompt, identity.sessionId, signal),
		prompt: job => PROMPT_FOR[job.kind]?.(plan, job),
		publishJobs: current =>
			opened.server.publish(
				opened.channel.id,
				JSON.stringify({
					kind: "conversation-plan:jobs",
					jobs: current,
				}),
			),
		publishMeta: target => Questions.announce(plan, opened.server, opened.channel.id, target),
		activity: async text => {
			await Chat.noticeExclusive(context, text);
		},
		onError: error => errors.push(error),
	});
	let closing: Promise<void> | undefined;
	return {
		plan,
		jobs,
		driver,
		identity,
		errors,
		saved,
		results: () => Promise.all(resultSnapshots),
		publications,
		commits,
		counts: () => ({ setups, unexpectedCommands, sandboxDestroys, credentialReleases }),
		close() {
			return closing ??= (async () => {
				jobs.stop();
				owners.revokeAll();
				identity.revokeAll();
				await jobs.idle();
				await plan.chat.running;
				try {
					await Promise.all(resultSnapshots);
					await Plan.close(plan);
				} finally {
					opened.storage.collaboration.commit = commit;
					opened.server.publish = publish;
				}
			})();
		},
	};
}
