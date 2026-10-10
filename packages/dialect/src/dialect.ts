/**
 * The plan MDX dialect.
 *
 * A plan is authored by collaborators and by the agent, so it is treated as
 * untrusted input. This module is the allowlist: anything not described here is
 * rejected before it can reach a renderer. Plan MDX is parsed into an AST and
 * rendered through components we own — it is never compiled or evaluated.
 */

import * as limits from "./limits";

export type Kind = "flow" | "text" | "both";

/** What a component may contain. */
export type Content =
	/** Any block-level plan content. */
	| { type: "blocks" }
	/** Inline content only. */
	| { type: "phrasing" }
	/** Nothing. */
	| { type: "empty" }
	/** Only the listed components, at least one. */
	| { type: "components"; names: readonly string[] };

export type Attribute =
	/** ULID, minted when the component is created. */
	| { type: "id"; required: true }
	/** Safe opaque identifier owned by a record outside the document. */
	| { type: "reference"; required: true; max: number }
	/** Plain text, length-bounded. */
	| { type: "text"; required: boolean; max: number; empty?: true }
	/** Canonical decimal integer, quoted rather than evaluated. */
	| { type: "integer"; required: boolean; min: number; max: number }
	/** One of a fixed set. */
	| { type: "enum"; required: boolean; values: readonly string[] };

export type Component = {
	name: string;
	kind: Kind;
	content: Content;
	/** `id` is implicit on anything built by {@link component}. */
	attributes: Readonly<Record<string, Attribute>>;
	/** Components that may not appear anywhere beneath this one. */
	forbids?: readonly string[];
	/** Only valid as a direct child of these components. */
	parent?: readonly string[];
};

const ID: Attribute = { type: "id", required: true };

type Spec = Omit<Component, "attributes"> & { attributes?: Record<string, Attribute> };

/**
 * A component with durable identity: everything that carries or anchors state.
 *
 * The id is a ULID, minted by whoever creates the component — a client for the
 * ones it can insert directly, the server for anything the agent authors. What
 * matters is that it exists and never changes, not who issued it: a ULID has
 * enough entropy that two editors cannot collide on one.
 */
function component(spec: Spec): Component {
	return { ...spec, attributes: { id: ID, ...spec.attributes } };
}

/**
 * A component with no identity of its own.
 *
 * Formatting, content without an anchor identity, and projections need no added id.
 *
 * A pure formatting mark carries no state. Giving it an id would also make it
 * behave badly: applying a mark to a selection has to split and merge wrappers,
 * and stable ids would force a server round-trip per keystroke. Internally
 * these map to Lexical text formats, which Yjs merges natively.
 *
 * A read-only projection of state owned elsewhere is addressed through its
 * parent, so a separate id would create a second identity for one fact.
 * Images already use their ordinary Lexical/Yjs node identity.
 */
function plain(spec: Spec): Component {
	return { ...spec, attributes: { ...spec.attributes } };
}

export const CALLOUT_TYPES = ["note", "tip", "important", "warning", "danger"] as const;

