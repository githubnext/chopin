import { ApiError } from "./api";

import type { ImplementationSnapshot } from "@chopin/protocol/implementation";

export function implementationEndpoint(room: string): string {
	return `/api/channels/${encodeURIComponent(room)}/implementation`;
}

export async function implementationResponse<T>(result: Response): Promise<T> {
	let value = await result.json();
	if (!result.ok) throw new ApiError(value.error ?? "Build is unavailable", result.status);
	return value;
}

/**
 * The planned `no-workspace` 409: no local agent is connected. A connected agent that is still
 * prototyping takes the build once it finishes, so busy is not offline.
 */
function offline(error: unknown): boolean {
	return error instanceof ApiError && error.status === 409 && error.message === "no-workspace";
}

/**
 * Approve the snapshot's tasks and start building them on the viewer's local agent.
 *
 * The one place the browser starts a build. `needs-agent` means no connected
 * agent could take it; any other refusal throws.
 */
export async function startBuild(
	room: string,
	snapshot: ImplementationSnapshot,
): Promise<"started" | "needs-agent"> {
	let graph = snapshot.graph;
	if (!graph) throw new ApiError("There are no tasks to build", 409);
	// The server picks the clicker's own connection; a snapshot can predate connecting.
	try {
		await implementationResponse(
			await fetch(implementationEndpoint(room), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...(snapshot.build ? { retryOf: snapshot.build.id } : {}),
					planRevision: snapshot.planRevision,
					graphVersion: graph.number,
					graphRevision: graph.revision,
				}),
			}),
		);
		return "started";
	} catch (error) {
		if (offline(error)) return "needs-agent";
		throw error;
	}
}
