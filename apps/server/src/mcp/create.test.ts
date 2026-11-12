import { describe, expect, it } from "bun:test";

import { limits } from "@chopin/dialect";

import { handler } from "../mcp";
import { isRepository, REPOSITORY_PATH } from "./create";

import type { CreateDocumentInput, DocumentReader, LinkedDocument } from "../mcp";

let document: LinkedDocument = {
	id: "f401c8d6-3717-4f1d-8473-cfdd0af894e4",
	title: "Release readiness",
	source: "# Release readiness\n",
	revision: 4,
	url: "/documents/githubnext/chopin/release-readiness",
};

let creation = {
	idempotencyKey: "create-plan-1",
	repository: "githubnext/chopin",
	baseBranch: "main",
	baseCommit: "0123456789abcdef0123456789abcdef01234567",
	title: "Ship MCP creation",
	brief: {
		goal: "Create a collaborative plan.",
		constraints: ["Keep plans editable through Chopin."],
		settledDecisions: ["Use the documented dialect."],
		openQuestions: ["Which reviewer owns the rollout?"],
		repositoryFindings: ["The plan becomes a hosted channel."],
	},
	plan: '# Draft\n\n<Callout type="note">\nCreated through MCP.\n</Callout>\n',
};

function request(body: unknown): Request {
	return new Request("https://chopin.test/mcp", {
		method: "POST",
		headers: {
			authorization: "Bearer allowed",
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

function reader(): DocumentReader<string> {
	return {
		async list() {
			return [];
		},
		async read(_caller, id) {
			return id === document.id ? document : undefined;
		},
	};
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return await response.json() as Record<string, unknown>;
}

function call(id: number, arguments_: Record<string, unknown>): Request {
	return request({
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: { name: "create_document", arguments: arguments_ },
	});
}

describe("the MCP creation protocol", () => {
	it("creates a validated canonical document through the host adapter", async () => {
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			create: {
				async create(_caller: string, input: CreateDocumentInput) {
					return {
						kind: "created" as const,
						document: {
							id: "created",
							title: input.title,
							brief: input.brief,
							source: input.plan,
							revision: 0,
							url: "/channels/created",
						},
					};
				},
			},
		});

		let result = await json(await mcp(call(5, creation)));

		expect(result.error).toBeUndefined();
		expect((result.result as { structuredContent: Record<string, unknown> }).structuredContent)
			.toMatchObject({
				id: "created",
				title: creation.title,
				brief: creation.brief,
				revision: 0,
				url: "/channels/created",
			});
		expect(
			(result.result as { structuredContent: { source: string } }).structuredContent.source,
		).toMatch(/<Callout (?=[^>]*id="[0-7][0-9A-HJKMNP-TV-Z]{25}")(?=[^>]*type="note")/);
	});

	it("returns dialect issues without asking the host to persist an invalid plan", async () => {
		let created = false;
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			create: {
				async create() {
					created = true;
					return { kind: "forbidden" as const };
				},
			},
		});

		let result = await json(await mcp(call(6, { ...creation, plan: "<Chart />\n" })));

		expect((result.result as { isError: boolean }).isError).toBe(true);
		expect(
			(result.result as { structuredContent: { issues: unknown[] } }).structuredContent.issues,
		).toEqual([expect.objectContaining({
			code: "unknown-component",
			path: "root > Chart[0]",
			offset: 0,
		})]);
		expect(created).toBe(false);
	});

	it("returns a structured issue for plan syntax that cannot be parsed", async () => {
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			create: {
				async create() {
					return { kind: "forbidden" as const };
				},
			},
		});

		let result = await json(await mcp(call(7, { ...creation, plan: "<Callout" })));

		expect((result.result as { structuredContent: { issues: unknown[] } }).structuredContent.issues)
			.toEqual([expect.objectContaining({ code: "parse", path: "root" })]);
	});

	it("allows a corrected retry with the same idempotency key after validation fails", async () => {
		let received: CreateDocumentInput[] = [];
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			create: {
				async create(_caller, input) {
					received.push(input);
					return {
						kind: "created" as const,
						document: {
							id: "created",
							title: input.title,
							brief: input.brief,
							source: input.plan,
							revision: 0,
							url: "/channels/created",
						},
					};
				},
			},
		});

		let rejected = await json(await mcp(call(8, { ...creation, plan: "<Chart />\n" })));
		expect((rejected.result as { isError: boolean }).isError).toBe(true);
		expect(
			(rejected.result as { structuredContent: { issues: unknown[] } }).structuredContent.issues,
		).toEqual([expect.objectContaining({ code: "unknown-component" })]);
		expect(received).toHaveLength(0);

		let corrected = await json(await mcp(call(9, creation)));
		expect((corrected.result as { structuredContent: unknown }).structuredContent).toMatchObject({
			id: "created",
			url: "/channels/created",
		});
		expect(received).toHaveLength(1);
		expect(received[0]!.idempotencyKey).toBe(creation.idempotencyKey);
	});

	it("reports a changed idempotent request as a tool conflict", async () => {
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			create: {
				async create() {
					return { kind: "conflict" as const };
				},
			},
		});

		let result = await json(await mcp(call(10, creation)));

		expect((result.result as { isError: boolean }).isError).toBe(true);
		expect((result.result as { structuredContent: unknown }).structuredContent).toEqual({
			code: "idempotency-conflict",
		});
	});

	it("accepts a document-creation request beyond the former read-only budget", async () => {
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			create: {
				async create(_caller, input) {
					return {
						kind: "created" as const,
						document: {
							id: "large-plan",
							title: input.title,
							brief: input.brief,
							source: input.plan,
							revision: 0,
							url: "/channels/large-plan",
						},
					};
				},
			},
		});
		let response = await mcp(call(11, {
			...creation,
			plan: `# Large\n\n${"word ".repeat(14_000)}\n`,
		}));

		expect(response.status).toBe(200);
		expect((await json(response)).error).toBeUndefined();
	});

	it("rejects a UTF-8 canonical plan beyond the source limit before creating it", async () => {
		let created = false;
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			create: {
				async create() {
					created = true;
					return { kind: "forbidden" as const };
				},
			},
		});
		let result = await json(
			await mcp(call(12, {
				...creation,
				plan: `# ${"😀".repeat(limits.MAX_SOURCE_BYTES / 4)}\n`,
			})),
		);

		expect((result.result as { isError: boolean }).isError).toBe(true);
		expect(
			(result.result as { structuredContent: { issues: unknown[] } }).structuredContent.issues,
		).toEqual([expect.objectContaining({ code: "source-too-large", path: "root" })]);
		expect(created).toBe(false);
	});

	it("replays reordered creation values and conflicts on a changed value", async () => {
		let accepted: CreateDocumentInput | undefined;
		let fingerprints: string[] = [];
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			create: {
				async create(_caller, input) {
					fingerprints.push(input.fingerprint);
					let created = {
						id: "replayed",
						title: input.title,
						brief: input.brief,
						source: input.plan,
						revision: 0,
						url: "/channels/replayed",
					};
					if (!accepted) {
						accepted = input;
						return { kind: "created" as const, document: created };
					}
					return accepted.fingerprint === input.fingerprint
						? { kind: "replayed" as const, document: created }
						: { kind: "conflict" as const };
				},
			},
		});
		let reordered = {
			plan: creation.plan,
			brief: {
				repositoryFindings: creation.brief.repositoryFindings,
				openQuestions: creation.brief.openQuestions,
				settledDecisions: creation.brief.settledDecisions,
				constraints: creation.brief.constraints,
				goal: creation.brief.goal,
			},
			title: creation.title,
			baseCommit: creation.baseCommit,
			baseBranch: creation.baseBranch,
			repository: creation.repository,
			idempotencyKey: creation.idempotencyKey,
		};

		let attempts: Array<[number, Record<string, unknown>]> = [[13, creation], [14, reordered]];
		for (let [id, arguments_] of attempts) {
			let result = await json(await mcp(call(id, arguments_)));
			expect((result.result as { structuredContent: { id: string } }).structuredContent.id)
				.toBe("replayed");
		}

		let changed = await json(await mcp(call(15, { ...creation, title: "A changed title" })));
		expect((changed.result as { isError: boolean }).isError).toBe(true);
		expect((changed.result as { structuredContent: unknown }).structuredContent).toEqual({
			code: "idempotency-conflict",
		});
		expect(fingerprints).toHaveLength(3);
		expect(fingerprints[1]).toBe(fingerprints[0]);
		expect(fingerprints[2]).not.toBe(fingerprints[0]);
	});

	it("does not advertise or dispatch creation from a read-only host", async () => {
		let mcp = handler({ caller: () => "octocat", documents: reader() });
		let tools = await json(
			await mcp(request({ jsonrpc: "2.0", id: 16, method: "tools/list" })),
		);

		expect((tools.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name))
			.toEqual(["list_documents", "read_document"]);
		let creationAttempt = await json(await mcp(call(17, creation)));
		expect(creationAttempt.error).toEqual({ code: -32601, message: "tool not found" });
	});
});

