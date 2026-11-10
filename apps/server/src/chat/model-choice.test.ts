import { afterEach, describe, expect, test } from "bun:test";

import { createPlannerAgent } from "../harness/agents";
import { openPlannerSession } from "../harness/session";
import * as Plan from "../plan/service";
import { openPlan } from "../testing/plan";
import { expectPlain } from "../testing/plain-words";
import { broadcast, tell } from "../wire";
import { authenticatedMemory } from "./job-authenticated-memory.test-fixtures";
import { chooseModel, modelState, publishModelState, turnModel } from "./model-choice";
import * as Chat from "./service";

import type { HarnessV1 } from "@ai-sdk/harness";
import type { Chat as Wire } from "@chopin/protocol";
import type { ModelChoiceDeps } from "./model-choice";
import type { Socket } from "../wire";

afterEach(() => Chat.holdStarts(false));

let catalog: Wire.ModelCatalog = {
	models: [
		{
			id: "acme/large",
			name: "Large",
			provider: { id: "acme", name: "Acme" },
			thinkingLevels: ["off", "low", "high"],
		},
		{ id: "acme/small", name: "Small", provider: { id: "acme", name: "Acme" } },
	],
	default: { model: "acme/small" },
};

async function sets(offered: () => Wire.ModelCatalog | undefined = () => catalog) {
	let opened = await openPlan("Related prose.\n");
	let deps: ModelChoiceDeps = {
		catalog: async () => offered(),
		storage: opened.storage,
		lease: () => opened.lease,
		now: () => new Date("2026-08-13T12:30:00.000Z"),
	};
	let replies: Array<Record<string, unknown>> = [];
	let ws = {
		send(text: string) {
			replies.push(JSON.parse(text));
			return text.length;
		},
	};
	let choose = (
		fields: Record<string, unknown>,
		options: { child?: boolean } = {},
	) =>
		chooseModel(deps, {
			server: opened.server,
			ws,
			channelId: opened.channel.id,
			userId: "U_test",
			child: options.child ?? false,
		}, { kind: "chat:model", rid: crypto.randomUUID(), ts: 0, ...fields } as never);
	let broadcasts = () => opened.broadcasts.filter(frame => frame.kind === "chat:model");
	return { opened, deps, replies, choose, broadcasts };
}

