import { parse } from "@chopin/dialect/parse";
import { serialize } from "@chopin/dialect/serialize";
import { assert, assertIntroducedUrls } from "@chopin/dialect/validate";
import type { Nodes, Parent } from "mdast";
import { z } from "zod";
import type { JsonValue } from "../storage/model";

export const DOCUMENT_DEVELOPMENT_MAX_INPUT_BYTES = 128 * 1024;

let nonempty = (max: number) => z.string().min(1).max(max).refine(value => !!value.trim());
let id = nonempty(128);
let hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
let identity = {
	messageId: id,
	revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	decisionHash: hash,
};
let message = z.object({ id, author: id, text: nonempty(4000) }).strict();
let passage = z.object({
	id,
	markdown: nonempty(1200),
	digest: nonempty(128),
	editable: z.boolean(),
}).strict();

let inputSchema = z.object({
	...identity,
	source: z.string().max(32000),
	messages: z.array(message).min(1).max(16),
	passages: z.array(passage).max(48),
	decisions: z.array(nonempty(800)).max(24),
	capacity: z.object({
		additions: z.number().int().min(0).max(48),
		characters: z.number().int().min(0).max(12000),
	}).strict(),
}).strict().superRefine((value, context) => {
	if (value.messages.reduce((sum, item) => sum + item.text.length, 0) > 16000) {
		context.addIssue({ code: "custom", message: "message context exceeds its bound" });
	}
	if (value.messages.at(-1)?.id !== value.messageId) {
		context.addIssue({ code: "custom", message: "latest message identity is invalid" });
	}
	for (let items of [value.messages, value.passages]) {
		if (new Set(items.map(item => item.id)).size !== items.length) {
			context.addIssue({ code: "custom", message: "duplicate context identity" });
		}
	}
});

// A generated passage cannot introduce document components or other authority-bearing nodes.
let ordinary = new Set([
	"paragraph",
	"list",
	"listItem",
	"text",
	"strong",
	"emphasis",
	"delete",
	"inlineCode",
	"link",
	"break",
]);
export function assertDocumentDevelopmentMarkdown(markdown: string): void {
	let tree = parse(markdown);
	assert(tree, { bytes: Buffer.byteLength(markdown) });
	assertIntroducedUrls([], tree.children);
	let block = tree.children[0];
	if (
		tree.children.length !== 1 || !block
		|| block.type !== "paragraph" && block.type !== "list"
			&& !(block.type === "heading" && (block.depth === 2 || block.depth === 3))
	) throw new Error("development passage must be one ordinary block");
	let visit = (node: Nodes): void => {
		if (!ordinary.has(node.type) && node !== block) {
			throw new Error("development passage contains unsupported markup");
		}
		for (let child of (node as Parent).children ?? []) visit(child);
	};
	visit(block);
}

export let documentDevelopmentOutputSchema = z.object({
	changes: z.array(
		z.object({
			id: id.nullable(),
			markdown: nonempty(1200),
			sourceIds: z.array(id).min(1).max(16),
		}).strict(),
	).max(8),
	removals: z.array(id).max(8),
}).strict();

let artifactSchema = documentDevelopmentOutputSchema.extend({ ...identity, model: nonempty(200) });

export type DocumentDevelopmentInput = z.infer<typeof inputSchema>;
export type DocumentDevelopmentOutput = z.infer<typeof documentDevelopmentOutputSchema>;
export type DocumentDevelopmentArtifact = z.infer<typeof artifactSchema>;

export class DocumentDevelopmentCapacityError extends Error {
	constructor() {
		super("document development exceeds captured capacity");
		this.name = "DocumentDevelopmentCapacityError";
	}
}

export function parseDocumentDevelopmentInput(value: JsonValue): DocumentDevelopmentInput {
	return inputSchema.parse(value);
}

export function parseDocumentDevelopmentOutput(
	value: JsonValue,
	input?: DocumentDevelopmentInput,
): DocumentDevelopmentOutput {
	let result = documentDevelopmentOutputSchema.parse(value);
	if (
		result.changes.length + result.removals.length > 8
		|| result.changes.reduce((sum, change) => sum + change.markdown.length, 0) > 4800
	) throw new Error("development changes exceed their bound");
	let targets = [
		...result.changes.flatMap(change => change.id === null ? [] : [change.id]),
		...result.removals,
	];
	if (new Set(targets).size !== targets.length) throw new Error("duplicate development target");
	for (let change of result.changes) {
		assertDocumentDevelopmentMarkdown(change.markdown);
		if (new Set(change.sourceIds).size !== change.sourceIds.length) {
			throw new Error("duplicate development source");
		}
		if (input && change.sourceIds.some(id => !input.messages.some(message => message.id === id))) {
			throw new Error("unknown development source");
		}
	}
	if (
		input
		&& targets.some(id => !input.passages.some(passage => passage.id === id && passage.editable))
	) {
		throw new Error("development target is unknown or protected");
	}
	if (input) {
		let size = (markdown: string) => serialize(parse(markdown)).length;
		let growth = result.changes.reduce((sum, change) => sum + size(change.markdown), 0);
		for (let id of targets) {
			growth -= size(input.passages.find(passage => passage.id === id)!.markdown);
		}
		if (
			result.changes.filter(change => change.id === null).length > input.capacity.additions
			|| growth > input.capacity.characters
		) throw new DocumentDevelopmentCapacityError();
	}
	return result;
}

export function parseDocumentDevelopmentArtifact(value: JsonValue): DocumentDevelopmentArtifact {
	let result = artifactSchema.parse(value);
	parseDocumentDevelopmentOutput({ changes: result.changes, removals: result.removals });
	return result;
}
