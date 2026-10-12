const LIMIT = 4_000;
const SECRET_KEY =
	/token|secret|password|passwd|authorization|api[-_]?key|credential|(?:^|[_-])proxy$/i;
const SECRET_TEXT =
	/\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{16,}|\bxox[abposr]-[A-Za-z0-9-]{10,}|\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const ASSIGNMENT_KEY =
	/(?:(^[\t ]*(?:\d+:[\t ]*)?(?:export[\t ]+)?)|(?<![\w.-]))["']?([\w.-]+)["']?\s*[:=]\s*/gm;
const QUOTED_VALUE = String.raw`"(?:\\[\s\S]?|[^"\\])*(?:"|$)|'(?:\\[\s\S]?|[^'\\])*(?:'|$)`;
const LINE_VALUE = new RegExp(String.raw`${QUOTED_VALUE}|[^\r\n]+`, "y");
const INLINE_VALUE = new RegExp(String.raw`\[redacted\]|${QUOTED_VALUE}|[^\r\n,;}\]]+`, "y");
/**
 * A colon, slash or at-sign as written, percent-encoded at any depth, as an HTML entity
 * with or without its semicolon, or escaped as JSON, JavaScript, Python or C would
 * (`\u003a`, `\u{3a}`, `%u003a`, `\U0000003a`, `\x3a`, `\072`). An escape matches from
 * its last backslash.
 */
const COLON = String
	.raw`(?::|\\(?:u003a|u\{0*3a\}|u0000003a|x3a|072)|%(?:25)*(?:u00)?3a|&#0*58;?|&#x0*3a;?|&colon;)`;
const SLASH = String
	.raw`(?:\\*/|\\+(?:u002f|u\{0*2f\}|u0000002f|x2f|057)|\\|%(?:25)*(?:u00)?2f|&#0*47;?|&#x0*2f;?|&sol;)`;
/**
 * A scheme's `://` in any of those spellings, read as a URL parser would: either slash may
 * be a backslash, and tabs and line breaks may come before each. Any scheme, or none. A
 * protocol-relative `//` counts too when it starts the text or follows whitespace, a quote,
 * `(`, `<`, `=`, `[`, a comma or a colon, so a `//` inside a path does not.
 */
const SEPARATOR = new RegExp(
	String.raw`(?:${COLON}|(?<![^\s"'\x60(<=\[,:]))(?:[\t\n\r]{0,16}${SLASH}){2}`,
	"gi",
);
/** An at-sign in any of those spellings; an escape also takes the backslashes before it. */
const AT_SIGN =
	/@|\\(?:u0040|u\{0*40\}|u00000040|x40|100)|%(?:25)*(?:u00)?40|&#0*64;?|&#x0*40;?|&commat;/gi;
const AT_SIGN_HINT = /@|\\(?:u|x40|100)|%(?:25)*(?:u00)?40|&#|&commat;/i;
/**
 * How far past a scheme to look for the at-sign that ends its userinfo. It exceeds the
 * display limit, so a password long enough to fill the display is still masked.
 */
const WINDOW = 8_192;
const PLAIN_USER = /^[A-Za-z0-9._-]{2,40}$/;
const TOKEN_USER =
	/^(?:gh[a-z]_|github_pat_|sk-|xox[a-z]-|ya29\.)|^.{20,}$|^(?:x-access-token|oauth2|x-token-auth|gitlab-ci-token)$/i;

/** Text from `start` to `end` that a redacted view shows as `text`. */
type Range = { start: number; end: number; text: string };

/**
 * The userinfo after each scheme, deliberately broad so that it fails closed: everything
 * from `://` to the last at-sign within the window, in any spelling, even past a later
 * scheme, so a password holding `://` is masked whole. Only a short plain user name with no
 * password stays visible.
 */
function credentials(text: string): Range[] {
	if (!AT_SIGN_HINT.test(text)) return [];
	// Each at-sign once, as where its match starts, where the mask ends (before the
	// backslashes of an escape) and where the match ends.
	let atSigns: Array<[index: number, start: number, end: number]> = [];
	AT_SIGN.lastIndex = 0;
	let found: RegExpExecArray | null;
	while ((found = AT_SIGN.exec(text))) {
		let start = found.index;
		if (text[start] === "\\") { while (text[start - 1] === "\\") start--; }
		atSigns.push([found.index, start, AT_SIGN.lastIndex]);
	}
	let ranges: Range[] = [];
	// Separators come in order, so the at-signs ending within each window only grow.
	let within = 0;
	SEPARATOR.lastIndex = 0;
	while ((found = SEPARATOR.exec(text))) {
		let start = SEPARATOR.lastIndex;
		while (within < atSigns.length && atSigns[within]![2] <= start + WINDOW) within++;
		let last = atSigns[within - 1];
		if (!last || last[0] < start) continue;
		let at = Math.max(last[1], start);
		if (at === start) continue;
		// Only a short user name can stay visible; reading a longer one would cost the window.
		let info = at - start <= 40 ? text.slice(start, at) : "";
		if (PLAIN_USER.test(info) && !TOKEN_USER.test(info)) continue;
		ranges.push({ start, end: at, text: "[redacted]" });
	}
	return ranges;
}

/** Each value assigned to a credential name, such as `password=…` or `"token": "…"`. */
function assignments(text: string): Range[] {
	let ranges: Range[] = [];
	ASSIGNMENT_KEY.lastIndex = 0;
	let assignment: RegExpExecArray | null;
	while ((assignment = ASSIGNMENT_KEY.exec(text))) {
		if (!SECRET_KEY.test(assignment[2]!)) continue;
		let valuePattern = assignment[1] === undefined ? INLINE_VALUE : LINE_VALUE;
		let start = ASSIGNMENT_KEY.lastIndex;
		valuePattern.lastIndex = start;
		let value = valuePattern.exec(text)?.[0];
		if (!value) continue;
		let quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
		ranges.push({ start, end: valuePattern.lastIndex, text: `${quote}[redacted]${quote}` });
		ASSIGNMENT_KEY.lastIndex = valuePattern.lastIndex;
	}
	return ranges;
}

/** Each prefixed token and Bearer credential. */
function tokens(text: string): Range[] {
	return Array.from(text.matchAll(SECRET_TEXT), match => {
		let start = match.index + (match[1]?.length ?? 0);
		return { start, end: match.index + match[0].length, text: "[redacted]" };
	});
}

/** The text with every range masked; overlapping ranges are masked as one. */
function redact(text: string, ranges: Range[]): string {
	if (!ranges.length) return text;
	ranges.sort((a, b) => a.start - b.start);
	let parts: string[] = [];
	let cursor = 0;
	let open: Range | undefined;
	for (let range of ranges) {
		if (open && range.start < open.end) {
			open = { start: open.start, end: Math.max(open.end, range.end), text: "[redacted]" };
			continue;
		}
		if (open) {
			parts.push(text.slice(cursor, open.start), open.text);
			cursor = open.end;
		}
		open = range;
	}
	parts.push(text.slice(cursor, open!.start), open!.text, text.slice(open!.end));
	return parts.join("");
}

/** Credential assignments and URL credentials masked, each found in the text as written. */
function scrub(text: string): string {
	return redact(text, [...assignments(text), ...credentials(text)]);
}

/** What a tool call may show other members: secrets masked, length bounded. */
export function clip(text: string): string {
	let masked = redact(text, [...credentials(text), ...tokens(text)]);
	return masked.length > LIMIT ? `${masked.slice(0, LIMIT - 1)}…` : masked;
}

function mask(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return scrub(value);
	if (!value || typeof value !== "object") return value;
	if (depth > 6) return "[redacted]";
	if (Array.isArray(value)) return value.map(item => mask(item, depth + 1));
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			scrub(key),
			SECRET_KEY.test(key) ? "[redacted]" : mask(item, depth + 1),
		]),
	);
}

export function argsText(input: unknown): string {
	return clip(JSON.stringify(mask(input), null, 2) ?? "");
}

/** Text shown as written, never parsed: assignments and token shapes masked, length bounded. */
export function textOutput(text: string): string {
	return clip(scrub(text));
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