describe("choosing a document's model and thinking level", () => {
	test("stores a choice the catalog offers, then answers the sender and tells the room", async () => {
		let { opened, deps, replies, choose, broadcasts } = await sets();
		await choose({ model: "acme/large", thinkingLevel: "high" });
		expect(await opened.storage.plannerModelChoices.get(opened.channel.id)).toMatchObject({
			model: "acme/large",
			thinkingLevel: "high",
			userId: "U_test",
		});
		let expected = {
			kind: "chat:model",
			catalog,
			choice: { model: "acme/large", thinkingLevel: "high" },
		};
		expect(replies).toMatchObject([expected]);
		expect(broadcasts()).toMatchObject([expected]);
		// Another person's join reads the same state.
		expect(await modelState(deps, opened.channel.id)).toMatchObject(expected);
	});

	test("refuses a model, or a level of its model, the catalog does not offer, and stores nothing", async () => {
		let { opened, replies, choose, broadcasts } = await sets();
		await choose({ model: "acme/gone" });
		await choose({ model: "acme/small", thinkingLevel: "high" });
		await choose({ model: "acme/large", thinkingLevel: "max" });
		await choose({ thinkingLevel: "low" });
		expect(replies.map(reply => reply.message)).toEqual([
			"That model isn't available.",
			"That model doesn't offer that level of reasoning.",
			"That model doesn't offer that level of reasoning.",
			"That model doesn't offer that level of reasoning.",
		]);
		expect(replies.every(reply => reply.kind === "session:error")).toBe(true);
		for (let reply of replies) expectPlain(String(reply.message), "a refused model choice");
		expect(await opened.storage.plannerModelChoices.get(opened.channel.id)).toBeUndefined();
		expect(broadcasts()).toEqual([]);
	});

	test("chooses any model and level the catalog lists, spelled and as long as the client wrote them", async () => {
		// The picker offers every entry of the catalog, so each can be chosen and is kept as it was.
		let long = `acme/${"m".repeat(5_000)}`;
		let odd: Wire.ModelCatalog = {
			models: [
				{
					id: long,
					name: "Long",
					thinkingLevels: ["extra high", "deep thought", "\u4f4e", "x".repeat(300)],
				},
				{ id: 'with space \n and "quotes"', name: "Spaced" },
			],
		};
		let { opened, replies, choose, broadcasts } = await sets(() => odd);
		await choose({ model: long, thinkingLevel: "deep thought" });
		expect(replies.at(-1)).toMatchObject({ kind: "chat:model" });
		expect(await opened.storage.plannerModelChoices.get(opened.channel.id)).toMatchObject({
			model: long,
			thinkingLevel: "deep thought",
		});
		await choose({ model: long, thinkingLevel: "\u4f4e" });
		await choose({ model: long, thinkingLevel: "x".repeat(300) });
		await choose({ model: 'with space \n and "quotes"' });
		expect(await opened.storage.plannerModelChoices.get(opened.channel.id)).toMatchObject({
			model: 'with space \n and "quotes"',
		});
		expect(replies.every(reply => reply.kind === "chat:model")).toBe(true);
		expect(broadcasts()).toHaveLength(4);
	});

	test("refuses a string only because the catalog does not list it, however long", async () => {
		let { opened, replies, choose, broadcasts } = await sets();
		await choose({ model: "x".repeat(257) });
		await choose({ model: "acme/large", thinkingLevel: "x".repeat(1_000_000) });
		await choose({ model: "" });
		// A client's model with no id, or an empty level, never reaches a catalog (see the link), so
		// an empty string is only ever a choice the catalog does not list.
		await choose({ model: "acme/large", thinkingLevel: "" });
		expect(replies.map(reply => reply.message)).toEqual([
			"That model isn't available.",
			"That model doesn't offer that level of reasoning.",
			"That model isn't available.",
			"That model doesn't offer that level of reasoning.",
		]);
		expect(await opened.storage.plannerModelChoices.get(opened.channel.id)).toBeUndefined();
		expect(broadcasts()).toEqual([]);
	});

	test("refuses anything that is not a string, and any choice for a child document", async () => {
		let { opened, replies, choose, broadcasts } = await sets();
		for (let fields of [{ model: 3 }, { model: null }, { thinkingLevel: ["low"] }]) {
			await choose(fields);
		}
		await choose({ model: "acme/large" }, { child: true });
		expect(replies.map(reply => reply.message)).toEqual([
			"That is not a model choice.",
			"That is not a model choice.",
			"That is not a model choice.",
			"A child document uses its parent's model.",
		]);
		expect(await opened.storage.plannerModelChoices.get(opened.channel.id)).toBeUndefined();
		expect(broadcasts()).toEqual([]);
	});

	test("refuses every choice where nothing can be chosen, but always accepts going back to the default", async () => {
		let { opened, replies, choose, broadcasts } = await sets(() => undefined);
		await choose({ model: "acme/large" });
		expect(replies[0]!.message).toBe("This document's model can't be chosen.");
		await choose({});
		expect(replies[1]).toMatchObject({ kind: "chat:model" });
		expect(broadcasts()).toHaveLength(1);
		expect(await opened.storage.plannerModelChoices.get(opened.channel.id)).toBeUndefined();
	});

	test("going back to the default removes the stored choice for everyone", async () => {
		let { opened, deps, choose, broadcasts } = await sets();
		await choose({ model: "acme/large", thinkingLevel: "low" });
		await choose({});
		expect(await opened.storage.plannerModelChoices.get(opened.channel.id)).toBeUndefined();
		let last = broadcasts().at(-1)!;
		expect("choice" in last).toBe(false);
		expect("choice" in await modelState(deps, opened.channel.id)).toBe(false);
	});

	test("answers nobody until the choice is stored: a failed write is refused as passing, and nothing is broadcast", async () => {
		let { opened, replies, choose, broadcasts } = await sets();
		let put = opened.storage.plannerModelChoices.put;
		opened.storage.plannerModelChoices.put = async () => {
			throw new Error("storage is busy");
		};
		let silenced = console.error;
		console.error = () => {};
		try {
			await choose({ model: "acme/large" });
		} finally {
			console.error = silenced;
			opened.storage.plannerModelChoices.put = put;
		}
		expect(replies).toMatchObject([{
			kind: "session:error",
			code: "temporarily-unavailable",
			message: "Couldn't save the model choice. Try again.",
		}]);
		expect(broadcasts()).toEqual([]);
		expect(await opened.storage.plannerModelChoices.get(opened.channel.id)).toBeUndefined();
	});

	test("hears two people's choices in the order they were stored", async () => {
		let { opened, deps, choose, broadcasts } = await sets();
		await Promise.all([
			choose({ model: "acme/large", thinkingLevel: "low" }),
			choose({ model: "acme/small" }),
		]);
		expect(broadcasts().map(frame => frame.choice)).toEqual([
			{ model: "acme/large", thinkingLevel: "low" },
			{ model: "acme/small" },
		]);
		expect((await modelState(deps, opened.channel.id)).choice).toEqual({ model: "acme/small" });
	});
});

