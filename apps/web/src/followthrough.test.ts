import { afterEach, expect, test } from "bun:test";
import { updateFollowthrough } from "./followthrough";

let originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("review actions bind the parent, receipt and expected receipt revision", async () => {
	let requests: Array<{ path: string; method: string; body: unknown }> = [];
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({
				path: String(input),
				method: init!.method!,
				body: JSON.parse(String(init!.body)),
			});
			return Response.json({ id: "review/one", revision: 4, status: "pending" });
		},
		{ preconnect: originalFetch.preconnect },
	) as typeof fetch;
	let view = { id: "review/one", revision: 3, status: "failed" } as const;
	await updateFollowthrough("document/one", view, "retry");
	await updateFollowthrough("document/one", view, "dismiss");
	expect(requests).toEqual([
		{
			path: "/api/channels/document%2Fone/followthrough/review%2Fone/retry",
			method: "POST",
			body: { revision: 3 },
		},
		{
			path: "/api/channels/document%2Fone/followthrough/review%2Fone/dismiss",
			method: "POST",
			body: { revision: 3 },
		},
	]);
});