/** Every string over `alphabet` of at most `length` characters. */
function strings(alphabet: string[], length: number): string[] {
	return length === 0
		? [""]
		: ["", ...strings(alphabet, length - 1).flatMap(rest => alphabet.map(first => first + rest))];
}

describe("the repository argument", () => {
	// What the repository argument accepted before its patterns lost their lookaround.
	let before =
		/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
	let advertised = (value: string) =>
		value.length <= REPOSITORY_PATH.maxLength && new RegExp(REPOSITORY_PATH.pattern).test(value);
	let examples = [
		["githubnext/chopin", true],
		["a/b", true],
		["a-b-c/b", true],
		["-octo/b", false],
		["octo-/b", false],
		["oc--to/b", false],
		["-/b", false],
		[`${"a".repeat(38)}-b/b`, false],
		[`${"a".repeat(39)}/b`, true],
		[`${"a".repeat(19)}-${"b".repeat(19)}/b`, true],
		["octo/.", false],
		["octo/..", false],
		["octo/...", true],
		["octo/.github", true],
		["octo/..github", true],
		["octo/_", true],
		["octo/a.", true],
		[`octo/${"a".repeat(100)}`, true],
		[`octo/.${"a".repeat(99)}`, true],
		[`octo/..${"a".repeat(98)}`, true],
		[`octo/${"a".repeat(101)}`, false],
		[`octo/..${"a".repeat(99)}`, false],
		["octo/", false],
		["/chopin", false],
		["octo/chopin/x", false],
		["octo/cho pin", false],
		["octo/chopin\n", false],
	] as const;

	it("accepts exactly what it accepted with lookaround", () => {
		for (let [value, accepted] of examples) {
			expect([value, before.test(value)]).toEqual([value, accepted]);
			expect([value, isRepository(value)]).toEqual([value, accepted]);
		}
		// Every pairing of an owner over "a" and "-" up to 7 characters with a name over "a", "."
		// and "_" up to 5.
		for (let owner of strings(["a", "-"], 7)) {
			for (let name of strings(["a", ".", "_"], 5)) {
				let value = `${owner}/${name}`;
				if (isRepository(value) !== before.test(value)) expect(value).toBe("accepted as before");
			}
		}
	});

	it("advertises a schema without lookaround that only an over-long owner gets past", () => {
		expect(REPOSITORY_PATH.pattern).not.toMatch(/\(\?<?[=!]/);
		for (let [value, accepted] of examples) {
			let owner = value.split("/")[0]!;
			expect([value, advertised(value)]).toEqual([value, accepted || owner.length > 39]);
		}
		// A pattern counts at most 39 letters and digits; only hyphens take an owner past 39.
		expect(advertised(`${"a".repeat(38)}-b/b`)).toBe(true);
		expect(isRepository(`${"a".repeat(38)}-b/b`)).toBe(false);
		expect(advertised(`${"a".repeat(40)}/b`)).toBe(false);
	});
});
