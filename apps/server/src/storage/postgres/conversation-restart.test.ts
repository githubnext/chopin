import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { PostgresStorage } from "./adapter";

let database = process.env.TEST_DATABASE_URL;
let root = resolve(import.meta.dir, "../../../../..");
let reconstruction = `
import { PostgresStorage } from "./apps/server/src/storage/postgres/adapter";
import * as Plan from "./apps/server/src/plan/service";
import { applyEvent } from "./apps/server/src/conversation-plan/events";
import { applyResearchOpportunity } from "./apps/server/src/conversation-plan/research-opportunities";
import { researchContext } from "./apps/server/src/conversation-plan/research-interpreter";
import { createProcessor } from "./apps/server/src/conversation-plan/service";
import * as Draft from "./packages/draft/src/index";
let storage = new PostgresStorage(process.env.TEST_DATABASE_URL);
let lease = await storage.leases.acquire("chopin:writer", crypto.randomUUID(), 30000);
if (!lease) throw new Error("writer lease unavailable");
try {
let server = { publish() { return 0; } };
let plan = await Plan.open(process.env.CHANNEL_ID, {
 storage, lease: () => lease, fatal(error) { throw error; }
}, server);
if (process.env.RESTART_PHASE === "write") {
 plan.conversationPlan = applyEvent(plan.conversationPlan, {
  id: "opened", type: "thread.opened", threadId: "pilot",
  observedThreadVersion: 0, origin: "planner",
  actor: { kind: "agent" }, at: 1000, question: "Ship a pilot?"
 });
 plan.conversationPlanJobs = [{
  id: "heading:document:m1", kind: "heading", target: "document", trigger: "m1",
  status: "running", attempts: 0, at: "2026-10-02T10:00:00.000Z"
 }];
  plan.conversationPlanEffects = ["job:heading:document"];
  let message = { id: "research-source", author: { kind: "member", handle: "ana" }, text: "Investigate public API alternatives.", ts: 1000 };
  plan.chat.entries.push(message);
  let input = { state: plan.conversationPlan, message, recent: [] };
  plan.conversationPlan = applyResearchOpportunity(plan.conversationPlan, plan.id, input, {
   analysis: { messageId: message.id, questionSetVersion: "conversation-research-1", modelVersion: "fixture", status: "unlinked", answers: {}, policyGate: "", latencyMs: 1 },
   candidate: { source: { messageId: message.id, author: message.author, quote: message.text, start: 0, end: message.text.length }, context: researchContext(input), standalone: true, explicit: true, changed: false }
  });
  let processor = createProcessor({ plan, exclusive: action => Plan.exclusive(plan, action), persist: () => Plan.persistExclusive(plan), publish() {}, active: () => true });
  let offer = plan.conversationPlan.researchOffers[0];
  let opened = await processor.editResearch(offer.id, { kind: "begin" }, message.author);
  let model = Draft.restore(opened.offer.workflow.draft).fork();
  await processor.editResearch(offer.id, { kind: "patch", patch: Draft.change(model, "Compare public API alternatives and licensing.") }, message.author);
  await processor.researchConsent({ offerId: offer.id, choice: "research", actionId: "start-research" }, message.author, "U_ana");
  processor.stop();
  await Plan.persist(plan);
}
console.log(JSON.stringify({
 source: Plan.source(plan), revision: plan.revision, seq: plan.document.seq,
 state: plan.conversationPlan, jobs: plan.conversationPlanJobs,
  receipts: plan.conversationPlanEffects, storageRevision: plan.persistence.revision,
  pending: plan.conversationPlanPendingEffects
}));
} finally {
 await storage.leases.release(lease);
 await storage.close();
}
// Exit without a room close/checkpoint; the next process must use committed storage.
process.exit(0);
`;

if (database) {
	describe("PostgreSQL conversation reconstruction", () => {
		test(
			"fresh processes retain accepted state and durably interrupt a running job once",
			async () => {
				let storage = new PostgresStorage(database);
				await storage.migrate();
				let now = new Date();
				let userId = crypto.randomUUID();
				let channelId = crypto.randomUUID();
				try {
					await storage.users.put({ id: userId, login: "ana", avatarUrl: "", now });
					let initial = await import("../../plan/service").then(module =>
						module.initial("# Pilot\n\nAlready accepted document output.")
					);
					await storage.channels.create({
						id: channelId,
						repositoryId: crypto.randomUUID(),
						repositoryOwner: "octo-org",
						repositoryName: "score",
						title: "Restart",
						createdBy: userId,
						now,
						initial,
					});
					let run = async (phase: string) => {
						let child = Bun.spawn(["bun", "--eval", reconstruction], {
							cwd: root,
							env: { ...process.env, CHANNEL_ID: channelId, RESTART_PHASE: phase },
							stdout: "pipe",
							stderr: "pipe",
						});
						let deadline = setTimeout(() => child.kill(), 15_000);
						let [output, errors, code] = await Promise.all([
							new Response(child.stdout).text(),
							new Response(child.stderr).text(),
							child.exited,
						]).finally(() => clearTimeout(deadline));
						expect(errors).toBe("");
						expect(code).toBe(0);
						return JSON.parse(output);
					};
					let written = await run("write");
					expect(written.jobs[0].status).toBe("running");
					let first = await run("read");
					expect(first.jobs).toMatchObject([{
						status: "failed",
						reason: "interrupted",
						attempts: 0,
					}]);
					expect(first.source).toBe(written.source);
					expect(first.state).toEqual(written.state);
					expect(first.receipts).toEqual(["job:heading:document"]);
					expect(first.state.researchOffers[0].workflow.accepted).toMatchObject({
						brief: "Compare public API alternatives and licensing.",
					});
					expect(first.pending).toMatchObject([{ kind: "research" }]);
					expect([first.revision, first.seq]).toEqual([written.revision, written.seq]);
					let stored = await storage.collaboration.load(channelId, new Date());
					expect(stored?.sidecar ?? stored?.snapshot?.sidecar).toMatchObject({
						conversationPlanJobs: [{ status: "failed", reason: "interrupted" }],
					});
					let second = await run("read");
					expect(second).toEqual(first);
				} finally {
					await storage.close();
				}
			},
			30_000,
		);
	});
} else {
	test.skip("PostgreSQL conversation reconstruction needs TEST_DATABASE_URL", () => {});
}
