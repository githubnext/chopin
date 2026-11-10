import { useEffect, useSyncExternalStore } from "react";

export type ExternalRead = "pending" | "readable" | "unreadable";

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export async function probeExternalRead(
	url: string,
	fetcher: Fetcher = fetch,
	timeout = 10_000,
): Promise<Exclude<ExternalRead, "pending">> {
	let control = new AbortController();
	let timer = setTimeout(() => control.abort(), timeout);
	try {
		await Promise.race([
			fetcher(url, { credentials: "omit", referrerPolicy: "no-referrer", signal: control.signal }),
			new Promise<never>((_, reject) =>
				control.signal.addEventListener("abort", () => reject(new Error("no answer")), {
					once: true,
				})
			),
		]);
		return "readable";
	} catch {
		return "unreadable";
	} finally {
		clearTimeout(timer);
		control.abort();
	}
}

let results = new Map<string, Exclude<ExternalRead, "pending">>();
let started = new Set<string>();
let listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useExternalRead(url: string | undefined): ExternalRead {
	useEffect(() => {
		if (!url || started.has(url)) return;
		started.add(url);
		void probeExternalRead(url).then(read => {
			results.set(url, read);
			for (let listener of listeners) listener();
		});
	}, [url]);
	return useSyncExternalStore(
		subscribe,
		() => url ? results.get(url) ?? "pending" : "pending",
		() => "pending",
	);
}
