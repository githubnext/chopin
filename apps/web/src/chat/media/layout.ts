/**
 * How Chat lays out a message's images and files the way Slack does, with no browser in it: the
 * grid several images make, the kind and words of a file's type, the copies an image is read at,
 * and what stands in for an image that is not drawn.
 */

/** Slack shows at most four images of a message, the fourth with `+N` for the rest. */
export const GALLERY_MAX_VISIBLE = 4;

export type GalleryShape = "pair" | "trio" | "quad";

/**
 * The grid of a message's images: two side by side, three as one tall image beside two stacked,
 * and four or more as two rows of two, the last saying how many more the viewer holds.
 */
export function galleryShape(count: number): { shape: GalleryShape; shown: number; more: number } {
	if (count <= 2) return { shape: "pair", shown: Math.max(0, count), more: 0 };
	if (count === 3) return { shape: "trio", shown: 3, more: 0 };
	return {
		shape: "quad",
		shown: GALLERY_MAX_VISIBLE,
		more: count - GALLERY_MAX_VISIBLE,
	};
}

/** Slack's thumbnail widths (`thumb_64` to `thumb_1024`), the copies the server makes. */
export const THUMBNAIL_WIDTHS = [64, 80, 160, 360, 480, 720, 800, 960, 1024] as const;
/** The largest copy, which the viewer draws. */
export const VIEWER_WIDTH = 1024;

/** The address of an image's copy `width` pixels wide. */
export function thumbnailUrl(url: string, width: number): string {
	return `${url}${url.includes("?") ? "&" : "?"}w=${width}`;
}

/**
 * The copy to draw in a box `cssWidth` pixels wide on a screen of `density`: the narrowest of
 * Slack's widths that fills it, or the largest. One address, not a `srcset`: a copy is never wider
 * than its image, so a `w` descriptor would claim a width the image does not have, and the browser
 * would report, and Chat would frame, the image at the wrong size.
 */
export function copyWidth(cssWidth: number, density = 1): number {
	let needed = cssWidth * Math.max(1, density);
	return THUMBNAIL_WIDTHS.find(width => width >= needed) ?? VIEWER_WIDTH;
}

/**
 * The box an image is drawn in: its own shape inside Slack's bounds, never larger than it is.
 */
