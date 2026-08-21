import { parse } from "./parse";

export type MdxChunk = {
	source: string;
	firstBlock: number;
	lastBlock: number;
	bytes: number;
};

/** Greedily pack complete top-level MDX blocks without changing a source byte. */
export function topLevelChunks(source: string, targetBytes: number): MdxChunk[] {
	if (!Number.isSafeInteger(targetBytes) || targetBytes < 1) {
		throw new Error("MDX chunk target must be a positive integer.");
	}
	let tree = parse(source);
	let encoder = new TextEncoder();
	if (tree.children.length === 0) {
		return source
			? [{ source, firstBlock: 0, lastBlock: 0, bytes: encoder.encode(source).byteLength }]
			: [];
	}
	let spans = tree.children.map((child, index) => {
		let ownStart = child.position?.start.offset;
		let nextStart = tree.children[index + 1]?.position?.start.offset;
		if (ownStart === undefined || (nextStart === undefined && index + 1 < tree.children.length)) {
			throw new Error("Parsed MDX block has no source offset.");
		}
		let start = index === 0 ? 0 : ownStart;
		let end = nextStart ?? source.length;
		let value = source.slice(start, end);
		return { source: value, block: index, bytes: encoder.encode(value).byteLength };
	});
	let chunks: MdxChunk[] = [];
	let current: MdxChunk | undefined;
	for (let span of spans) {
		if (current && current.bytes + span.bytes <= targetBytes) {
			current.source += span.source;
			current.lastBlock = span.block;
			current.bytes += span.bytes;
			continue;
		}
		current = {
			source: span.source,
			firstBlock: span.block,
			lastBlock: span.block,
			bytes: span.bytes,
		};
		chunks.push(current);
	}
	if (chunks.map(chunk => chunk.source).join("") !== source) {
		throw new Error("MDX chunks do not reassemble to their source.");
	}
	return chunks;
}
