import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createJustBashNetworkSandboxSession } from "@ai-sdk/sandbox-just-bash";
import { ulid } from "@chopin/dialect";

import { createAtomicAdapter } from "./adapter";
import { registerFullPlanner } from "./full";
import { startStubModelServer } from "./model-stub";
import { create, translate } from "../../chat/service";
import { bigPng } from "../../images/raster.test-fixtures";

import type { HostInput } from "@bastani/atomic";
import type { TextStreamPart, ToolSet } from "ai";
import type { Room } from "../../chat/service";

const MIB = 1_048_576;

let stub = startStubModelServer((prompt, prior) =>
	!prior && prompt.startsWith("draw ")
		? { kind: "tool", name: "draw_image", arguments: JSON.stringify({ path: prompt.slice(5) }) }
		: { kind: "text", text: "Drawn." }
);
afterAll(stub.stop);

type Stored = { sha256: string; mimeType: string; bytes: Uint8Array };

async function drawn(pictures: Array<{ name: string; bytes: Uint8Array }>, imageMaxBytes?: number) {
	let root = await mkdtemp(join(tmpdir(), "chopin-atomic-images-"));
	let agentDir = join(root, "agent");
	let cwd = join(root, "cwd");
	let previous = process.env.ATOMIC_CODING_AGENT_DIR;
	let harness = createAtomicAdapter({
		auth: "ai-gateway",
		model: "stub/model",
		journal: join(root, "state", "workflows.sqlite"),
		providers: {
			stub: {
				baseUrl: stub.baseUrl,
				apiKey: "stub",
				api: "openai-completions",
				models: [{
					id: "model",
					name: "Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 4096,
				}],
			},
		},
	});
	let sandbox = await createJustBashNetworkSandboxSession();
	let release: (() => void) | undefined;
	try {
		await mkdir(cwd, { recursive: true });
		await mkdir(join(agentDir, "extensions"), { recursive: true });
		await writeFile(
			join(agentDir, "extensions", "draw.ts"),
			`import { readFileSync } from "node:fs";
export default api => {
	api.registerTool({name: "draw_image", label: "Draw", description: "Draws", parameters: {type: "object", properties: {path: {type: "string"}}}, async execute(_id, params) {
		return {content: [{type: "text", text: "Drew it"}, {type: "image", data: readFileSync(params.path).toString("base64"), mimeType: "image/png", alt: params.path.split("/").pop()}], details: {}};
	}});
};`,
		);
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ chopin: { plannerTools: ["draw_image"] }, images: { autoResize: false } }),
		);
		let files = new Map<string, string>();
		for (let { name, bytes } of pictures) {
			let file = join(root, name);
			await writeFile(file, bytes);
			files.set(name, file);
		}
		process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
		let humanInput: HostInput = {
			confirm: async () => false,
			select: async () => undefined,
			input: async () => undefined,
			editor: async () => undefined,
			questionnaire: async () => ({ answers: [], cancelled: true }),
		};
		let sessionId = crypto.randomUUID();
		release = registerFullPlanner(sessionId, { cwd, humanInput });
		let agent = new HarnessAgent({
			harness,
			instructions: "Draw what is asked.",
			permissionMode: "allow-reads",
			tools: {},
			activeTools: [],
		});
		let session = await agent.createSession({ sessionId, sandboxSession: sandbox });
		try {
			let chat = create();
			let stored: Stored[] = [];
			chat.agent = { activeTools: ["draw_image"] } as never;
			chat.busy = true;
			chat.turnController = new AbortController();
			let entryId = ulid();
			chat.entries.push({
				id: entryId,
				author: { kind: "member", handle: "ana" },
				text: "Draw",
				ts: 1,
			});
			chat.turn = {
				id: "turn-1",
				handle: "ana",
				started: 1,
				startedAt: 1,
				entryOffset: 0,
				responded: false,
			};
			chat.activeRequest = {
				entryId,
				userId: "member-user",
				handle: "ana",
				text: "Draw",
				claimantSessionId: undefined,
				turnId: "turn-1",
				lifecycle: chat.lifecycle,
			};
			let context = {
				chat,
				server: { publish() {} },
				room: "doc",
				plan: {},
				config: imageMaxBytes === undefined ? {} : { imageMaxBytes },
				auth: {
					clock: () => new Date(0),
					storage: {
						channels: { get: async (id: string) => ({ id, archivedAt: null }) },
						images: { put: async (image: Stored) => void stored.push(image) },
					},
					sessions: { resolve: async () => ({ user: { id: "owner-user" } }) },
				},
				activeOwner: async () => ({ ownerSessionId: "s", release: () => {} }),
			} as unknown as Room;
			let result = await agent.stream({ session, prompt: `draw ${files.get(pictures[0]!.name)}` });
			let types: string[] = [];
			for await (let part of result.fullStream) {
				types.push(part.type);
				translate(context, part as TextStreamPart<ToolSet>);
			}
			await result.text;
			await chat.turnImages?.work;
			return { chat, stored, types };
		} finally {
			await session.destroy();
		}
	} finally {
		release?.();
		await harness.shutdown();
		await sandbox.destroy();
		if (previous === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
		else process.env.ATOMIC_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("a full Atomic Planner's image over the stored limit is stored as a smaller copy", async () => {
	let over = bigPng(MIB + 1);
	let { chat, stored, types } = await drawn([{ name: "over.png", bytes: over }], MIB);
	expect(types).toContain("tool-result");
	expect(stored).toHaveLength(1);
	expect(stored[0]!.bytes.byteLength).toBeLessThanOrEqual(MIB);
	let entry = chat.entries.find(item => item.images);
	expect(entry?.refusedImages).toBeUndefined();
	expect(entry?.images).toEqual([{
		src: `/images/${stored[0]!.sha256}.webp`,
		alt: "over.png",
		width: 40,
		height: 30,
		generated: true,
	}]);
});

test("a full Atomic Planner's image of exactly the stored limit is hosted", async () => {
	let at = bigPng(MIB);
	let { chat, stored } = await drawn([{ name: "at.png", bytes: at }], MIB);
	expect(stored.map(image => image.sha256)).toEqual([sha(at)]);
	let entry = chat.entries.find(item => item.images);
	expect(entry?.images).toEqual([{
		src: `/images/${sha(at)}.png`,
		alt: "at.png",
		width: 40,
		height: 30,
		generated: true,
	}]);
	expect(entry?.refusedImages).toBeUndefined();
});

test("a full Atomic Planner's 30 MiB image is shown under the 10 MiB default, never refused", async () => {
	let { chat, stored } = await drawn([{ name: "huge.png", bytes: bigPng(30 * MIB) }]);
	expect(stored).toHaveLength(1);
	let entry = chat.entries.find(item => item.images);
	expect(entry?.refusedImages).toBeUndefined();
	expect(entry?.images).toHaveLength(1);
});
