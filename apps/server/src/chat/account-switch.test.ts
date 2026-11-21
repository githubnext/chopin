/**
 * A person's AI accounts changing while a document's remote Planner is attached for them: what
 * their composer is told, as Chopin's process wires the link, the list of their accounts' models and
 * the model state together, and what a pick is checked against.
 */
import { afterEach, describe, expect, it } from "bun:test";

import { accountModels } from "../ai/account-models";
import {
	plannerCatalog,
	plannerOffered,
	plannerOfferIncoming,
	plannerOfferKnown,
	plannerOutdated,
} from "../harness/harnesses";
import { testLease } from "../storage/contract-support";
import { linkAuth, linkServer, rawLink } from "../testing/agent-link";
import { keptList, lastModels } from "./last-models";
import { chooseModel, MODELS_LOADING, modelState, PLANNER_OUTDATED } from "./model-choice";

import type { Chat as Wire } from "@chopin/protocol";
import type { AccountModelSources } from "../ai/account-models";
import type { HeldCatalog } from "../ai/model-catalog";
import type { AgentAi } from "../harness/remote/endpoint";
import type { ModelChoiceDeps } from "./model-choice";

const COPILOT = "https://api.githubcopilot.com";

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function until(condition: () => boolean, withinMs = 2_000) {
	for (let deadline = Date.now() + withinMs; !condition(); await Bun.sleep(5)) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
	}
}

/** The public catalog as Chopin holds it, describing the one Copilot model both accounts have. */
function heldCatalog(): HeldCatalog {
	let body = {
		"github-copilot": {
			id: "github-copilot",
			name: "GitHub Copilot",
			api: COPILOT,
			npm: "@ai-sdk/openai-compatible",
			models: {
				"chopin-large": {
					id: "chopin-large",
					name: "Chopin Large",
					attachment: true,
					reasoning: false,
					tool_call: true,
					modalities: { input: ["text"], output: ["text"] },
					limit: { context: 200_000, output: 32_000 },
					cost: { input: 1, output: 2 },
					provider: { npm: "@ai-sdk/openai" },
				},
			},
		},
	};
	return {
		body: new TextEncoder().encode(JSON.stringify(body)),
		headers: new Headers({ "content-type": "application/json" }),
		fetchedAt: Date.now(),
	};
}

/** One entry of Copilot's `GET /models`. */
function listed(id: string, name: string, preview = false) {
	return {
		id,
		name,
		preview,
		model_picker_enabled: true,
		policy: { state: "enabled" },
		supported_endpoints: ["/chat/completions"],
		capabilities: {
			type: "chat",
			family: id,
			limits: { max_context_window_tokens: 64_000, max_output_tokens: 8_000 },
			supports: { tool_calls: true },
		},
	};
}

/** The sign-in's Copilot list, and that of the token of another account connected in its place. */
const SIGN_IN: AccountModelSources = {
	providers: ["github-copilot"],
	copilot: { list: { data: [listed("chopin-large", "Large")] }, baseUrl: COPILOT },
};
const TOKEN: AccountModelSources = {
	providers: ["github-copilot"],
	copilot: {
		list: {
			data: [listed("chopin-large", "Large"), listed("gemini-4-neon", "Gemini 4 Neon", true)],
		},
		baseUrl: COPILOT,
	},
};

/** What the Planner reports through the sign-in's catalog launch, and through the token's. */
const OLD = {
	models: { available: [{ id: "github-copilot/chopin-large", name: "Planner Large" }] },
};
const NEW = {
	models: {
		available: [
			{ id: "github-copilot/chopin-large", name: "Planner Large" },
			{ id: "github-copilot/gemini-4-neon", name: "Planner Neon" },
		],
	},
};

/** The ids a list names, in an order of their own: which comes first is Atomic's to decide. */
function ids(catalog: Wire.ModelCatalog | undefined) {
	return catalog?.models.map(model => model.id).toSorted();
}

/**
 * A document whose Planner is attached for the member over a link that names its catalog launches,
 * wired as Chopin's process wires it: the member's list of their accounts' models is dropped as
 * their accounts change, before the link hears it.
 */
