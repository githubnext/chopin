import { describe, expect, it } from "bun:test";

import { repositoryTools } from "./repository";

describe("hosted repository tools", () => {
	it("binds every read to one repository and filters search results", async () => {
		let urls: URL[] = [];
		let tools = repositoryTools({
			fetch: async input => {
				let url = new URL(String(input));
				urls.push(url);
				if (url.pathname.includes("/contents/")) {
					return Response.json({
						type: "file",
						encoding: "base64",
						content: Buffer.from("one\ntwo").toString("base64"),
					});
				}
				if (url.pathname.includes("/git/trees/")) {
					return Response.json({
						tree: [{ path: "src/a.ts", type: "blob", size: 10 }],
						truncated: false,
					});
				}
				if (url.pathname === "/search/code") {
					return Response.json({
						items: [
							{ path: "src/a.ts", html_url: "url", repository: { node_id: "R_repo" } },
							{ path: "secret", repository: { node_id: "R_other" } },
						],
					});
				}
				return Response.json([{
					sha: "abc",
					commit: { message: "change", author: { name: "Mona", date: "today" } },
				}]);
			},
		});
		let context = {
			repository: { id: "R_repo", owner: "octo-org", name: "score", defaultBranch: "main" },
			owner: { currentToken: () => "ghu_owner" },
		};
		let call = (name: keyof typeof tools, input: unknown) =>
			tools[name].execute!(input, { context, toolCallId: "call", messages: [] });

		expect(await call("read_repository_file", { path: "src/a.ts" })).toContain("1: one");
		expect(await call("list_repository_tree", {})).toContain("src/a.ts");
		let searched = await call("search_repository", { terms: "symbol" });
		expect(searched).toContain("src/a.ts");
		expect(searched).not.toContain("secret");
		expect(await call("repository_history", {})).toContain("change");
		expect(
			urls.filter(url => url.pathname !== "/search/code").every(url =>
				url.pathname.startsWith("/repos/octo-org/score/")
			),
		).toBe(true);
		expect(urls.find(url => url.pathname === "/search/code")!.searchParams.get("q"))
			.toContain("repo:octo-org/score");
	});

	it("reads repository and owner from each call's toolsContext", async () => {
		let requests: Array<{ url: URL; authorization: string | null }> = [];
		let tool = repositoryTools({
			fetch: async (input, init) => {
				requests.push({
					url: new URL(String(input)),
					authorization: new Headers(init?.headers).get("authorization"),
				});
				return Response.json({ tree: [], truncated: false });
			},
		}).list_repository_tree;
		for (let [owner, name, token] of [["first", "repo-a", "one"], ["second", "repo-b", "two"]]) {
			await tool.execute!({ owner: "forged", repo: "forged" }, {
				context: {
					repository: { id: name!, owner: owner!, name: name!, defaultBranch: "main" },
					owner: { currentToken: () => token },
				},
				toolCallId: "call",
				messages: [],
			});
		}
		expect(requests.map(({ url }) => url.pathname)).toEqual([
			"/repos/first/repo-a/git/trees/main",
			"/repos/second/repo-b/git/trees/main",
		]);
		expect(requests.map(({ authorization }) => authorization)).toEqual([
			"Bearer one",
			"Bearer two",
		]);
	});

	it("refuses paths that can escape the repository", async () => {
		let tools = repositoryTools({
			fetch: async () => Response.json({}),
		});
		let result = await tools.read_repository_file.execute!({ path: "../secret" }, {
			context: {
				repository: { id: "R", owner: "o", name: "r", defaultBranch: "main" },
				owner: { currentToken: () => "token" },
			},
			toolCallId: "call",
			messages: [],
		});
		expect(result).toContain("relative repository path");
	});

	it("resolves authorization again when a repository handler starts", async () => {
		let token: string | undefined = "ghu_current";
		let requests = 0;
		let tools = repositoryTools({
			fetch: async (_input, init) => {
				requests++;
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ghu_current");
				return Response.json({ tree: [], truncated: false });
			},
		});
		let tree = tools.list_repository_tree;
		let context = {
			repository: { id: "R", owner: "o", name: "r", defaultBranch: "main" },
			owner: { currentToken: () => token },
		};
		expect(await tree.execute!({}, { context, toolCallId: "call", messages: [] })).not.toContain(
			"Error:",
		);
		token = undefined;
		expect(await tree.execute!({}, { context, toolCallId: "call", messages: [] })).toContain(
			"authorization expired",
		);
		expect(requests).toBe(1);
	});
});
