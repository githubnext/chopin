const LIMIT = 4_000;
const SECRET_KEY = /token|secret|password|passwd|authorization|api[-_]?key|credential/i;
const SECRET_TEXT =
	/\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{16,}|\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** What a tool call may show other members: secrets masked, length bounded. */
export function clip(text: string): string {
	let masked = text.replace(SECRET_TEXT, (_match, bearer?: string) => `${bearer ?? ""}[redacted]`);
	return masked.length > LIMIT ? `${masked.slice(0, LIMIT - 1)}…` : masked;
}

function mask(value: unknown, depth = 0): unknown {
	if (!value || typeof value !== "object" || depth > 6) return value;
	if (Array.isArray(value)) return value.map(item => mask(item, depth + 1));
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			key,
			SECRET_KEY.test(key) ? "[redacted]" : mask(item, depth + 1),
		]),
	);
}

export function argsText(input: unknown): string {
	return clip(JSON.stringify(mask(input), null, 2) ?? "");
}

export function outputText(output: unknown): string {
	if (typeof output === "string") return clip(output);
	return clip(JSON.stringify(mask(output)) ?? "");
}