export function fittedBox(
	width: number,
	height: number,
	bounds: { width: number; height: number },
): { width: number; height: number } {
	let scale = Math.min(1, bounds.width / width, bounds.height / height);
	return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export type Placeholder =
	| { state: "loading" }
	| { state: "broken"; words: string }
	| { state: "unavailable"; words: string };

/**
 * What stands in the image's place while it is not drawn: a quiet box while it loads, then, if it
 * never arrives, the same box saying why. An address Chat never loads says so from the start.
 */
export function placeholderOf(
	source: "unavailable" | "loadable",
	load: "loading" | "shown" | "broken",
): Placeholder | undefined {
	if (source === "unavailable") return { state: "unavailable", words: "Image can’t be shown" };
	if (load === "broken") return { state: "broken", words: "Couldn’t load image" };
	return load === "loading" ? { state: "loading" } : undefined;
}

export type FileKind =
	| "pdf"
	| "document"
	| "spreadsheet"
	| "slides"
	| "code"
	| "text"
	| "archive"
	| "image"
	| "video"
	| "audio"
	| "generic";

const KINDS: Record<string, [FileKind, string]> = {
	pdf: ["pdf", "PDF"],
	doc: ["document", "Word document"],
	docx: ["document", "Word document"],
	odt: ["document", "Document"],
	rtf: ["document", "Rich text"],
	pages: ["document", "Document"],
	csv: ["spreadsheet", "CSV"],
	tsv: ["spreadsheet", "TSV"],
	xls: ["spreadsheet", "Spreadsheet"],
	xlsx: ["spreadsheet", "Spreadsheet"],
	ods: ["spreadsheet", "Spreadsheet"],
	numbers: ["spreadsheet", "Spreadsheet"],
	ppt: ["slides", "Presentation"],
	pptx: ["slides", "Presentation"],
	odp: ["slides", "Presentation"],
	key: ["slides", "Presentation"],
	txt: ["text", "Plain text"],
	text: ["text", "Plain text"],
	log: ["text", "Log"],
	md: ["text", "Markdown"],
	markdown: ["text", "Markdown"],
	mdx: ["text", "MDX"],
	rst: ["text", "reStructuredText"],
	adoc: ["text", "AsciiDoc"],
	zip: ["archive", "ZIP archive"],
	tar: ["archive", "Archive"],
	gz: ["archive", "Archive"],
	tgz: ["archive", "Archive"],
	bz2: ["archive", "Archive"],
	xz: ["archive", "Archive"],
	"7z": ["archive", "Archive"],
	rar: ["archive", "Archive"],
	svg: ["image", "SVG image"],
	png: ["image", "PNG image"],
	jpg: ["image", "JPEG image"],
	jpeg: ["image", "JPEG image"],
	gif: ["image", "GIF image"],
	webp: ["image", "WebP image"],
	avif: ["image", "AVIF image"],
	heic: ["image", "HEIC image"],
	mp4: ["video", "MP4 video"],
	mov: ["video", "QuickTime video"],
	webm: ["video", "WebM video"],
	mkv: ["video", "Video"],
	mp3: ["audio", "MP3 audio"],
	wav: ["audio", "WAV audio"],
	m4a: ["audio", "Audio"],
	ogg: ["audio", "Ogg audio"],
	flac: ["audio", "FLAC audio"],
	ts: ["code", "TypeScript"],
	tsx: ["code", "TypeScript"],
	mts: ["code", "TypeScript"],
	cts: ["code", "TypeScript"],
	js: ["code", "JavaScript"],
	jsx: ["code", "JavaScript"],
	mjs: ["code", "JavaScript"],
	cjs: ["code", "JavaScript"],
	py: ["code", "Python"],
	rb: ["code", "Ruby"],
	go: ["code", "Go"],
	rs: ["code", "Rust"],
	java: ["code", "Java"],
	kt: ["code", "Kotlin"],
	swift: ["code", "Swift"],
	c: ["code", "C"],
	h: ["code", "C"],
	cc: ["code", "C++"],
	cpp: ["code", "C++"],
	hpp: ["code", "C++"],
	cs: ["code", "C#"],
	php: ["code", "PHP"],
	sh: ["code", "Shell"],
	bash: ["code", "Shell"],
	zsh: ["code", "Shell"],
	sql: ["code", "SQL"],
	json: ["code", "JSON"],
	jsonc: ["code", "JSON"],
	yaml: ["code", "YAML"],
	yml: ["code", "YAML"],
	toml: ["code", "TOML"],
	xml: ["code", "XML"],
	html: ["code", "HTML"],
	css: ["code", "CSS"],
	scss: ["code", "SCSS"],
	vue: ["code", "Vue"],
	svelte: ["code", "Svelte"],
	lua: ["code", "Lua"],
	r: ["code", "R"],
	scala: ["code", "Scala"],
	dart: ["code", "Dart"],
	ex: ["code", "Elixir"],
	exs: ["code", "Elixir"],
	hs: ["code", "Haskell"],
	tf: ["code", "Terraform"],
	diff: ["code", "Diff"],
	patch: ["code", "Diff"],
};

/**
 * A file's kind, for the colour and glyph of its icon, and its type in words, as Slack names a
 * file by its type: from its name's extension, since Chat keeps every text file as plain text.
 */
export function fileType(name: string): { kind: FileKind; label: string } {
	let dot = name.lastIndexOf(".");
	let extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
	let known = KINDS[extension];
	if (known) return { kind: known[0], label: known[1] };
	if (/^(?:dockerfile|makefile)$/i.test(name)) return { kind: "code", label: name };
	return { kind: "generic", label: extension ? `${extension.toUpperCase()} file` : "File" };
}
