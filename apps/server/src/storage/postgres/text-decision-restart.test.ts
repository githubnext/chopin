import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { PostgresStorage } from "./adapter";

let database = process.env.TEST_DATABASE_URL;
let root = resolve(import.meta.dir, "../../../../..");
let reconstruction = `
import { PostgresStorage } from "./apps/server/src/storage/postgres/adapter";
import * as Plan from "./apps/server/src/plan/service";
import * as Questions from "./apps/server/src/questions/service";
import * as Store from "./apps/server/src/questions/store";
import * as Question from "./packages/question/src/index";
let storage = new PostgresStorage(process.env.TEST_DATABASE_URL);
let lease = await storage.leases.acquire("chopin:writer", crypto.randomUUID(), 120000);
if (!lease) throw new Error("writer lease unavailable");
try {
 let server = { publish() { return 0; } };
 let plan = await Plan.open(process.env.CHANNEL_ID, {
  storage, lease: () => lease, fatal(error) { throw error; }
 }, server);
 let phase = process.env.DECISION_PHASE;
 let ws = {
  data: { handle: "ana", client: "restart-client", room: plan.id },
  send(raw) {
   let reply = JSON.parse(raw);
   if (reply.kind === "session:error" || reply.ok === false || reply.accepted === false) {
    throw new Error(raw);
   }
  }, publish() {}
 };
 let id = phase === "write"
  ? await Questions.capture(plan, server, plan.id, {
   key: "text-restart-once", question: "How should onboarding work?",
   description: "Help people learn by doing."
  }, { human: "ana" })
  : [...plan.records.keys()][0];
 if (!id) throw new Error("decision was not restored");
 let before = plan.records.get(id);
 if (phase === "write") {
  let entry = Store.get(plan.questions, id);
  let model = entry.model.fork();
  model.api.str([entry.definition.questions[0].id, "custom"]).ins(0, "Start with a task.");
  await Questions.edit(plan, ws, {
   kind: "question:edit", ts: 0, rid: "edit", id, patch: [...model.api.flush().toBinary()]
  });
 } else if (phase === "resolve") {
  await Questions.submit(plan, server, plan.id, ws, {
   kind: "question:submit", ts: 0, rid: "submit", id,
   revision: Store.get(plan.questions, id).revision
  });
 } else if (phase === "reopen") {
  await Questions.reopen(plan, server, plan.id, ws, {
   kind: "question:reopen", ts: 0, rid: "reopen", id
  });
 }
 let entry = Store.get(plan.questions, id);
 console.log(JSON.stringify({
  id, before, record: plan.records.get(id), source: Plan.source(plan),
  drafts: entry ? Question.read(entry.model, entry.definition) : null,
  revision: entry?.revision
 }));
} finally {
 await storage.leases.release(lease);
 await storage.close();
}
// Reconstruct committed state in another process without a graceful room checkpoint.
process.exit(0);
`;

if (database) {
	test(
		"PostgreSQL reconstructs a written draft, explicit resolution and reopened prose history",
		async () => {
			let storage = new PostgresStorage(database);
			await storage.migrate();
			let now = new Date();
			let userId = crypto.randomUUID();
			let channelId = crypto.randomUUID();
			try {
				await storage.users.put({ id: userId, login: "ana", avatarUrl: "", now });
				await storage.channels.create({
					id: channelId,
					repositoryId: crypto.randomUUID(),
					repositoryOwner: "octo-org",
					repositoryName: "score",
					title: "Text decision restart",
					createdBy: userId,
					now,
				});
				let run = async (phase: string) => {
					let child = Bun.spawn(["bun", "--eval", reconstruction], {
						cwd: root,
						env: { ...process.env, CHANNEL_ID: channelId, DECISION_PHASE: phase },
						stdout: "pipe",
						stderr: "pipe",
					});
					let deadline = setTimeout(() => child.kill(), 240_000);
					let [output, errors, code] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]).finally(() => clearTimeout(deadline));
					expect(errors).toBe("");
					expect(code).toBe(0);
					return JSON.parse(output.trim().split("\n").at(-1)!);
				};
				let written = await run("write");
				let first = await run("read");
				let questionId = first.record.definition.questions[0].id;
				expect(first.id).toBe(written.id);
				expect(first.source).toBe(written.source);
				expect(first.record).toMatchObject({
					origin: "human",
					status: "open",
					definition: { questions: [{ response: "text", options: [] }] },
				});
				expect(first.drafts[questionId]).toMatchObject({
					mode: "custom",
					custom: "Start with a task.",
				});
				let resolved = await run("resolve");
				expect(resolved.record).toMatchObject({
					status: "answered",
					resolver: "ana",
					choices: [],
					answers: { [questionId]: "Start with a task." },
				});
				let reopened = await run("reopen");
				expect(reopened.before).toEqual(resolved.record);
				let restored = await run("read");
				expect(restored.record).toEqual(reopened.record);
				expect(restored.record).toMatchObject({
					status: "reopened",
					history: [{ choices: [], owner: "ana", answers: { [questionId]: "Start with a task." } }],
				});
				expect(restored.drafts[questionId]).toMatchObject({ mode: "custom", custom: "" });
				expect(restored.source).toContain('<Previous value="Start with a task." by="ana"');
			} finally {
				await storage.close();
			}
		},
		1_300_000,
	);
} else {
	test.skip("PostgreSQL written decision reconstruction needs TEST_DATABASE_URL", () => {});
}
