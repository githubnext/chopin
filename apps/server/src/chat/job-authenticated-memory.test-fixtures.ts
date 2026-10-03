import * as Chat from "./service";
import * as Plan from "../plan/service";
import { Sessions } from "../auth/session";
import { ActiveOwnerBindings } from "../agent/active-owner";
import { createPlannerAgent } from "../harness/agents";
import { openPlannerSession } from "../harness/session";
import { headingHarness } from "./job-heading-harness.test-fixtures";
import type { ConversationPlan } from "@chopin/protocol";
import type { HostedAuth } from "../auth/routes";
import type { openPlan } from "../testing/plan";

function clock(): Date {
	return new Date();
}

async function noop(_output?: unknown): Promise<void> {}

export async function authenticatedMemory(
	opened: Awaited<ReturnType<typeof openPlan>>,
	kind: ConversationPlan.JobKind = "heading",
	call?: { name: string; input: Record<string, unknown> },
) {
	let plan = opened.plan;
	let sessions = new Sessions(opened.storage, true, clock);
	let session = await sessions.issue("U_test", {
		accessToken: "test-token",
		accessExpiresIn: 28_800,
		refreshToken: "test-refresh",
		refreshExpiresIn: 15_897_600,
	});
	let repository = {
		id: opened.channel.repositoryId,
		owner: "owner",
		name: "repository",
		defaultBranch: "main",
	};
	let auth = {
		storage: opened.storage,
		sessions,
		clock,
		github: {
			repositoryAccess: async () => ({ ...repository, permissions: { push: true, admin: false } }),
		},
		admission: { allowed: async () => true },
	} as unknown as HostedAuth;
	let owners = new ActiveOwnerBindings(auth);
	let startCheck: () => Promise<void> = noop;
	let resultCheck: (output: unknown) => Promise<void> = noop;
	let driver = headingHarness(() => startCheck(), output => resultCheck(output), call);
	let headingAgent = createPlannerAgent(driver.fake, kind);
	let sandboxDestroys = 0;
	let context: Chat.Room = {
		chat: plan.chat,
		plan,
		server: opened.server,
		room: opened.channel.id,
		config: { agent: true } as Chat.Room["config"],
		auth,
		repository,
		claimantSessionId: session.id,
		activeOwner: () => owners.resolve(opened.channel.id),
		persist: () => Plan.persist(plan),
		openPlannerSession: (owner, channel) =>
			openPlannerSession(owner, channel, {
				headingAgent,
				refineAgent: headingAgent,
				proseAgent: headingAgent,
				githubTools: async () => ({ ok: true, value: {} }),
				createSandbox: async () =>
					({
						defaultWorkingDirectory: "/tmp",
						async run() {
							return { exitCode: 0, stdout: "", stderr: "" };
						},
						async destroy() {
							sandboxDestroys++;
						},
					}) as never,
				registerCredential: () => () => {},
			}),
	};

	return {
		context,
		driver,
		sessionId: session.id,
		revokeAll: () => owners.revokeAll(),
		invalidateOwner: () => owners.revokeCredential(session.id, 1),
		sandboxDestroys: () => sandboxDestroys,
		onStart(check: typeof startCheck) {
			startCheck = check;
		},
		onResult(check: typeof resultCheck) {
			resultCheck = check;
		},
	};
}
