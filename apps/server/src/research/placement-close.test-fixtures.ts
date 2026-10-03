import assert from "node:assert/strict";
import { placeResearchReference } from "./placement";
import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import * as Plan from "../plan/service";
import * as Chat from "../chat/service";
import * as Rooms from "../rooms";
import { openPlan } from "../testing/plan";
import { authenticatedMemory } from "../chat/job-authenticated-memory.test-fixtures";
import { headingHarness } from "../chat/job-heading-harness.test-fixtures";
import { createPlannerAgent } from "../harness/agents";
import { openPlannerSession } from "../harness/session";
import { createConversationRuntime } from "../conversation-plan/runtime";
import { researchStorage } from "../conversation-plan/accepted-research-storage.test-fixtures";
// Isolate a failed lock cycle so it cannot strand Chat in the parent test process.
let timeout = setTimeout(() => process.exit(2), 5_000);
let opened = await openPlan();
let plan = opened.plan;
let identity = await authenticatedMemory(opened);
let context = identity.context;
let runtime = createConversationRuntime({
	config: { agent: true },
	server: () => opened.server,
	unavailable: () => false,
});
let ws = {
	data: { room: plan.id, client: "client", handle: "test", principalId: "U_test" },
	send() {},
} as never;
let room = Rooms.join(ws);
room.plan = plan;
let main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
let p = parse(main, { sourceType: "module", plugins: ["typescript"] }).program;
let names = ["withDocumentLock", "closeRoom"];
let source = names.map(name => {
	let n = p.body.find(n => n.type === "FunctionDeclaration" && n.id?.name === name)!;
	return main.slice(n.start!, n.end!);
}).join("\n");
let transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
let { closeRoom, withDocumentLock } = new Function(
	"documentLocks",
	"Rooms",
	"Service",
	"conversationRuntime",
	"documentBackend",
	"server",
	transpiled + "\nreturn {closeRoom,withDocumentLock};",
)(new Map(), Rooms, Plan, runtime, () => opened.backend, opened.server);
let { research, jobs } = researchStorage({ opened, plan } as Parameters<typeof researchStorage>[0]);
let entered = Promise.withResolvers<void>();
let release = Promise.withResolvers<void>();
let placementRequested = false;
let workspaceId: string | undefined;
let resultReturned = false;
context.createResearch = async request => {
	let created = await research.startPlannerInline({
		channelId: plan.id,
		question: request.question,
		originMessageId: request.entryId,
		requestedBy: request.userId,
		requestedByHandle: request.handle,
		placeReference: async id => {
			workspaceId = id;
			entered.resolve();
			await release.promise;
			placementRequested = true;
			return placeResearchReference(plan.id, id, {
				get: Rooms.get,
				exclusive: withDocumentLock,
				detached: async (channelId, action) => {
					let detached = await Plan.open(channelId, opened.backend, opened.server);
					try {
						return await action(detached);
					} finally {
						await Plan.close(detached);
					}
				},
			});
		},
	});
	return {
		workspaceId: created.request.id,
		state: created.request.state,
		stage: created.request.stage,
	};
};
let driver = headingHarness(async () => {}, async () => {
	resultReturned = true;
	driver.finish();
}, {
	name: "create_research_workspace",
	input: { question: "Research the exact API compatibility." },
});
let agent = createPlannerAgent(driver.fake);
context.openPlannerSession = (owner, channel) =>
	openPlannerSession(owner, channel, {
		agent,
		githubTools: async () => ({ ok: true, value: {} }),
		createSandbox: async () =>
			({
				defaultWorkingDirectory: "/tmp",
				async run() {
					return { exitCode: 0, stdout: "", stderr: "" };
				},
				async destroy() {},
			}) as never,
		registerCredential: () => () => {},
	});
await Chat.send(context, ws, {
	kind: "chat:send",
	ts: 0,
	rid: "send",
	requestId: crypto.randomUUID(),
	to: "planner",
	text: "Create research on exact API compatibility.",
});
await entered.promise;
let closed = false;
let closeError: unknown;
let closing = closeRoom(room, true).then(
	() => closed = true,
	(error: unknown) => closeError = error,
);
await Bun.sleep(10);
console.log("beforeRelease", {
	closed,
	closing: !!room.closing,
	chatClosed: plan.chat.closed,
	chatRunning: !!plan.chat.running,
});
release.resolve();
await Promise.race([closing, Bun.sleep(300)]);
console.log("afterRelease", {
	closed,
	closeError: String(closeError ?? ""),
	placementRequested,
	resultReturned,
	closing: !!room.closing,
	chatClosed: plan.chat.closed,
	chatRunning: !!plan.chat.running,
});
if (!closed || closeError) {
	console.log(
		"REPRODUCED actual Chat/current Harness tool waits for documentLock held by closeRoom, which waits for Chat.running.",
	);
	process.exit(1);
}
assert.equal(closeError, undefined);
assert.equal(closed, true);
assert.equal(room.closing, undefined);
assert.equal(plan.chat.running, undefined);
assert.equal(resultReturned, true);
assert.ok(workspaceId);
let stored = await opened.storage.research.get(plan.id, workspaceId);
assert.equal(stored?.workspace.id, workspaceId);
assert.equal(stored?.workspace.inlineReference, "pending");
assert.equal(stored?.turns[0]?.evidenceJobId, undefined);
assert.deepEqual((await jobs.list(plan.id, 100))?.jobs, []);
console.log("Deferred request retains its identity, pending reference, and no queued work.");
Rooms.forget(room);
identity.revokeAll();
clearTimeout(timeout);
console.log("No close deadlock in current Harness execution.");
process.exit(0);
