import { expect, test } from "bun:test";
import { previewResponse, visualPreviewDescriptor } from "./descriptor";
import { sha256 } from "./policy";

import type { VisualDecision } from "@chopin/protocol";

let html = '<!doctype html><style>body{margin:0}</style><script type="module">1</script>';
let bytes = new TextEncoder().encode(html);
let digest = `sha256:${sha256(bytes)}`;
let definition: VisualDecision.Definition = {
	schema: "visual-decision@1",
	title: "A generic component",
	requestId: "request-1",
	artifact: { ref: "artifact-1", digest },
	definitionRevision: `sha256:${"a".repeat(64)}`,
	controls: [{ type: "color", id: "accent", label: "Accent" }],
	baseline: { accent: "#123456" },
};

test("descriptor is unavailable until a trusted artifact resolver and origin exist", async () => {
	let prior = process.env.VISUAL_PREVIEW_ORIGIN;
	delete process.env.VISUAL_PREVIEW_ORIGIN;
	try {
		expect((await previewResponse(definition, "http://127.0.0.1:8840")).status).toBe(503);
		expect(
			await visualPreviewDescriptor(definition, "http://127.0.0.1:8840", async () => ({
				bytes,
				url: `http://localhost:8841/bundles/${digest.slice(7)}/bundle.html`,
			})),
		).toBeUndefined();
	} finally {
		if (prior === undefined) delete process.env.VISUAL_PREVIEW_ORIGIN;
		else process.env.VISUAL_PREVIEW_ORIGIN = prior;
	}
});

test("descriptor binds bytes, revision, and URL to the trusted definition", async () => {
	let prior = process.env.VISUAL_PREVIEW_ORIGIN;
	process.env.VISUAL_PREVIEW_ORIGIN = "http://localhost:8841";
	try {
		let resolve = async () => ({
			bytes,
			url: `http://localhost:8841/bundles/${digest.slice(7)}/bundle.html`,
		});
		let descriptor = await visualPreviewDescriptor(definition, "http://127.0.0.1:8840", resolve);
		expect(descriptor?.artifact).toEqual(definition.artifact);
		expect(descriptor?.definitionRevision).toBe(definition.definitionRevision);
		expect(descriptor?.bundle.sha256).toBe(digest.slice(7));
		expect((await previewResponse(definition, "http://127.0.0.1:8840", resolve)).status)
			.toBe(200);
		expect(
			(await previewResponse(definition, "http://127.0.0.1:8840", async () => ({
				bytes,
				url: "https://untrusted.test/bundle.html",
			}))).status,
		).toBe(503);
		expect(
			(await previewResponse(
				{
					...definition,
					artifact: { ...definition.artifact, digest: `sha256:${"0".repeat(64)}` },
				},
				"http://127.0.0.1:8840",
				resolve,
			)).status,
		).toBe(503);
	} finally {
		if (prior === undefined) delete process.env.VISUAL_PREVIEW_ORIGIN;
		else process.env.VISUAL_PREVIEW_ORIGIN = prior;
	}
});
