import { expect, test } from "bun:test";

import type { ActiveOwnerBinding } from "../agent/active-owner";
import type { WorkerSandbox } from "../jobs/worker-session";
import { type ReplyAgent, replyToReaction } from "./reaction-worker";
import type { ReactionReplyInput } from "./service";

function binding(overrides: Partial<ActiveOwnerBinding> = {}) {
	let released = 0;
	let value = {
		channelId: "room",
		token: "gho_owner",
		ownerSessionId: "owner",
		ownerGeneration: 1,
		credentialRevision: 1,
		signal: new AbortController().signal,
		currentToken: () => "gho_owner",
		revalidate: async () => true,
		release: () => void released++,
		...overrides,
	} as unknown as ActiveOwnerBinding;
	return { value, released: () => released };
}

function input(overrides: Partial<ReactionReplyInput> = {}): ReactionReplyInput {
	return {
		entry: { id: "a1", author: { kind: "agent" }, text: "I proposed three phases.", ts: 1 },
		emoji: "🤔",
		handle: "ben",
		intent: "confused",
		preceding: [{ author: "member", handle: "ana", text: "Plan the rollout." }],
		signal: new AbortController().signal,
		...overrides,
	};
}

function fake(text: string | undefined = "Phase one is the restringing.") {
	let destroyed = 0;
	let generated: Array<{ prompt: string; options: { model: string; instructions: string } }> = [];
	let agent = {
		createSession: async () => ({ destroy: async () => void destroyed++ }),
		generate: async (call: any) => {
			generated.push({ prompt: call.prompt, options: call.options });
			return { output: { text } };
		},
	} as unknown as ReplyAgent;
	let sandbox = (async () => ({ destroy: async () => {} })) as unknown as () => Promise<
		WorkerSandbox
	>;
	return { agent, sandbox, generated, destroyed: () => destroyed };
}

test("a worker with no tools writes the reply from the data it is given, as the owner's borrowed credential", async () => {
	let owner = binding();
	let worker = fake("  Phase one is the restringing.  ");
	let text = await replyToReaction(input(), {
		binding: owner.value,
		channelId: "room",
		model: "gpt-test",
		agent: worker.agent,
		openSandbox: worker.sandbox,
	});
	expect(text).toBe("Phase one is the restringing.");
	expect(worker.generated).toHaveLength(1);
	expect(JSON.parse(worker.generated[0]!.prompt)).toEqual({
		reading: "confused",
		reaction: { emoji: "🤔", person: "ben" },
		yourMessage: "I proposed three phases.",
		messagesBefore: [{ author: "member", handle: "ana", text: "Plan the rollout." }],
	});
	expect(worker.generated[0]!.options.model).toBe("gpt-test");
	expect(worker.generated[0]!.options.instructions).toContain("You have no tools");
	expect(worker.destroyed()).toBe(1);
});

test("an owner who no longer holds write access gets no reply made", async () => {
	let worker = fake();
	let text = await replyToReaction(input(), {
		binding: binding({ revalidate: async () => false }).value,
		channelId: "room",
		model: "",
		agent: worker.agent,
		openSandbox: worker.sandbox,
	});
	expect(text).toBeUndefined();
	expect(worker.generated).toEqual([]);
	expect(worker.destroyed()).toBe(1);
});

test("an owner who loses access while the reply is being written has it discarded", async () => {
	let checks = 0;
	let worker = fake();
	let text = await replyToReaction(input(), {
		binding: binding({ revalidate: async () => ++checks < 2 }).value,
		channelId: "room",
		model: "",
		agent: worker.agent,
		openSandbox: worker.sandbox,
	});
	expect(text).toBeUndefined();
	expect(worker.generated).toHaveLength(1);
});

test("an empty reply is no reply, and the session is closed either way", async () => {
	let worker = fake("   ");
	expect(
		await replyToReaction(input(), {
			binding: binding().value,
			channelId: "room",
			model: "",
			agent: worker.agent,
			openSandbox: worker.sandbox,
		}),
	).toBeUndefined();
	expect(worker.destroyed()).toBe(1);
});

test("a stopped request writes nothing", async () => {
	let controller = new AbortController();
	controller.abort(new Error("stopped"));
	let worker = fake();
	let text = await replyToReaction(input({ signal: controller.signal }), {
		binding: binding().value,
		channelId: "room",
		model: "",
		agent: worker.agent,
		openSandbox: worker.sandbox,
	}).catch(() => undefined);
	expect(text).toBeUndefined();
	expect(worker.generated).toEqual([]);
});

test("the real reply agent offers the model no tools", async () => {
	let { reactionReplyAgent } = await import("../harness/agents");
	let agent = reactionReplyAgent as unknown as {
		settings?: { tools?: object; activeTools?: unknown[] };
	};
	expect(Object.keys(agent.settings?.tools ?? {})).toEqual([]);
	expect(agent.settings?.activeTools).toEqual([]);
});