export const COMPONENTS: Readonly<Record<string, Component>> = Object.freeze({
	Image: plain({
		name: "Image",
		// A sole JSX image parses as flow; one inside prose parses as text.
		kind: "both",
		content: { type: "empty" },
		attributes: {
			src: { type: "text", required: true, max: limits.MAX_SOURCE_BYTES },
			alt: { type: "text", required: true, max: limits.MAX_SOURCE_BYTES, empty: true },
			width: { type: "integer", required: true, min: 1, max: limits.MAX_IMAGE_WIDTH },
		},
	}),
	Experiment: component({
		name: "Experiment",
		kind: "flow",
		content: { type: "empty" },
		attributes: {
			experiment: { type: "reference", required: true, max: 96 },
			view: { type: "text", required: true, max: 64 },
			decision: { type: "text", required: false, max: 96 },
		},
	}),
	/**
	 * A questionnaire, and who settled it.
	 *
	 * The provenance sits here rather than on each `Answer` because a
	 * questionnaire resolves as a unit — every question is answered by the same
	 * person at the same moment — so repeating it per answer would be one fact
	 * written several times. `Decision` carries its provenance the same way, on
	 * the container, with the content on the children.
	 *
	 * Both are optional: a questionnaire has neither until it is answered, and
	 * one settled before this was recorded has neither for good.
	 *
	 * `status="expired"` marks host input nobody answered within its time limit.
	 * It stays in the document, unanswered, with `at` saying when it expired.
	 */
	Questionnaire: component({
		name: "Questionnaire",
		kind: "flow",
		content: { type: "components", names: ["Question"] },
		forbids: ["Questionnaire", "Tabs", "Callout"],
		attributes: {
			thread: { type: "text", required: false, max: limits.MAX_ID },
			status: {
				type: "enum",
				required: false,
				values: ["open", "decided", "reopened", "discarded", "expired"],
			},
			by: { type: "text", required: false, max: limits.MAX_HANDLE },
			at: { type: "text", required: false, max: limits.MAX_TIMESTAMP },
		},
	}),

	Question: component({
		name: "Question",
		kind: "flow",
		content: { type: "components", names: ["Option", "Answer", "Previous"] },
		parent: ["Questionnaire"],
		attributes: {
			header: { type: "text", required: true, max: limits.MAX_QUESTIONNAIRE_TEXT },
			prompt: { type: "text", required: true, max: limits.MAX_QUESTIONNAIRE_TEXT },
			multiple: { type: "enum", required: true, values: ["true", "false"] },
		},
	}),

	Option: component({
		name: "Option",
		kind: "flow",
		content: { type: "empty" },
		parent: ["Question"],
		attributes: {
			label: { type: "text", required: true, max: limits.MAX_QUESTIONNAIRE_TEXT },
			description: { type: "text", required: false, max: limits.MAX_QUESTIONNAIRE_TEXT },
		},
	}),

	/**
	 * Immutable projection of the resolved answer. The sidecar record is
	 * authoritative; this exists so the source reads correctly on its own.
	 */
	Answer: plain({
		name: "Answer",
		kind: "flow",
		content: { type: "empty" },
		parent: ["Question"],
		attributes: {
			value: { type: "text", required: true, max: limits.MAX_QUESTIONNAIRE_TEXT },
			choices: { type: "text", required: false, max: limits.MAX_ANSWER_CHOICES },
		},
	}),

	/** Latest decision replaced by a reopened question; the record holds the full history. */
	Previous: plain({
		name: "Previous",
		kind: "flow",
		content: { type: "empty" },
		parent: ["Question"],
		attributes: {
			choices: { type: "text", required: false, max: limits.MAX_ANSWER_CHOICES },
			value: { type: "text", required: false, max: limits.MAX_CUSTOM_ANSWER },
			by: { type: "text", required: true, max: limits.MAX_HANDLE },
			at: { type: "text", required: true, max: limits.MAX_TIMESTAMP },
		},
	}),

	/**
	 * An accepted comment thread.
	 *
	 * The record beside the plan owns it; this exists so the source carries the
	 * decision when read alone. Only accepted threads are projected — an open
	 * one is a conversation, not yet part of the plan — and the projection is
	 * written once and never revised, which is what makes it history.
	 */
	Decision: component({
		name: "Decision",
		kind: "flow",
		content: { type: "components", names: ["Note"] },
		forbids: ["Questionnaire", "Decision", "Tabs", "Callout"],
		attributes: {
			quote: { type: "text", required: true, max: limits.MAX_QUOTE },
			by: { type: "text", required: true, max: limits.MAX_HANDLE },
			at: { type: "text", required: true, max: limits.MAX_TIMESTAMP },
		},
	}),

	/**
	 * One comment in an accepted thread.
	 *
	 * The text is an attribute rather than children, following `Answer`: a flow
	 * component's children are parsed as blocks, so prose written between the
	 * tags comes back wrapped in a paragraph and flattens on the way out. An
	 * attribute round-trips exactly, which the plan's round-trip check requires.
	 */
	Note: plain({
		name: "Note",
		kind: "flow",
		content: { type: "empty" },
		parent: ["Decision"],
		attributes: {
			by: { type: "text", required: true, max: limits.MAX_HANDLE },
			text: { type: "text", required: true, max: limits.MAX_NOTE },
		},
	}),

	Columns: component({
		name: "Columns",
		kind: "flow",
		content: { type: "components", names: ["Column"] },
		forbids: ["Columns"],
	}),

	Column: component({
		name: "Column",
		kind: "flow",
		content: { type: "blocks" },
		parent: ["Columns"],
		forbids: [
			"Experiment",
			"Questionnaire",
			"Question",
			"Option",
			"Answer",
			"Previous",
			"Decision",
			"Note",
			"Tabs",
			"Tab",
			"Callout",
			"Research",
			"Columns",
			"Column",
		],
	}),

	Tabs: component({
		name: "Tabs",
		kind: "flow",
		content: { type: "components", names: ["Tab"] },
		forbids: ["Tabs"],
	}),

	Tab: component({
		name: "Tab",
		kind: "flow",
		content: { type: "blocks" },
		parent: ["Tabs"],
		attributes: {
			label: { type: "text", required: true, max: limits.MAX_TAB_LABEL },
		},
	}),

	Callout: component({
		name: "Callout",
		kind: "flow",
		content: { type: "blocks" },
		forbids: ["Callout"],
		attributes: {
			type: { type: "enum", required: true, values: CALLOUT_TYPES },
			title: { type: "text", required: false, max: limits.MAX_CALLOUT_TITLE },
		},
	}),

	/** A reference to authoritative Research Workspace state. */
	Research: plain({
		name: "Research",
		kind: "flow",
		content: { type: "empty" },
		attributes: {
			id: { type: "reference", required: true, max: 96 },
		},
	}),

	/** Markdown has no underline; this keeps it out of raw HTML. */
	Underline: plain({
		name: "Underline",
		kind: "text",
		content: { type: "phrasing" },
	}),
});

