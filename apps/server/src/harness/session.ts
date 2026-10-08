import { BACKGROUND_TOOL_NAMES, PLANNER_TOOL_NAMES } from "./tool-names";
import { createJustBashNetworkSandboxSession } from "@ai-sdk/sandbox-just-bash";
import { headingPlannerAgent, plannerAgent, prosePlannerAgent, refinePlannerAgent } from "./agents";
import { githubTools, type GitHubToolsError, type Result } from "./github-tools";
import { registerCredential } from "./harnesses";
import {
	type FullPlanner,
	pauseOwnedRuns,
	type PlannerRuns,
	registerFullPlanner,
	resumeOwnedRuns,
	untilUnpaused,
} from "./atomic/full";
import { createHumanInput } from "./atomic/human-input";
import { type PlannerWorkspace, plannerWorkspace } from "./atomic/workspace";

import type { HarnessAgent } from "@ai-sdk/harness/agent";
import type { ActiveOwnerBinding } from "../agent/active-owner";
import type { HostedRepository } from "../agent/repository";
import type { DocumentRoom } from "../agent/tools";

export type OpenError =
	| GitHubToolsError
	| { kind: "HarnessCapabilityUnsupported"; cause: unknown }
	| { kind: "Timeout"; cause: unknown }
	| { kind: "ShuttingDown"; cause: unknown };

type Sandbox = Awaited<ReturnType<typeof createJustBashNetworkSandboxSession>>;

type PlannerAgent = typeof plannerAgent;

export type PlannerChannel = {
	room: DocumentRoom;
	repository: HostedRepository;
	instructions: string | ((workspace?: PlannerWorkspace) => string);
	model?: string;
	/** `atomic` runs the session as a full Atomic session in the channel's workspace. */
	harness?: string;
};

/** Atomic answers an action it could not carry out with `noop` or `cancelled`; report it rather than claim success. */
function applied(outcome: { status: string; message: string }): void {
	if (outcome.status === "noop" || outcome.status === "cancelled") throw new Error(outcome.message);
}

export type PlannerSession = {
	/** The tools this session offers; a full Atomic session reports the set of its running turn. */
	activeTools?: readonly string[];
	stream: (prompt: string, abortSignal: AbortSignal) => ReturnType<PlannerAgent["stream"]>;
	destroy: () => Promise<void>;
	/** Workflow runs this session owns; only atomic Planner sessions report them. */
	runs?: () => PlannerRuns | undefined;
	/** Subscribes to run changes; returns the unsubscribe function. */
	watchRuns?: (listener: (runs: PlannerRuns) => void) => () => void;
	/** Pauses every workflow run this session owns, resumably. */
	pauseRuns?: () => Promise<void>;
	/** Resumes the runs this session paused. */
	resumeRuns?: () => Promise<void>;
	/** Pauses one run this session owns. */
	pauseRun?: (runId: string) => Promise<void>;
	/** Resumes one paused run this session owns. */
	resumeRun?: (runId: string) => Promise<void>;
};

export type PlannerSessionDependencies = {
	agent?: PlannerAgent;
	headingAgent?: PlannerAgent;
	refineAgent?: PlannerAgent;
	proseAgent?: PlannerAgent;
	githubTools?: typeof githubTools;
	createSandbox?: () => Promise<Sandbox>;
	registerCredential?: typeof registerCredential;
	timeoutMs?: number;
};

