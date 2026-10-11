import { attachedLink, remotePlanner } from "./registry";

import type { HarnessV1, HarnessV1Session, HarnessV1StartOptions } from "@ai-sdk/harness";
import type { PlannerLink } from "./link";
import type { RemotePlanner } from "./registry";

export type RemoteTarget = { link: PlannerLink; planner: RemotePlanner };

/**
 * Finds the attached client and Chopin's record for a session. Only sessions
 * Chopin registered for a document's Planner have one.
 */
export function attachedTarget(sessionId: string): RemoteTarget {
	let planner = remotePlanner(sessionId);
	if (!planner) {
		throw new Error(
			"HARNESS=remote runs only Planner sessions; this session has no document to attach to.",
		);
	}
	let link = attachedLink(planner.channelId);
	if (!link) throw new Error("No Planner is attached to this document.");
	return { link, planner };
}

/**
 * `HarnessV1` whose sessions run in a client attached over the Planner link.
 * The server keeps no model and no client tools: it forwards each session and
 * turn, and runs Chopin's host tools when the client calls them.
 */
export function createRemoteAdapter(
	resolve: (sessionId: string) => RemoteTarget = attachedTarget,
): HarnessV1 & { shutdown(): Promise<void> } {
	let open = new Set<HarnessV1Session>();
	return {
		specificationVersion: "harness-v1",
		harnessId: "remote",
		builtinTools: {},
		supportsBuiltinToolFiltering: true,

		async doStart(options: HarnessV1StartOptions): Promise<HarnessV1Session> {
			if (options.resumeFrom || options.continueFrom) {
				throw new Error("The remote Planner cannot resume a session.");
			}
			let { link, planner } = resolve(options.sessionId);
			let session = await link.startSession(options.sessionId, planner);
			let handle: HarnessV1Session = {
				...session,
				async doDestroy() {
					open.delete(handle);
					await session.doDestroy();
				},
			};
			open.add(handle);
			return handle;
		},

		async shutdown() {
			await Promise.allSettled([...open].map(session => session.doDestroy()));
		},
	};
}