/** What a member of the room hears, in the order it arrives: broadcasts and what it is told alone. */
type Heard = Array<Record<string, unknown>>;

/**
 * Holds the first read a document's model state makes of `read` (its stored choice, or the catalog
 * its harness reports) open until `release`, with the value the read had when it began, as a slow
 * query that started before a choice was stored and answers after it.
 */
function slowFirstRead<T extends object, K extends keyof T>(owner: T, read: K) {
	let method = owner[read] as unknown as (...args: unknown[]) => Promise<unknown>;
	let { promise: gate, resolve: release } = Promise.withResolvers<void>();
	let held = false;
	(owner as Record<K, unknown>)[read] = async (...args: unknown[]) => {
		let value = await method.apply(owner, args);
		if (!held) {
			held = true;
			await gate;
		}
		return value;
	};
	return release;
}

test("a removed model keeps the name its catalog reported for the room and the turn", async () => {
	let offered: Wire.ModelCatalog | undefined = catalog;
	let { deps, opened, choose } = await sets(() => offered);
	await choose({ model: "acme/large" });
	offered = { models: [catalog.models[1]!], default: catalog.default };
	expect((await modelState(deps, opened.channel.id)).modelName).toBe("Large");
	expect((await turnModel(deps, opened.channel.id)).notice).toBe(
		"Large is no longer available, so Chopin used its default model.",
	);
});

