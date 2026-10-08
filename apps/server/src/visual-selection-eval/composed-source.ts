import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type PassageInput = {
	documentTitle: string;
	heading: string;
	passage: string;
};

export type ComposedCase = {
	id: string;
	cluster: string;
	input: PassageInput;
	passageSha256: string;
	source: {
		path: string;
		sha256: string;
		snapshot: string;
		cutoff: string;
		segments?: Array<{ firstLine: number; lastLine: number; startByte: number; endByte: number }>;
		jsonPointer?: string;
		startByteInBody?: number;
		endByteInBody?: number;
		adaptation: string;
	};
};

function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Verify frozen source bytes before any passage reaches a provider. */
export async function loadComposedCases(
	manifestPath: string,
	sourceRoot: string,
): Promise<ComposedCase[]> {
	let manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
		version: number;
		cases: ComposedCase[];
	};
	if (manifest.version !== 1 || !Array.isArray(manifest.cases) || manifest.cases.length !== 3) {
		throw new Error("Expected exactly three frozen composed-assessment cases");
	}
	let seen = new Set<string>();
	for (let item of manifest.cases) {
		if (!item.id || seen.has(item.id)) throw new Error("Duplicate or empty case ID");
		seen.add(item.id);
		let path = item.source.path;
		if (!path || isAbsolute(path) || path.split("/").includes("..")) {
			throw new Error(`Invalid frozen source path: ${path}`);
		}
		let raw = await readFile(join(sourceRoot, path));
		if (sha256(raw) !== item.source.sha256) throw new Error(`Source hash changed: ${item.id}`);
		let passage: string;
		if (item.source.segments) {
			let lines = raw.toString("utf8").split(/(?<=\n)/);
			let chunks = item.source.segments.map(span => {
				let start = Buffer.byteLength(lines.slice(0, span.firstLine - 1).join(""));
				let end = Buffer.byteLength(lines.slice(0, span.lastLine).join(""));
				if (
					span.firstLine < 1 || span.lastLine < span.firstLine
					|| start !== span.startByte || end !== span.endByte
				) throw new Error(`Source offset changed: ${item.id}`);
				return raw.subarray(start, end);
			});
			passage = Buffer.concat(
				chunks.flatMap((chunk, index) => index === 0 ? [chunk] : [Buffer.from("\n"), chunk]),
			).toString("utf8").trim();
		} else if (item.source.jsonPointer === "/events/0/body") {
			let document = JSON.parse(raw.toString("utf8")) as {
				cutoff?: string;
				events?: Array<{ body?: string }>;
			};
			if (
				document.cutoff !== item.source.cutoff || typeof document.events?.[0]?.body !== "string"
			) {
				throw new Error(`Source checkpoint changed: ${item.id}`);
			}
			let body = document.events[0].body;
			if (
				item.source.startByteInBody !== 0 || item.source.endByteInBody !== Buffer.byteLength(body)
			) {
				throw new Error(`Source body offset changed: ${item.id}`);
			}
			passage = body;
		} else {
			throw new Error(`Unsupported source selector: ${item.id}`);
		}
		if (passage !== item.input.passage || sha256(passage) !== item.passageSha256) {
			throw new Error(`Frozen passage changed: ${item.id}`);
		}
	}
	return manifest.cases;
}
