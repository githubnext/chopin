/**
 * MDX <-> Lexical conversion.
 *
 * The server uses this headlessly to bootstrap the collaborative document from
 * canonical source and to project the shared tree back to MDX. The browser runs
 * the same conversion through MDXEditor against the same registry.
 */

import { $getRoot } from "lexical";
import { exportLexicalTreeToMdast, importMdastTreeToLexical } from "@mdxeditor/editor";

import { parse } from "./parse";
import { normalizeMarks } from "./nodes/underline";
import { registry as buildRegistry } from "./registry";
import { serialize } from "./serialize";
import { assert } from "./validate";

import type { ImportPoint } from "@mdxeditor/editor";
import type { LexicalEditor, LexicalNode, RootNode } from "lexical";
import type { Root } from "mdast";
import type { Registry } from "./registry";

export type ConvertOptions = {
	/** Reuse a registry instead of rebuilding it per call. */
	registry?: Registry;
	/** Validate before importing and after exporting. Defaults to true. */
	validate?: boolean;
};

/**
 * Replace an editor's content with a parsed plan.
 *
 * Runs inside the caller's `editor.update()` so the import can be part of a
 * larger transaction (bootstrap, epoch rebuild, agent operation batch).
 *
 * @throws {PlanValidationError} when the source violates the dialect.
 */
export function $importPlan(source: string, options: ConvertOptions = {}): void {
	let reg = options.registry ?? buildRegistry();
	let tree = parse(source);

	if (options.validate !== false) {
		assert(tree, { bytes: new TextEncoder().encode(source).byteLength });
	}

	let root = $getRoot();
	root.clear();

	importMdastTreeToLexical({
		root: root as unknown as Parameters<typeof importMdastTreeToLexical>[0]["root"],
		mdastRoot: tree,
		// MDXEditor sorts visitors in place. The registry is shared by every
		// conversion in this process, so never hand its array over directly.
		visitors: [...reg.importVisitors],
		jsxComponentDescriptors: reg.jsxComponentDescriptors,
		directiveDescriptors: reg.directiveDescriptors,
		codeBlockEditorDescriptors: reg.codeBlockEditorDescriptors,
	});
}

/**
 * Create detached Lexical nodes from a plan tree without clearing the root.
 *
 * Must run inside the destination editor's update: Lexical registers newly
 * constructed nodes in the active editor state, so nodes staged in another
 * editor cannot later be moved across. Callers attach every returned node
 * before the update ends; detached nodes are otherwise garbage-collected.
 */
export function $createPlanNodes(tree: Root, options: ConvertOptions = {}): LexicalNode[] {
	let reg = options.registry ?? buildRegistry();
	if (options.validate !== false) assert(tree);

	let nodes: LexicalNode[] = [];
	let point: ImportPoint = {
		append(node) {
			nodes.push(node);
		},
		getType() {
			return "root";
		},
	};

	importMdastTreeToLexical({
		root: point,
		mdastRoot: tree,
		visitors: [...reg.importVisitors],
		jsxComponentDescriptors: reg.jsxComponentDescriptors,
		directiveDescriptors: reg.directiveDescriptors,
		codeBlockEditorDescriptors: reg.codeBlockEditorDescriptors,
	});

	return nodes;
}

/** Project the current editor content to MDAST. Must run inside a read or update. */
export function $exportPlanTree(options: ConvertOptions = {}): Root {
	let reg = options.registry ?? buildRegistry();

	let tree = exportLexicalTreeToMdast({
		root: $getRoot() as RootNode,
		visitors: reg.exportVisitors,
		jsxComponentDescriptors: reg.jsxComponentDescriptors,
		jsxIsAvailable: reg.jsxIsAvailable,
		// The dialect has no imports; never synthesise an ESM block.
		addImportStatements: false,
	});

	normalizeMarks(tree);
	return tree;
}

/**
 * Project the current editor content to canonical MDX.
 *
 * @throws {PlanValidationError} when the projection violates the dialect.
 */
export function $exportPlan(options: ConvertOptions = {}): string {
	let tree = $exportPlanTree(options);
	if (options.validate !== false) assert(tree);
	return serialize(tree);
}

/** Load canonical source into an editor as one discrete transaction. */
export function importPlan(
	editor: LexicalEditor,
	source: string,
	options: ConvertOptions = {},
): void {
	let failure: unknown;
	editor.update(
		() => {
			try {
				$importPlan(source, options);
			} catch (err) {
				failure = err;
			}
		},
		{ discrete: true },
	);
	if (failure) throw failure;
}

/** Read canonical source out of an editor. */
export function exportPlan(editor: LexicalEditor, options: ConvertOptions = {}): string {
	let source = "";
	let failure: unknown;
	editor.getEditorState().read(() => {
		try {
			source = $exportPlan(options);
		} catch (err) {
			failure = err;
		}
	});
	if (failure) throw failure;
	return source;
}
