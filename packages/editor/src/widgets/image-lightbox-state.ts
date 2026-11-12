export function stepImage(index: number, delta: number, count: number): number {
	return Math.min(Math.max(index + delta, 0), Math.max(count - 1, 0));
}

export function arrowStep(key: string): -1 | 1 | undefined {
	return key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : undefined;
}

export function wrapTab(active: number, count: number, backwards: boolean): number | undefined {
	if (count === 0) return undefined;
	if (active < 0) return backwards ? count - 1 : 0;
	if (backwards && active === 0) return count - 1;
	if (!backwards && active === count - 1) return 0;
	return undefined;
}

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };

/** The scale that fits a picture, turned `turns` quarters, inside a box; a small one is never enlarged. */
export function fitScale(natural: Size, box: Size, turns: number): number {
	let quarter = turns % 2 === 1;
	let width = quarter ? natural.height : natural.width;
	let height = quarter ? natural.width : natural.height;
	if (width <= 0 || height <= 0 || box.width <= 0 || box.height <= 0) return 1;
	return Math.min(1, box.width / width, box.height / height);
}

export type ZoomBounds = { min: number; max: number };

/** From fitted to eight times that, and never less than twice the picture's own pixels. */
export function zoomBounds(fit: number): ZoomBounds {
	return { min: fit, max: Math.max(fit * 8, 2) };
}

export function clampZoom(scale: number, bounds: ZoomBounds): number {
	return Math.min(Math.max(scale, bounds.min), bounds.max);
}

/** The slider runs 0 to 100 on a logarithmic scale, so each step looks the same size. */
function position(scale: number, bounds: ZoomBounds): number {
	if (bounds.max <= bounds.min) return 0;
	return Math.log(clampZoom(scale, bounds) / bounds.min) / Math.log(bounds.max / bounds.min) * 100;
}

export function sliderOf(scale: number, bounds: ZoomBounds): number {
	return Math.round(position(scale, bounds));
}

export function scaleOf(slider: number, bounds: ZoomBounds): number {
	let at = Math.min(Math.max(slider, 0), 100) / 100;
	return bounds.min * (bounds.max / bounds.min) ** at;
}

/** One press of − or +: an eighth of the slider. */
export function zoomStep(scale: number, direction: -1 | 1, bounds: ZoomBounds): number {
	return scaleOf(position(scale, bounds) + direction * 12.5, bounds);
}

/** Double-click: back to fitted from any zoom, else to the picture's own pixels (or twice fitted). */
export function toggleZoom(scale: number, bounds: ZoomBounds): number {
	if (scale > bounds.min * 1.01) return bounds.min;
	return clampZoom(bounds.min < 0.99 ? 1 : bounds.min * 2, bounds);
}

export function zoomKey(key: string): -1 | 1 | "fit" | undefined {
	if (key === "+" || key === "=") return 1;
	if (key === "-" || key === "_") return -1;
	if (key === "0") return "fit";
	return undefined;
}

/** Keeps a zoomed picture over the stage: it moves only as far as its edges allow. */
export function clampPan(pan: Point, shown: Size, stage: Size): Point {
	let x = Math.max(0, (shown.width - stage.width) / 2);
	let y = Math.max(0, (shown.height - stage.height) / 2);
	return {
		x: Math.min(Math.max(pan.x, -x), x) || 0,
		y: Math.min(Math.max(pan.y, -y), y) || 0,
	};
}

/** The pan that keeps the point under the pointer (from the stage's centre) still while zooming. */
export function zoomAt(pan: Point, point: Point, from: number, to: number): Point {
	let ratio = to / from;
	return { x: point.x - (point.x - pan.x) * ratio, y: point.y - (point.y - pan.y) * ratio };
}

/** The box a picture turned `turns` quarters takes at `scale`. */
export function shownSize(natural: Size, scale: number, turns: number): Size {
	let quarter = turns % 2 === 1;
	return {
		width: (quarter ? natural.height : natural.width) * scale,
		height: (quarter ? natural.width : natural.height) * scale,
	};
}

let relative: Intl.RelativeTimeFormat | undefined;
let dated: Intl.DateTimeFormat | undefined;

/** Slack's "3 hours ago": minutes, hours and days, then the date. */
export function relativeTime(at: number, now: number): string {
	let seconds = Math.round((now - at) / 1000);
	if (seconds < 45) return "just now";
	relative ??= new Intl.RelativeTimeFormat("en", { numeric: "auto" });
	let minutes = Math.round(seconds / 60);
	if (minutes < 60) return relative.format(-minutes, "minute");
	let hours = Math.round(minutes / 60);
	if (hours < 24) return relative.format(-hours, "hour");
	let days = Math.round(hours / 24);
	if (days < 7) return relative.format(-days, "day");
	dated ??= new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });
	return dated.format(new Date(at));
}

/** The muted line under the name: "3 hours ago in Weekly plan – chart.png". */
export function detailLine(
	{ file, place, time }: { file: string; place?: string; time?: string },
): string {
	let where = place ? (time ? `in ${place}` : `In ${place}`) : undefined;
	let lead = [time, where].filter(Boolean).join(" ");
	return lead ? `${lead} – ${file}` : file;
}

/** The last part of an address's path, as a file's name, or undefined for an address with none. */
export function fileNameOf(src: string): string | undefined {
	if (/^(data|blob):/i.test(src)) return undefined;
	let path = src.split(/[?#]/, 1)[0] ?? "";
	let last = path.split("/").pop() ?? "";
	try {
		last = decodeURIComponent(last);
	} catch {
		// A malformed escape keeps the name as written.
	}
	return last.trim() || undefined;
}

const EXTENSIONS: Record<string, string> = {
	jpeg: "jpg",
	"svg+xml": "svg",
	plain: "txt",
	markdown: "md",
	"x-icon": "ico",
	"vnd.microsoft.icon": "ico",
};

/** A download's name: the name it has, with the extension its type says where it has none. */
export function downloadName(name: string, type?: string): string {
	let cleaned = [...name].map(character => character < " " ? "-" : character).join("")
		.replace(/[\\/:*?"<>|]+/g, "-").replace(/-{2,}/g, "-").trim().slice(0, 120) || "image";
	if (/\.[a-z0-9]{1,5}$/i.test(cleaned)) return cleaned;
	let subtype = type?.split(";")[0]?.split("/")[1]?.trim().toLowerCase();
	let extension = subtype ? EXTENSIONS[subtype] ?? subtype : undefined;
	return extension && /^[a-z0-9]{1,5}$/.test(extension) ? `${cleaned}.${extension}` : cleaned;
}

/** How a two-finger pinch moved: the scale it asks for and the point it is about. */
export function pinch(
	before: readonly [Point, Point],
	after: readonly [Point, Point],
): { ratio: number; centre: Point } {
	let distance = ([a, b]: readonly [Point, Point]) => Math.hypot(a.x - b.x, a.y - b.y);
	let start = distance(before);
	return {
		ratio: start > 0 ? distance(after) / start : 1,
		centre: { x: (after[0].x + after[1].x) / 2, y: (after[0].y + after[1].y) / 2 },
	};
}
