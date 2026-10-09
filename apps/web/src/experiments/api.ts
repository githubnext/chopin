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
