/**
 * The plan MDX dialect.
 *
 * A plan is authored by collaborators and by the agent, so it is treated as
 * untrusted input. This module is the allowlist: anything not described here is
 * rejected before it can reach a renderer. Plan MDX is parsed into an AST and
 * rendered through components we own — it is never compiled or evaluated.
 */

import * as limits from "./limits";

export type Kind = "flow" | "text";

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
	/** Plain text, length-bounded. */
	| { type: "text"; required: boolean; max: number }
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
 * Two kinds qualify, and they are spelled the same because they need the same
 * thing — nothing added.
 *
 * A pure formatting mark carries no state. Giving it an id would also make it
 * behave badly: applying a mark to a selection has to split and merge wrappers,
 * and stable ids would force a server round-trip per keystroke. Internally
 * these map to Lexical text formats, which Yjs merges natively.
 *
 * A read-only projection of state owned elsewhere is addressed through its
 * parent, so a separate id would create a second identity for one fact.
 */
function plain(spec: Spec): Component {
	return { ...spec, attributes: { ...spec.attributes } };
}

export const CALLOUT_TYPES = ["note", "tip", "important", "warning", "danger"] as const;

export const COMPONENTS: Readonly<Record<string, Component>> = Object.freeze({
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
	 */
	Questionnaire: component({
		name: "Questionnaire",
		kind: "flow",
		content: { type: "components", names: ["Question"] },
		forbids: ["Questionnaire", "Tabs", "Callout"],
		attributes: {
			by: { type: "text", required: false, max: limits.MAX_HANDLE },
			at: { type: "text", required: false, max: limits.MAX_TIMESTAMP },
		},
	}),

	Question: component({
		name: "Question",
		kind: "flow",
		content: { type: "components", names: ["Option", "Answer"] },
		parent: ["Questionnaire"],
		attributes: {
			header: { type: "text", required: true, max: limits.MAX_QUESTION_HEADER },
			prompt: { type: "text", required: true, max: limits.MAX_QUESTION_PROMPT },
			multiple: { type: "enum", required: true, values: ["true", "false"] },
		},
	}),

	Option: component({
		name: "Option",
		kind: "flow",
		content: { type: "empty" },
		parent: ["Question"],
		attributes: {
			label: { type: "text", required: true, max: limits.MAX_OPTION_LABEL },
			description: { type: "text", required: false, max: limits.MAX_OPTION_DESCRIPTION },
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
			value: { type: "text", required: true, max: limits.MAX_CUSTOM_ANSWER },
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

	ResearchQuestion: component({
		name: "ResearchQuestion",
		kind: "flow",
		content: { type: "blocks" },
		forbids: ["ResearchQuestion"],
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
 * URL protocols permitted in images.
 *
 * Narrower than links, and absolute where a link need not be: there is no
 * server here to resolve a repository-relative path against, so a relative
 * image would render as a break in every client that opened the plan.
 */
export const IMAGE_PROTOCOLS: readonly string[] = Object.freeze(["https:"]);

/** Fenced code language that renders as a diagram. */
export const MERMAID_LANGUAGE = "mermaid";

/**
 * Fenced code language that renders as a diff.
 *
 * A unified patch and nothing else — no `patch`, no `udiff`. A renderer that
 * accepts three spellings has to be told about all three in three places, and
 * the plan is written by an agent that will copy whichever one it last read.
 */
export const DIFF_LANGUAGE = "diff";
