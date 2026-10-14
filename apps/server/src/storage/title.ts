import type { ChannelRecord, JsonValue } from "./model";

/** Finalize only the new MCP rewrite receipt with the slug reserved by this transaction. */
export function finalizeTitleReceipt(sidecar: JsonValue, channel: ChannelRecord): JsonValue {
	let state = structuredClone(sidecar) as {
		mcpUpdates?: Array<{ document: { title: string; url: string } }>;
	};
	let receipt = state?.mcpUpdates?.at(-1);
	if (!receipt) throw new Error("MCP rewrite receipt is missing");
	receipt.document.title = channel.title;
	receipt.document.url = receipt.document.url.slice(0, receipt.document.url.lastIndexOf("/") + 1)
		+ encodeURIComponent(channel.slug);
	return state as unknown as JsonValue;
}