describe("the stored choice a room is told where nothing can be chosen", () => {
	test("is told while the harness knows it offers nothing, and held back while it cannot know yet", async () => {
		let offered: Wire.ModelCatalog | undefined = catalog;
		let known = true;
		let { deps, opened, choose } = await sets(() => offered);
		deps.known = () => known;
		let chosen = { model: "acme/large", thinkingLevel: "high" };
		await choose(chosen);
		// The client withdrew its models, or an older one took its place: the picker has nothing to
		// list, and the choice the document holds is still the room's, so the composer can say so.
		offered = undefined;
		expect(await modelState(deps, opened.channel.id)).toEqual({
			kind: "chat:model",
			ts: 0,
			choice: chosen,
			modelName: "Large",
		});
		// No client is attached, or it has yet to report (a restart, a blip): nothing is said of the
		// choice, which is neither gone nor honoured, and the machine's own status speaks.
		known = false;
		expect(await modelState(deps, opened.channel.id)).toEqual({ kind: "chat:model", ts: 0 });
		// A catalog carries the choice whatever else is known, and nothing stored was changed.
		offered = catalog;
		expect(await modelState(deps, opened.channel.id)).toEqual({
			kind: "chat:model",
			ts: 0,
			catalog,
			choice: chosen,
			modelName: "Large",
		});
		expect(await opened.storage.plannerModelChoices.get(opened.channel.id)).toMatchObject(chosen);
		// Nobody chose: there is no choice to say, known or not.
		let fresh = await sets(() => undefined);
		fresh.deps.known = () => true;
		expect(await modelState(fresh.deps, fresh.opened.channel.id)).toEqual({
			kind: "chat:model",
			ts: 0,
		});
	});

	test("a turn that falls back where what the harness offers is unknown says so once, so the room is told the choice", async () => {
		let known = false;
		let fellBack: string[] = [];
		let { deps, opened, choose } = await sets();
		await choose({ model: "acme/large", thinkingLevel: "high" });
		let silent: ModelChoiceDeps = {
			...deps,
			catalog: async () => undefined,
			known: () => known,
			fellBack: id => {
				fellBack.push(id);
				known = true;
			},
		};
		// Before any turn nothing is said of the choice, and nothing has fallen back.
		expect(await modelState(silent, opened.channel.id)).toEqual({ kind: "chat:model", ts: 0 });
		// The turn found no catalog to check it against: the default runs, with the notice, and the
		// harness is told that it did.
		expect(await turnModel(silent, opened.channel.id)).toEqual({
			notice: "Large is no longer available, so Chopin used its default model.",
		});
		expect(fellBack).toEqual([opened.channel.id]);
		// So the choice is now told, and the composer can say what the turn did.
		expect(await modelState(silent, opened.channel.id)).toEqual({
			kind: "chat:model",
			ts: 0,
			choice: { model: "acme/large", thinkingLevel: "high" },
			modelName: "Large",
		});
	});

	test("says nothing of a fallback where it knows what the harness offers, or when nothing was chosen, or when a catalog was there to check", async () => {
		let fellBack: string[] = [];
		let offered: Wire.ModelCatalog | undefined = catalog;
		let known = true;
		let { deps, opened, choose } = await sets(() => offered);
		let watched: ModelChoiceDeps = {
			...deps,
			known: () => known,
			fellBack: id => void fellBack.push(id),
		};
		// Nobody chose: the default is no choice, known or not.
		known = false;
		offered = undefined;
		expect(await turnModel(watched, opened.channel.id)).toEqual({});
		offered = catalog;
		await choose({ model: "acme/large" });
		// A catalog was there, and it lists the model: it runs, and nothing fell back.
		expect(await turnModel(watched, opened.channel.id)).toEqual({ model: "acme/large" });
		// A catalog was there and the model has gone: that is told in the catalog's own way.
		offered = { models: [catalog.models[1]!], default: catalog.default };
		expect((await turnModel(watched, opened.channel.id)).notice).toContain("no longer available");
		// The harness knows it offers nothing (a client that reported nothing): known already.
		offered = undefined;
		known = true;
		expect((await turnModel(watched, opened.channel.id)).notice).toContain("no longer available");
		expect(fellBack).toEqual([]);
	});

	test("is told to everyone when the client that went comes back, and the turn runs the default meanwhile", async () => {
		let offered: Wire.ModelCatalog | undefined = catalog;
		let { deps, opened, choose } = await sets(() => offered);
		deps.known = () => true;
		await choose({ model: "acme/large" });
		offered = undefined;
		let gone = "Large is no longer available, so Chopin used its default model.";
		expect(await turnModel(deps, opened.channel.id)).toEqual({ notice: gone });
		expect((await modelState(deps, opened.channel.id)).choice).toEqual({ model: "acme/large" });
		offered = catalog;
		expect(await turnModel(deps, opened.channel.id)).toEqual({ model: "acme/large" });
	});
});

