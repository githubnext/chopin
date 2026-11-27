import {
	BACKGROUND_TOOL_NAMES,
	PLANNER_TOOL_NAMES,
	REACTION_TOOL_NAMES,
	THREAD_NOTE_TOOL_NAME,
} from "./tool-names";
import { createJustBashNetworkSandboxSession } from "@ai-sdk/sandbox-just-bash";
import {
	decisionFollowupPlannerAgent,
	headingPlannerAgent,
	plannerAgent,
	prosePlannerAgent,
	reactionPlannerAgent,
	refinePlannerAgent,
	threadPlannerAgent,
} from "./agents";
import { githubTools, type GitHubToolsError, lazyGithubTools, type Result } from "./github-tools";
import { registerCredential } from "./harnesses";
import { type FullPlanner, registerFullPlanner } from "./atomic/full";
import { createHumanInput, PendingInputs } from "./atomic/human-input";
import { type PlannerWorkspace, plannerWorkspace } from "./atomic/workspace";
import { registerRemotePlanner, type RemotePlanner } from "./remote/registry";
import { promptWithAttachments } from "../chat/attachment-prompt";
import type { SentAttachment } from "../chat/attachment-prompt";
import type { TellChat } from "../chat/thread-notes";
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

export type PlannerForkHooks = {
	atomicEntries?: unknown[];
	atomicLeafId?: string | null;
	onAtomicEntries?: (entries: unknown[], leafId: string | null) => void;
	remoteFrom?: { session: string; turn?: string };
	onRemoteTurn?: (point: { session: string; turn: string }) => void;
};

export type PlannerChannel = {
	room: DocumentRoom;
	repository: HostedRepository;
	instructions:
		| string
		| ((
			workspace?: PlannerWorkspace | (RemoteWorkspace & { forkedNatively?: boolean }),
		) => string);
	model?: string;
	/**
	 * The document's chosen model and thinking level when the session opens, already checked against
	 * the harness's catalog. A remote client that offered `session-choice` makes its session on it,
	 * with `model` as the model where none was chosen, as each turn has; every turn still passes its
	 * own `choice` to `stream`.
	 */
	choice?: PlannerChoice;
	/**
	 * `atomic` runs the session as a full Atomic session in the channel's workspace;
	 * `remote` runs it in the client attached to the channel.
	 */
	harness?: string;
	/** Active Chat instance for tool progress and job state; defaults to `room.plan.chat`. */
	chat?: Pick<
		NonNullable<DocumentRoom["plan"]["chat"]>,
		"job" | "toolProgress" | "toolFinished"
	>;
	/** Session-tree and remote fork hooks for Chat threads. */
	fork?: PlannerForkHooks;
	/**
	 * A thread's full Atomic Planner only: sends the Chat Planner of the same document a note of
	 * what was decided in the thread, offered to its turns as `tell_chat_planner`.
	 */
	tellChat?: TellChat;
	/** An answer to a reader's reaction: no tools, isolated on every harness. */
	reader?: true;
};

export type PlannerChoice = { model?: string; thinkingLevel?: string };

/**
 * The images and files sent with the message that began a turn, and whether its model reads
 * images. The first attempt of a turn is given them with its prompt; a repair is not.
 */
export type PlannerFiles = {
	attachments: readonly SentAttachment[];
	readsImages: boolean;
};

/**
 * The Chat message a turn answers, and `retry` when the turn runs it again after an earlier turn
 * for it failed. A remote client that offered `retry-turn` is told both.
 */
export type PlannerTurnMessage = { id: string; retry?: true };

