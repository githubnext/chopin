import { describe, expect, test } from "bun:test";
import type { Chat, ConversationPlan } from "@chopin/protocol";

type Member = Extract<Chat.Author, { kind: "member" }>;
type SaveCommandFrame = ConversationPlan.ScopedChoiceSave & {
	kind: "conversation-plan:scoped-choice-save";
	rid: string;
	source?: unknown;
	quote?: string;
	actor?: unknown;
};
type RouteDeps = {
	refreshAccess: () => Promise<"allowed" | "denied" | "unavailable">;
	conversationPlanEnabled: boolean;
	canEdit: boolean;
	archived: boolean;
	roomClosing: boolean;
	actor: Member;
	processor?: {
		saveScopedChoice(
			input: ConversationPlan.ScopedChoiceSave,
			actor: Member,
		): Promise<{ eventId: string; revision: number }>;
	};
	reply: (rid: string, frame: unknown) => void;
	fail: (rid: string, message: string) => void;
};
type HandleScopedChoiceSave = (frame: SaveCommandFrame, deps: RouteDeps) => Promise<void>;

let routeUrl = new URL("./save-command.ts", import.meta.url).href;
let route = await import(routeUrl).catch(() => undefined) as
	| { handleScopedChoiceSave?: HandleScopedChoiceSave }
	| undefined;

function handler(): HandleScopedChoiceSave {
	expect(route?.handleScopedChoiceSave).toBeFunction();
	return route!.handleScopedChoiceSave!;
}

function frame(overrides: Partial<SaveCommandFrame> = {}): SaveCommandFrame {
	return {
		kind: "conversation-plan:scoped-choice-save",
		rid: "save-rid",
		actionId: "scoped-save:proposal-1:0",
		threadId: "thread-1",
		expectedVersion: 4,
		proposalId: "proposal-1",
		cardId: "card-1",
		optionId: "option-1",
		expectedLabel: "Lexical",
		expectedGeneration: 0,
		...overrides,
	};
}

function harness(options: {
	access?: "allowed" | "denied" | "unavailable";
	conversationPlanEnabled?: boolean;
	canEdit?: boolean;
	archived?: boolean;
	roomClosing?: boolean;
	processor?: RouteDeps["processor"];
} = {}) {
	let calls: Array<{ input: ConversationPlan.ScopedChoiceSave; actor: Member }> = [];
	let replies: Array<{ rid: string; frame: unknown; durable: boolean }> = [];
	let failures: Array<{ rid: string; message: string }> = [];
	let durable = false;
	let processor: NonNullable<RouteDeps["processor"]> = options.processor ?? {
		saveScopedChoice: async (input, actor) => {
			calls.push({ input, actor });
			durable = true;
			return { eventId: "human:Rob:scoped-save:proposal-1:0", revision: 9 };
		},
	};
	let deps: RouteDeps = {
		refreshAccess: async () => options.access ?? "allowed",
		conversationPlanEnabled: options.conversationPlanEnabled ?? true,
		canEdit: options.canEdit ?? true,
		archived: options.archived ?? false,
		roomClosing: options.roomClosing ?? false,
		actor: { kind: "member", handle: "Rob" },
		processor,
		reply: (rid, value) => replies.push({ rid, frame: value, durable }),
		fail: (rid, message) => failures.push({ rid, message }),
	};
	return { deps, calls, replies, failures, setDurable: (value: boolean) => durable = value };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let promise = new Promise<T>(done => resolve = done);
	return { promise, resolve };
}

async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (condition()) return;
		await Bun.sleep(1);
	}
	throw new Error("condition did not become true");
}

describe("scoped-choice Save wire route", () => {
	test("passes only bounded request fields and replies after the durable save", async () => {
		let gate = deferred<void>();
		let setup = harness({
			processor: {
				saveScopedChoice: async (input, actor) => {
					setup.calls.push({ input, actor });
					await gate.promise;
					setup.setDurable(true);
					return { eventId: "human:Rob:scoped-save:proposal-1:0", revision: 9 };
				},
			},
		});
		let request = frame({
			source: { messageId: "forged", quote: "attacker text" },
			quote: "forged quote",
			actor: { kind: "member", handle: "Mallory" },
		});
		let pending = handler()(request, setup.deps);
		await until(() => setup.calls.length === 1);
		expect(setup.calls).toEqual([{
			input: {
				actionId: request.actionId,
				threadId: request.threadId,
				expectedVersion: request.expectedVersion,
				proposalId: request.proposalId,
				cardId: request.cardId,
				optionId: request.optionId,
				expectedLabel: request.expectedLabel,
				expectedGeneration: request.expectedGeneration,
			},
			actor: { kind: "member", handle: "Rob" },
		}]);
		expect(setup.replies).toEqual([]);
		expect(setup.failures).toEqual([]);

		gate.resolve();
		await pending;
		expect(setup.replies).toEqual([{
			rid: request.rid,
			frame: {
				kind: "conversation-plan:scoped-choice-save",
				ts: 0,
				eventId: "human:Rob:scoped-save:proposal-1:0",
				revision: 9,
			},
			durable: true,
		}]);
		expect(setup.replies[0]!.frame).not.toHaveProperty("answers");
	});

	test("authorization, write access, and room lifecycle gates block the processor", async () => {
		let deniedCases = [
			{ access: "denied" as const },
			{ access: "unavailable" as const },
			{ canEdit: false },
			{ conversationPlanEnabled: false },
			{ archived: true },
			{ roomClosing: true },
		];

		for (let overrides of deniedCases) {
			let setup = harness(overrides);
			await handler()(frame(), setup.deps);
			expect(setup.calls).toEqual([]);
			expect(setup.replies).toEqual([]);
			expect(setup.failures).toHaveLength(1);
		}
	});

	test("a stale proposal error is returned as failure without a success reply", async () => {
		let setup = harness({
			processor: {
				saveScopedChoice: async (input, actor) => {
					setup.calls.push({ input, actor });
					throw new Error("scoped choice card or proposal is stale");
				},
			},
		});
		let request = frame();
		await handler()(request, setup.deps);
		expect(setup.calls).toHaveLength(1);
		expect(setup.replies).toEqual([]);
		expect(setup.failures).toEqual([{
			rid: request.rid,
			message: "scoped choice card or proposal is stale",
		}]);
	});
});