describe("a room hears its model state in the order it was stored", () => {
	/** A person's choice goes out of `choose`; what the held announcement or join delivers is `heard`. */
	async function racing(held?: "choice" | "catalog") {
		let offered: Wire.ModelCatalog | undefined = catalog;
		let { opened, deps, choose } = await sets(() => offered);
		let heard: Heard = [];
		let publish = opened.server.publish.bind(opened.server);
		opened.server.publish = ((topic: string, data: string) => {
			heard.push(JSON.parse(data));
			return publish(topic, data);
		}) as never;
		let release = held === "choice"
			? slowFirstRead(opened.storage.plannerModelChoices, "get")
			: held === "catalog"
			? slowFirstRead(deps, "catalog")
			: () => {};
		let channelId = opened.channel.id;
		// What main.ts does: an announcement goes to the room, a join's state to the joiner alone.
		let announce = (state: Wire.ModelState) => broadcast(opened.server, channelId, state);
		let joiner = { send: (text: string) => heard.push(JSON.parse(text)) };
		let greet = (state: Wire.ModelState) => tell(joiner, state);
		let settle = async (reads: Promise<void>, choosing: Promise<void>) => {
			// Long enough for an unordered choice to store and broadcast ahead of the slow read.
			await Bun.sleep(20);
			release();
			await Promise.all([reads, choosing]);
		};
		return {
			opened,
			deps,
			choose,
			heard,
			announce,
			greet,
			settle,
			offer: (next: typeof offered) => (offered = next),
		};
	}

	for (let held of ["choice", "catalog"] as const) {
		test(`a catalog change announced while a choice is being stored does not bring the old choice back (slow ${held} read)`, async () => {
			let { opened, deps, choose, heard, announce, settle } = await racing(held);
			let announced = publishModelState(deps, opened.channel.id, announce);
			let choosing = choose({ model: "acme/large", thinkingLevel: "high" });
			await settle(announced, choosing);
			expect(heard.at(-1)).toMatchObject({
				kind: "chat:model",
				catalog,
				choice: { model: "acme/large", thinkingLevel: "high" },
			});
			expect(await opened.storage.plannerModelChoices.get(opened.channel.id)).toMatchObject({
				model: "acme/large",
				thinkingLevel: "high",
			});
		});

		test(`a person who joins while a choice is being stored ends up with that choice (slow ${held} read)`, async () => {
			let { opened, deps, choose, heard, greet, settle } = await racing(held);
			// The joiner is already subscribed to the room, so it hears the broadcast as well.
			let joining = publishModelState(deps, opened.channel.id, greet);
			let choosing = choose({ model: "acme/small" });
			await settle(joining, choosing);
			expect(heard.at(-1)).toMatchObject({ kind: "chat:model", choice: { model: "acme/small" } });
		});
	}

	test("an announcement made after a choice was stored says the new choice and the current catalog", async () => {
		let { opened, deps, choose, heard, announce, offer } = await racing();
		await choose({ model: "acme/large" });
		offer({ models: [catalog.models[0]!] });
		await publishModelState(deps, opened.channel.id, announce);
		expect(heard.at(-1)).toMatchObject({
			kind: "chat:model",
			catalog: { models: [catalog.models[0]] },
			choice: { model: "acme/large" },
		});
	});

	test("a read that fails refuses nothing and does not hold up the announcements and choices behind it", async () => {
		let { opened, deps, choose, heard, announce } = await racing();
		let get = opened.storage.plannerModelChoices.get;
		opened.storage.plannerModelChoices.get = async () => {
			throw new Error("storage is busy");
		};
		await expect(publishModelState(deps, opened.channel.id, announce)).rejects.toThrow(
			"storage is busy",
		);
		opened.storage.plannerModelChoices.get = get;
		await choose({ model: "acme/small" });
		await publishModelState(deps, opened.channel.id, announce);
		expect(heard.map(frame => frame.choice)).toEqual([{ model: "acme/small" }, {
			model: "acme/small",
		}]);
	});
});

