import { readFile } from "node:fs/promises";
import { verifyBundle } from "./policy";
import { previewOrigin } from "./site";

import type { PreviewManifest } from "./policy";
import type { VisualDecision } from "@chopin/protocol";

let artifact: Promise<{ manifest: PreviewManifest; bytes: Uint8Array }> | undefined;

export function visualBundle() {
	return artifact ??= (async () => {
		let directory = new URL("../../../web/preview/dist/", import.meta.url);
		let [raw, bytes] = await Promise.all([
			readFile(new URL("manifest.json", directory), "utf8"),
			readFile(new URL("bundle.html", directory)),
		]);
		let manifest = verifyBundle(JSON.parse(raw), bytes);
		return { manifest, bytes };
	})();
}

export async function visualDefinition(): Promise<VisualDecision.Definition> {
	let { manifest } = await visualBundle();
	return {
		specimen: "decision-card-v1",
		bundleDigest: `sha256:${manifest.bundle.sha256}`,
		baseline: { ...manifest.baseline },
		controls: [
			{ id: "optionPadding", type: "number", min: 4, max: 8, step: 2 },
			{ id: "selectedColor", type: "color", format: "#RRGGBB" },
		],
	};
}

export async function previewResponse(appOrigin: string) {
	let descriptor = await visualPreviewDescriptor(appOrigin);
	if (!descriptor) {
		return Response.json({ error: "Visual preview is not configured" }, { status: 503 });
	}
	return Response.json(descriptor, { headers: { "cache-control": "no-store" } });
}

export async function visualPreviewDescriptor(appOrigin: string) {
	let origin = previewOrigin(appOrigin);
	if (!origin) return;
	let { manifest } = await visualBundle();
	return { origin, manifest };
}

export function previewFramePolicy(appOrigin: string) {
	let origin = previewOrigin(appOrigin);
	return `frame-src ${origin ?? "'none'"}; object-src 'none'; base-uri 'self'`;
}