export type PlannerSession = {
	/** The tools this session offers; a full Atomic session reports the set of its running turn. */
	activeTools?: readonly string[];
	/**
	 * Runs one turn. `choice` is what a person chose for the document, already checked against the
	 * harness's catalog: the model replaces the channel's, and the thinking level goes to the
	 * harness that offers one. Every turn passes it, a background job's included. `context` is what
	 * cannot go before a prompt that opens with a command: an Atomic session records it in the
	 * session before the command so later turns keep it, and any other harness adds it to the turn's
	 * instructions.
	 */
	stream: (
		prompt: string,
		abortSignal: AbortSignal,
		choice?: PlannerChoice,
		files?: PlannerFiles,
		message?: PlannerTurnMessage,
		context?: string,
	) => ReturnType<PlannerAgent["stream"]>;
	destroy: () => Promise<void>;
	/**
	 * Gives the running turn a person's message, which it reads at its next step. Rejects when no
	 * turn is running or its harness takes no input mid-run; whether one does is `plannerSteers`.
	 * Absent for a background job's session, which no one talks to.
	 */
	steer?: (text: string) => Promise<void>;
	/**
	 * The questions this session asked that no member has answered yet, and the requests whose
	 * result its client has not received. A session with either is kept past a turn that ended
	 * without it.
	 */
	inputs?: Pick<PendingInputs, "open" | "held" | "watch">;
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
	/** Records an in-flight credential rebind so host tools wait for it before failing. */
	rebinding?: (wait: Promise<void>) => void;
	/** Explicitly withdraws open questions held by this session (as when a person clicks Stop). */
	withdrawInputs?: () => void;
};

