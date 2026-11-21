/**
 * The models a person's own AI accounts offer, listed the way an Atomic agent on a launch for them
 * lists its own, but by Chopin, at once, with no agent and no machine: Atomic's model runtime, run
 * here with no network, is given the public model catalog Chopin serves agents and the account's own
 * Copilot model list, as its refresh would have read them through Chopin's proxy, and a stand-in in
 * place of every key, as an agent on a launch holds. It reads and sends nothing itself, so no
 * credential reaches it.
 */

import { AuthStorage, ModelRuntime } from "@bastani/atomic";
import {
	githubCopilotProvider,
	parseGitHubCopilotDiscoveredModels,
} from "@bastani/atomic-ai/providers/github-copilot";
import { parseGitHubCopilotAccountModelLists } from "@bastani/atomic-ai/providers/github-copilot-account";
import {
	buildModelsDevChatModels,
	finalizeChatModels,
} from "@bastani/atomic-ai/utils/models-dev-catalog";
import { ATOMIC_AI_PROVIDERS } from "@chopin/protocol/ai-credentials";

import { atomicCatalog } from "../harness/atomic/adapter";

import type { AiProvider } from "@chopin/protocol/ai-credentials";
import type { Chat as Wire } from "@chopin/protocol";
import type { CopilotModelList } from "./copilot";
import type { HeldCatalog } from "./model-catalog";

/** What the stand-in key of every provider says; Atomic's runtime only needs one to be there. */
const STAND_IN = "chopin-account-lists";

/** How long a person's list is served as it is, and how long it is served while it is computed again. */
export const ACCOUNT_MODELS_FRESH_MS = 2 * 60_000;
export const ACCOUNT_MODELS_STALE_MS = 30 * 60_000;

/** What a person's list is computed from: the providers they can use, and Copilot's own list. */
export type AccountModelSources = { providers: readonly AiProvider[]; copilot?: CopilotModelList };

type ModelsStoreEntry = {
	models: unknown[];
	lastModified?: number;
	checkedAt?: number;
	etag?: string;
};

/** The catalog's chat models by provider, as Atomic's catalog refresh maps them. */
type ParsedCatalog = { byProvider: Map<string, unknown[]>; lastModified: number; etag?: string };

let parsed = new WeakMap<HeldCatalog, ParsedCatalog | undefined>();

/**
 * The catalog's chat models by provider, mapped as Atomic's refresh maps a download
 * (`loadRemoteCatalog`), once per catalog fetched; undefined for a catalog that isn't one.
 */
function parse(held: HeldCatalog): ParsedCatalog | undefined {
	if (parsed.has(held)) return parsed.get(held);
	let result: ParsedCatalog | undefined;
	try {
		let data: unknown = JSON.parse(new TextDecoder().decode(held.body));
		if (data && typeof data === "object" && !Array.isArray(data)) {
			let byProvider = new Map<string, unknown[]>();
			for (let model of finalizeChatModels(buildModelsDevChatModels(data as never))) {
				let list = byProvider.get(model.provider) ?? [];
				list.push({ ...model, type: "chat" });
				byProvider.set(model.provider, list);
			}
			let modified = Date.parse(held.headers.get("last-modified") ?? "");
			let etag = held.headers.get("etag") ?? undefined;
			result = {
				byProvider,
				lastModified: Number.isNaN(modified) ? held.fetchedAt : modified,
				...(etag ? { etag } : {}),
			};
		}
	} catch {
		result = undefined;
	}
	parsed.set(held, result);
	return result;
}

/**
 * What an Atomic agent on a launch for this person would list, as Chopin's Planner offers models:
 * each chat model of the Atomic providers their usable accounts stand for (`ATOMIC_AI_PROVIDERS`),
 * as `provider/model`, from Atomic's own catalog, the public catalog newer than it and, for GitHub
 * Copilot, the models the account's own list adds, kept to those the account's list enables, as
 * Atomic keeps them for a key whose list it has read. Copilot is left out where its list couldn't
 * be read, as a Planner leaves it out until it has the list. Undefined when nothing is left.
 */
export async function accountCatalog(input: {
	sources: AccountModelSources;
	catalog?: HeldCatalog;
	now: number;
}): Promise<Wire.ModelCatalog | undefined> {
	let catalog = input.catalog && parse(input.catalog);
	let providers = new Set(
		input.sources.providers.flatMap(provider => ATOMIC_AI_PROVIDERS[provider]),
	);
	let entries = new Map<string, ModelsStoreEntry>();
	for (let id of providers) {
		let models = catalog?.byProvider.get(id);
		if (!models) continue;
		entries.set(id, {
			models,
			lastModified: catalog!.lastModified,
			checkedAt: input.now,
			...(catalog!.etag ? { etag: catalog!.etag } : {}),
		});
	}
	let credentials: Record<string, Record<string, unknown>> = {};
	for (let id of providers) credentials[id] = { type: "api_key", key: STAND_IN };
	if (providers.has("github-copilot")) {
		let copilot = copilotLists(input.sources.copilot, entries.get("github-copilot")?.models ?? []);
		if (copilot) {
			let entry = entries.get("github-copilot") ?? { models: [], checkedAt: input.now };
			entries.set("github-copilot", { ...entry, models: [...entry.models, ...copilot.discovered] });
			credentials["github-copilot"] = { ...credentials["github-copilot"], ...copilot.lists };
		} else {
			providers.delete("github-copilot");
			delete credentials["github-copilot"];
		}
	}
	if (!providers.size) return undefined;
	let runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(credentials as never),
		modelsPath: null,
		modelsStore: {
			read: async id => entries.get(id) as never,
			write: async (id, entry) => void entries.set(id, entry as ModelsStoreEntry),
			delete: async id => void entries.delete(id),
		},
		allowModelNetwork: false,
	});
	let listed = await atomicCatalog(runtime, { auth: "auto" }, undefined);
	// Only what their accounts stand for: a key in this process's own environment is not theirs.
	let models = listed.models.filter(model => model.provider && providers.has(model.provider.id));
	return models.length ? { models } : undefined;
}

