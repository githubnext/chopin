import { parseDocumentPath } from "@chopin/protocol/document-url";

import * as Api from "./api";

/**
 * A document's own read, started when the reader shows signs of opening it.
 *
 * Opening a document asks the server for its record (who may edit it, its title and revision) before
 * anything else can start, and the server checks the reader's access to the repository to answer.
 * A pointer resting on a Projects row, or a press on it, says which document that will be, a
 * hundred milliseconds or more before the click that opens it, so the read is started then and the
 * click uses it.
 *
 * It is the read the click would have made, made earlier: the same request, with the reader's own
 * session, which changes nothing on the server. It joins no room, announces no presence and claims
 * no Planner. Nobody has asked for it yet, though, so it is only ever a head start, and nothing
 * the reader can see depends on it. One that fails, for any reason, is dropped, and a session that
 * has ended does not reload the page for it. An opening that was waiting on one that failed makes
 * its own read, as it would have without any, and fails or not as that does. A read is used only
 * while it is under way or soon after it was answered, and not after the page has been told that
 * its document changed, so a change made since the pointer came to rest is not hidden from the
 * click.
 */

/**
 * How long a read can stand for the opening's own, counted from when it was answered, or from when
 * it started while it is under way. A pointer that comes to rest and a click that follows it are
 * well within a second of each other; a record older than that is one the click can do without.
 */
export const FRESH_MS = 1_000;

/**
 * How long the same row is not read ahead again once its document has been opened or its read has
 * failed. The pointer is still on the row when the click has navigated, and the browser reports it
 * arriving there again; that is not a sign of opening it again, and nor is a pointer passing over a
 * row whose read just failed.
 */
export const AGAIN_MS = 5_000;

/** How long a pointer or the focus rests on a row before that counts as intent. */
export const DWELL_MS = 120;

export type DocumentAddress = { owner: string; repository: string; slug: string };

type Read = (owner: string, repository: string, slug: string) => Promise<Api.ChannelDetail>;

type Ahead = {
	/** The id of the document the read is of, which is what a change to it names. */
	documentId: string;
	/** When the read started. */
	at: number;
	/** When it was answered, once it has been. */
	answeredAt?: number;
	detail: Promise<Api.ChannelDetail>;
};

/** An opening waiting on a read it was handed; `drop` makes it stop waiting and read for itself. */
type Waiting = { documentId: string; drop: () => void };

let key = ({ owner, repository, slug }: DocumentAddress) => `${owner}/${repository}/${slug}`;

export function createDocumentIntent(read: Read, now: () => number = () => performance.now()) {
	let reads = new Map<string, Ahead>();
	// When each document was last opened or had a read fail.
	let done = new Map<string, number>();
	// Openings waiting on a read they were handed, until they have it. Those reads are no longer in
	// `reads`, so a change to their document would not find them there.
	let used = new Set<Waiting>();
	let usable = (ahead: Ahead) => now() - (ahead.answeredAt ?? ahead.at) < FRESH_MS;
	return {
		/**
		 * Start reading a document, unless it is being read, or was read a moment ago, or has just been
		 * opened, or its read has just failed.
		 */
		start(address: DocumentAddress, documentId: string): void {
			let id = key(address);
			let known = reads.get(id);
			if (known && usable(known)) return;
			let last = done.get(id);
			if (last !== undefined && now() - last < AGAIN_MS) return;
			let ahead: Ahead = {
				documentId,
				at: now(),
				detail: read(address.owner, address.repository, address.slug),
			};
			reads.set(id, ahead);
			ahead.detail.then(
				() => void (ahead.answeredAt = now()),
				() => {
					if (reads.get(id) === ahead) reads.delete(id);
					done.set(id, now());
				},
			);
		},
		/**
		 * Drop the read of a document, under way or answered, because it was renamed, archived,
		 * restored or deleted and the record that was read may be from before. An old
		 * address still opens a renamed document, so a click on its row would otherwise be given the
		 * record it had before. The opening reads for itself instead. A read of any other document is
		 * as good as it was. An opening already waiting on one, because the click came first, stops
		 * waiting and makes its own read at once, whether or not the read it waited on ever answers.
		 */
		forget(documentId: string): void {
			for (let [id, ahead] of reads) if (ahead.documentId === documentId) reads.delete(id);
			for (let waiting of used) if (waiting.documentId === documentId) waiting.drop();
		},
		/**
		 * What an opening reads: the read that was started on intent, if one is under way or was
		 * answered a moment ago (each is handed out once), or its own read. If the one it waited on
		 * fails, or its document changes while it waits, the opening's own is made then, once.
		 */
		async read(
			address: DocumentAddress,
			own: () => Promise<Api.ChannelDetail>,
		): Promise<Api.ChannelDetail> {
			let id = key(address);
			let ahead = reads.get(id);
			reads.delete(id);
			done.set(id, now());
			if (!ahead || !usable(ahead)) return own();
			let dropped = Promise.withResolvers<void>();
			let changed = false;
			let waiting: Waiting = {
				documentId: ahead.documentId,
				drop: () => {
					changed = true;
					dropped.resolve();
				},
			};
			used.add(waiting);
			let record: Api.ChannelDetail | undefined;
			try {
				record = await Promise.race([
					ahead.detail.catch(() => undefined),
					dropped.promise.then(() => undefined),
				]);
			} finally {
				used.delete(waiting);
			}
			return changed ? own() : record ?? own();
		},
	};
}

/**
 * The request `Api.document` makes, but it only fails. `Api.document` reloads the page when the
 * session has ended, which is for a reader who asked; this read is one nobody has, and the opening
 * that does asks for itself and is told then. It is here, not beside `Api.document`, to stay out of
 * the initial bundle, which has no room left in its budget.
 */
async function readAhead(
	owner: string,
	repository: string,
	slug: string,
): Promise<Api.ChannelDetail> {
	let result = await fetch(
		`/api/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/documents/${
			encodeURIComponent(slug)
		}`,
	);
	if (!result.ok) throw new Api.ApiError(`request failed (${result.status})`, result.status);
	return (await result.json()) as Api.ChannelDetail;
}

export const documentIntent = createDocumentIntent(readAhead);

/**
 * The document a link opens, if it is a document of its own. A child's link is not one: opening it
 * also waits on its parent, which is read another way.
 */
export function addressOfHref(href: string | null | undefined): DocumentAddress | undefined {
	if (!href) return undefined;
	let parsed = parseDocumentPath(href);
	return parsed?.slug
		? { owner: parsed.owner, repository: parsed.repository, slug: parsed.slug }
		: undefined;
}
