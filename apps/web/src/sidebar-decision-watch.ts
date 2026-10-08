import type { Sidebar } from "@chopin/protocol";

export const MAX_WATCH_FRAME_REPOSITORIES = 50;
export const MAX_WATCHED_REPOSITORIES = 200;
export const MAX_WATCHED_DOCUMENTS = 500;

const FIRST_RETRY_MS = 2_000;
const LAST_RETRY_MS = 60_000;

export type WatchStatus = "requested" | "watched" | "refused" | "unavailable";

export type WatchEntry = {
	identity: string;
	channelIds: ReadonlySet<string>;
	status: WatchStatus;
};

export type WatchLedger = ReadonlyMap<string, WatchEntry>;

export type WatchFrame = {
	repositories: Sidebar.WatchedRepository[];
	sent: ReadonlyMap<string, WatchEntry>;
};

export type WatchPlan = {
	ledger: WatchLedger;
	frames: WatchFrame[];
	unwatch: string[][];
};

function chunks<T>(values: T[], size: number): T[][] {
	let result: T[][] = [];
	for (let start = 0; start < values.length; start += size) {
		result.push(values.slice(start, start + size));
	}
	return result;
}

function identityOf(repository: Sidebar.WatchedRepository): string {
	return `${repository.owner}/${repository.name}`;
}

function framesFor(
	requests: Sidebar.WatchedRepository[],
	ledger: WatchLedger,
): WatchFrame[] {
	let layers: Sidebar.WatchedRepository[][] = [];
	for (let repository of requests) {
		let slices = repository.channelIds.length === 0
			? [[]]
			: chunks(repository.channelIds, MAX_WATCHED_DOCUMENTS);
		slices.forEach((channelIds, layer) => {
			(layers[layer] ??= []).push({ ...repository, channelIds });
		});
	}
	return layers.flatMap(layer =>
		chunks(layer, MAX_WATCH_FRAME_REPOSITORIES).map(repositories => ({
			repositories,
			sent: new Map(
				repositories.map(repository => [
					repository.repositoryId,
					ledger.get(repository.repositoryId)!,
				]),
			),
		}))
	);
}

/**
 * Work out what to send so the server watches exactly the desired repositories and
 * snapshots every loaded document once per connection, including documents loaded
 * after the repository was first watched.
 */
export function planDecisionWatch(
	ledger: WatchLedger,
	desired: Sidebar.WatchedRepository[],
): WatchPlan {
	let next = new Map(ledger);
	let wanted = new Set(desired.map(repository => repository.repositoryId));
	let unwatch = [...ledger.keys()].filter(repositoryId => !wanted.has(repositoryId));
	for (let repositoryId of unwatch) next.delete(repositoryId);
	let requests: Sidebar.WatchedRepository[] = [];
	for (let repository of desired) {
		let identity = identityOf(repository);
		let entry = ledger.get(repository.repositoryId);
		let known = entry?.identity === identity ? entry : undefined;
		if (known?.status === "refused" || known?.status === "unavailable") continue;
		let channelIds = known
			? repository.channelIds.filter(channelId => !known.channelIds.has(channelId))
			: repository.channelIds;
		if (known && channelIds.length === 0) continue;
		requests.push({ ...repository, channelIds });
		next.set(repository.repositoryId, {
			identity,
			channelIds: new Set([...(known?.channelIds ?? []), ...channelIds]),
			status: "requested",
		});
	}
	return {
		ledger: next,
		frames: framesFor(requests, next),
		unwatch: chunks(unwatch, MAX_WATCHED_REPOSITORIES),
	};
}

function replyStatus(reply: Sidebar.Watched | undefined, repositoryId: string): WatchStatus {
	if (reply?.watched.includes(repositoryId)) return "watched";
	if (reply?.refused.includes(repositoryId)) return "refused";
	return "unavailable";
}

function covers(current: WatchEntry, sent: WatchEntry): boolean {
	return current.identity === sent.identity
		&& [...sent.channelIds].every(channelId => current.channelIds.has(channelId));
}

/**
 * Record a watch reply, or a failed request. Success settles only the plan that sent
 * it; a failure also marks any later plan that still relies on its documents, so a
 * retry reconciles them. Unavailable stays until the retry replaces the entry.
 */
export function settleDecisionWatch(
	ledger: WatchLedger,
	frame: WatchFrame,
	reply: Sidebar.Watched | undefined,
): WatchLedger {
	let next = new Map(ledger);
	for (let [repositoryId, sent] of frame.sent) {
		let current = next.get(repositoryId);
		if (!current || current.status === "unavailable") continue;
		let status = replyStatus(reply, repositoryId);
		let settles = status === "unavailable"
			? covers(current, sent)
			: current.channelIds === sent.channelIds;
		if (settles) next.set(repositoryId, { ...current, status });
	}
	return next;
}

export function awaitingRetry(ledger: WatchLedger): boolean {
	return [...ledger.values()].some(entry => entry.status === "unavailable");
}

/** Forget unavailable repositories so the next plan watches them again with every loaded document. */
export function retryDecisionWatch(ledger: WatchLedger): WatchLedger {
	return new Map([...ledger].filter(([, entry]) => entry.status !== "unavailable"));
}

export function retryDelay(attempt: number): number {
	return Math.min(FIRST_RETRY_MS * 2 ** attempt, LAST_RETRY_MS);
}
