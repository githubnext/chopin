// Text width estimation without a browser. Conservative per-character
// advances (in em) for IBM Plex Sans / Plex Mono; wide (CJK, full-width)
// characters always cost 1em and combining marks cost nothing.

const NARROW = new Set(`il.,:;'|!\`ijlrtf()[]{}`);
const WIDE_UPPER = new Set("MWQOGDCH@%&");

function isWide(cp) {
	return (
		(cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf)
		|| (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
		|| (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
		|| (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff)
		|| (cp >= 0x20000 && cp <= 0x3fffd)
	);
}

function isMark(cp) {
	return (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x20d0 && cp <= 0x20ff) || cp === 0x200d
		|| (cp >= 0xfe00 && cp <= 0xfe0f);
}

export function advance(ch, mono) {
	const cp = ch.codePointAt(0);
	if (isMark(cp)) return 0;
	if (isWide(cp)) return 1;
	if (mono) return 0.6;
	if (ch === " ") return 0.28;
	if (NARROW.has(ch)) return 0.3;
	if (WIDE_UPPER.has(ch)) return 0.74;
	if (ch >= "A" && ch <= "Z") return 0.64;
	if (ch >= "0" && ch <= "9") return 0.58;
	if (ch === "m" || ch === "w") return 0.84;
	return 0.54;
}

// Widths are estimated for IBM Plex. A brand typeface may run wider, so a
// render with brand fonts measures with a safety margin (see renderSpec).
// Fixed modest allowance for Chopin Inter. No mutable render-global measurement state.
const WIDTH_SCALE = 1.1;

// opts: { size, mono, tracking (em), upper, weight }
export function textWidth(
	str,
	{ size = 12, mono = false, tracking = 0, upper = false, weight = 400 } = {},
) {
	const s = upper ? String(str).toUpperCase() : String(str);
	let em = 0;
	let n = 0;
	for (const ch of s) {
		em += advance(ch, mono);
		n++;
	}
	const bold = !mono && weight >= 600 ? 1.04 : 1;
	return (em * size * bold + Math.max(0, n - 1) * tracking * size) * WIDTH_SCALE;
}

export const snap = (v, g = 4) => Math.round(v / g) * g;
export const ceil4 = (v) => Math.ceil(v / 4) * 4;

// Greedy word wrap to maxWidth; returns lines.
export function wrap(str, maxWidth, opts) {
	const words = String(str).split(/\s+/).filter(Boolean);
	const lines = [];
	let cur = "";
	for (const w of words) {
		const next = cur ? `${cur} ${w}` : w;
		if (cur && textWidth(next, opts) > maxWidth) {
			lines.push(cur);
			cur = w;
		} else cur = next;
	}
	if (cur) lines.push(cur);
	return lines.length ? lines : [""];
}