describe("what the next turn runs", () => {
	test("is the harness's own until somebody chooses", async () => {
		let { deps, opened } = await sets();
		expect(await turnModel(deps, opened.channel.id)).toEqual({});
	});

	test("is the stored choice while the catalog offers it", async () => {
		let { deps, opened, choose } = await sets();
		await choose({ model: "acme/large", thinkingLevel: "high" });
		expect(await turnModel(deps, opened.channel.id)).toEqual({
			model: "acme/large",
			thinkingLevel: "high",
		});
	});

	test("falls back to the default with a notice when the model has gone, and returns when it does", async () => {
		let offered: Wire.ModelCatalog | undefined = catalog;
		let { deps, opened, choose } = await sets(() => offered);
		await choose({ model: "acme/large", thinkingLevel: "high" });
		offered = { models: [catalog.models[1]!], default: catalog.default };
		expect(await turnModel(deps, opened.channel.id)).toEqual({
			notice: "Large is no longer available, so Chopin used its default model.",
		});
		// Still stored, so the model coming back restores the choice.
		expect((await modelState(deps, opened.channel.id)).choice).toEqual({
			model: "acme/large",
			thinkingLevel: "high",
		});
		offered = catalog;
		expect(await turnModel(deps, opened.channel.id)).toEqual({
			model: "acme/large",
			thinkingLevel: "high",
		});
	});

	test("is exactly the level that was chosen, among levels that read alike", async () => {
		let levels = ["xhigh", "extra high", "high", "High", "\u00df-fast", "SS-fast"];
		let odd: Wire.ModelCatalog = {
			models: [{ id: "acme/odd", name: "Odd", thinkingLevels: levels }],
			default: { model: "acme/odd" },
		};
		let { deps, opened, choose, replies } = await sets(() => odd);
		for (let level of levels) {
			await choose({ model: "acme/odd", thinkingLevel: level });
			expect(await turnModel(deps, opened.channel.id)).toEqual({
				model: "acme/odd",
				thinkingLevel: level,
			});
			expect((await modelState(deps, opened.channel.id)).choice).toEqual({
				model: "acme/odd",
				thinkingLevel: level,
			});
		}
		expect(replies.every(reply => reply.kind === "chat:model")).toBe(true);
		// A spelling the model does not list is not one of them, whatever it reads like.
		await choose({ model: "acme/odd", thinkingLevel: "HIGH" });
		expect(replies.at(-1)).toMatchObject({
			kind: "session:error",
			message: "That model doesn't offer that level of reasoning.",
		});
		expect(await turnModel(deps, opened.channel.id)).toEqual({
			model: "acme/odd",
			thinkingLevel: "SS-fast",
		});
	});

	test("keeps the model and falls back only on a level it no longer lists", async () => {
		let offered: Wire.ModelCatalog | undefined = catalog;
		let { deps, opened, choose } = await sets(() => offered);
		await choose({ model: "acme/large", thinkingLevel: "high" });
		offered = {
			models: [{ ...catalog.models[0]!, thinkingLevels: ["off", "low"] }, catalog.models[1]!],
			default: catalog.default,
		};
		expect(await turnModel(deps, opened.channel.id)).toEqual({
			model: "acme/large",
			notice: "high reasoning is no longer available for this model, so Chopin used its default.",
		});
	});

	test("falls back when the harness offers no catalog at all", async () => {
		let offered: Wire.ModelCatalog | undefined = catalog;
		let { deps, opened, choose } = await sets(() => offered);
		await choose({ model: "acme/large" });
		offered = undefined;
		expect(await turnModel(deps, opened.channel.id)).toMatchObject({
			notice: "Large is no longer available, so Chopin used its default model.",
		});
	});
});

