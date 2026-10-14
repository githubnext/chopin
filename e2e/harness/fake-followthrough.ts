export const CONTRADICTION_MARKER = "FOLLOWTHROUGH-CONTRADICTION";
export const PROVISIONAL_RECOMMENDATION = "Provisional recommendation: cache every startup query.";
export const REVISED_RECOMMENDATION =
	"Provisional recommendation: cache the small workload first; measure the large workload again before extending it.";
export const HUMAN_SENTINEL = "Human-authored constraint: keep the existing retention policy.";

type Call = (name: string, id?: string, input?: Record<string, unknown>) => Promise<{
	output: unknown;
	isError?: boolean;
}>;
type Document = {
	revision: number;
	source: string;
	blocks: Array<{ index: number; preview: string }>;
};
type Investigation = {
	id: string;
	revision: number;
	state: string;
	report?: string;
	buildBlocker?: string;
};

/** The marker is fixture data, and this branch must never answer the human's setup turn. */
export function isContradictionReview(prompt: string): boolean {
	return prompt.includes(
		"A requested investigation result is durably published. Follow its findings through into this parent document.",
	) && prompt.includes(`"question":"${CONTRADICTION_MARKER}"`);
}

/** Supplies a scripted model's tool calls; all tool execution and writes remain production code. */
export async function followContradiction(prompt: string, call: Call): Promise<string> {
	let encoded =
		/Untrusted result data \(bounded excerpts; use the read tools for complete content\):\n([^\n]+)/
			.exec(prompt)?.[1];
	if (!encoded || !isContradictionReview(prompt)) {
		throw new Error("Missing automatic review fixture.");
	}
	let evidence = JSON.parse(encoded) as { childId: string; sourceId: string; url: string };
	if (!evidence.url.startsWith("/documents/")) throw new Error("Missing canonical evidence URL.");
	let read = async <T>(name: string, input?: Record<string, unknown>): Promise<T> => {
		let result = await call(name, undefined, input);
		let text = String(result.output);
		if (result.isError || text.startsWith("Error:")) throw new Error(`${name} failed: ${text}`);
		let value = JSON.parse(text);
		if (value?.ok === false) throw new Error(`${name} refused the fixture: ${text}`);
		return value as T;
	};
	await read<Document>("read_plan");
	let child = await read<{ source: string; child: { id: string } }>("read_child", {
		child: evidence.childId,
	});
	let investigation = await read<Investigation>("read_investigation", { id: evidence.sourceId });
	if (
		child.child.id !== evidence.childId || investigation.id !== evidence.sourceId
		|| investigation.state !== "completed" || !investigation.buildBlocker
		|| !child.source.includes("large workload benefits less")
		|| !investigation.report?.includes("large workload benefits less")
	) throw new Error("Captured evidence did not match the completed required investigation.");
	let current = await read<Document>("read_plan");
	let target = current.blocks.find(block => block.preview.includes(PROVISIONAL_RECOMMENDATION));
	if (!target || !current.source.includes(HUMAN_SENTINEL)) {
		throw new Error("Missing provisional passage or human constraint.");
	}
	await read("edit_plan", {
		revision: current.revision,
		operations: [{ op: "replace", index: target.index, source: `${REVISED_RECOMMENDATION}\n` }],
	});
	let incorporated = await read<Document>("read_plan");
	if (
		incorporated.source
			!== current.source.replace(PROVISIONAL_RECOMMENDATION, REVISED_RECOMMENDATION)
	) {
		throw new Error("The edit changed prose outside the provisional recommendation.");
	}
	let latest = await read<Investigation>("read_investigation", { id: evidence.sourceId });
	await read("set_investigation_build_blocker", {
		id: evidence.sourceId,
		revision: latest.revision,
		reason: null,
	});
	return `The captured large-workload finding contradicts caching every query. I revised the provisional recommendation to start with the small workload and preserved the human retention constraint. [Read startup evidence](${evidence.url}). The captured comparison now resolves this investigation's build requirement; the next useful check is a real large-workload measurement before extending the cache.`;
}