async function switching(
	options: { accountsWaitMs?: number; features?: string; offeredWaitMs?: number } = {},
) {
	let { auth, channel } = await linkAuth();
	let connected: "sign-in" | "token" = "sign-in";
	/** Holds the computation of the token's list until it is resolved. */
	let tokenListed: Promise<void> = Promise.resolve();
	let listeners = new Set<(userId: string) => void>();
	let heard: string[] = [];
	let handed = 0;
	let prepare: Promise<void> = Promise.resolve();
	let ai: AgentAi = {
		async launch() {
			throw new Error("no session is opened here");
		},
		async catalog() {
			await prepare;
			handed++;
			return {
				launchId: `catalog-${handed}`,
				grants: {
					launch: `chopin_launch_catalog_${handed}`,
					expiresAt: Date.now() + 60 * 60_000,
					providers: [{
						provider: "github-copilot",
						baseUrl: "https://chopin.test/api/v1/ai/github-copilot",
						placeholder: `chopin_ai_catalog_${handed}`,
						keyVariable: "COPILOT_GITHUB_TOKEN",
					}],
					withheld: [],
				},
			};
		},
		end() {},
		onChanged(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	let lists = accountModels({
		async sources(userId) {
			if (userId !== "U_member" || connected === "sign-in") return SIGN_IN;
			await tokenListed;
			return TOKEN;
		},
		catalog: async () => heldCatalog(),
		changed: userId => void heard.push(userId),
	});
	let changedAt = new Map<string, number>();
	ai.onChanged(userId => {
		changedAt.set(userId, Date.now());
		lists.forget(userId);
	});
	let lease = await testLease(auth.storage);
	let kept = lastModels({ storage: auth.storage, lease: () => lease });
	let server = linkServer(auth, 2_000, undefined, 2_000, undefined, undefined, {
		ai,
		catalogChanged: (channelId, reported) => void kept.remember(channelId, reported),
	});
	cleanups.push(server.stop);
	let deps: ModelChoiceDeps = {
		catalog: async id => plannerCatalog("remote", id, undefined),
		known: id => plannerOfferKnown("remote", id),
		incoming: id => plannerOfferIncoming("remote", id, true),
		offered: id => plannerOffered("remote", id, options.offeredWaitMs ?? 300),
		outdated: id => plannerOutdated("remote", id),
		accounts: userId => lists.read(userId, options.accountsWaitMs ?? 5_000),
		lastKnown: (channelId, userId) =>
			keptList(auth.storage, channelId, userId, changedAt.get(userId)),
		storage: auth.storage,
		lease: () => lease,
	};
	let raw = await rawLink(
		server.url,
		undefined,
		options.features ?? "capability-catalog, ai-credentials, ai-catalog, catalog-launches",
	);
	cleanups.push(async () => {
		raw.send({ type: "detach" });
		await raw.closed;
	});
	raw.send({ type: "attach", version: 1, document: channel.id });
	await raw.next("attached");
	let link = server.links.at(-1)!;
	let replies: Array<Record<string, unknown>> = [];
	let choose = (model: string) =>
		chooseModel(deps, {
			server: { publish() {} } as never,
			ws: {
				send(text: string) {
					replies.push(JSON.parse(text));
					return text.length;
				},
			},
			channelId: channel.id,
			userId: "U_member",
			child: false,
		}, { kind: "chat:model", rid: crypto.randomUUID(), ts: 0, model } as never);
	return {
		auth,
		channel,
		raw,
		link,
		deps,
		heard,
		replies,
		choose,
		/**
		 * The member connects a GitHub token of another account in place of their sign-in: `held`
		 * holds its catalog launch, and `listed` the computation of its list.
		 */
		connectToken(held?: Promise<void>, listed?: Promise<void>) {
			connected = "token";
			if (held) prepare = held;
			if (listed) tokenListed = listed;
			for (let listener of listeners) listener("U_member");
		},
		state: (viewer = "U_member") => modelState(deps, channel.id, viewer),
	};
}

describe("a person's AI accounts changing under an attached Planner", () => {
	it("shows the models of their new accounts at once, marked, until the Planner reports through a launch of them, which then wins", async () => {
		let { raw, link, connectToken, state, heard } = await switching();
		// Before the Planner reports, the member is shown their sign-in's list, held for them.
		expect(ids((await state()).accounts?.catalog)).toEqual(["github-copilot/chopin-large"]);
		raw.send({ type: "ai-catalog" });
		let first = await raw.next("ai-catalog");
		raw.send({ type: "capabilities", catalog: OLD, catalogLaunch: first.catalogLaunch });
		await until(() => link.catalog !== undefined);
		let before = await state();
		expect(ids(before.catalog)).toEqual(["github-copilot/chopin-large"]);
		expect(before.accounts).toBeUndefined();

		// The member connects a token of another account; its launch waits to be prepared.
		let release = Promise.withResolvers<void>();
		connectToken(release.promise);
		// Their open composers are told, and what they are told is their new accounts' list,
		// recomputed for the token rather than the one held for their sign-in, marked as theirs.
		expect(heard).toEqual(["U_member"]);
		let switched = await state();
		expect(switched.catalog).toBeUndefined();
		expect(ids(switched.accounts?.catalog)).toEqual([
			"github-copilot/chopin-large",
			"github-copilot/gemini-4-neon",
		]);
		expect(switched.waiting).toEqual({});
		// Nobody else is shown it: a teammate sees their own accounts' list.
		expect(ids((await state("U_rival")).accounts?.catalog)).toEqual([
			"github-copilot/chopin-large",
		]);

		// The old launch's report, late, changes nothing, before the new launch and after.
		raw.send({ type: "capabilities", catalog: OLD, catalogLaunch: first.catalogLaunch });
		await Bun.sleep(50);
		expect((await state()).catalog).toBeUndefined();
		release.resolve();
		let second = await raw.next("ai-catalog");
		raw.send({ type: "capabilities", catalog: OLD, catalogLaunch: first.catalogLaunch });
		await Bun.sleep(50);
		expect((await state()).catalog).toBeUndefined();
		expect(ids((await state()).accounts?.catalog)).toContain("github-copilot/gemini-4-neon");

		// The Planner's report through the new launch is what is shown, unmarked.
		raw.send({ type: "capabilities", catalog: NEW, catalogLaunch: second.catalogLaunch });
		await until(() => link.catalog !== undefined);
		let after = await state();
		expect(ids(after.catalog)).toEqual([
			"github-copilot/chopin-large",
			"github-copilot/gemini-4-neon",
		]);
		expect(after.accounts).toBeUndefined();
		expect(after.waiting).toBeUndefined();
	});

	it("checks a pick against the Planner's report through a launch of the person's accounts as they are now, and never against an earlier one", async () => {
		let { auth, channel, raw, link, connectToken, replies, choose } = await switching();
		raw.send({ type: "ai-catalog" });
		let first = await raw.next("ai-catalog");
		raw.send({ type: "capabilities", catalog: OLD, catalogLaunch: first.catalogLaunch });
		await until(() => link.catalog !== undefined);
		let release = Promise.withResolvers<void>();
		connectToken(release.promise);

		// A pick from either list, while the Planner has yet to report for the new accounts.
		await choose("github-copilot/chopin-large");
		await choose("github-copilot/gemini-4-neon");
		expect(replies.map(reply => reply.message)).toEqual([MODELS_LOADING, MODELS_LOADING]);
		expect(await auth.storage.plannerModelChoices.get(channel.id)).toBeUndefined();

		release.resolve();
		let second = await raw.next("ai-catalog");
		raw.send({ type: "capabilities", catalog: NEW, catalogLaunch: second.catalogLaunch });
		await until(() => link.catalog !== undefined);
		await choose("github-copilot/gemini-4-neon");
		expect(await auth.storage.plannerModelChoices.get(channel.id)).toMatchObject({
			model: "github-copilot/gemini-4-neon",
		});
	});

	it("tells a person whose accounts changed nothing kept from the accounts they had while their new accounts' list is computed", async () => {
		let { auth, channel, raw, link, connectToken, state, heard } = await switching({
			accountsWaitMs: 50,
		});
		raw.send({ type: "ai-catalog" });
		let first = await raw.next("ai-catalog");
		raw.send({ type: "capabilities", catalog: OLD, catalogLaunch: first.catalogLaunch });
		await until(() => link.catalog !== undefined);
		// The Planner's list is kept for the member, as Chopin keeps it to show while one starts.
		let saved = async () => await auth.storage.plannerCatalogs.get(channel.id, "U_member");
		for (let deadline = Date.now() + 2_000; !(await saved()); await Bun.sleep(5)) {
			if (Date.now() > deadline) throw new Error("the Planner's list was never kept");
		}

		let listed = Promise.withResolvers<void>();
		connectToken(undefined, listed.promise);
		// Neither the Planner's list nor the one kept from the sign-in: the new accounts' is on its way.
		let waiting = await state();
		expect(waiting.catalog).toBeUndefined();
		expect(waiting.lastKnown).toBeUndefined();
		expect(waiting.accounts).toBeUndefined();
		expect(waiting.waiting).toEqual({});

		heard.length = 0;
		listed.resolve();
		// Whoever stopped waiting for it is told once it is ready, and is then shown it.
		await until(() => heard.includes("U_member"));
		expect(ids((await state()).accounts?.catalog)).toEqual([
			"github-copilot/chopin-large",
			"github-copilot/gemini-4-neon",
		]);
	});

	it("says at once that a Planner that doesn't name its catalog launches needs an update to switch, and refuses a pick in those words without waiting", async () => {
		let { auth, channel, raw, link, connectToken, state, replies, choose } = await switching({
			features: "capability-catalog, ai-credentials, ai-catalog",
			offeredWaitMs: 10_000,
		});
		raw.send({ type: "ai-catalog" });
		await raw.next("ai-catalog");
		raw.send({ type: "capabilities", catalog: OLD });
		await until(() => link.catalog !== undefined);
		connectToken();
		// The member is shown their new accounts' list, and everyone is told the machine needs an
		// update rather than that its models are on their way.
		let switched = await state();
		expect(switched.catalog).toBeUndefined();
		expect(ids(switched.accounts?.catalog)).toContain("github-copilot/gemini-4-neon");
		expect(switched.waiting).toEqual({ outdated: true });
		let started = performance.now();
		await choose("github-copilot/chopin-large");
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(replies.map(reply => reply.message)).toEqual([PLANNER_OUTDATED]);
		expect(await auth.storage.plannerModelChoices.get(channel.id)).toBeUndefined();

		// A report once the new launch is handed is taken, as from any client that doesn't name them.
		await raw.next("ai-catalog");
		raw.send({ type: "capabilities", catalog: NEW });
		await until(() => link.catalog !== undefined);
		let after = await state();
		expect(ids(after.catalog)).toContain("github-copilot/gemini-4-neon");
		expect(after.waiting).toBeUndefined();
	});
});
