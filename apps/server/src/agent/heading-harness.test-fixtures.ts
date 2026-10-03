import { tool } from "ai";
import { z } from "zod";
import { createPlannerAgent } from "../harness/agents";
import { openPlannerSession } from "../harness/session";
import * as Service from "../plan/service";

import type { HarnessV1 } from "@ai-sdk/harness";
import type { ActiveOwnerBinding } from "./active-owner";
import type { DocumentRoom } from "./tools";
import type { openPlan } from "../testing/plan";

export const INPUT = { revision: 0, title: "Sign in", goal: "Choose how people sign in." };

export function documentRoom(context: Awaited<ReturnType<typeof openPlan>>): DocumentRoom {
	return {
		id: context.channel.id,
		plan: context.plan,
		server: context.server,
		exclusive: action => Service.exclusive(context.plan, action),
		persist: () => Service.persist(context.plan),
		async publish() {},
		anchors() {},
		changes() {},
	};
}

export async function headingSession(
	room: DocumentRoom,
	submit: (result: unknown) => Promise<void>,
) {
	let names: string[] = [];
	let destroyed = { session: 0, sandbox: 0 };
	let fake: HarnessV1 = {
		specificationVersion: "harness-v1",
		harnessId: "heading-test",
		builtinTools: {},
		async doStart(start) {
			return {
				sessionId: start.sessionId,
				isResume: false,
				async doPromptTurn(options) {
					names = options.tools.map(spec => spec.name);
					let done = Promise.withResolvers<void>();
					queueMicrotask(() =>
						options.emit({
							type: "tool-call",
							toolCallId: "heading-1",
							toolName: "draft_heading",
							input: JSON.stringify(INPUT),
						})
					);
					return {
						done: done.promise,
						async submitToolResult(value) {
							await submit(value);
							options.emit({
								type: "tool-result",
								toolCallId: "heading-1",
								toolName: "draft_heading",
								result: value.output as string,
							});
							options.emit({
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
				async doDestroy() {
					destroyed.session++;
				},
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
	let opened = await openPlannerSession(owner, {
		room,
		repository: owner.repository,
		instructions: "Title the document only.",
	}, {
		headingAgent: createPlannerAgent(fake, "heading"),
		githubTools: async () => ({
			ok: true,
			value: {
				list_pull_requests: tool({ inputSchema: z.object({}), execute: async () => "[]" }),
				pull_request_read: tool({ inputSchema: z.object({}), execute: async () => "unused" }),
			},
		}),
		createSandbox: async () =>
			({
				defaultWorkingDirectory: "/tmp",
				async run() {
					return { exitCode: 0, stdout: "", stderr: "" };
				},
				async destroy() {
					destroyed.sandbox++;
				},
			}) as never,
		registerCredential: () => () => {},
	});
	if (!opened.ok) throw new Error(`Could not open test Planner: ${opened.error.kind}`);
	return { session: opened.value, owner, names: () => names, destroyed };
}
