/**
 * The plan schema registry.
 *
 * One definition drives both the browser editor and headless conversion on the
 * server. Divergence here means the two disagree about what a plan
 * is, so both sides build from `plugins()` and nothing else.
 *
 * A realm can be constructed outside React: calling only `init()` registers
 * visitors and nodes without `postInit()` building a DOM-bound editor.
 */

import { Realm } from "@mdxeditor/gurx";
import type { createEditor } from "lexical";
import {
	addExportVisitor$,
	addImportVisitor$,
	addLexicalNode$,
	addToMarkdownExtension$,
	codeBlockEditorDescriptors$,
	corePlugin,
	directiveDescriptors$,
	exportVisitors$,
	headingsPlugin,
	importVisitors$,
	jsxComponentDescriptors$,
	jsxIsAvailable$,
	linkPlugin,
	listsPlugin,
	quotePlugin,
	realmPlugin,
	thematicBreakPlugin,
	usedLexicalNodes$,
} from "@mdxeditor/editor";

import type { exportLexicalTreeToMdast, importMdastTreeToLexical } from "@mdxeditor/editor";

import { CONTAINER_EXPORT_VISITORS, CONTAINER_IMPORT_VISITORS } from "./nodes/container-visitors";
import { CONTAINER_NODES } from "./nodes/containers";
import { CONTENT_EXPORT_VISITORS, CONTENT_IMPORT_VISITORS } from "./nodes/content-visitors";
import { CONTENT_NODES } from "./nodes/content";
import { DecisionNode, LexicalDecisionVisitor, MdastDecisionVisitor } from "./nodes/decision";
import {
	LexicalQuestionnaireVisitor,
	MdastQuestionnaireVisitor,
	QuestionnaireNode,
} from "./nodes/questionnaire";
import { LexicalTableVisitor, MdastTableVisitor, TABLE_NODES } from "./nodes/table";
import { MdastUnderlineVisitor } from "./nodes/underline";
import { extensions } from "./serialize";

import type { RealmPlugin } from "@mdxeditor/editor";

type ImportOptions = Parameters<typeof importMdastTreeToLexical>[0];
type ExportOptions = Parameters<typeof exportLexicalTreeToMdast>[0];

/**
 * Everything needed to convert between MDAST and Lexical.
 *
 * Shapes are taken from the conversion functions themselves so the registry
 * cannot drift from what they accept.
 */
export type Registry = {
	importVisitors: ImportOptions["visitors"];
	exportVisitors: ExportOptions["visitors"];
	nodes: LexicalNodes;
	jsxComponentDescriptors: ImportOptions["jsxComponentDescriptors"];
	directiveDescriptors: ImportOptions["directiveDescriptors"];
	codeBlockEditorDescriptors: ImportOptions["codeBlockEditorDescriptors"];
	jsxIsAvailable: boolean;
};

/** Node classes handed to `createEditor`/`createHeadlessEditor`. */
type LexicalNodes = NonNullable<Parameters<typeof createEditor>[0]>["nodes"];

/**
 * Native tables. Deliberately replaces MDXEditor's `tablePlugin()`, which models
 * a table as one atomic decorator property and cannot merge concurrent edits.
 * Both register the Lexical node type `table`, so they must never be combined.
 */
export const tablePlugin = realmPlugin({
	init(realm) {
		realm.pubIn({
			[addLexicalNode$]: TABLE_NODES,
			[addImportVisitor$]: MdastTableVisitor,
			[addExportVisitor$]: LexicalTableVisitor,
		});
	},
});

/**
 * Declares that plan documents are MDX.
 *
 * Without this, `exportLexicalTreeToMdast` rewrites JSX marks into raw `html`
 * nodes, which the dialect forbids. Ace does not use MDXEditor's `jsxPlugin`
 * because plan components are a fixed allowlist, not user-supplied descriptors.
 */
export const jsxPlugin = realmPlugin({
	init(realm) {
		realm.pub(jsxIsAvailable$, true);
	},
});

/**
 * Tabs and Callout.
 *
 * These are element nodes with ordinary Lexical children, so their content
 * collaborates like top-level prose rather than being snapshotted into a
 * parent property the way MDXEditor's nested editors work.
 */
export const containersPlugin = realmPlugin({
	init(realm) {
		realm.pubIn({
			[addLexicalNode$]: CONTAINER_NODES,
			[addImportVisitor$]: CONTAINER_IMPORT_VISITORS,
			[addExportVisitor$]: CONTAINER_EXPORT_VISITORS,
		});
	},
});

/**
 * Code, math, images and footnotes.
 *
 * Code and math keep their source as Lexical text children so it merges per
 * character. Highlighting and KaTeX rendering happen over that model in
 * `@chopin/editor`, never by rewriting nodes as the user types.
 */
export const contentPlugin = realmPlugin({
	init(realm) {
		realm.pubIn({
			[addLexicalNode$]: CONTENT_NODES,
			[addImportVisitor$]: CONTENT_IMPORT_VISITORS,
			[addExportVisitor$]: CONTENT_EXPORT_VISITORS,
		});
	},
});