export type PlannerSessionDependencies = {
	agent?: PlannerAgent;
	headingAgent?: PlannerAgent;
	refineAgent?: PlannerAgent;
	proseAgent?: PlannerAgent;
	followupAgent?: PlannerAgent;
	reactionAgent?: PlannerAgent;
	/** A thread's full Atomic Planner, which is offered `tell_chat_planner`. */
	threadAgent?: PlannerAgent;
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
	let activeChat = channel.chat ?? channel.room.plan.chat;
	let job = activeChat?.job;
	let isolated = !!job || !!channel.reader;
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
	let pendingRebind: Promise<void> | undefined;
	let waitForRebind = async (): Promise<void> => {
		for (let tries = 0; tries < 4; tries++) {
			let wait = pendingRebind;
			if (wait) {
				await wait.catch(() => {});
				continue;
			}
			if (current.currentToken()) return;
			if (!current.waitForRebind) return;
			let before = current;
			await current.waitForRebind().catch(() => {});
			if (!pendingRebind && current === before) return;
		}
	};
	let rebindable = channel.harness === "remote" && !isolated;
	let ownerEnded = rebindable ? new AbortController() : undefined;
	let stopWatchingOwner: (() => void) | undefined;
	let isSuspended = () => false;
	let isCredentialRenewal = (signal: AbortSignal): boolean => {
		let reason = signal.reason;
		let message = reason instanceof Error ? reason.message : String(reason ?? "");
		return message === "credential-rotated" || message === "credential-expired";
	};
	let watchOwner = (binding: ActiveOwnerBinding) => {
		stopWatchingOwner?.();
		stopWatchingOwner = undefined;
		if (!ownerEnded) return;
		let onAbort = () => {
			if (current !== binding) return;
			if (!isCredentialRenewal(binding.signal)) {
				ownerEnded?.abort(binding.signal.reason);
				return;
			}
			// Give ownerSignal / rebindRetained (whose abort listener may fire after ours)
			// a turn to register `pendingRebind` or call `rebind`; abort if neither happens
			// or if the rebind finishes without replacing this binding.
			queueMicrotask(() => {
				if (current !== binding || isSuspended()) return;
				if (!pendingRebind) {
					ownerEnded?.abort(binding.signal.reason);
					return;
				}
				void waitForRebind().then(() => {
					if (current === binding && binding.signal.aborted && !isSuspended()) {
						ownerEnded?.abort(binding.signal.reason);
					}
				});
			});
		};
		if (binding.signal.aborted) onAbort();
		else {
			binding.signal.addEventListener("abort", onAbort, { once: true });
			stopWatchingOwner = () => binding.signal.removeEventListener("abort", onAbort);
		}
	};
	let liveOwner: ActiveOwnerBinding = {
		get channelId() {
			return current.channelId;
		},
		get token() {
			return current.token;
		},
		get repository() {
			return current.repository;
		},
		get ownerSessionId() {
			return current.ownerSessionId;
		},
		get ownerGeneration() {
			return current.ownerGeneration;
		},
		get credentialRevision() {
			return current.credentialRevision;
		},
		get ownerUserId() {
			return current.ownerUserId;
		},
		get expiresAt() {
			return current.expiresAt;
		},
		get signal() {
			return ownerEnded ? ownerEnded.signal : current.signal;
		},
		currentToken: () => current.currentToken(),
		waitForRebind,
		revalidate: async () => {
			if (pendingRebind || current.signal.aborted || !current.currentToken()) {
				await waitForRebind();
			}
			let active = current;
			if (await active.revalidate()) return true;
			if (pendingRebind || active.signal.aborted || !active.currentToken()) {
				await waitForRebind();
				if (current !== active || (!current.signal.aborted && !!current.currentToken())) {
					return current.revalidate();
				}
			}
			return false;
		},
		release: () => current.release(),
	};
	let tools = lazyGithubTools(() => current, deps.githubTools ?? githubTools, waitForRebind);
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
		unregister = (deps.registerCredential ?? registerCredential)(
			sessionId,
			() => current.currentToken(),
		);
		// Background jobs keep the isolated boundary; only a Planner turn may run as a full session.
		let workspace = channel.harness === "atomic" && !isolated
			? await plannerWorkspace(channel.room.id, channel.repository)
			: undefined;
		let planner: FullPlanner | undefined;
		let inputs = new PendingInputs();
		if (workspace) {
			planner = {
				cwd: workspace.cwd,
				humanInput: createHumanInput(channel.room, undefined, inputs),
				toolReport: (id, output, state) => {
					let chat = channel.chat ?? channel.room.plan.chat;
					if (state === "running") chat?.toolProgress?.(id, output);
					else chat?.toolFinished?.(id, output, state === "done");
				},
				...(channel.fork?.atomicEntries !== undefined
					? { sessionEntries: channel.fork.atomicEntries }
					: {}),
				...(channel.fork?.atomicLeafId !== undefined
					? { branchLeafId: channel.fork.atomicLeafId }
					: {}),
				...(channel.fork?.onAtomicEntries
					? { onSessionEntries: channel.fork.onAtomicEntries }
					: {}),
			};
			unregisterFull = registerFullPlanner(sessionId, planner);
		}
		let remote: RemotePlanner | undefined;
		if (channel.harness === "remote") {
			let opensOn: PlannerChoice = {
				...(channel.model ? { model: channel.model } : {}),
				...channel.choice,
			};
			let held: RemotePlanner = {
				channelId: channel.room.id,
				isolated,
				...(opensOn.model || opensOn.thinkingLevel ? { choice: opensOn } : {}),
				...(channel.fork?.remoteFrom ? { forkFrom: { ...channel.fork.remoteFrom } } : {}),
				...(channel.fork?.onRemoteTurn ? { onRemoteTurn: channel.fork.onRemoteTurn } : {}),
			};
			if (!isolated) {
				held.humanInput = report => createHumanInput(channel.room, report, inputs);
				held.holdInput = () => inputs.hold();
				if (channel.room.unsentDecisions) {
					held.unsentDecisions = channel.room.unsentDecisions;
				}
				held.toolReport = (id, output, state) => {
					let chat = channel.chat ?? channel.room.plan.chat;
					if (state === "running") chat?.toolProgress?.(id, output);
					else chat?.toolFinished?.(id, output, state === "done");
				};
			}
			remote = held;
			isSuspended = () => held.suspended === true;
			unregisterRemote = registerRemotePlanner(sessionId, held);
		}
		let noting = !!channel.tellChat && !!planner;
		let agent = job?.kind === "heading"
			? deps.headingAgent ?? deps.agent ?? headingPlannerAgent
			: job?.kind === "refine" || job?.kind === "suggest"
			? deps.refineAgent ?? deps.agent ?? refinePlannerAgent
			: job?.kind === "prose"
			? deps.proseAgent ?? deps.agent ?? prosePlannerAgent
			: job?.kind === "decision-followup"
			? deps.followupAgent ?? deps.agent ?? decisionFollowupPlannerAgent
			: channel.reader
			? deps.reactionAgent ?? deps.agent ?? reactionPlannerAgent
			: noting
			? deps.threadAgent ?? deps.agent ?? threadPlannerAgent
			: deps.agent ?? plannerAgent;
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
		let { choice: _opened, ...callOptions } = channel;
		let instructions = typeof channel.instructions === "function"
			? channel.instructions(
				workspace
					?? (remote && !isolated
						? { remote: true, forkedNatively: remote.forkedNatively === true }
						: undefined),
			)
			: channel.instructions;
		if (owner.signal.aborted) throw new Error("Planner owner unavailable");
		watchOwner(current);
		let active = session;
		let stopped: Promise<void> | undefined;
		let fixedTools = Object.freeze([
			...(job
				? BACKGROUND_TOOL_NAMES[job.kind]
				: channel.reader
				? REACTION_TOOL_NAMES
				: PLANNER_TOOL_NAMES),
			...(noting ? [THREAD_NOTE_TOOL_NAME] : []),
		]);
		return {
			ok: true,
			value: {
				get activeTools() {
					return planner?.activeTools ?? remote?.activeTools ?? fixedTools;
				},
				...(planner || remote && !isolated ? { inputs } : {}),
				...(remote && !isolated
					? {
						rebind: (renewed: ActiveOwnerBinding) => {
							unregister?.();
							current = renewed;
							if (ownerEnded?.signal.aborted) ownerEnded = new AbortController();
							watchOwner(renewed);
							unregister = (deps.registerCredential ?? registerCredential)(
								sessionId,
								() => current.currentToken(),
							);
						},
						rebinding: (wait: Promise<void>) => {
							if (ownerEnded?.signal.aborted && isCredentialRenewal(current.signal)) {
								ownerEnded = new AbortController();
							}
							let tracked = wait.catch(() => {}).finally(() => {
								if (pendingRebind === tracked) pendingRebind = undefined;
							});
							pendingRebind = tracked;
						},
						suspended: () => remote.suspended === true,
						shuttingDown: () => remote.stopping === true,
						withdrawInputs: () => remote.withdrawInputs?.(),
					}
					: {}),
				stream: (prompt, abortSignal, choice, files, message, context) => {
					// The remote turn aborts it when the turn ends or the link drops mid-tool.
					let hostTools = remote ? new AbortController() : undefined;
					if (remote) {
						remote.hostTools = hostTools;
						remote.turnMessage = message;
					}
					// The level is on this turn alone, as the model is; an Atomic session records `context`
					// in the session before a command prompt so later turns still have it.
					return startingTurn(
						choice?.thinkingLevel,
						() =>
							agent.stream({
								session: active,
								prompt: files?.attachments.length
									? [promptWithAttachments(prompt, files.attachments, files.readsImages)]
									: prompt,
								abortSignal,
								options: {
									...callOptions,
									...(choice?.model ? { model: choice.model } : {}),
									instructions: context && !planner
										? `${instructions}\n\n${context}`
										: instructions,
									owner: liveOwner,
									githubTools: tools,
									...(hostTools ? { toolSignal: hostTools.signal } : {}),
								},
							}),
						planner ? context : undefined,
					);
				},
				...(job ? {} : { steer: (text: string) => active.experimental_steerTurn(text) }),
				destroy: () =>
					stopped ??= (async () => {
						try {
							await active.destroy();
						} finally {
							try {
								await sandbox.destroy();
							} finally {
								stopWatchingOwner?.();
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
