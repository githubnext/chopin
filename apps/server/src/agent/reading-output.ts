/**
 * What a model reads of `read_plan` and `read_child`. Both tools return their structured view
 * as JSON; this is the same view as line-addressable text, in parts, for the model.
 */
import { documentText, NOTE_BYTES, type Notes, oneLine, type ReadRange } from "../document-reading";

import type { Block } from "../plan/edit";

type View = {
	child?: { id: string; title: string };
	document: { id: string; url: string; earlier_urls?: string[] };
	revision: number;
	source: string;
	blocks: Block[];
	comments: Array<
		{ id: string; quote: string; accepted_by?: string; actioned: boolean; comments: string[] }
	>;
	questions: Array<{ id: string; status: string; questions: string[]; answered_by?: string }>;
};

type Call = { toolName: string; input: unknown; output: unknown };

function rangeOf(input: unknown): ReadRange {
	let args = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
	let range: ReadRange = {};
	for (let key of ["offset", "limit", "column"] as const) {
		let value = args[key];
		if (Number.isSafeInteger(value) && (value as number) >= 1) range[key] = value as number;
	}
	return range;
}

function readingText(view: View, range: ReadRange, tool: string): string {
	let child = view.child;
	let notes: Notes[] = [];
	if (view.questions.length) {
		notes.push({
			title: "Decisions (their text, options and answers are in the source):",
			items: view.questions.map(item =>
				`- ${item.id}: ${item.status}${item.answered_by ? ` by ${item.answered_by}` : ""}: ${
					item.questions.join(" / ")
				}`
			),
			bytes: NOTE_BYTES.decisions,
			rest: (omitted: number) =>
				`(${omitted} more decisions are not listed here; each one, with its options and answers, is in the source.)`,
		});
	}
	if (view.comments.length) {
		notes.push({
			title: "Accepted comments:",
			items: view.comments.map(item =>
				`- ${item.id} on "${oneLine(item.quote, 80)}", ${
					item.actioned ? "actioned" : "needs action"
				}: ${item.comments.join(" / ")}`
			),
			bytes: NOTE_BYTES.comments,
			rest: (omitted: number) => `(${omitted} more accepted comments are not listed here.)`,
		});
	}
	return documentText({
		fields: [
			...child ? [["child", child.id], ["title", child.title]] as Array<[string, string]> : [],
			["document", view.document.id],
			["url", view.document.url],
			...view.document.earlier_urls
				? [["earlier urls", view.document.earlier_urls.join(", ")] as [string, string]]
				: [],
			["revision", String(view.revision)],
		],
		notes,
		source: view.source,
		blocks: view.blocks,
		next: at => `${tool} ${JSON.stringify({ ...child ? { child: child.id } : {}, ...at })}`,
		range,
	});
}

/**
 * The text a model reads for a finished `read_plan` or `read_child` call, or nothing for any
 * other result: another tool, or one of these that failed and so came back as an error text.
 */
export function readingOutput({ toolName, input, output }: Call): string | undefined {
	if (toolName !== "read_plan" && toolName !== "read_child") return;
	if (typeof output !== "string" || !output.startsWith("{")) return;
	try {
		return readingText(JSON.parse(output) as View, rangeOf(input), toolName);
	} catch (error) {
		console.error(`[agent/${toolName}] the model's reading could not be made`, error);
	}
}

/** `toModelOutput` for the two reading tools, as the AI SDK calls it. */
export function readingModelOutput(toolName: string) {
	return ({ input, output }: { input: unknown; output: unknown }) => {
		let text = readingOutput({ toolName, input, output });
		if (text !== undefined || typeof output === "string") {
			return { type: "text" as const, value: text ?? (output as string) };
		}
		return { type: "json" as const, value: output as never };
	};
}
