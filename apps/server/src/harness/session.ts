import { BACKGROUND_TOOL_NAMES, PLANNER_TOOL_NAMES, VISUAL_PLANNER_TOOL_NAMES } from "./tool-names";
import { createJustBashNetworkSandboxSession } from "@ai-sdk/sandbox-just-bash";
import {
	decisionFollowupPlannerAgent,
	headingPlannerAgent,
	plannerAgent,
	prosePlannerAgent,
	refinePlannerAgent,
	visualPlannerAgent,
} from "./agents";
import { githubTools, type GitHubToolsError, lazyGithubTools, type Result } from "./github-tools";
import { registerCredential } from "./harnesses";
import {
	type FullPlanner,
	pauseOwnedRuns,
	type PlannerRuns,
	registerFullPlanner,
	resumeOwnedRuns,
	untilUnpaused,
} from "./atomic/full";
import { createHumanInput, PendingInputs } from "./atomic/human-input";
import { type PlannerWorkspace, plannerWorkspace } from "./atomic/workspace";
import { registerRemotePlanner, type RemotePlanner } from "./remote/registry";
import { promptWithAttachments } from "../chat/attachment-prompt";
import type { SentAttachment } from "../chat/attachment-prompt";
import { startingTurn } from "./turn-level";

import type { HarnessAgent } from "@ai-sdk/harness/agent";
import type { ActiveOwnerBinding } from "../agent/active-owner";
import type { HostedRepository } from "../agent/repository";
import type { DocumentRoom } from "../agent/tools";
import type { RemoteWorkspace } from "../agent/planner";

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
	instructions: string | ((workspace?: PlannerWorkspace | RemoteWorkspace) => string);
	model?: string;
	/**
	 * `atomic` runs the session as a full Atomic session in the channel's workspace;
	 * `remote` runs it in the client attached to the channel.
	 */
	harness?: string;
};

/** Atomic answers an action it could not carry out with `noop` or `cancelled`; report it rather than claim success. */
function applied(outcome: { status: string; message: string }): void {
	if (outcome.status === "noop" || outcome.status === "cancelled") throw new Error(outcome.message);
}

export type PlannerChoice = { model?: string; thinkingLevel?: string };

/**
 * The images and files sent with the message that began a turn, and whether its model reads
 * images. The first attempt of a turn is given them with its prompt; a repair is not.
 */
export type PlannerFiles = {
	attachments: readonly SentAttachment[];
	readsImages: boolean;
};

export type PlannerSession = {
	/** The tools this session offers; a full Atomic session reports the set of its running turn. */
	activeTools?: readonly string[];
	/**
	 * Runs one turn. `choice` is what a person chose for the document, already checked against the
	 * harness's catalog: the model replaces the channel's, and the thinking level goes to the
	 * harness that offers one. Background jobs never pass one.
	 */
	stream: (
		prompt: string,
		abortSignal: AbortSignal,
		choice?: PlannerChoice,
		files?: PlannerFiles,
	) => ReturnType<PlannerAgent["stream"]>;
	destroy: () => Promise<void>;
	/**
	 * The questions this session asked that no member has answered yet, and the requests whose
	 * result its client has not received. A session with either is kept past a turn that ended
	 * without it, as one that owns a workflow run is.
	 */
	inputs?: Pick<PendingInputs, "open" | "held" | "watch">;
	/** Workflow runs this session owns; only atomic and remote Planner sessions report them. */
	runs?: () => PlannerRuns | undefined;
	/** Subscribes to run changes; returns the unsubscribe function. */
	watchRuns?: (listener: (runs: PlannerRuns) => void) => () => void;
	/**
	 * Whether the client that runs this session lost its link unexpectedly and may still come
	 * back: nothing it holds has ended, so the session is kept, however long that takes, until it
	 * does or something explicit ends it.
	 */
	suspended?: () => boolean;
	/** Whether the server is going down, so what its links close says nothing about the client. */
	shuttingDown?: () => boolean;
	/** Takes the binding of the owner's renewed credential in place of one that ended. */
	rebind?: (owner: ActiveOwnerBinding) => void;
	/** Calls `listener` when `suspended` changes; returns the unsubscribe function. */
	watchLink?: (listener: () => void) => () => void;
	/**
	 * Pauses every workflow run this session owns, resumably. Resolves `held` when it could not
	 * reach the client that runs them and waits to tell it when it returns.
	 */
	pauseRuns?: () => Promise<void | "held" | "unconfirmed">;
	/** Resumes the runs this session paused. */
	resumeRuns?: () => Promise<void>;
	/** Pauses one run this session owns; `held` as for `pauseRuns`. */
	pauseRun?: (runId: string) => Promise<void | "held" | "unconfirmed">;
	/** Resumes one paused run this session owns. */
	resumeRun?: (runId: string) => Promise<void>;
	/**
	 * Whether a run that ends blocked or failed between turns starts a Planner turn
	 * about it. A remote Planner's runs are only what its client reports, so they
	 * never start a turn no writer asked for.
	 */
	followsUpRuns?: boolean;
};

/** Run control for a remote Planner: the attached client stops and resumes its own runs. */
function remoteRunControl(
	remote: RemotePlanner,
	watchRuns: NonNullable<PlannerSession["watchRuns"]>,
): Pick<
	PlannerSession,
	"runs" | "watchRuns" | "pauseRuns" | "resumeRuns" | "pauseRun" | "resumeRun" | "followsUpRuns"
> {
	let control = () => {
		if (!remote.control) throw new Error("The Planner has no attached session to control.");
		return remote.control;
	};
	return {
		runs: () => remote.runs,
		watchRuns,
		pauseRuns: async () => control()("stop"),
		resumeRuns: async () => void await control()("resume"),
		pauseRun: async runId => control()("stop", runId),
		resumeRun: async runId => void await control()("resume", runId),
		followsUpRuns: false,
	};
}

