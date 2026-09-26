import { createJustBashNetworkSandboxSession } from "@ai-sdk/sandbox-just-bash";
import { plannerAgent } from "./agents";
import { githubTools, type GitHubToolsError, type Result } from "./github-tools";
import { registerCredential } from "./harnesses";

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

type PlannerChannel = {
	room: DocumentRoom;
	repository: HostedRepository;
	instructions: string;
	model?: string;
};

export type PlannerSession = {
	stream: (prompt: string, abortSignal: AbortSignal) => ReturnType<PlannerAgent["stream"]>;
	destroy: () => Promise<void>;
};

export type PlannerSessionDependencies = {
	agent?: PlannerAgent;
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
	let session: Awaited<ReturnType<HarnessAgent["createSession"]>> | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		if (owner.signal.aborted) throw new Error("Planner owner unavailable");
		let sessionId = crypto.randomUUID();
		unregister = (deps.registerCredential ?? registerCredential)(sessionId, owner.currentToken);
		let agent = deps.agent ?? plannerAgent;
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
		return {
			ok: true,
			value: {
				stream: (prompt, abortSignal) =>
					agent.stream({
						session: active,
						prompt,
						abortSignal,
						options: {
							...channel,
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
