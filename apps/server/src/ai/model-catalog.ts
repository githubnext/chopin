/**
 * The public model catalog agents refresh their model lists from (models.dev's `api.json`), held by
 * the process for every reader: the proxy, which serves it to a live launch, and the model lists
 * Chopin computes for each person's composer. It is fetched with nothing of anyone's, no credential
 * and nothing of a request, and held for ten minutes.
 */

/** The public model catalog agents refresh their model lists from. */
export const MODEL_CATALOG = "https://models.dev";

/** How long a fetched catalog is served before it is fetched again. */
export const CATALOG_FRESH_MS = 10 * 60 * 1000;

/** The catalog as fetched: its body, its `etag` and `last-modified`, and when it was fetched. */
export type HeldCatalog = { body: Uint8Array; headers: Headers; fetchedAt: number };

export type ModelCatalog = {
	/** Whether the catalog held now is younger than `CATALOG_FRESH_MS`. */
	fresh(): boolean;
	/**
	 * The catalog, fetched again once it is no longer fresh, once for every reader at a time; the
	 * copy held before when a fetch fails, and undefined with none.
	 */
	read(): Promise<HeldCatalog | undefined>;
};

export function modelCatalog(
	options: { upstream?: string; fetch?: typeof fetch; clock?: () => number } = {},
): ModelCatalog {
	let send = options.fetch ?? fetch;
	let clock = options.clock ?? Date.now;
	let held: HeldCatalog | undefined;
	let fetching: Promise<HeldCatalog | undefined> | undefined;
	let fresh = () => !!held && clock() - held.fetchedAt < CATALOG_FRESH_MS;
	async function fetched(): Promise<HeldCatalog | undefined> {
		let upstream: Response;
		try {
			upstream = await send(`${options.upstream ?? MODEL_CATALOG}/api.json`, {
				headers: { accept: "application/json" },
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
			});
		} catch {
			return held;
		}
		if (!upstream.ok) {
			await upstream.body?.cancel();
			return held;
		}
		let headers = new Headers({ "content-type": "application/json" });
		for (let name of ["etag", "last-modified"]) {
			let value = upstream.headers.get(name);
			if (value) headers.set(name, value);
		}
		try {
			held = { body: new Uint8Array(await upstream.arrayBuffer()), headers, fetchedAt: clock() };
		} catch {
			// A body cut short leaves the copy held before.
		}
		return held;
	}
	return {
		fresh,
		read() {
			if (fresh()) return Promise.resolve(held);
			fetching ??= fetched().finally(() => {
				fetching = undefined;
			});
			return fetching;
		},
	};
}