export type PlannerSessionDependencies = {
	agent?: PlannerAgent;
	headingAgent?: PlannerAgent;
	refineAgent?: PlannerAgent;
	proseAgent?: PlannerAgent;
	followupAgent?: PlannerAgent;
	visualAgent?: PlannerAgent;
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
	let current = owner;
	let tools = lazyGithubTools(current, deps.githubTools ?? githubTools);
	let sandbox: Sandbox;
	try {
		sandbox = await (deps.createSandbox ?? createJustBashNetworkSandboxSession)();
	} catch (cause) {
		return { ok: false, error: { kind: "Unavailable", cause } };
	}
	let unregister: (() => void) | undefined;
	let unregisterFull: (() => void) | undefined;
	let unregisterRemote: (() => void) | undefined;
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
		let linkListeners = new Set<() => void>();
		let inputs = new PendingInputs();
		if (workspace) {
			planner = {
				cwd: workspace.cwd,
				humanInput: createHumanInput(
					channel.room,
					(runId, signal) => untilUnpaused(planner!, runId, signal),
					undefined,
					inputs,
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
		let remote: RemotePlanner | undefined;
		if (channel.harness === "remote") {
			let held: RemotePlanner = { channelId: channel.room.id, isolated: !!job };
			if (!job) {
				held.humanInput = report =>
					createHumanInput(
						channel.room,
						(runId, signal) => untilUnpaused(held, runId, signal),
						report,
						inputs,
					);
				held.holdInput = () => inputs.hold();
				held.linkChanged = () => {
					for (let listener of linkListeners) listener();
				};
				held.onRuns = runs => {
					for (let listener of listeners) listener(runs);
				};
				held.toolReport = (id, output, state) => {
					let chat = channel.room.plan.chat;
					if (state === "running") chat?.toolProgress?.(id, output);
					else chat?.toolFinished?.(id, output, state === "done");
				};
			}
			remote = held;
			unregisterRemote = registerRemotePlanner(sessionId, held);
		}
		let instructions = typeof channel.instructions === "function"
			? channel.instructions(workspace ?? (remote && !job ? { remote: true } : undefined))
			: channel.instructions;
		let agent = deps.agent ?? (job?.kind === "heading"
			? deps.headingAgent ?? headingPlannerAgent
			: job?.kind === "refine" || job?.kind === "suggest"
			? deps.refineAgent ?? refinePlannerAgent
			: job?.kind === "prose"
			? deps.proseAgent ?? prosePlannerAgent
			: job?.kind === "decision-followup"
			? deps.followupAgent ?? decisionFollowupPlannerAgent
			: channel.room.visual
			? deps.visualAgent ?? visualPlannerAgent
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
		let stopped: Promise<void> | undefined;
		let workflows = () => {
			if (!planner?.workflows) {
				throw new Error("The Planner has no live Atomic session to control.");
			}
			return planner.workflows;
		};
		let watchRuns = (listener: (runs: PlannerRuns) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		};
		let runControl = planner
			? {
				runs: () => planner.runs,
				watchRuns,
				pauseRuns: () => pauseOwnedRuns(workflows()),
				resumeRuns: () => resumeOwnedRuns(workflows()),
				pauseRun: async (runId: string) => applied(await workflows().pause(runId)),
				resumeRun: async (runId: string) => applied(await workflows().resume(runId)),
			}
			: remote && !job
			? remoteRunControl(remote, watchRuns)
			: {};
		let fixedTools = Object.freeze([
			...(job
				? BACKGROUND_TOOL_NAMES[job.kind]
				: channel.room.visual
				? VISUAL_PLANNER_TOOL_NAMES
				: PLANNER_TOOL_NAMES),
		]);
		return {
			ok: true,
			value: {
				get activeTools() {
					return planner?.activeTools ?? remote?.activeTools ?? fixedTools;
				},
				...runControl,
				...(planner || remote && !job ? { inputs } : {}),
				...(remote && !job
					? {
						rebind: (renewed: ActiveOwnerBinding) => {
							unregister?.();
							current = renewed;
							tools = lazyGithubTools(current, deps.githubTools ?? githubTools);
							unregister = (deps.registerCredential ?? registerCredential)(
								sessionId,
								renewed.currentToken,
							);
						},
						suspended: () => remote.suspended === true,
						shuttingDown: () => remote.stopping === true,
						watchLink: (listener: () => void) => {
							linkListeners.add(listener);
							return () => linkListeners.delete(listener);
						},
					}
					: {}),
				stream: (prompt, abortSignal, choice, files) => {
					// The remote turn aborts it when the turn ends or the link drops mid-tool.
					let hostTools = remote ? new AbortController() : undefined;
					if (remote) remote.hostTools = hostTools;
					// The level is on this turn alone, as the model is: nothing is left for the next one.
					return startingTurn(choice?.thinkingLevel, () =>
						agent.stream({
							session: active,
							prompt: files?.attachments.length
								? [promptWithAttachments(prompt, files.attachments, files.readsImages)]
								: prompt,
							abortSignal,
							options: {
								...channel,
								...(choice?.model ? { model: choice.model } : {}),
								instructions,
								owner: current,
								githubTools: tools,
								...(hostTools ? { toolSignal: hostTools.signal } : {}),
							},
						}));
				},
				destroy: () =>
					stopped ??= (async () => {
						try {
							await active.destroy();
						} finally {
							try {
								await sandbox.destroy();
							} finally {
								unregister?.();
								unregisterFull?.();
								unregisterRemote?.();
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
		unregisterRemote?.();
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
