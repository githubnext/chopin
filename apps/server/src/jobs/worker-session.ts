import { createJustBashNetworkSandboxSession } from "@ai-sdk/sandbox-just-bash";

import { registerCredential } from "../harness/harnesses";

export type WorkerSandbox = Awaited<ReturnType<typeof createJustBashNetworkSandboxSession>>;
type Destroyable = { destroy(): PromiseLike<void> };

export type WorkerAgent<Session extends Destroyable> = {
	createSession(options: { sessionId: string; sandboxSession: WorkerSandbox }): Promise<Session>;
};

export type WorkerSession<Session> = { session: Session; close(): Promise<void> };

async function openAbortable<T extends Destroyable>(
	opening: Promise<T>,
	aborted: Promise<never>,
): Promise<T> {
	try {
		return await Promise.race([opening, aborted]);
	} catch (err) {
		void opening.then(late => late.destroy()).catch(() => {});
		throw err;
	}
}

/**
 * Opens one bounded worker session: a fresh sandbox, a registered per-session
 * credential, and the agent session. Aborting while either resource is still
 * opening destroys it once it arrives. `close()` destroys the session, then the
 * sandbox, then releases the credential, continuing past failures.
 */
export async function openWorkerSession<Session extends Destroyable>(
	agent: WorkerAgent<Session>,
	options: {
		token: () => string | undefined;
		maxAiCredits: number;
		aborted: Promise<never>;
		openSandbox?: () => Promise<WorkerSandbox>;
	},
): Promise<WorkerSession<Session>> {
	let openSandbox = options.openSandbox ?? (() => createJustBashNetworkSandboxSession());
	let sandbox = await openAbortable(openSandbox(), options.aborted);
	let sessionId = crypto.randomUUID();
	let release = registerCredential(sessionId, options.token, options.maxAiCredits);
	let session: Session | undefined;
	let close = async () => {
		try {
			await session?.destroy();
		} finally {
			try {
				await sandbox.destroy();
			} finally {
				release();
			}
		}
	};
	try {
		session = await openAbortable(
			agent.createSession({ sessionId, sandboxSession: sandbox }),
			options.aborted,
		);
	} catch (err) {
		await close().catch(() => {});
		throw err;
	}
	return { session, close };
}
