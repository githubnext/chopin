/**
 * The wireframe language: a bounded, indented outline of interface parts.
 *
 * One table describes every kind so later kinds, flags and properties extend
 * the language in a single place. Nothing here is evaluated.
 */

export const MAX_WIREFRAME_SOURCE_BYTES = 64 * 1024;
export const MAX_WIREFRAME_NODES = 400;
export const MAX_WIREFRAME_DEPTH = 10;
export const MAX_WIREFRAME_LABEL = 200;
export const MAX_WIREFRAME_ID = 40;
export const MAX_WIREFRAME_PROBLEMS = 20;

/** Characters no label, item or property value may contain. */
// oxlint-disable-next-line no-control-regex
export const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** A property accepts one of a fixed set of words, free text, or a small count. */
export type WireframeValue = readonly string[] | "text" | "count";

export type WireframeKindSpec = {
	/** Whether a quoted label is required, optional or not accepted. */
	label: "required" | "optional" | "none";
	/** Blocks are other kinds; items are `- text` lines. */
	children: "blocks" | "items" | "none";
	flags: readonly string[];
	props: Readonly<Record<string, WireframeValue>>;
	/** Only a note points at another part with `-> target`. */
	target?: true;
};

const ALIGN = ["start", "center", "end", "between"] as const;
const TONE = ["neutral", "info", "success", "warning", "danger"] as const;
const HEIGHT = ["xs", "sm", "md", "lg", "xl"] as const;
const WIDTH = ["sm", "md", "lg"] as const;
const range = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
/** Share of a row's width, and how many times to draw a part. */
const SHARE = range(1, 12);
const REPEAT = range(2, 12);
/** Placeholder lines or items. */
const LINES = range(1, 8);

/** Every kind but a note can take a share of its row and be drawn several times. */
function sized<const Spec extends WireframeKindSpec>(
	spec: Spec,
): Spec & { props: { w: typeof SHARE; repeat: typeof REPEAT } } {
	return { ...spec, props: { ...spec.props, w: SHARE, repeat: REPEAT } };
}

export const WIREFRAME_KINDS = Object.freeze(
	{
		panel: sized({
			label: "optional",
			children: "blocks",
			flags: ["shaded"],
			props: { h: HEIGHT, width: WIDTH },
		}),
		header: sized({
			label: "optional",
			children: "blocks",
			flags: ["flush"],
			props: { align: ALIGN },
		}),
		/** `flow` joins sibling children with connectors; a `stack` child is a parallel column. */
		row: sized({
			label: "none",
			children: "blocks",
			flags: ["wrap", "flow", "flush"],
			props: { align: ALIGN, h: HEIGHT },
		}),
		stack: sized({
			label: "none",
			children: "blocks",
			flags: [],
			props: { align: ALIGN, h: HEIGHT },
		}),
		card: sized({
			label: "optional",
			children: "blocks",
			flags: ["selected", "muted", "shaded"],
			props: { h: HEIGHT, width: WIDTH },
		}),
		title: sized({ label: "required", children: "none", flags: [], props: {} }),
		text: sized({ label: "required", children: "none", flags: ["muted", "strong"], props: {} }),
		button: sized({
			label: "optional",
			children: "none",
			flags: ["primary", "danger", "disabled"],
			props: {},
		}),
		badge: sized({ label: "required", children: "none", flags: [], props: { tone: TONE } }),
		disclosure: sized({ label: "required", children: "blocks", flags: ["open"], props: {} }),
		list: sized({ label: "optional", children: "items", flags: ["ordered"], props: { n: LINES } }),
		note: { label: "required", children: "none", flags: [], props: {}, target: true },
		input: sized({
			label: "optional",
			children: "none",
			flags: ["disabled"],
			props: { placeholder: "text", value: "text" },
		}),
		tabs: sized({ label: "none", children: "items", flags: [], props: { active: "count" } }),
		nav: sized({
			label: "none",
			children: "items",
			flags: ["vertical"],
			props: { active: "count", n: LINES },
		}),
		image: sized({
			label: "optional",
			children: "none",
			flags: [],
			props: { ratio: ["square", "wide", "tall"], h: HEIGHT },
		}),
		divider: sized({ label: "none", children: "none", flags: [], props: {} }),
		/** Placeholders: a grey block, bars of text, a glyph and a grid of parts. */
		box: sized({
			label: "optional",
			children: "blocks",
			flags: ["shaded"],
			props: { h: HEIGHT, width: WIDTH },
		}),
		fill: sized({ label: "optional", children: "none", flags: [], props: { h: HEIGHT } }),
		lines: sized({ label: "none", children: "none", flags: [], props: { n: LINES } }),
		icon: sized({ label: "none", children: "none", flags: [], props: {} }),
		grid: sized({ label: "none", children: "blocks", flags: [], props: { cols: range(2, 6) } }),
	} satisfies Record<string, WireframeKindSpec>,
);

export type WireframeKind = keyof typeof WIREFRAME_KINDS;

export function isWireframeKind(word: string): word is WireframeKind {
	return Object.hasOwn(WIREFRAME_KINDS, word);
}

/** Inclusive, one-based source lines; a node's span covers its descendants. */
export type WireframeSpan = { start: number; end: number };

export type WireframeItem = { text: string; span: WireframeSpan };

export type WireframeNode = {
	kind: WireframeKind;
	label?: string;
	id?: string;
	flags: string[];
	props: Record<string, string>;
	/** As written: `#id` or a kind name. Resolve with `resolveWireframeTarget`. */
	target?: string;
	children: WireframeNode[];
	items: WireframeItem[];
	span: WireframeSpan;
};

export type Wireframe = { nodes: WireframeNode[] };

export type WireframeProblem = { line: number; message: string };

export type WireframeResult =
	| { ok: true; wireframe: Wireframe }
	| { ok: false; problems: WireframeProblem[] };
