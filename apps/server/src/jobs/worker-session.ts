import { createJustBashNetworkSandboxSession } from "@ai-sdk/sandbox-just-bash";

import { registerCredential } from "../harness/harnesses";
import { registerRemotePlanner } from "../harness/remote/registry";

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
 * Opens one bounded worker session for a document: a fresh sandbox, a registered
 * per-session credential, and the agent session. The session is also registered as
 * an isolated session of the document, so under `HARNESS=remote` it runs in the
 * client attached as that document's Planner. Aborting while either resource is
 * still opening destroys it once it arrives. `close()` destroys the session, then
 * the sandbox, then releases the credential, continuing past failures.
 */
export async function openWorkerSession<Session extends Destroyable>(
	agent: WorkerAgent<Session>,
	options: {
		channelId: string;
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
	let unregister = registerRemotePlanner(sessionId, {
		channelId: options.channelId,
		isolated: true,
	});
	let session: Session | undefined;
	let close = async () => {
		try {
			await session?.destroy();
		} finally {
			try {
				await sandbox.destroy();
			} finally {
				unregister();
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
