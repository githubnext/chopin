const LIMIT = 4_000;
const SECRET_KEY = /token|secret|password|passwd|authorization|api[-_]?key|credential/i;
const SECRET_TEXT =
	/\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{16,}|\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const ASSIGNMENT_KEY =
	/(?:(^[\t ]*(?:\d+:[\t ]*)?(?:export[\t ]+)?)|(?<![\w.-]))["']?([\w.-]+)["']?\s*[:=]\s*/gm;
const QUOTED_VALUE = String.raw`"(?:\\[\s\S]?|[^"\\])*(?:"|$)|'(?:\\[\s\S]?|[^'\\])*(?:'|$)`;
const LINE_VALUE = new RegExp(String.raw`${QUOTED_VALUE}|[^\r\n]+`, "y");
const INLINE_VALUE = new RegExp(String.raw`\[redacted\]|${QUOTED_VALUE}|[^\r\n,;}\]]+`, "y");

function scrub(text: string): string {
	let parts: string[] = [];
	let cursor = 0;
	ASSIGNMENT_KEY.lastIndex = 0;
	let assignment: RegExpExecArray | null;
	while ((assignment = ASSIGNMENT_KEY.exec(text))) {
		if (!SECRET_KEY.test(assignment[2]!)) continue;
		let valuePattern = assignment[1] === undefined ? INLINE_VALUE : LINE_VALUE;
		valuePattern.lastIndex = ASSIGNMENT_KEY.lastIndex;
		let value = valuePattern.exec(text)?.[0];
		if (!value) continue;
		let quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
		parts.push(text.slice(cursor, ASSIGNMENT_KEY.lastIndex), `${quote}[redacted]${quote}`);
		cursor = valuePattern.lastIndex;
		ASSIGNMENT_KEY.lastIndex = cursor;
	}
	parts.push(text.slice(cursor));
	return parts.join("");
}

/** What a tool call may show other members: secrets masked, length bounded. */
export function clip(text: string): string {
	let masked = text.replace(SECRET_TEXT, (_match, bearer?: string) => `${bearer ?? ""}[redacted]`);
	return masked.length > LIMIT ? `${masked.slice(0, LIMIT - 1)}…` : masked;
}

function mask(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return scrub(value);
	if (!value || typeof value !== "object") return value;
	if (depth > 6) return "[redacted]";
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
	if (typeof output === "string") {
		try {
			let parsed: unknown = JSON.parse(output);
			let masked = JSON.stringify(mask(parsed)) ?? "";
			return clip(masked === JSON.stringify(parsed) ? output : masked);
		} catch {
			return clip(scrub(output));
		}
	}
	return clip(JSON.stringify(mask(output)) ?? "");
}
