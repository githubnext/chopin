/**
 * MDAST <-> Lexical visitors for code, math, images and footnotes.
 */

import {
	$createCodeBlockNode,
	$createFootnoteDefinitionNode,
	$createFootnoteReferenceNode,
	$createImageNode,
	$createMathNode,
	$isCodeBlockNode,
	$isFootnoteDefinitionNode,
	$isFootnoteReferenceNode,
	$isImageNode,
	$isMathNode,
} from "./content";
import { IMAGE_PROTOCOLS } from "../dialect";
import { PRIORITY } from "./shared";

import { $createTextNode } from "lexical";

import type { LexicalExportVisitor, MdastImportVisitor } from "@mdxeditor/editor";
import type { ElementNode, LexicalNode } from "lexical";
import type * as Mdast from "mdast";
// Math nodes are contributed to mdast by this package rather than @types/mdast.
import type { InlineMath, Math } from "mdast-util-math";
import type {
	CodeBlockNode,
	FootnoteDefinitionNode,
	FootnoteReferenceNode,
	ImageNode,
	MathNode,
} from "./content";

// -- code ------------------------------------------------------------------

export const MdastCodeVisitor: MdastImportVisitor<Mdast.Code> = {
	testNode: "code",
	visitNode({ mdastNode, lexicalParent }) {
		(lexicalParent as ElementNode).append(
			$createCodeBlockNode(mdastNode.lang ?? "", mdastNode.value, mdastNode.meta ?? ""),
		);
	},
	priority: PRIORITY,
};

export const LexicalCodeVisitor: LexicalExportVisitor<CodeBlockNode, Mdast.Code> = {
	testLexicalNode: $isCodeBlockNode,
	visitLexicalNode({ lexicalNode, actions }) {
		actions.addAndStepInto(
			"code",
			{
				lang: lexicalNode.getLanguage() || null,
				// Nothing renders the info string, but rewriting an author's
				// fence is an edit they did not ask for — and one the server's
				// round-trip check refuses.
				meta: lexicalNode.getMeta() || null,
				value: lexicalNode.getTextContent(),
			},
			false,
		);
	},
	priority: PRIORITY,
};

// -- math ------------------------------------------------------------------

export const MdastMathVisitor: MdastImportVisitor<Math> = {
	testNode: "math",
	visitNode({ mdastNode, lexicalParent }) {
		(lexicalParent as ElementNode).append(
			$createMathNode(false, mdastNode.value, mdastNode.meta ?? ""),
		);
	},
	priority: PRIORITY,
};

export const MdastInlineMathVisitor: MdastImportVisitor<InlineMath> = {
	testNode: "inlineMath",
	visitNode({ mdastNode, lexicalParent }) {
		(lexicalParent as ElementNode).append($createMathNode(true, mdastNode.value));
	},
	priority: PRIORITY,
};

export const LexicalMathVisitor: LexicalExportVisitor<MathNode, Math | InlineMath> = {
	testLexicalNode: $isMathNode,
	visitLexicalNode({ lexicalNode, actions }) {
		actions.addAndStepInto(
			lexicalNode.isInlineMath() ? "inlineMath" : "math",
			lexicalNode.isInlineMath()
				? { value: lexicalNode.getTextContent() }
				: { meta: lexicalNode.getMeta() || null, value: lexicalNode.getTextContent() },
			false,
		);
	},
	priority: PRIORITY,
};

// -- image -----------------------------------------------------------------

function permitted(url: string): boolean {
	try {
		return IMAGE_PROTOCOLS.includes(new URL(url).protocol);
	} catch {
		return false;
	}
}

export const MdastImageVisitor: MdastImportVisitor<Mdast.Image> = {
	testNode: "image",
	visitNode({ mdastNode, lexicalParent }) {
		let parent = lexicalParent as ElementNode;

		// A URL the dialect will not accept must not become a node. It would
		// import cleanly, serialise cleanly, and then fail validation on the
		// server — which rebuilds the epoch over something the author could
		// have fixed had they been able to see it. Paste it back as the text
		// it was instead.
		if (!permitted(mdastNode.url)) {
			let alt = mdastNode.alt ?? "";
			parent.append($createTextNode(`![${alt}](${mdastNode.url})`));
			return;
		}

		parent.append($createImageNode(mdastNode.url, mdastNode.alt ?? ""));
	},
	priority: PRIORITY,
};

export const LexicalImageVisitor: LexicalExportVisitor<ImageNode, Mdast.Image> = {
	testLexicalNode: $isImageNode,
	visitLexicalNode({ lexicalNode, actions }) {
		actions.addAndStepInto(
			"image",
			{ url: lexicalNode.getSrc(), alt: lexicalNode.getAlt() || null },
			false,
		);
	},
	priority: PRIORITY,
};

// -- footnotes -------------------------------------------------------------

export const MdastFootnoteReferenceVisitor: MdastImportVisitor<Mdast.FootnoteReference> = {
	testNode: "footnoteReference",
	visitNode({ mdastNode, lexicalParent }) {
		// mdast lower-cases `identifier`; `label` keeps the authored ULID casing.
		let identifier = mdastNode.label ?? mdastNode.identifier.toUpperCase();
		(lexicalParent as ElementNode).append($createFootnoteReferenceNode(identifier));
	},
	priority: PRIORITY,
};

export const LexicalFootnoteReferenceVisitor: LexicalExportVisitor<
	FootnoteReferenceNode,
	Mdast.FootnoteReference
> = {
	testLexicalNode: $isFootnoteReferenceNode,
	visitLexicalNode({ lexicalNode, actions }) {
		let identifier = lexicalNode.getIdentifier();
		actions.addAndStepInto(
			"footnoteReference",
			{ identifier: identifier.toLowerCase(), label: identifier },
			false,
		);
	},
	priority: PRIORITY,
};

export const MdastFootnoteDefinitionVisitor: MdastImportVisitor<Mdast.FootnoteDefinition> = {
	testNode: "footnoteDefinition",
	visitNode({ mdastNode, actions }) {
		let identifier = mdastNode.label ?? mdastNode.identifier.toUpperCase();
		actions.addAndStepInto($createFootnoteDefinitionNode(identifier));
	},
	priority: PRIORITY,
};

export const LexicalFootnoteDefinitionVisitor: LexicalExportVisitor<
	FootnoteDefinitionNode,
	Mdast.FootnoteDefinition
> = {
	testLexicalNode: $isFootnoteDefinitionNode,
	visitLexicalNode({ lexicalNode, actions }) {
		let identifier = lexicalNode.getIdentifier();
		actions.addAndStepInto("footnoteDefinition", {
			identifier: identifier.toLowerCase(),
			label: identifier,
		});
	},
	priority: PRIORITY,
};

export const CONTENT_IMPORT_VISITORS: MdastImportVisitor<never>[] = [
	MdastCodeVisitor,
	MdastMathVisitor,
	MdastInlineMathVisitor,
	MdastImageVisitor,
	MdastFootnoteReferenceVisitor,
	MdastFootnoteDefinitionVisitor,
] as unknown as MdastImportVisitor<never>[];

export const CONTENT_EXPORT_VISITORS: LexicalExportVisitor<LexicalNode, Mdast.Nodes>[] = [
	LexicalCodeVisitor,
	LexicalMathVisitor,
	LexicalImageVisitor,
	LexicalFootnoteReferenceVisitor,
	LexicalFootnoteDefinitionVisitor,
] as unknown as LexicalExportVisitor<LexicalNode, Mdast.Nodes>[];
