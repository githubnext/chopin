import { createPlannerAgent } from "../../apps/server/src/harness/agents";
import { openPlannerSession } from "../../apps/server/src/harness/session";
import { documentTools } from "../../apps/server/src/agent/tools";
import { createScopedTools } from "../../apps/server/src/agent/scoped-tools";
import { jobTools } from "../../apps/server/src/agent/job-tools";
import * as Service from "../../apps/server/src/plan/service";
import * as Room from "../../apps/server/src/plan/room";
import { openPlan } from "../../apps/server/src/testing/plan";
import { fixtureRepository, frozenPullRequests, frozenRepositoryTools } from "./fixtures";
import { ToolGuard } from "./guard";
import { leaseDuration } from "./prompt";
import { sanitizer } from "./sanitize";

import type { ActiveOwnerBinding } from "../../apps/server/src/agent/active-owner";
import type { DocumentRoom } from "../../apps/server/src/agent/tools";
import type { Harness, Limits, Scenario } from "./types";

export async function scenarioSession(
	scenario: Scenario,
	settings: {
		harness: Harness;
		token: string;
		instructions: string;
		model: string;
		visual: "off" | "fixture-prose";
		limits: Limits;
	},
	dependencies: { openPlan?: typeof openPlan } = {},
) {
	let context = await (dependencies.openPlan ?? openPlan)(scenario.source);
	let lease = await context.storage.leases.renew(
		context.lease,
		leaseDuration(scenario.turns.length, settings.limits.turnTimeoutMs),
	);
	if (!lease) {
		await Service.close(context.plan);
		throw new Error("Could not extend the evaluation's owned memory writer lease");
	}
	context.plan.persistence.lease = () => lease!;
	let ownerController = new AbortController();
	let room: DocumentRoom = {
		id: context.channel.id,
		plan: context.plan,
		server: context.server,
		exclusive: action => Service.exclusive(context.plan, action),
		persist: () => Service.persist(context.plan),
		publish: mutation =>
			Service.publish(context.plan, context.server, context.channel.id, mutation),
		anchors() {},
		changes() {},
		currentMemberRequest: () => ({
			entryId: `turn-${guard.turn}`,
			userId: "U_test",
			handle: guard.human.speaker,
			text: guard.human.text,
			claimantSessionId: undefined,
			turnId: `turn-${guard.turn}`,
			lifecycle: guard.turn,
		}),
		...(settings.visual === "fixture-prose"
			? {
				visual: {
					ask: async request => ({
						model: "fixture-prose-v1",
						answers: Object.fromEntries(
							Object.keys(request.questions).map(key => [key, { type: "noul" as const, noul: 0 }]),
						),
						usage: { input_tokens: 0, output_tokens: 0 },
						latencyMs: 0,
					}),
				},
			}
			: {}),
	};
	let guard = new ToolGuard(room, settings.limits);
	let owner: ActiveOwnerBinding = {
		channelId: room.id,
		token: settings.token,
		repository: fixtureRepository,
		ownerSessionId: `eval-${room.id}`,
		ownerGeneration: 1,
		credentialRevision: 1,
		expiresAt: new Date(Date.now() + 3_600_000),
		signal: ownerController.signal,
		currentToken: () => ownerController.signal.aborted ? undefined : settings.token,
		revalidate: async () => !ownerController.signal.aborted,
		release() {},
	};
	let realAgent = createPlannerAgent(settings.harness, undefined, !!room.visual);
	let guarded = guard.wrap({
		...documentTools,
		...jobTools,
		...createScopedTools(),
		...frozenRepositoryTools(),
		...frozenPullRequests(),
	});
	// openPlannerSession's lazy PR binding only accepts the two PR tools. Inject after it binds,
	// preserving the real agent's schemas, context, permission handling and document execution.
	let agent = new Proxy(realAgent, {
		get(target, key) {
			if (key === "stream") {
				return (call: Parameters<typeof realAgent.stream>[0]) =>
					target.stream({
						...call,
						options: {
							...call.options!,
							githubTools: { ...call.options!.githubTools, ...guarded },
						},
					});
			}
			let value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	let opened = await openPlannerSession(owner, {
		room,
		repository: fixtureRepository,
		instructions: settings.instructions,
		model: settings.model,
		harness: "copilot-sdk",
	}, {
		agent,
		githubTools: async () => ({ ok: true, value: frozenPullRequests() }),
		createSandbox: async () =>
			({
				defaultWorkingDirectory: "/private/tmp",
				async run(input: { command: string }) {
					// HarnessAgent always initializes its work directory, even for host-only tools.
					// This acknowledges that exact bootstrap command without running a shell.
					if (input.command === 'mkdir -p "$WORK_DIR"') {
						return { exitCode: 0, stdout: "", stderr: "" };
					}
					throw new Error("The Planner evaluation sandbox cannot execute commands");
				},
				async destroy() {},
			}) as never,
		timeoutMs: 30_000,
	});
	if (!opened.ok) {
		await Service.close(context.plan);
		let reason = "cause" in opened.error ? sanitizer([settings.token])(opened.error.cause) : "";
		throw new Error(`Planner open failed: ${opened.error.kind}: ${reason}`, {
			cause: opened.error,
		});
	}
	return {
		guard,
		session: opened.value,
		leaseExpiresAt: lease.expiresAt,
		source: () => Room.project(context.plan.document),
		revision: () => context.plan.revision,
		async storedDocument() {
			let stored = await context.storage.collaboration.load(context.channel.id, new Date());
			if (!stored?.snapshot) throw new Error("Evaluation document checkpoint is missing");
			let restored = await Room.restore(
				stored.snapshot.epoch,
				stored.snapshot.document,
				stored.snapshot.source,
				stored.updates.map(update => ({ epoch: update.epoch, update: update.update })),
			);
			try {
				return { source: Room.project(restored), storageRevision: stored.channel.revision };
			} finally {
				restored.doc.destroy();
			}
		},
		async close() {
			ownerController.abort(new Error("Evaluation ended"));
			try {
				await opened.value.destroy();
			} finally {
				await Service.close(context.plan);
			}
		},
	};
}
