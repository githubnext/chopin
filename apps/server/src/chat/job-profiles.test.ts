import { installJobCleanup } from "./job.test-fixtures";
import { expect, test } from "bun:test";
import * as Chat from "./service";
import * as Plan from "../plan/service";
import { openPlan } from "../testing/plan";
import { createPlannerAgent } from "../harness/agents";
import { openPlannerSession } from "../harness/session";
import { BACKGROUND_TOOL_NAMES } from "../harness/tool-names";
import { JOB_TOOLS, WRITE_TOOLS } from "../agent/job-scope";
import { headingHarness } from "./job-heading-harness.test-fixtures";
import { harness, JOB } from "./job.test-fixtures";
import type { ActiveOwnerBinding } from "../agent/active-owner";
import type { ConversationPlan } from "@chopin/protocol";

installJobCleanup();

test("each complete background profile opens the current session with only reads and its own writer", async () => {
	for (let kind of ["heading", "refine", "suggest", "prose"] as ConversationPlan.JobKind[]) {
		let opened = await openPlan();
		opened.plan.chat.job = { ...JOB, kind };
		let driver = headingHarness(async () => {}, async output => {
			expect(String(output)).toContain('"revision": 0');
			driver.finish();
		}, { name: "read_plan", input: {} });
		let agent = createPlannerAgent(driver.fake, kind);
		let owner: ActiveOwnerBinding = {
			channelId: opened.channel.id,
			token: "token",
			repository: { id: "R_test", owner: "owner", name: "repository", defaultBranch: "main" },
			ownerSessionId: "owner",
			ownerGeneration: 1,
			credentialRevision: 1,
			expiresAt: new Date(Date.now() + 60_000),
			signal: new AbortController().signal,
			currentToken: () => "token",
			revalidate: async () => true,
			release() {},
		};
		let result = await openPlannerSession(owner, {
			room: Chat.documentRoom(
				{
					plan: opened.plan,
					chat: opened.plan.chat,
					room: opened.channel.id,
					server: opened.server,
					persist: () => Plan.persist(opened.plan),
				} as Chat.Room,
			),
			repository: owner.repository,
			instructions: "Read the document.",
		}, {
			headingAgent: agent,
			refineAgent: agent,
			proseAgent: agent,
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
		try {
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("complete profile did not open");
			expect(result.value.activeTools).toEqual(BACKGROUND_TOOL_NAMES[kind]);
			expect(Object.isFrozen(result.value.activeTools)).toBe(true);
			let stream = await result.value.stream("Read", owner.signal);
			for await (let _part of stream.fullStream) {}
			expect(driver.tools).toEqual([[...BACKGROUND_TOOL_NAMES[kind]]]);
			expect(driver.tools[0]!.filter(name => WRITE_TOOLS.has(name))).toEqual([JOB_TOOLS[kind]]);
			await result.value.destroy();
		} finally {
			opened.plan.chat.job = undefined;
			await Plan.close(opened.plan);
		}
	}
});

test("the direct writer receives the same live verified member request", () => {
	let h = harness();
	h.chat.busy = true;
	h.chat.turn = { id: "turn", handle: "ana", started: 1, responded: false };
	let active: Chat.ActiveMemberRequest = {
		entryId: "entry",
		userId: "U_ana",
		handle: "ana",
		text: "Rename the auth decision.",
		claimantSessionId: "session",
		turnId: "turn",
		lifecycle: h.chat.lifecycle,
	};
	h.chat.entries.push({
		id: "entry",
		author: { kind: "member", handle: "ana" },
		text: active.text,
		ts: 1,
	});
	h.chat.activeRequest = active;
	let room = Chat.documentRoom(h.context);
	expect(room.currentMemberRequest?.()).toBe(active);
	h.chat.entries[0]!.text = "Changed source";
	expect(room.currentMemberRequest?.()).toBeUndefined();
	h.chat.entries[0]!.text = active.text;
	h.chat.lifecycle++;
	expect(room.currentMemberRequest?.()).toBeUndefined();
});
