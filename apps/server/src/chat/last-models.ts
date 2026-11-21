/**
 * The models each document's remote Planner last reported, kept per account so that account's
 * composer can show them, marked as the last known list, while a Planner of the document starts
 * again (see `ModelState.lastKnown`).
 */

import { remoteCatalog } from "../harness/catalog";

import type { CapabilityCatalog } from "@chopin/agent-link";
import type { Lease, PlannerCatalog } from "../storage/model";
import type { StorageAdapter } from "../storage/port";

export type ReportedCatalog = { userId: string; catalog: CapabilityCatalog | undefined };

/**
 * The list last reported for `userId` on the document, else their latest on any document, of the
 * accounts they have now: one reported before their AI accounts last changed (`changedAt`,
 * milliseconds since the epoch) was listed through accounts they may no longer have, and is none.
 */
export async function keptList(
	storage: Pick<StorageAdapter, "plannerCatalogs">,
	channelId: string,
	userId: string,
	changedAt = -Infinity,
): Promise<PlannerCatalog | undefined> {
	let current = (kept: PlannerCatalog | undefined) =>
		kept && kept.reportedAt.getTime() >= changedAt ? kept : undefined;
	return current(await storage.plannerCatalogs.get(channelId, userId))
		?? current(await storage.plannerCatalogs.latest(userId));
}

/**
 * Saves what a document's Planner reported for the account it attached for, under the writer lease,
 * when it lists models and differs from what was last saved for that document and account, or the
 * account's AI accounts changed since (`changed`), so the list is saved as of the accounts they have
 * now. A report with no models keeps the last list, and so does a process without the lease. Saves
 * of one list run in the order they were reported; one that fails is said in the log and tried with
 * the next report.
 */
export function lastModels(options: {
	storage: Pick<StorageAdapter, "plannerCatalogs">;
	lease: () => Lease | undefined;
	operatorModel?: string;
	now?: () => Date;
}): {
	remember(channelId: string, reported: ReportedCatalog): Promise<void>;
	changed(userId: string): void;
} {
	let saved = new Map<string, { hash?: bigint | number; userId: string; saving: Promise<void> }>();
	return {
		changed(userId) {
			// The next report is saved even if it lists the same: it is of the accounts they have now.
			for (let entry of saved.values()) if (entry.userId === userId) entry.hash = undefined;
		},
		remember(channelId, reported) {
			let catalog = remoteCatalog(reported.catalog, options.operatorModel);
			let lease = options.lease();
			if (!catalog?.models.length || !lease) return Promise.resolve();
			let key = JSON.stringify([channelId, reported.userId]);
			let hash = Bun.hash(JSON.stringify(catalog));
			let last = saved.get(key);
			if (last?.hash === hash) return last.saving;
			let reportedAt = (options.now ?? (() => new Date()))();
			let entry: { hash?: bigint | number; userId: string; saving: Promise<void> } = {
				hash,
				userId: reported.userId,
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
