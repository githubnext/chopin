import { afterEach, describe, expect, it } from "bun:test";

import { Admission } from "../auth/admission";
import { Machines } from "../auth/machines";
import { Sessions } from "../auth/session";
import { Connections } from "../experiments/connections";
import { GitHubError } from "../github/client";
import { handler } from "../mcp";
import * as edit from "../plan/edit";
import * as Plan from "../plan/service";
import * as Questions from "../questions/service";
import * as Rooms from "../rooms";
import { implementationConnector } from "../tasks/connector";
import { implementationGraphs } from "../tasks/plan-graphs";
import { createBuildStarter } from "../tasks/start-build";
import { openPlan } from "../testing/plan";
import { hosted } from "./hosted";
import { INDEX_HEADING } from "../agent/orchestrate-index";

import type { HostedAuth } from "../auth/routes";
import type {
	GitHub,
	GitHubTokenGrant,
	GitHubUser,
	InstallationPage,
	Repository,
	RepositoryPage,
} from "../github/client";
import type { PlannerInvocation } from "./hosted";

const NOW = new Date("2026-11-20T12:00:00.000Z");
const HEAD = "0123456789abcdef0123456789abcdef01234567";

const BRIEF = {
	goal: "Coordinate multi-document work.",
	constraints: [],
	settledDecisions: [],
	openQuestions: [],
	repositoryFindings: [],
};

const SAMPLE_TASK = {
	id: "impl-1",
	title: "Implement slice",
	context: "Part of orchestrated plan.",
	goal: "Deliver the slice cleanly.",
	acceptance: ["Slice works.", "Tests pass."],
	dependsOn: [],
};

class FakeGitHub implements GitHub {
	push = true;
	repositoryValue: Repository = {
		id: "R_app",
		owner: "octo",
		name: "app",
		fullName: "octo/app",
		private: true,
		url: "https://github.test/octo/app",
		defaultBranch: "main",
		permissions: { pull: true, push: true, admin: false },
	};

	authorize(): string {
		return "";
	}
	async exchange(): Promise<GitHubTokenGrant> {
		return {
			accessToken: "t",
			accessExpiresIn: 28_800,
			refreshToken: "r",
			refreshExpiresIn: 15_897_600,
		};
	}
	async refresh(): Promise<GitHubTokenGrant> {
		return {
			accessToken: "t",
			accessExpiresIn: 28_800,
			refreshToken: "r",
			refreshExpiresIn: 15_897_600,
		};
	}
	async user(token: string): Promise<GitHubUser> {
		if (token === "denied") throw new GitHubError("bad credentials", 401);
		return { id: `U_${token}`, login: token, avatarUrl: "https://github.test/avatar" };
	}
	async organizationMembership() {
		return undefined;
	}
	async repositories(): Promise<RepositoryPage> {
		return { repositories: [], nextPage: undefined };
	}
	async installations(): Promise<InstallationPage> {
		return { installations: [], nextPage: undefined };
	}
	async installationRepositories(): Promise<RepositoryPage> {
		return this.repositories();
	}
	async repository(_token: string, owner: string, name: string): Promise<Repository> {
		return {
			...this.repositoryValue,
			owner,
			name,
			fullName: `${owner}/${name}`,
			permissions: { pull: true, push: this.push, admin: false },
		};
	}
	async repositoryAccess(token: string, owner: string, name: string) {
		return this.repository(token, owner, name);
	}
	async installationRepositoryAccess() {
		return undefined;
	}
	async branchHead() {
		return HEAD;
	}
	invalidate(): void {}
}

let roomsToClear: Rooms.Room[] = [];
let plansToClose: Plan.Plan[] = [];

afterEach(async () => {
	for (let room of roomsToClear.splice(0)) Rooms.forget(room);
	for (let plan of plansToClose.splice(0)) await Plan.close(plan);
});