export async function openPlannerSession(
	owner: ActiveOwnerBinding,
	channel: PlannerChannel,
	deps: PlannerSessionDependencies = {},
): Promise<Result<PlannerSession, OpenError>> {
	let job = channel.room.plan.chat?.job;
	if (job && !Object.hasOwn(BACKGROUND_TOOL_NAMES, job.kind)) {
		return {
			ok: false,
			error: {
				kind: "Unavailable",
				cause: new Error(`Background ${job.kind} tools are not available`),
			},
		};
	}
	try {
		if (owner.signal.aborted || !await owner.revalidate()) {
			return {
				ok: false,
				error: { kind: "Unavailable", cause: new Error("Planner owner unavailable") },
			};
		}
	} catch (cause) {
		return { ok: false, error: { kind: "Unavailable", cause } };
	}
	let tools: Awaited<ReturnType<typeof githubTools>>;
	try {
		tools = await (deps.githubTools ?? githubTools)(owner);
	} catch (cause) {
		return { ok: false, error: { kind: "Unavailable", cause } };
	}
	if (!tools.ok) return tools;
	let sandbox: Sandbox;
	try {
		sandbox = await (deps.createSandbox ?? createJustBashNetworkSandboxSession)();
	} catch (cause) {
		return { ok: false, error: { kind: "Unavailable", cause } };
	}
	let unregister: (() => void) | undefined;
	let unregisterFull: (() => void) | undefined;
	let session: Awaited<ReturnType<HarnessAgent["createSession"]>> | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		if (owner.signal.aborted) throw new Error("Planner owner unavailable");
		let sessionId = crypto.randomUUID();
		unregister = (deps.registerCredential ?? registerCredential)(sessionId, owner.currentToken);
		// Background jobs keep the isolated boundary; only a Planner turn may run as a full session.
		let workspace = channel.harness === "atomic" && !job
			? await plannerWorkspace(channel.room.id, channel.repository)
			: undefined;
		let planner: FullPlanner | undefined;
		let listeners = new Set<(runs: PlannerRuns) => void>();
		if (workspace) {
			planner = {
				cwd: workspace.cwd,
				humanInput: createHumanInput(
					channel.room,
					undefined,
					(runId, signal) => untilUnpaused(planner!, runId, signal),
				),
				onRuns: runs => {
					for (let listener of listeners) listener(runs);
				},
				toolReport: (id, output, state) => {
					let chat = channel.room.plan.chat;
					if (state === "running") chat?.toolProgress?.(id, output);
					else chat?.toolFinished?.(id, output, state === "done");
				},
			};
			unregisterFull = registerFullPlanner(sessionId, planner);
		}
		let instructions = typeof channel.instructions === "function"
			? channel.instructions(workspace)
			: channel.instructions;
		let agent = deps.agent ?? (job?.kind === "heading"
			? deps.headingAgent ?? headingPlannerAgent
			: job?.kind === "refine" || job?.kind === "suggest"
			? deps.refineAgent ?? refinePlannerAgent
			: job?.kind === "prose"
			? deps.proseAgent ?? prosePlannerAgent
			: plannerAgent);
		let opening = agent.createSession({ sessionId, sandboxSession: sandbox });
		let deadline = new Promise<never>((_, reject) => {
			timeout = setTimeout(
				() => reject(new Error("Planner session timed out")),
				deps.timeoutMs ?? 30_000,
			);
		});
		try {
			session = await Promise.race([opening, deadline]);
		} catch (cause) {
			void opening.then(late => late.destroy()).catch(() => {});
			throw cause;
		}
		if (owner.signal.aborted) throw new Error("Planner owner unavailable");
		let active = session;
		let release = unregister;
		let stopped: Promise<void> | undefined;
		let workflows = () => {
			if (!planner?.workflows) {
				throw new Error("The Planner has no live Atomic session to control.");
			}
			return planner.workflows;
		};
		let runControl = planner
			? {
				runs: () => planner.runs,
				watchRuns: (listener: (runs: PlannerRuns) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				pauseRuns: () => pauseOwnedRuns(workflows()),
				resumeRuns: () => resumeOwnedRuns(workflows()),
				pauseRun: async (runId: string) => applied(await workflows().pause(runId)),
				resumeRun: async (runId: string) => applied(await workflows().resume(runId)),
			}
			: {};
		let fixedTools = Object.freeze([
			...(job ? BACKGROUND_TOOL_NAMES[job.kind] : PLANNER_TOOL_NAMES),
		]);
		return {
			ok: true,
			value: {
				get activeTools() {
					return planner?.activeTools ?? fixedTools;
				},
				...runControl,
				stream: (prompt, abortSignal) =>
					agent.stream({
						session: active,
						prompt,
						abortSignal,
						options: {
							...channel,
							instructions,
							owner,
							githubTools: tools.value,
						},
					}),
				destroy: () =>
					stopped ??= (async () => {
						try {
							await active.destroy();
						} finally {
							try {
								await sandbox.destroy();
							} finally {
								release();
								unregisterFull?.();
							}
						}
					})(),
			},
		};
	} catch (cause) {
		try {
			await session?.destroy();
		} catch (cleanupError) {
			console.error("[agent] Planner session cleanup failed:", cleanupError);
		}
		try {
			await sandbox.destroy();
		} catch (cleanupError) {
			console.error("[agent] Planner sandbox cleanup failed:", cleanupError);
		}
		unregister?.();
		unregisterFull?.();
		let message = cause instanceof Error ? cause.message : String(cause);
		let kind: "Timeout" | "ShuttingDown" | "HarnessCapabilityUnsupported" | "Unavailable" =
			message.includes("timed out")
				? "Timeout"
				: message.includes("shutting down")
				? "ShuttingDown"
				: message.includes("capability") || message.includes("unsupported")
				? "HarnessCapabilityUnsupported"
				: "Unavailable";
		return { ok: false, error: { kind, cause } };
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