export const COMPONENT_NAMES: readonly string[] = Object.freeze(Object.keys(COMPONENTS));

export function lookup(name: string | null | undefined): Component | undefined {
	if (!name) return undefined;
	return Object.hasOwn(COMPONENTS, name) ? COMPONENTS[name] : undefined;
}

/** MDAST node types the dialect accepts outside of custom components. */
export const NODES: readonly string[] = Object.freeze([
	"root",
	"paragraph",
	"heading",
	"thematicBreak",
	"blockquote",
	"list",
	"listItem",
	"code",
	"table",
	"tableRow",
	"tableCell",
	"text",
	"strong",
	"emphasis",
	"delete",
	"inlineCode",
	"break",
	"link",
	"image",
	"math",
	"inlineMath",
	"footnoteReference",
	"footnoteDefinition",
	"mdxJsxFlowElement",
	"mdxJsxTextElement",
]);

/** Node types that must never appear: executable or raw-HTML constructs. */
export const FORBIDDEN_NODES: readonly string[] = Object.freeze([
	"html",
	"mdxjsEsm",
	"mdxFlowExpression",
	"mdxTextExpression",
	"yaml",
	"toml",
	"linkReference",
	"imageReference",
	"definition",
]);

/** URL protocols permitted in links. */
export const LINK_PROTOCOLS: readonly string[] = Object.freeze(["https:", "mailto:"]);

/**
 * Characters a URL must never carry: controls (C0, DEL, C1) and format
 * characters (soft hyphen, zero-width and bidirectional marks, the byte-order
 * mark), plus line and paragraph separators.
 *
 * Browsers strip some of these while parsing, so `\u0001javascript:` has no
 * scheme to a pattern yet resolves to one; others hide a different address
 * behind the one a reader sees.
 */
export const HIDDEN_URL_CHARACTERS: RegExp = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Whether a value with no scheme still names another host.
 *
 * `//host` is protocol-relative, and browsers read `\` as `/`, so `\\host`
 * and `/\host` are too. None of them is a path in the repository.
 */
export function leavesRepository(url: string): boolean {
	return url.startsWith("//") || url.includes("\\");
}

/**
 * Why a URL is unsafe to newly store, or nothing if it is fine.
 *
 * Browsers trim surrounding whitespace and drop tabs and newlines anywhere,
 * so ` javascript:` or `java\tscript:` reach a scheme the plain check below
 * never saw. Images are absolute or one exact same-origin path by rule, so
 * only links can be scheme-less paths that wander off to another host.
 */
export function disguisedUrl(url: string, kind: "link" | "image" = "link"): string | undefined {
	let noun = kind === "image" ? "Image URL" : "Link";
	if (HIDDEN_URL_CHARACTERS.test(url)) return `${noun} contains hidden or control characters`;
	if (/^\s|\s$/.test(url)) return `${noun} cannot start or end with whitespace`;
	let scheme = /^[a-z][a-z0-9+.-]*:/i;
	if (!scheme.test(url) && scheme.test(url.replace(/\s/g, ""))) {
		return `${noun} hides a protocol behind whitespace`;
	}
	if (kind === "link" && !scheme.test(url) && leavesRepository(url)) {
		return "Link without a protocol must stay in the repository";
	}
	return undefined;
}

/**
 * URL protocols permitted in absolute image URLs.
 *
 * Narrower than links, and absolute where a link need not be: there is no
 * server here to resolve a repository-relative path against, so a relative
 * image would render as a break in every client that opened the plan. The one
 * exception is {@link HOSTED_IMAGE_PATH}.
 */
export const IMAGE_PROTOCOLS: readonly string[] = Object.freeze(["https:"]);

/**
 * The only relative image form: an image Chopin stores itself, named by the
 * SHA-256 of its bytes and served from the document's own origin. Every other
 * relative path still has nothing to resolve against.
 */
export const HOSTED_IMAGE_PATH = /^\/images\/[0-9a-f]{64}\.(?:png|jpg|jpeg|webp|gif)$/;

/** Fenced code language that renders as a diagram. */
export const MERMAID_LANGUAGE = "mermaid";

/** Fenced JSON source for a bounded SeeCode explanatory diagram. */
export const SEECODE_LANGUAGE = "seecode";

/** Fenced indented outline for a bounded interface wireframe. */
export const WIREFRAME_LANGUAGE = "wireframe";

/**
 * Fenced code language that renders as a diff.
 *
 * A unified patch and nothing else — no `patch`, no `udiff`. A renderer that
 * accepts three spellings has to be told about all three in three places, and
 * the plan is written by an agent that will copy whichever one it last read.
 */
export const DIFF_LANGUAGE = "diff";