describe("MCP orchestrate tool end-to-end", () => {
	it("supports open, list, decisions, answer, instruct, build, and index with provenance containment and Planner parity", async () => {
		let opened = await openPlan("# Umbrella plan\n\nOverview.\n");
		plansToClose.push(opened.plan);
		let storage = opened.storage;
		let source = (await storage.channels.get(opened.channel.id))!;
		let held = Rooms.hold(source.id);
		held.room.plan = opened.plan;
		roomsToClear.push(held.room);

		let github = new FakeGitHub();
		github.repositoryValue = {
			...github.repositoryValue,
			id: source.repositoryId,
			owner: source.repositoryOwner,
			name: source.repositoryName,
			fullName: `${source.repositoryOwner}/${source.repositoryName}`,
		};
		let clock = () => NOW;
		let config = {
			origin: "https://chopin.test",
			encryptionKey: new Uint8Array(32).fill(7),
			clientId: "client-id",
			clientSecret: "client-secret",
			appSlug: "chopin-test",
		};
		let auth: HostedAuth = {
			config,
			storage,
			github,
			sessions: new Sessions(storage, true, clock),
			machines: new Machines(storage, clock, { origin: config.origin, clientId: config.clientId }),
			admission: new Admission(config, github, () => clock().getTime()),
			clock,
			pairings: {},
		};

		let connections = new Connections();
		connections.open(
			{
				id: "M_alice",
				owner: "U_alice",
				login: "alice",
				autoRun: false,
				protocol: 8,
			},
			"Alice laptop",
			[{
				repositoryId: source.repositoryId,
				repository: `${source.repositoryOwner}/${source.repositoryName}`,
				branch: "main",
				commit: HEAD,
			}],
		);

		let openDocPlan = async <T>(
			id: string,
			action: (plan: Plan.Plan) => Promise<T>,
		): Promise<T> => {
			let live = Rooms.get(id)?.plan;
			if (live) return action(live);
			let docPlan = await Plan.open(
				id,
				{
					documentTitles: true,
					storage,
					lease: () => opened.lease,
					fatal: err => {
						throw err;
					},
				},
				opened.server,
			);
			try {
				return await action(docPlan);
			} finally {
				await Plan.close(docPlan);
			}
		};

		let connector = implementationConnector(
			openDocPlan,
			connections,
			async id => `https://chopin.test/channels/${id}`,
			async id => !!(await storage.channels.get(id)),
		);
		let starter = createBuildStarter({
			withPlan: openDocPlan,
			connections,
			connector,
		});

		let invocations: PlannerInvocation[] = [];
		let plannerAnswers: Array<{ channelId: string; id: string; generation: number }> = [];
		let mcp = handler(
			hosted(auth, { lease: () => opened.lease }, {
				invokePlanner: async input => {
					invocations.push(input);
					return undefined;
				},
				onPlannerAnswer: (channelId, id, generation) => {
					plannerAnswers.push({ channelId, id, generation });
				},
				startBuild: input => starter.startPlanBuild(input),
			}),
		);

		let call = async (args: Record<string, unknown>, token = "alice") => {
			let res = await mcp(
				new Request("https://chopin.test/mcp", {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "tools/call",
						params: { name: "orchestrate", arguments: args },
					}),
				}),
			);
			return await res.json() as {
				result?: {
					structuredContent?: Record<string, unknown>;
					isError?: boolean;
				};
				error?: { code: number; message: string };
			};
		};

		// 1. open two created documents
		let openedRes = await call({
			id: source.id,
			operation: "open",
			documents: [
				{
					idempotencyKey: "sub-auth-doc",
					title: "Auth",
					brief: BRIEF,
					document: "# Auth\n\nHandle sign-in.\n",
				},
				{
					idempotencyKey: "sub-billing-doc",
					title: "Billing",
					brief: BRIEF,
					document: "# Billing\n\nHandle invoices.\n",
				},
			],
		});
		expect(openedRes.result?.isError).toBeUndefined();
		let openDocs = (openedRes.result!.structuredContent as {
			documents: Array<{ ok: boolean; document: { id: string; title: string; url: string } }>;
		}).documents;
		expect(openDocs).toHaveLength(2);
		let authDoc = openDocs[0]!.document;
		let billingDoc = openDocs[1]!.document;

		// Create unrelated, archived, and grandchild documents to prove containment!
		let unrelated = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: source.repositoryId,
			repositoryOwner: source.repositoryOwner,
			repositoryName: source.repositoryName,
			title: "Unrelated",
			createdBy: "U_alice",
			now: NOW,
		});
		let grandchild = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: source.repositoryId,
			repositoryOwner: source.repositoryOwner,
			repositoryName: source.repositoryName,
			title: "Grandchild",
			createdBy: "U_alice",
			createdFrom: authDoc.id,
			now: NOW,
		});

		// Add an open Planner decision + draft graph to authDoc
		let authCardId = "";
		let authOptionId = "";
		await openDocPlan(authDoc.id, async docPlan => {
			let captured = await Questions.captureDecisions(docPlan, docPlan.server, authDoc.id, {
				revision: docPlan.revision,
				questions: [{
					key: "auth-provider-1",
					header: "Auth",
					question: "Which OAuth provider?",
					multiple: false,
					options: [
						{ label: "GitHub", description: "Use GitHub OAuth" },
						{ label: "OIDC", description: "Generic OIDC" },
					],
					blocks: [{ index: 1, digest: edit.outline(docPlan)[1]!.digest }],
				}],
			});
			authCardId = captured.decisions[0]!.id;
			authOptionId = docPlan.records.get(authCardId)!.definition.questions[0]!.options[0]!.id;
			await implementationGraphs().revise(docPlan, {
				planRevision: docPlan.revision,
				graphRevision: 0,
				operations: [{ op: "add", task: SAMPLE_TASK }],
			});
		});

		// 2. index writes the table into the umbrella doc
		let indexed = await call({ id: source.id, operation: "index" });
		expect(indexed.result?.isError).toBeUndefined();
		expect(indexed.result?.structuredContent).toMatchObject({
			ok: true,
			operation: "index",
			index: { state: "written" },
		});
		expect(edit.source(opened.plan)).toContain(`## ${INDEX_HEADING}`);
		expect(edit.source(opened.plan)).toContain("Auth");
		expect(edit.source(opened.plan)).toContain("Billing");
		expect(edit.source(opened.plan)).not.toContain("Unrelated");
		expect(edit.source(opened.plan)).not.toContain("Grandchild");

		// 3. decisions across created documents (read-only allowed even for pull-only caller!)
		github.push = false;
		let decs = await call({
			id: source.id,
			operation: "decisions",
			status: "open",
		});
		expect(decs.result?.isError).toBeUndefined();
		expect(decs.result?.structuredContent).toMatchObject({
			ok: true,
			operation: "decisions",
			documents: expect.arrayContaining([
				expect.objectContaining({
					id: authDoc.id,
					decisions: [expect.objectContaining({ id: authCardId, status: "open" })],
					decisionCounts: expect.objectContaining({ open: 1, total: 1 }),
				}),
				expect.objectContaining({
					id: billingDoc.id,
					decisions: [],
					decisionCounts: expect.objectContaining({ total: 0 }),
				}),
			]),
		});
		// Pull-only caller refused for mutating operations
		let pullAnswer = await call({
			id: source.id,
			operation: "answer",
			target: authDoc.id,
			decisionId: authCardId,
			revision: 0,
			idempotencyKey: "k-pull",
			optionIds: [authOptionId],
		});
		expect(pullAnswer.result?.isError).toBe(true);
		expect(pullAnswer.result?.structuredContent).toMatchObject({ code: "repository-forbidden" });
		github.push = true;

		// 4. answer decision on authDoc -> settles durably + fires onPlannerAnswer!
		let answered = await call({
			id: source.id,
			operation: "answer",
			target: authDoc.id,
			decisionId: authCardId,
			revision: 0,
			idempotencyKey: "orch-ans-1",
			optionIds: [authOptionId],
		});
		expect(answered.result?.isError).toBeUndefined();
		expect(answered.result?.structuredContent).toMatchObject({
			ok: true,
			operation: "answer",
			target: { id: authDoc.id },
			status: "answered",
			replayed: false,
			decisionId: authCardId,
		});
		expect(plannerAnswers).toEqual([{ channelId: authDoc.id, id: authCardId, generation: 1 }]);

		// Refuses unrelated and grandchild targets!
		let refusedUnrelated = await call({
			id: source.id,
			operation: "answer",
			target: unrelated.id,
			decisionId: authCardId,
			revision: 0,
			idempotencyKey: "orch-ans-bad",
			optionIds: [authOptionId],
		});
		expect(refusedUnrelated.result?.isError).toBe(true);
		expect(refusedUnrelated.result?.structuredContent).toMatchObject({
			code: "target-not-created",
		});

		// 5. instruct created docs
		let instructed = await call({
			id: source.id,
			operation: "instruct",
			instruction: "Finalize sections.",
			targets: [authDoc.id, grandchild.id],
		});
		expect(instructed.result?.isError).toBeUndefined();
		expect(instructed.result?.structuredContent).toMatchObject({
			ok: true,
			operation: "instruct",
			documents: [{ id: authDoc.id, started: true }],
			unknown: [grandchild.id],
		});
		expect(invocations.map(i => i.channel.id)).toEqual([authDoc.id]);

		// 6. build created docs: authDoc's graph was drafted before answering its decision (now stale!),
		// billingDoc has no graph yet -> graph-stale and graph-required when draftIfNeeded: false!
		let staleBuild = await call({
			id: source.id,
			operation: "build",
			draftIfNeeded: false,
		});
		expect(staleBuild.result?.isError).toBeUndefined();
		let staleDocs = (staleBuild.result!.structuredContent as {
			documents: Array<Record<string, unknown>>;
		}).documents;
		expect(staleDocs.find(d => d.id === authDoc.id)).toMatchObject({
			status: "refused",
			reason: "graph-stale",
			planRevision: 2,
		});
		expect(staleDocs.find(d => d.id === billingDoc.id)).toMatchObject({
			status: "refused",
			reason: "graph-required",
		});

		// Refresh authDoc's graph to its post-answer revision -> build starts and index updates!
		await openDocPlan(authDoc.id, async docPlan => {
			await implementationGraphs().revise(docPlan, {
				planRevision: docPlan.revision,
				graphRevision: docPlan.graph!.versions.at(-1)!.revision,
				operations: [{ op: "replace", id: SAMPLE_TASK.id, task: SAMPLE_TASK }],
			});
		});
		let built = await call({
			id: source.id,
			operation: "build",
			draftIfNeeded: false,
		});
		expect(built.result?.isError).toBeUndefined();
		let buildDocs = (built.result!.structuredContent as {
			documents: Array<Record<string, unknown>>;
		}).documents;
		expect(buildDocs.find(d => d.id === authDoc.id)).toMatchObject({
			status: "started",
			build: { state: "queued" },
		});
		expect(buildDocs.find(d => d.id === billingDoc.id)).toMatchObject({
			status: "refused",
			reason: "graph-required",
		});
		// Index refreshed automatically with building state!
		expect(edit.source(opened.plan)).toContain("| building");
	});
});
