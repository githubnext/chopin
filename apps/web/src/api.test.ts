import { afterEach, describe, expect, it } from "bun:test";

import {
	archiveChannel,
	cancelResearchRequest,
	channels,
	createResearchRequest,
	createResearchWorkspace,
	deleteChannel,
	researchRequest,
	restoreChannel,
	retryResearchRequest,
} from "./api";

let originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("document lifecycle API", () => {
	it("binds catalogue mode and uses the archive, restore, and delete contracts", async () => {
		let requests: Array<{ method: string; path: string }> = [];
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ method: init?.method ?? "GET", path: String(input) });
				return init?.method === "DELETE"
					? new Response(null, { status: 204 })
					: Response.json({});
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		await channels("octo org", "score/card", {
			cursor: "cursor:1",
			includeArchived: true,
			query: "release plan",
		});
		await channels("octo-org", "score", { includeArchived: false });
		await archiveChannel("channel/one");
		await restoreChannel("channel/one");
		await deleteChannel("channel/one");
		await createResearchWorkspace("channel/one", "Private draft", "workspace/one");
		await createResearchRequest("channel/one", "Inline request", "request/one");
		await researchRequest("channel/one", "request/one");
		await cancelResearchRequest("channel/one", "request/one");
		await retryResearchRequest("channel/one", "request/one");

		expect(requests).toEqual([{
			method: "GET",
			path:
				"/api/repositories/octo%20org/score%2Fcard/channels?cursor=cursor%3A1&query=release+plan&includeArchived=true",
		}, {
			method: "GET",
			path: "/api/repositories/octo-org/score/channels",
		}, {
			method: "POST",
			path: "/api/channels/channel%2Fone/archive",
		}, {
			method: "POST",
			path: "/api/channels/channel%2Fone/restore",
		}, {
			method: "DELETE",
			path: "/api/channels/channel%2Fone",
		}, {
			method: "POST",
			path: "/api/channels/channel%2Fone/research-workspaces",
		}, {
			method: "POST",
			path: "/api/channels/channel%2Fone/research-requests",
		}, {
			method: "GET",
			path: "/api/channels/channel%2Fone/research-requests/request%2Fone",
		}, {
			method: "POST",
			path: "/api/channels/channel%2Fone/research-requests/request%2Fone/cancel",
		}, {
			method: "POST",
			path: "/api/channels/channel%2Fone/research-requests/request%2Fone/retry",
		}]);
	});
});