/**
 * Copilot's account lists for Atomic's key (`availableModelIds`, `fastModelIds`) and the models its
 * list adds to the catalog (`discovered`), read from the account's own model list as Atomic reads
 * it; undefined where there is no list or it isn't one.
 */
function copilotLists(list: CopilotModelList | undefined, overlay: readonly unknown[]) {
	if (!list) return undefined;
	try {
		let provider = githubCopilotProvider();
		let known = [...provider.getAllModels?.() ?? provider.getModels(), ...overlay];
		let { availableModelIds, fastModelIds } = parseGitHubCopilotAccountModelLists(
			list.list,
			list.baseUrl,
		);
		return {
			lists: { availableModelIds, fastModelIds },
			discovered: parseGitHubCopilotDiscoveredModels(list.list, known as never),
		};
	} catch {
		return undefined;
	}
}

export type AccountModels = {
	/**
	 * The list held for `userId`: as it is while it is fresh, and while it is not yet stale as it is
	 * too, computing it again meanwhile; otherwise the one computed now, waited for at most `waitMs`.
	 * Undefined when there is none yet, or their accounts offer no model Chopin can list.
	 */
	read(userId: string, waitMs?: number): Promise<Wire.ModelCatalog | undefined>;
	/** Starts computing `userId`'s list when none fresh is held. */
	warm(userId: string): void;
	/** `userId`'s accounts changed: the list held for them goes, and `changed` hears it. */
	forget(userId: string): void;
};

type Held = { at: number; value: Wire.ModelCatalog | undefined; said: string };

/**
 * Each person's list, computed from their own accounts (`sources`) and the catalog the process
 * holds, kept for `ACCOUNT_MODELS_FRESH_MS` and computed again in the background after that, and
 * dropped when their accounts change. `changed` hears whose list changed once one computed differs
 * from what was held, or was dropped, or is ready for a reader that stopped waiting for it, so their
 * open composers can be told it.
 */
export function accountModels(options: {
	sources: (userId: string) => Promise<AccountModelSources>;
	catalog: () => Promise<HeldCatalog | undefined>;
	changed?: (userId: string) => void;
	clock?: () => number;
}): AccountModels {
	let clock = options.clock ?? Date.now;
	let held = new Map<string, Held>();
	let computing = new Map<string, Promise<Held | undefined>>();
	let generations = new Map<string, number>();
	/** Whose list a reader stopped waiting for: they are told once it is computed. */
	let owed = new Set<string>();

	function compute(userId: string): Promise<Held | undefined> {
		let running = computing.get(userId);
		if (running) return running;
		let generation = generations.get(userId) ?? 0;
		let work = (async (): Promise<Held | undefined> => {
			let [sources, catalog] = await Promise.all([options.sources(userId), options.catalog()]);
			let now = clock();
			let value = await accountCatalog({ sources, catalog, now });
			if ((generations.get(userId) ?? 0) !== generation) return undefined;
			let said = JSON.stringify(value ?? null);
			let before = held.get(userId);
			let next = { at: now, value, said };
			held.set(userId, next);
			for (let [id, entry] of held) if (now - entry.at >= ACCOUNT_MODELS_STALE_MS) held.delete(id);
			let told = owed.delete(userId);
			if ((before && before.said !== said) || (told && value)) options.changed?.(userId);
			return next;
		})().catch(error => {
			console.error("[ai] could not list a person's models from their AI accounts:", error);
			return undefined;
		}).finally(() => {
			if (computing.get(userId) === work) computing.delete(userId);
		});
		computing.set(userId, work);
		return work;
	}

	return {
		async read(userId, waitMs = 0) {
			let kept = held.get(userId);
			let age = kept ? clock() - kept.at : Infinity;
			if (kept && age < ACCOUNT_MODELS_FRESH_MS) return kept.value;
			let work = compute(userId);
			if (kept && age < ACCOUNT_MODELS_STALE_MS) return kept.value;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let waited = await Promise.race([
				work,
				new Promise<undefined>(resolve => {
					timer = setTimeout(() => resolve(undefined), waitMs);
				}),
			]).finally(() => clearTimeout(timer));
			if (!waited) owed.add(userId);
			return waited?.value;
		},
		warm(userId) {
			let kept = held.get(userId);
			if (!kept || clock() - kept.at >= ACCOUNT_MODELS_FRESH_MS) void compute(userId);
		},
		forget(userId) {
			generations.set(userId, (generations.get(userId) ?? 0) + 1);
			computing.delete(userId);
			if (held.delete(userId)) options.changed?.(userId);
		},
	};
}
