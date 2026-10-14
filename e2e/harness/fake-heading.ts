import { documentTitleText } from "../../packages/dialect/src/title";
import { parse } from "../../packages/dialect/src/parse";

type Call = (name: string, id?: string, input?: Record<string, unknown>) => Promise<{
	output: unknown;
	isError?: boolean;
}>;

/** A deterministic topic fixture; other messages keep the current authored title. */
export async function nameDocument(prompt: string, call: Call): Promise<void> {
	let read = await call("read_plan");
	if (read.isError) throw new Error(`read_plan failed: ${String(read.output)}`);
	let document = JSON.parse(String(read.output)) as { revision: number; source: string };
	let topics = [...prompt.matchAll(/^- @[^:]+: TITLE-TOPIC: (.+)$/gm)];
	let title = topics.at(-1)?.[1] ?? documentTitleText(parse(document.source)) ?? "";
	let named = await call("draft_heading", undefined, { revision: document.revision, title });
	if (named.isError || !String(named.output).includes('"ok": true')) {
		throw new Error(`draft_heading failed: ${String(named.output)}`);
	}
}
