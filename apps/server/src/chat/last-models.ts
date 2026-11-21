/**
 * The models each document's remote Planner last reported, kept per account so that account's
 * composer can show them, marked as the last known list, while a Planner of the document starts
 * again (see `ModelState.lastKnown`).
 */

import { remoteCatalog } from "../harness/catalog";

import type { CapabilityCatalog } from "@chopin/agent-link";
import type { Lease } from "../storage/model";
import type { StorageAdapter } from "../storage/port";

export type ReportedCatalog = { userId: string; catalog: CapabilityCatalog | undefined };

/**
 * Saves what a document's Planner reported for the account it attached for, under the writer lease,
 * when it lists models and differs from what was last saved for that document and account. A report
 * with no models keeps the last list, and so does a process without the lease. Saves of one list
 * run in the order they were reported; one that fails is said in the log and tried with the next
 * report.
 */
export function lastModels(options: {
	storage: Pick<StorageAdapter, "plannerCatalogs">;
	lease: () => Lease | undefined;
	operatorModel?: string;
	now?: () => Date;
}): { remember(channelId: string, reported: ReportedCatalog): Promise<void> } {
	let saved = new Map<string, { hash: bigint | number; saving: Promise<void> }>();
	return {
		remember(channelId, reported) {
			let catalog = remoteCatalog(reported.catalog, options.operatorModel);
			let lease = options.lease();
			if (!catalog?.models.length || !lease) return Promise.resolve();
			let key = JSON.stringify([channelId, reported.userId]);
			let hash = Bun.hash(JSON.stringify(catalog));
			let last = saved.get(key);
			if (last?.hash === hash) return last.saving;
			let reportedAt = (options.now ?? (() => new Date()))();
			let entry = {
				hash,
				saving: Promise.resolve(),
			};
			entry.saving = (last?.saving ?? Promise.resolve()).then(() =>
				options.storage.plannerCatalogs.put(lease, {
					channelId,
					userId: reported.userId,
					catalog,
					reportedAt,
				})
			).catch(error => {
				if (saved.get(key) === entry) saved.delete(key);
				console.error("chopin: could not keep a document's model list -", error);
			});
			saved.set(key, entry);
			return entry.saving;
		},
	};
}
