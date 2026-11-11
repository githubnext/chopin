import { describe, expect, it } from "bun:test";

import { fixture } from "../images/raster.test-fixtures";
import { handler, TOOLS } from "../mcp";

import type { DocumentReader, UploadImage, UploadImageInput } from "../mcp";

let url = "/documents/githubnext/chopin/release-readiness";
let png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function base64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

function call(arguments_: Record<string, unknown>): Request {
	return new Request("https://chopin.test/mcp", {
		method: "POST",
		headers: { authorization: "Bearer allowed", "content-type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "upload_image", arguments: arguments_ },
		}),
	});
}

function reader(): DocumentReader<string> {
	return {
		async list() {
			return [];
		},
		async read() {
			return undefined;
		},
	};
}

async function result(response: Response) {
	let body = await response.json() as {
		result?: { content?: unknown; structuredContent: unknown; isError?: boolean };
		error?: { code: number };
	};
	return body;
}

function setup(outcome: Awaited<ReturnType<UploadImage<string>["upload"]>> = {
	kind: "uploaded",
	path: `/images/${"a".repeat(64)}.png`,
}) {
	let received: Array<{ caller: string; input: UploadImageInput }> = [];
	let upload: UploadImage<string> = {
		async upload(caller, input) {
			received.push({ caller, input });
			return outcome;
		},
	};
	return { received, mcp: handler({ caller: () => "octocat", documents: reader(), upload }) };
}

async function listed(mcp: ReturnType<typeof handler>): Promise<string[]> {
	let response = await mcp(
		new Request("https://chopin.test/mcp", {
			method: "POST",
			headers: { authorization: "Bearer allowed" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		}),
	);
	let body = await response.json() as { result: { tools: Array<{ name: string }> } };
	return body.result.tools.map(tool => tool.name);
}

describe("the MCP upload_image protocol", () => {
	it("offers the tool only when the host can store images", async () => {
		expect(await listed(setup().mcp)).toContain("upload_image");
		expect(await listed(handler({ caller: () => "octocat", documents: reader() }))).not
			.toContain("upload_image");
		let schema = TOOLS.find(tool => tool.name === "upload_image")!;
		expect(schema.inputSchema).toMatchObject({
			required: ["id", "data", "mimeType"],
			additionalProperties: false,
			properties: {
				mimeType: { enum: ["image/png", "image/jpeg", "image/webp", "image/gif"] },
			},
		});
	});

	it("returns the hosted path and Markdown for a valid image", async () => {
		let { mcp, received } = setup();
		let response = await result(
			await mcp(call({ id: url, data: base64(png), mimeType: "image/png" })),
		);
		let path = `/images/${"a".repeat(64)}.png`;
		expect(response.result).toEqual({
			content: [{ type: "text", text: JSON.stringify({ path, markdown: `![](${path})` }) }],
			structuredContent: { path, markdown: `![](${path})` },
		});
		expect(received).toEqual([{
			caller: "octocat",
			input: { id: url, mimeType: "image/png", bytes: png },
		}]);
	});

	it("accepts each allowed signature and refuses a mismatched one", async () => {
		let signatures: Array<[string, number[]]> = [
			["image/jpeg", [0xff, 0xd8, 0xff, 0xe0]],
			["image/webp", [0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]],
			["image/gif", [...new TextEncoder().encode("GIF87a")]],
			["image/gif", [...new TextEncoder().encode("GIF89a")]],
		];
		for (let [mimeType, bytes] of signatures) {
			let { mcp, received } = setup();
			let response = await result(
				await mcp(call({ id: url, data: base64(new Uint8Array(bytes)), mimeType })),
			);
			expect(response.result?.isError).toBeUndefined();
			expect(received).toHaveLength(1);
		}

		for (
			let [mimeType, bytes] of [
				["image/png", [0xff, 0xd8, 0xff, 0xe0]],
				["image/jpeg", [...png]],
				["image/webp", [0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]],
				["image/gif", [...new TextEncoder().encode("GIF88a")]],
				["image/png", []],
			] as Array<[string, number[]]>
		) {
			let { mcp, received } = setup();
			let response = await result(
				await mcp(call({ id: url, data: base64(new Uint8Array(bytes)), mimeType })),
			);
			expect(response.result).toMatchObject({
				structuredContent: { code: "signature-mismatch" },
				isError: true,
			});
			expect(received).toEqual([]);
		}
	});

	it("refuses SVG and other types before storing", async () => {
		let { mcp, received } = setup();
		let svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
		for (let mimeType of ["image/svg+xml", "text/html", "image/avif"]) {
			let response = await result(await mcp(call({ id: url, data: base64(svg), mimeType })));
			expect(response.result).toMatchObject({
				structuredContent: { code: "unsupported-type" },
				isError: true,
			});
		}

		let largest = new Uint8Array(1_048_576);
		largest.set(png);
		let accepted = await result(
			await mcp(call({ id: url, data: base64(largest), mimeType: "image/png" })),
		);
		expect(accepted.result?.isError).toBeUndefined();
		expect(received).toHaveLength(1);
	});

	it("stores an image over 1 MiB as a smaller copy, and refuses only one it cannot read", async () => {
		let { mcp, received } = setup();
		let photo = await new Bun.Image(fixture("option-write-back.png")).resize(2000, 1500).png({
			compressionLevel: 0,
		}).bytes();
		expect(photo.byteLength).toBeGreaterThan(1_048_576);
		let stored = await result(
			await mcp(call({ id: url, data: base64(photo), mimeType: "image/png" })),
		);
		expect(stored.error).toBeUndefined();
		expect(stored.result?.isError).toBeUndefined();
		expect(received).toHaveLength(1);
		let kept = received[0]!.input;
		expect(kept.mimeType).toBe("image/webp");
		expect(kept.bytes.byteLength).toBeLessThanOrEqual(1_048_576);
		let { width, height } = await new Bun.Image(kept.bytes).metadata();
		expect(width / height).toBeCloseTo(4 / 3, 1);

		let unreadable = new Uint8Array(1_048_577);
		unreadable.set(png);
		let refused = await result(
			await mcp(call({ id: url, data: base64(unreadable), mimeType: "image/png" })),
		);
		expect(refused.result).toMatchObject({
			structuredContent: { code: "too-large" },
			isError: true,
		});
		expect(received).toHaveLength(1);
	});

	it("rejects malformed arguments as invalid parameters", async () => {
		let { mcp, received } = setup();
		for (
			let arguments_ of [
				{ id: url, data: base64(png) },
				{ id: " ", data: base64(png), mimeType: "image/png" },
				{ id: url, data: "not base64!", mimeType: "image/png" },
				{ id: url, data: base64(png), mimeType: "image/png", extra: true },
				{ id: url, data: 7, mimeType: "image/png" },
			]
		) {
			expect(await result(await mcp(call(arguments_)))).toMatchObject({ error: { code: -32602 } });
		}
		expect(received).toEqual([]);
	});

	it("maps document refusals to the shared codes", async () => {
		for (
			let [kind, code] of [
				["forbidden", "repository-forbidden"],
				["unavailable", "document-unavailable"],
				["archived", "document-archived"],
			] as const
		) {
			let { mcp } = setup({ kind });
			let response = await result(
				await mcp(call({ id: url, data: base64(png), mimeType: "image/png" })),
			);
			expect(response.result).toMatchObject({ structuredContent: { code }, isError: true });
		}
	});
});
