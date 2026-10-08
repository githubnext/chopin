import type { Sidebar } from "@chopin/protocol";

export const MAX_WATCH_FRAME_REPOSITORIES = 50;
export const MAX_WATCHED_REPOSITORIES = 200;
export const MAX_WATCHED_DOCUMENTS = 500;

const FIRST_RETRY_MS = 2_000;
const LAST_RETRY_MS = 60_000;
export const RESYNC_INTERVAL_MS = 1_000;

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

export type ResyncQueue = {
	pending: ReadonlySet<string>;
	sentAt: ReadonlyMap<string, number>;
};

export type ResyncPlan = {
	queue: ResyncQueue;
	frames: Sidebar.WatchedRepository[][];
	/** Milliseconds until the next pending repository may be requested again. */
	wait?: number;
};

export function emptyResyncQueue(): ResyncQueue {
	return { pending: new Set(), sentAt: new Map() };
}

/** Ask for a fresh snapshot of a repository whose total the client can no longer order. */
export function requestResync(queue: ResyncQueue, repositoryId: string): ResyncQueue {
	if (queue.pending.has(repositoryId)) return queue;
	return { ...queue, pending: new Set([...queue.pending, repositoryId]) };
}

/**
 * Re-watch pending repositories with no documents, which makes the server send a
 * snapshot ordered after every frame it sent before. Each repository is requested
 * at most once a second, so a burst of conflicts costs one snapshot. Repositories
 * this connection does not watch are dropped: no snapshot would answer them.
 */
export function takeResyncs(
	queue: ResyncQueue,
	ledger: WatchLedger,
	desired: Sidebar.WatchedRepository[],
	now: number,
): ResyncPlan {
	let byId = new Map(desired.map(repository => [repository.repositoryId, repository]));
	let pending = new Set<string>();
	let sentAt = new Map(queue.sentAt);
	let due: Sidebar.WatchedRepository[] = [];
	let wait: number | undefined;
	for (let repositoryId of queue.pending) {
		let repository = byId.get(repositoryId);
		let entry = ledger.get(repositoryId);
		if (
			!repository || entry?.identity !== identityOf(repository)
			|| (entry.status !== "requested" && entry.status !== "watched")
		) continue;
		let remaining = (sentAt.get(repositoryId) ?? -Infinity) + RESYNC_INTERVAL_MS - now;
		if (remaining > 0) {
			pending.add(repositoryId);
			wait = Math.min(wait ?? remaining, remaining);
			continue;
		}
		sentAt.set(repositoryId, now);
		due.push({ ...repository, channelIds: [] });
	}
	return {
		queue: { pending, sentAt },
		frames: chunks(due, MAX_WATCH_FRAME_REPOSITORIES),
		...(wait === undefined ? {} : { wait }),
	};
}