/**
 * Durable questionnaires.
 *
 * Atomic on purpose: the definition is immutable and the answer belongs to the
 * sidecar record, so there is nothing inside for two people to edit.
 */
export const questionnairePlugin = realmPlugin({
	init(realm) {
		realm.pubIn({
			[addLexicalNode$]: [QuestionnaireNode],
			[addImportVisitor$]: MdastQuestionnaireVisitor,
			[addExportVisitor$]: LexicalQuestionnaireVisitor,
		});
	},
});

/**
 * Accepted comment threads.
 *
 * Atomic for the same reason a questionnaire is, and never revised once
 * written: the node is the plan's copy of a decision the record owns.
 */
export const decisionPlugin = realmPlugin({
	init(realm) {
		realm.pubIn({
			[addLexicalNode$]: [DecisionNode],
			[addImportVisitor$]: MdastDecisionVisitor,
			[addExportVisitor$]: LexicalDecisionVisitor,
		});
	},
});

/** Underline, mapped to Lexical's native text format rather than a wrapper node. */
export const underlinePlugin = realmPlugin({
	init(realm) {
		realm.pubIn({
			[addImportVisitor$]: MdastUnderlineVisitor,
		});
	},
});

/**
 * Teach the editor's own serialiser the dialect.
 *
 * Visitors turn Lexical nodes into MDAST; these turn that MDAST into markdown,
 * and the two are registered separately. MDXEditor's core writes the whole
 * document out on every update to publish `markdown$`, using extensions from
 * its realm rather than the ones `serialize.ts` passes to `exportPlan`.
 *
 * A node type it cannot write does not serialise badly, it throws — and that
 * listener is registered when the root editor is built, ahead of every composer
 * child. Lexical then abandons the rest of the loop, so everything behind it is
 * skipped, collaboration included. One unhandled node and the plan accepts
 * edits while sending none of them, for the rest of the session, in silence.
 *
 * The serialiser's own list, whole. The core's copies of `mdxJsx` and
 * `gfmStrikethrough` are harmlessly overridden by identical ones, and sharing
 * the list is what stops the two drifting apart again.
 */
export const markdownPlugin = realmPlugin({
	init(realm) {
		realm.pub(addToMarkdownExtension$, extensions());
	},
});

/**
 * Core plugin parameters.
 *
 * `suppressHtmlProcessing` matters: the dialect has no raw HTML, and leaving it
 * on would register MDXEditor's HTML visitors and quietly admit `html` nodes.
 */
function core(): RealmPlugin {
	return corePlugin({
		initialMarkdown: "",
		contentEditableClassName: "",
		spellCheck: true,
		toMarkdownOptions: {},
		autoFocus: false,
		placeholder: "",
		readOnly: false,
		iconComponentFor: () => null as never,
		suppressHtmlProcessing: true,
		translation: (_key: string, fallback: string) => fallback,
		trim: true,
		onChange: () => {},
		onBlur: () => {},
		onError: () => {},
		additionalLexicalNodes: [],
		lexicalEditorNamespace: "AcePlan",
	});
}

/**
 * The plugin set defining the dialect's Lexical schema.
 *
 * `core` is MDXEditor's own base plugin, and it is only ours to supply when
 * nobody else has. `<MDXEditor>` installs one from its props and re-publishes
 * `readOnly`, `placeholder`, `spellCheck` and the content class on every
 * render — so a second copy carrying our defaults silently overwrites what the
 * host asked for. The browser passes `core: false` and sets those on the
 * component; the headless registry has no component and supplies its own.
 */
export function plugins({ core: withCore = true } = {}): RealmPlugin[] {
	return [
		...(withCore ? [core()] : []),
		headingsPlugin(),
		listsPlugin(),
		quotePlugin(),
		linkPlugin(),
		thematicBreakPlugin(),
		jsxPlugin(),
		tablePlugin(),
		containersPlugin(),
		contentPlugin(),
		questionnairePlugin(),
		decisionPlugin(),
		underlinePlugin(),
		markdownPlugin(),
	];
}

/**
 * Build the registry without React or a DOM.
 *
 * Only `init()` runs; `postInit()` would construct a Lexical editor, which is
 * the browser's job.
 */
export function registry(): Registry {
	let realm = new Realm();
	for (let plugin of plugins()) plugin.init?.(realm);

	return {
		importVisitors: realm.getValue(importVisitors$),
		exportVisitors: realm.getValue(exportVisitors$),
		nodes: realm.getValue(usedLexicalNodes$),
		jsxComponentDescriptors: realm.getValue(jsxComponentDescriptors$),
		directiveDescriptors: realm.getValue(directiveDescriptors$),
		codeBlockEditorDescriptors: realm.getValue(codeBlockEditorDescriptors$),
		jsxIsAvailable: realm.getValue(jsxIsAvailable$),
	};
}
