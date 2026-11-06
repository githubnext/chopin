/**
 * Work this page holds that nobody else has yet: edits the server has not acknowledged,
 * answers and drafts it has not taken, a message not yet sent.
 *
 * A page that is about to replace itself, reloading for a new build, asks here first. Owners
 * are held weakly, so one that is thrown away needs no way to say so, and one that is still
 * reachable with work in it keeps the page from reloading, which is the safe mistake.
 */

export type PendingWorkSource = { readonly unsaved: boolean };

/** The sources of one page. */
export class PendingWork {
	readonly #sources = new Set<WeakRef<PendingWorkSource>>();

	/** Count `source` while its `unsaved` is true. */
	track(source: PendingWorkSource): void {
		this.#sources.add(new WeakRef(source));
	}

	/** Whether any tracked source holds work that a reload would lose. */
	any(): boolean {
		for (let reference of this.#sources) {
			let source = reference.deref();
			if (!source) this.#sources.delete(reference);
			else if (source.unsaved) return true;
		}
		return false;
	}
}

const page = new PendingWork();

/** Count `source` on this page while its `unsaved` is true. */
export function trackPendingWork(source: PendingWorkSource): void {
	page.track(source);
}

/** Whether anything on this page holds work that a reload would lose. */
export function hasPendingWork(): boolean {
	return page.any();
}
