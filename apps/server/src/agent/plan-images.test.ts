import { expect, test } from "bun:test";

import { altText, MAX_ALT_LENGTH, planImage } from "./plan-images";
import { documentTools } from "./tools";
import { PLANNER_TOOL_NAMES } from "../harness/tool-names";

import type { DocumentRoom } from "./tools";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

test("the image tool is a Planner tool, and a background job never gets it", () => {
	expect(PLANNER_TOOL_NAMES).toContain("upload_plan_image");
	expect(Object.keys(documentTools)).toContain("upload_plan_image");
});

test("alt text is one line that cannot end its image early", () => {
	expect(altText("  A [diagram]\nof \\ the\tflow  ")).toBe("A \\[diagram\\] of \\\\ the flow");
});

test("planImage accepts exactly data, mimeType and alt, and checks the bytes", () => {
	let good = { data: base64(PNG), mimeType: "image/png", alt: "A boundary" };
	expect(planImage(good, "doc")).toEqual({ bytes: PNG, mimeType: "image/png", alt: "A boundary" });
	for (
		let [input, message] of [
			[{ ...good, alt: "   " }, "alt is required"],
			[{ ...good, alt: "x".repeat(MAX_ALT_LENGTH + 1) }, "alt exceeds"],
			[{ ...good, extra: 1 }, "takes exactly"],
			[{ data: good.data, mimeType: good.mimeType }, "takes exactly"],
			[{ ...good, mimeType: "image/svg+xml" }, "Only PNG, JPEG, WebP and GIF"],
			[{ ...good, mimeType: "image/jpeg" }, "not the image type"],
			[{ ...good, data: "not base64!" }, "standard base64"],
			[{ ...good, data: base64(new Uint8Array(1_048_577).fill(1)) }, "larger than 1 MiB"],
			["text", "must be an object"],
		] as const
	) {
		expect(() => planImage(input, "doc")).toThrow(message);
	}
});

async function run(room: Partial<DocumentRoom>, input: unknown) {
	let output = await documentTools.upload_plan_image.execute!(input as never, {
		context: { room: { id: "doc", plan: {}, ...room } },
		toolCallId: "call",
		messages: [],
	} as never);
	let text = String(output);
	return text.startsWith("Error: ") ? text : JSON.parse(text);
}

test("upload_plan_image stores through the room and returns the Markdown to use", async () => {
	let stored: Array<{ bytes: Uint8Array; mimeType: string }> = [];
	let result = await run({
		uploadImage: async image => {
			stored.push(image);
			return { path: `/images/${"a".repeat(64)}.png` };
		},
	}, { data: base64(PNG), mimeType: "image/png", alt: "Write-through: write, cache, database" });
	expect(stored).toEqual([{ bytes: PNG, mimeType: "image/png" }]);
	expect(result).toEqual({
		path: `/images/${"a".repeat(64)}.png`,
		markdown: `![Write-through: write, cache, database](/images/${"a".repeat(64)}.png)`,
	});
});

test("upload_plan_image is refused where the session cannot store images, and for bad input", async () => {
	let input = { data: base64(PNG), mimeType: "image/png", alt: "Boundary" };
	expect(await run({}, input)).toBe("Error: images cannot be stored in this session");
	let stored = 0;
	let room = { uploadImage: async () => (stored++, { path: "/images/x.png" }) };
	expect(await run(room, { ...input, alt: "" })).toStartWith("Error: alt is required");
	expect(stored).toBe(0);
});
