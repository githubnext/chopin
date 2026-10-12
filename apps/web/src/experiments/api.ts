import type { InvestigationProvenance } from "@chopin/experiment/records";

export async function experimentRequest<T>(
	path: string,
	value?: unknown,
	signal?: AbortSignal,
): Promise<T> {
	let response = await fetch(path, {
		method: value === undefined ? "GET" : "POST",
		headers: value === undefined ? undefined : { "content-type": "application/json" },
		body: value === undefined ? undefined : JSON.stringify(value),
		signal,
	});
	let result = await response.json();
	if (!response.ok) throw new Error(result.error ?? "Investigation request failed");
	return result;
}

/** Where an investigation child came from; undefined for any other document. */
export async function investigationProvenance(
	documentId: string,
	signal?: AbortSignal,
): Promise<InvestigationProvenance | undefined> {
	let response = await fetch(
		`/api/documents/${encodeURIComponent(documentId)}/investigation-provenance`,
		{ signal },
	);
	if (response.status === 404) return undefined;
	let result = await response.json();
	if (!response.ok) throw new Error(result.error ?? "Investigation request failed");
	return result;
}
