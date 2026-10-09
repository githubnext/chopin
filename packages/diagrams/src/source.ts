/** Decode one bounded JSON fence without evaluating document content. */
export const MAX_DIAGRAM_SOURCE_BYTES = 64 * 1024;

export type DiagramSource =
	| { ok: true; spec: unknown }
	| { ok: false; message: string };

export function parseDiagramSource(source: string): DiagramSource {
	if (
		source.length > MAX_DIAGRAM_SOURCE_BYTES
		|| new TextEncoder().encode(source).byteLength > MAX_DIAGRAM_SOURCE_BYTES
	) {
		return { ok: false, message: "Diagram source is too large (64 KiB maximum)." };
	}
	try {
		return { ok: true, spec: JSON.parse(source) as unknown };
	} catch {
		return { ok: false, message: "Diagram source must be valid JSON." };
	}
}
