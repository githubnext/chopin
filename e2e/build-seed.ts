import type { BuildRequest } from "../packages/protocol/implementation";
import type { Graph } from "../apps/server/src/tasks/graphs";

/** A first build of the graph's latest tasks that failed before it claimed them, so Build is on. */
export function failedBuild(graph: Graph): BuildRequest {
	let version = graph.versions.at(-1)!;
	return {
		id: crypto.randomUUID(),
		user: "U_e2e",
		connectionId: "seeded",
		repositoryId: "R_score",
		checkout: { repository: "octo-org/score", commit: "0".repeat(40) },
		planRevision: version.planRevision,
		graphVersion: version.number,
		graphRevision: version.revision,
		createdAt: new Date().toISOString(),
		expiresAt: 0,
		state: "failed",
		error: "The agent did not start.",
	};
}
