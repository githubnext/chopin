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
 * no Planner. A read is used once and only if it is recent, and one that failed is forgotten, so
 * opening the document asks again and shows what it finds.
 */

/** How long a read started on intent can still stand for the click's own. */
export const FRESH_MS = 5_000;

/** How long a pointer or the focus rests on a row before that counts as intent. */
export const DWELL_MS = 120;

export type DocumentAddress = { owner: string; repository: string; slug: string };

type Read = (owner: string, repository: string, slug: string) => Promise<Api.ChannelDetail>;

let key = ({ owner, repository, slug }: DocumentAddress) => `${owner}/${repository}/${slug}`;

export function createDocumentIntent(read: Read, now: () => number = () => performance.now()) {
	let entries = new Map<
		string,
		{ at: number; detail: Promise<Api.ChannelDetail>; used: boolean }
	>();
	return {
		/**
		 * Start reading a document, unless a recent read of it is under way or done, or has been used:
		 * a pointer that is still on the row after the click that opened it is not asking again.
		 */
		start(address: DocumentAddress): void {
			let id = key(address);
			let known = entries.get(id);
			if (known && now() - known.at < FRESH_MS) return;
			let entry = {
				at: now(),
				detail: read(address.owner, address.repository, address.slug),
				used: false,
			};
			entries.set(id, entry);
			entry.detail.catch(() => {
				if (entries.get(id) === entry) entries.delete(id);
			});
		},
		/** The read an opening can stand on, if there is a recent one. Each is handed out once. */
		take(address: DocumentAddress): Promise<Api.ChannelDetail> | undefined {
			let entry = entries.get(key(address));
			if (!entry || entry.used || now() - entry.at >= FRESH_MS) return undefined;
			entry.used = true;
			return entry.detail;
		},
	};
}

export const documentIntent = createDocumentIntent((owner, repository, slug) =>
	Api.document(owner, repository, slug)
);

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
