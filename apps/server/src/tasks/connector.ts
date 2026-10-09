import { z } from "zod";
import type { Connection, Connections, Grant } from "../experiments/connections";
import { fail } from "../experiments/service";
import { LIFECYCLE_TOOLS, lifecycleCall } from "../mcp/lifecycle";
import { exclusive, source } from "../plan/service";
import type { Plan } from "../plan/service";
import { claimImplementation, reportImplementationLifecycle } from "./plan-graphs";
import { pickBuild, reportBuild } from "./builds";
import { implementationLifecycle } from "./lifecycle";

export type WithPlan = <T>(id: string, action: (plan: Plan) => Promise<T>) => Promise<T>;

export function implementationSchemas(
	runScoped: boolean,
): Record<string, z.ZodType<Record<string, unknown>>> {
	if (!runScoped) {
		let id = z.string().uuid();
		return {
			wait_for_work: z.object({}).strict(),
			claim_implementation_build: z.object({ id }).strict(),
			renew_implementation_build: z.object({ id }).strict(),
			report_implementation_build: z.object({
				id,
				state: z.enum(["running", "stopped", "failed"]),
				session: z.string().min(1).max(128).optional(),
				error: z.string().max(2000).optional(),
			}).strict(),
		};
	}
	return {
		read_implementation: z.object({}).strict(),
		...Object.fromEntries(LIFECYCLE_TOOLS.map(tool => {
			let { id: _id, runId: _run, ...properties } = tool.inputSchema.properties;
			return [
				tool.name,
				z.fromJSONSchema({
					...tool.inputSchema,
					type: "object" as const,
					properties: JSON.parse(JSON.stringify(properties)),
					required: tool.inputSchema.required.filter(key => key !== "id" && key !== "runId"),
				}) as z.ZodType<Record<string, unknown>>,
			];
		})),
	};
}

export function implementationConnector(
	withPlan: WithPlan,
	connections: Connections,
	documentUrl: (id: string) => Promise<string>,
	documentExists: (id: string) => Promise<boolean>,
) {
	let tracked = new Set<string>();
	let pending = async (connection: Connection) =>
		withPlan(connection.documentId, async plan => {
			let build = plan.builds.at(-1);
			return build?.connectionId === connection.id && build.user === connection.owner
				? build
				: undefined;
		});
	return {
		track(id: string) {
			tracked.add(id);
		},
		async waiting(connection: Connection) {
			let build = await pending(connection);
			return build?.state === "queued"
				? { id: build.id, kind: "implementation" as const }
				: undefined;
		},
		async busy(connection: Connection) {
			let build = await pending(connection);
			return !!build && ["queued", "starting", "running"].includes(build.state);
		},
		async call(connection: Connection, grant: Grant, name: string, args: Record<string, unknown>) {
			tracked.add(connection.documentId);
			return withPlan(connection.documentId, async plan => {
				let build = plan.builds.at(-1);
				if (
					!build || build.connectionId !== connection.id || build.user !== connection.owner
					|| build.repositoryId !== connection.source.repositoryId
					|| build.id !== (grant.run?.id ?? args.id)
				) fail("build-forbidden");
				if (grant.run) {
					if (
						grant.run.kind !== "implementation" || grant.run.generation !== 1
						|| build.state !== "running" || build.expiresAt <= Date.now()
					) fail("build-inactive");
					if (name === "read_implementation") {
						return exclusive(plan, async () => ({
							document: {
								id: plan.id,
								revision: plan.revision,
								source: source(plan),
								url: await documentUrl(plan.id),
							},
							graph: plan.graph?.versions.at(-1),
							run: plan.execution
								?? plan.lifecycle.history.find(item => item.run.id === build.id)?.run,
							...implementationLifecycle({
								graph: plan.graph!,
								execution: plan.execution,
								lifecycle: plan.lifecycle,
							}),
						}));
					}
					let parsed = lifecycleCall(name, { ...args, id: plan.id, runId: build.id });
					if (!parsed.known || !parsed.input) fail("invalid-request");
					let result = await reportImplementationLifecycle(plan, parsed.input);
					if (result.kind === "refused") fail(result.reason);
					return { state: result.kind };
				}
				if (name === "claim_implementation_build") {
					if (build.expiresAt <= Date.now()) fail("build-expired");
					let picked = await pickBuild(plan, connection.owner, connection.id);
					if (!picked) fail("build-already-claimed");
					return {
						build: picked,
						documentId: plan.id,
						source: { ...picked.checkout, repositoryId: picked.repositoryId },
						runToken: connections.runToken(connection.id, picked.id, 1, "implementation"),
					};
				}
				if (!["starting", "running"].includes(build.state) || build.expiresAt <= Date.now()) {
					fail("build-inactive");
				}
				if (name === "renew_implementation_build") {
					await reportBuild(plan, connection.owner, connection.id, build.id, {
						state: build.state as "running" | "starting",
						expiresAt: Date.now() + 60_000,
					});
				} else if (name === "report_implementation_build") {
					let report = args as {
						state: "running" | "stopped" | "failed";
						session?: string;
						error?: string;
					};
					if (report.state === "running") {
						if (!report.session || build.state !== "starting") fail("invalid-state");
						let claim = await claimImplementation(plan, {
							planRevision: build.planRevision,
							graphRevision: build.graphRevision,
							run: {
								id: build.id,
								user: connection.owner,
								client: { name: "chopin-acp", version: "0.1.0" },
								session: report.session,
								graphVersion: build.graphVersion,
								graphRevision: build.graphRevision,
								planRevision: build.planRevision,
								repository: build.checkout.repository,
								branch: `chopin/implement-${build.id.slice(0, 8)}`,
								commit: build.checkout.commit,
								startedAt: new Date().toISOString(),
							},
						});
						if (claim.kind !== "started") fail("build-claim-refused");
					}
					await reportBuild(plan, connection.owner, connection.id, build.id, report);
				} else fail("tool-forbidden");
				return { accepted: true };
			});
		},
		async sweep() {
			for (let id of tracked) {
				if (!await documentExists(id)) {
					tracked.delete(id);
					continue;
				}
				await withPlan(id, async plan => {
					let build = plan.builds.at(-1);
					if (!build || !["queued", "starting", "running"].includes(build.state)) {
						tracked.delete(id);
						return;
					}
					if (!connections.get(build.connectionId) || build.expiresAt <= Date.now()) {
						await reportBuild(plan, build.user, build.connectionId, build.id, {
							state: "failed",
							error: "Workspace disconnected or agent stopped responding. No automatic replay.",
						});
						tracked.delete(id);
					}
				});
			}
		},
	};
}
export type ImplementationConnector = ReturnType<typeof implementationConnector>;
