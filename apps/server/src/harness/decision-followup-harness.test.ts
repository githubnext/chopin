import { expect, spyOn, test } from "bun:test";
import { createPlannerAgent, plannerAgent } from "./agents";
import { openPlannerSession } from "./session";
import { BACKGROUND_TOOL_NAMES } from "./tool-names";
import { documentTools } from "../agent/tools";
import { scopedJobTools } from "../agent/job-tools";
import { fixture, running, scopeRoom } from "../questions/decision-followup.test-fixtures";
import * as Room from "../plan/room";
import type { HarnessV1 } from "@ai-sdk/harness";
import type { ActiveOwnerBinding } from "../agent/active-owner";

test("the session selects the follow-up profile and executes only its scoped writing boundary", async () => {
	let context = await fixture();
	let id = context.ids[0]!;
	await context.save(id, "Keep offline support.");
	running(context);
	let room = scopeRoom(context);
	let names: string[] = [];
	let results: unknown[] = [];
	let fake: HarnessV1 = {
		specificationVersion: "harness-v1",
		harnessId: "decision-followup-test",
		builtinTools: {},
		async doStart(start) {
			return {
				sessionId: start.sessionId,
				isResume: false,
				async doPromptTurn(turn) {
					names = turn.tools.map(spec => spec.name);
					let done = Promise.withResolvers<void>();
					queueMicrotask(() =>
						turn.emit({
							type: "tool-call",
							toolCallId: "scope-read",
							toolName: "read_decision_scope",
							input: "{}",
						})
					);
					return {
						done: done.promise,
						async submitToolResult(value) {
							results.push(value.output);
							let first = results.length === 1;
							turn.emit({
								type: "tool-result",
								toolCallId: first ? "scope-read" : "scope-write",
								toolName: first ? "read_decision_scope" : "write_decision_scope",
								result: value.output as string,
							});
							if (first) {
								let snapshot = JSON.parse(value.output as string);
								turn.emit({
									type: "tool-call",
									toolCallId: "scope-write",
									toolName: "write_decision_scope",
									input: JSON.stringify({
										id,
										revision: snapshot.revision,
										answersHash: snapshot.answersHash,
										source: "Offline support is required.",
									}),
								});
								return;
							}
							turn.emit({
								type: "finish-step",
								finishReason: { unified: "stop", raw: undefined },
								usage: {
									inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
									outputTokens: { total: 0, text: 0, reasoning: 0 },
								},
							});
							done.resolve();
						},
					};
				},
				async doDestroy() {},
				async doCompact() {},
				async doContinueTurn() {
					throw new Error("unused");
				},
				async doSuspendTurn() {
					throw new Error("unused");
				},
				async doDetach() {
					throw new Error("unused");
				},
				async doStop() {
					throw new Error("unused");
				},
			};
		},
	};
	let owner: ActiveOwnerBinding = {
		channelId: room.id,
		token: "test-token",
		repository: { id: "R_test", owner: "owner", name: "repository", defaultBranch: "main" },
		ownerSessionId: "owner-session",
		ownerGeneration: 1,
		credentialRevision: 1,
		expiresAt: new Date(Date.now() + 60_000),
		signal: new AbortController().signal,
		currentToken: () => "test-token",
		revalidate: async () => true,
		release() {},
	};
	let fallback = spyOn(plannerAgent, "createSession").mockRejectedValue(
		new Error("A follow-up must not select the ordinary Planner"),
	);
	let opened: Awaited<ReturnType<typeof openPlannerSession>> | undefined;
	try {
		let dependencies = {
			followupAgent: createPlannerAgent(fake, "decision-followup"),
			githubTools: async () => ({ ok: true as const, value: {} }),
			createSandbox: async () =>
				({
					defaultWorkingDirectory: "/tmp",
					run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
					destroy: async () => {},
				}) as never,
			registerCredential: () => () => {},
		};
		opened = await openPlannerSession(owner, {
			room,
			repository: owner.repository,
			instructions: "Update only the saved decision scope.",
		}, dependencies);
		if (!opened.ok) {
			throw new Error(`Follow-up profile unavailable: ${opened.error.kind}`, {
				cause: "cause" in opened.error ? opened.error.cause : undefined,
			});
		}
		let stream = await opened.value.stream("Incorporate the saved answer.", owner.signal);
		for await (let _part of stream.fullStream) {}
		expect([...names].sort()).toEqual([...BACKGROUND_TOOL_NAMES["decision-followup"]].sort());
		expect(names).toContain("read_decision_scope");
		expect(names).toContain("write_decision_scope");
		expect(names).not.toContain("edit_plan");
		expect(names).not.toContain("open_decisions");
		expect(results).toHaveLength(2);
		expect(JSON.parse(results[1] as string)).toMatchObject({ ok: true, id, replayed: false });
		expect(Room.project(context.plan.document)).toContain("Offline support is required.");
		let before = Room.project(context.plan.document);
		let stale = scopedJobTools({ edit_plan: documentTools.edit_plan }, room);
		let refusal = await stale.edit_plan!.execute!({
			revision: context.plan.revision,
			operations: [{ op: "replace_root", source: "An unrelated rewrite." }],
		}, { context: { room, owner }, toolCallId: "stale-tool", messages: [] } as never);
		expect(refusal).toContain("edit_plan is not available");
		expect(Room.project(context.plan.document)).toBe(before);
	} finally {
		if (opened?.ok) await opened.value.destroy();
		fallback.mockRestore();
	}
});
