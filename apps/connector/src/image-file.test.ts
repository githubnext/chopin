import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { imageFileArguments, MAX_IMAGE_FILE_BYTES } from "./image-file";
import { implementationBridge } from "./implementation";

type BridgeApi = Parameters<typeof implementationBridge>[0];

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let base: string;
let root: string;
beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "chopin-image-"));
	root = join(base, "worktree");
	await mkdir(join(root, "shots"), { recursive: true });
});
afterEach(() => rm(base, { recursive: true, force: true }));

test("reads an image inside the worktree as upload arguments", async () => {
	await writeFile(join(root, "shots", "a.png"), PNG);
	expect(await imageFileArguments(root, "shots/a.png")).toEqual({
		data: Buffer.from(PNG).toString("base64"),
		mimeType: "image/png",
	});
	expect((await imageFileArguments(root, join(root, "shots", "a.png"))).mimeType).toBe(
		"image/png",
	);
});

test("refuses paths outside the worktree, including through a symlink", async () => {
	await writeFile(join(base, "outside.png"), PNG);
	await symlink(join(base, "outside.png"), join(root, "link.png"));
	await expect(imageFileArguments(root, "../outside.png")).rejects.toThrow("inside this run");
	await expect(imageFileArguments(root, join(base, "outside.png"))).rejects.toThrow(
		"inside this run",
	);
	await expect(imageFileArguments(root, "link.png")).rejects.toThrow("inside this run");
	await expect(imageFileArguments(root, "missing.png")).rejects.toThrow("No file");
});

test("refuses non-images and images over 1 MiB with a smaller-screenshot hint", async () => {
	await writeFile(join(root, "notes.txt"), "hello");
	await expect(imageFileArguments(root, "notes.txt")).rejects.toThrow("PNG, JPEG or WebP");
	let large = new Uint8Array(MAX_IMAGE_FILE_BYTES + 1);
	large.set(PNG);
	await writeFile(join(root, "large.png"), large);
	await expect(imageFileArguments(root, "large.png")).rejects.toThrow("1280x800");
});

test("the spike bridge serves upload_image_file by forwarding the file's bytes", async () => {
	await writeFile(join(root, "shot.png"), PNG);
	let invoked: Array<{ name: string; args: Record<string, unknown> }> = [];
	let api = {
		tools: async () => ({
			tools: [{
				name: "upload_investigation_image",
				inputSchema: { type: "object" as const },
			}],
		}),
		invoke: async (name: string, args: Record<string, unknown> = {}) => {
			invoked.push({ name, args });
			return { content: [{ type: "text", text: JSON.stringify({ path: "/images/x.png" }) }] };
		},
	};
	let server = await implementationBridge(api as unknown as BridgeApi, root);
	let [client, transport] = InMemoryTransport.createLinkedPair();
	await server.connect(transport);
	let mcp = new Client({ name: "test", version: "1" });
	await mcp.connect(client);
	try {
		let names = (await mcp.listTools()).tools.map(tool => tool.name);
		expect(names).toEqual(["upload_investigation_image", "upload_image_file"]);
		let result = await mcp.callTool({ name: "upload_image_file", arguments: { path: "shot.png" } });
		expect(result.isError).toBeFalsy();
		expect(invoked).toEqual([{
			name: "upload_investigation_image",
			args: { data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" },
		}]);
		let refused = await mcp.callTool({
			name: "upload_image_file",
			arguments: { path: "../escape.png" },
		});
		expect(refused.isError).toBe(true);
		expect(invoked).toHaveLength(1);
	} finally {
		await mcp.close();
		await server.close();
	}
});

test("bridges without a worktree or image upload offer no local tool", async () => {
	let api = {
		tools: async () => ({
			tools: [{ name: "read_rebuild", inputSchema: { type: "object" as const } }],
		}),
		invoke: async () => ({ content: [] }),
	};
	let server = await implementationBridge(api as unknown as BridgeApi, root);
	let [client, transport] = InMemoryTransport.createLinkedPair();
	await server.connect(transport);
	let mcp = new Client({ name: "test", version: "1" });
	await mcp.connect(client);
	try {
		expect((await mcp.listTools()).tools.map(tool => tool.name)).toEqual(["read_rebuild"]);
	} finally {
		await mcp.close();
		await server.close();
	}
});
