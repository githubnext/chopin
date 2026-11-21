import { expect, test } from "bun:test";

import { userAndChannel } from "../storage/contract-support";
import { MemoryStorage } from "../storage/memory/adapter";
import { lastModels } from "./last-models";

import type { CapabilityCatalog } from "@chopin/agent-link";
import type { Lease, PlannerCatalog } from "../storage/model";

const LARGE: CapabilityCatalog = {
	models: {
		available: [{ id: "acme/large", name: "Large", thinkingLevels: ["low", "high"] }],
		default: { id: "acme/large" },
	},
};
const SMALL: CapabilityCatalog = { models: { available: [{ id: "acme/small", name: "Small" }] } };

async function kept() {
	let storage = new MemoryStorage();
	let { userId, channelId, lease } = await userAndChannel(storage);
	let puts: PlannerCatalog[] = [];
	let put = storage.plannerCatalogs.put.bind(storage.plannerCatalogs);
	storage.plannerCatalogs.put = async (held: Lease, row: PlannerCatalog) => {
		puts.push(row);
		return put(held, row);
	};
	let held: Lease | undefined = lease;
	let clock = 0;
	let models = lastModels({
		storage,
		lease: () => held,
		now: () => new Date(++clock * 1_000),
	});
	return { storage, userId, channelId, puts, models, drop: () => held = undefined };
}

test("keeps what a document's Planner reported for its account, once for each change", async () => {
	let { storage, userId, channelId, puts, models } = await kept();
	await models.remember(channelId, { userId, catalog: LARGE });
	await models.remember(channelId, { userId, catalog: LARGE });
	expect(puts).toHaveLength(1);
	expect(await storage.plannerCatalogs.get(channelId, userId)).toEqual({
		channelId,
		userId,
		catalog: {
			models: [{ id: "acme/large", name: "Large", thinkingLevels: ["low", "high"] }],
			default: { model: "acme/large" },
		},
		reportedAt: new Date(1_000),
	});
	await models.remember(channelId, { userId, catalog: SMALL });
	expect(puts).toHaveLength(2);
	expect((await storage.plannerCatalogs.get(channelId, userId))?.catalog).toEqual({
		models: [{ id: "acme/small", name: "Small" }],
	});
});

test("keeps the last list when a report lists no models, and saves nothing without the writer lease", async () => {
	let { storage, userId, channelId, puts, models, drop } = await kept();
	await models.remember(channelId, { userId, catalog: LARGE });
	await models.remember(channelId, { userId, catalog: undefined });
	await models.remember(channelId, { userId, catalog: { models: { available: [] } } });
	expect(puts).toHaveLength(1);
	drop();
	await models.remember(channelId, { userId, catalog: SMALL });
	expect(puts).toHaveLength(1);
	expect((await storage.plannerCatalogs.get(channelId, userId))?.catalog.models[0]?.id).toBe(
		"acme/large",
	);
});

test("saves reports in the order they came, so the newest is what stays", async () => {
	let { storage, userId, channelId, models } = await kept();
	// Not awaited between: three reports of one link in quick succession.
	let saves = [
		models.remember(channelId, { userId, catalog: LARGE }),
		models.remember(channelId, { userId, catalog: SMALL }),
		models.remember(channelId, { userId, catalog: LARGE }),
	];
	await Promise.all(saves);
	expect((await storage.plannerCatalogs.get(channelId, userId))?.catalog.models[0]?.id).toBe(
		"acme/large",
	);
});

test("a save storage refuses is said and tried again with the next report", async () => {
	let { storage, userId, channelId, models } = await kept();
	let put = storage.plannerCatalogs.put;
	let refuse = true;
	storage.plannerCatalogs.put = (held, row) =>
		refuse ? Promise.reject(new Error("storage is down")) : put(held, row);
	let errors = console.error;
	let said: unknown[] = [];
	console.error = (...args: unknown[]) => said.push(args[0]);
	try {
		await models.remember(channelId, { userId, catalog: LARGE });
	} finally {
		console.error = errors;
	}
	expect(said).toEqual(["chopin: could not keep a document's model list -"]);
	refuse = false;
	await models.remember(channelId, { userId, catalog: LARGE });
	expect((await storage.plannerCatalogs.get(channelId, userId))?.catalog.models[0]?.id).toBe(
		"acme/large",
	);
});