/** A Planner that records which model and thinking level each turn asked for. */
function recordingPlanner() {
	let models: Array<string | undefined> = [];
	let levels: Array<string | undefined> = [];
	let fake: HarnessV1 = {
		specificationVersion: "harness-v1",
		harnessId: "model-choice",
		builtinTools: {},
		async doStart(start) {
			return {
				sessionId: start.sessionId,
				isResume: false,
				async doPromptTurn(options) {
					models.push(options.model);
					levels.push((options as { thinkingLevel?: string }).thinkingLevel);
					options.emit({ type: "text-start", id: "reply" });
					options.emit({ type: "text-delta", id: "reply", delta: "Done." });
					options.emit({ type: "text-end", id: "reply" });
					options.emit({
						type: "finish-step",
						finishReason: { unified: "stop", raw: undefined },
						usage: {
							inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
							outputTokens: { total: 0, text: 0, reasoning: 0 },
						},
					});
					return { done: Promise.resolve(), async submitToolResult() {} };
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
	return { fake, models, levels };
}

describe("a Planner turn", () => {
	async function room(
		picked: () => Promise<{ model?: string; thinkingLevel?: string; notice?: string }>,
	) {
		let opened = await openPlan("Related prose.\n");
		let identity = await authenticatedMemory(opened);
		let { fake, models, levels } = recordingPlanner();
		identity.context.modelChoice = picked;
		identity.context.openPlannerSession = (owner, channel) =>
			openPlannerSession(owner, channel, {
				agent: createPlannerAgent(fake),
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
		let socket = {
			data: { handle: "ana", principalId: "U_test" },
			send() {},
		} as unknown as Socket;
		let send = async (text: string) => {
			await Chat.send(identity.context, socket, {
				kind: "chat:send",
				rid: crypto.randomUUID(),
				requestId: crypto.randomUUID(),
				text,
				to: "planner",
				ts: 0,
			});
			for (let attempt = 0; attempt < 300 && opened.plan.chat.busy; attempt++) await Bun.sleep(10);
			await opened.plan.chat.running;
		};
		let said = () =>
			opened.plan.chat.entries.filter(entry => entry.author.kind === "system").map(entry =>
				entry.text
			);
		let finish = async () => {
			identity.revokeAll();
			await Plan.close(opened.plan);
		};
		return { opened, send, models, levels, said, finish };
	}

	test("runs the chosen model, and the harness's default when nobody chose", async () => {
		let choice: { model?: string } = {};
		let { send, models, finish } = await room(async () => choice);
		try {
			await send("first");
			choice = { model: "acme/large" };
			await send("second");
			choice = {};
			await send("third");
			expect(models).toEqual([undefined, "acme/large", undefined]);
		} finally {
			await finish();
		}
	});

	test("puts the chosen thinking level on the turn, and none when nobody chose one", async () => {
		let choice: { model?: string; thinkingLevel?: string } = {};
		let { send, levels, finish } = await room(async () => choice);
		try {
			await send("first");
			choice = { model: "acme/large", thinkingLevel: "high" };
			await send("second");
			choice = { thinkingLevel: "low" };
			await send("third");
			choice = {};
			await send("fourth");
			expect(levels).toEqual([undefined, "high", "low", undefined]);
		} finally {
			await finish();
		}
	});

	test("keeps a level to its own document's turn when two turns run at once", async () => {
		let first = await room(async () => ({ thinkingLevel: "high" }));
		let second = await room(async () => ({ thinkingLevel: "low" }));
		let third = await room(async () => ({}));
		try {
			await Promise.all([first.send("one"), second.send("two"), third.send("three")]);
			expect([first.levels, second.levels, third.levels]).toEqual([["high"], ["low"], [undefined]]);
		} finally {
			await Promise.all([first.finish(), second.finish(), third.finish()]);
		}
	});

	test("says once, in Chat, that a choice that is gone ran the default, and again only when it changes", async () => {
		let notice: string | undefined =
			"Large is no longer available, so Chopin used its default model.";
		let { send, models, said, finish } = await room(async () => (notice ? { notice } : {}));
		try {
			await send("first");
			await send("second");
			expect(models).toEqual([undefined, undefined]);
			expect(said().filter(text => text.includes("no longer available"))).toEqual([notice]);
			for (let text of said()) expectPlain(text, "the fallback notice");
			notice = "Small is no longer available, so Chopin used its default model.";
			await send("third");
			notice = undefined;
			await send("fourth");
			notice = "Small is no longer available, so Chopin used its default model.";
			await send("fifth");
			expect(said().filter(text => text.includes("no longer available"))).toEqual([
				"Large is no longer available, so Chopin used its default model.",
				"Small is no longer available, so Chopin used its default model.",
				"Small is no longer available, so Chopin used its default model.",
			]);
		} finally {
			await finish();
		}
	});

	test("still runs when the choice cannot be read, with the harness's default, and says so in Chat and to the composers", async () => {
		let { opened, send, models, said, finish } = await room(async () => {
			throw new Error("storage is busy");
		});
		let silenced = console.error;
		console.error = () => {};
		let lines: string[] = [];
		try {
			await send("hello");
			lines = said();
		} finally {
			console.error = silenced;
			await finish();
		}
		expect(models).toEqual([undefined]);
		// Never silently: the default ran, and the room is told that the choice could not be read.
		let unread = "This document's model choice couldn't be read, so Chopin used its default model.";
		expect(lines.filter(text => text.includes("couldn't be read"))).toEqual([unread]);
		for (let text of lines) expectPlain(text, "the unreadable-choice notice");
		expect(opened.broadcasts.filter(frame => frame.kind === "chat:model-unreadable")).toMatchObject(
			[
				{ unreadable: true },
			],
		);
	});

	test("tells a person who joins that the last turn could not read the choice, and nothing once one could", async () => {
		let readable = false;
		let { opened, send, finish } = await room(async () => {
			if (!readable) throw new Error("storage is busy");
			return { model: "acme/large" };
		});
		let joined = () => {
			let frames: Array<{ kind: string; unreadable?: boolean }> = [];
			Chat.greet(
				opened.plan.chat,
				{ send: (text: string) => frames.push(JSON.parse(text)) } as never,
			);
			return frames.filter(frame => frame.kind.startsWith("chat:model")).map(frame => [
				frame.kind,
				frame.unreadable,
			]);
		};
		let silenced = console.error;
		console.error = () => {};
		try {
			expect(joined()).toEqual([]);
			await send("first");
			expect(joined()).toEqual([["chat:model-unreadable", true]]);
			readable = true;
			await send("second");
			expect(joined()).toEqual([]);
		} finally {
			console.error = silenced;
			await finish();
		}
	});

	test("says a choice it could not read once while that holds, clears it when a later turn reads it, and says it again if it fails again", async () => {
		let readable = false;
		let { opened, send, models, said, finish } = await room(async () => {
			if (!readable) throw new Error("the catalog is unavailable");
			return { model: "acme/large" };
		});
		let silenced = console.error;
		console.error = () => {};
		let lines: string[] = [];
		try {
			await send("first");
			await send("second");
			readable = true;
			await send("third");
			readable = false;
			await send("fourth");
			lines = said();
		} finally {
			console.error = silenced;
			await finish();
		}
		// The default ran whenever the choice could not be read, and the chosen model when it could.
		expect(models).toEqual([undefined, undefined, "acme/large", undefined]);
		let unread = "This document's model choice couldn't be read, so Chopin used its default model.";
		expect(lines.filter(text => text.includes("couldn't be read"))).toEqual([unread, unread]);
		// The composers hear a change only, so the strip is neither repeated nor left up once it is untrue.
		expect(
			opened.broadcasts.filter(frame => frame.kind === "chat:model-unreadable").map(frame =>
				frame.unreadable
			),
		).toEqual([true, false, true]);
	});
});

describe("a document's commands in its model state", () => {
	test("tells the room what the harness offers, in the order and with the duplicates it reported", async () => {
		let { opened, deps } = await sets(() => undefined);
		let commands: Wire.CommandOption[] = [
			{ name: "review", kind: "prompt", description: "Review the diff" },
			{ name: "review", kind: "prompt" },
		];
		deps.commands = async () => commands;
		expect((await modelState(deps, opened.channel.id)).commands).toEqual(commands);
	});

	test("leaves the field out where the harness offers none, and never fails the state for it", async () => {
		let { opened, deps } = await sets();
		expect("commands" in await modelState(deps, opened.channel.id)).toBe(false);
		deps.commands = async () => [];
		expect("commands" in await modelState(deps, opened.channel.id)).toBe(false);
		let error = console.error;
		console.error = () => {};
		try {
			deps.commands = async () => {
				throw new Error("no session");
			};
			let state = await modelState(deps, opened.channel.id);
			expect("commands" in state).toBe(false);
			expect(state.catalog).toEqual(catalog);
		} finally {
			console.error = error;
		}
	});
});
