import { verifyBundle } from "./policy";
import { previewOrigin } from "./site";

import type { VisualDecision } from "@chopin/protocol";

export type TrustedPreviewArtifact = { bytes: Uint8Array; url: string };
export type TrustedPreviewResolver = (
	ref: string,
) => Promise<TrustedPreviewArtifact | undefined>;

export async function visualPreviewDescriptor(
	definition: VisualDecision.Definition,
	appOrigin: string,
	resolve?: TrustedPreviewResolver,
) {
	let origin = previewOrigin(appOrigin);
	if (!origin || !resolve) return;
	let artifact = await resolve(definition.artifact.ref);
	if (!artifact) return;
	let url = new URL(artifact.url);
	if (
		url.origin !== origin || url.username || url.password
		|| url.search || url.hash || !url.pathname.startsWith("/bundles/")
	) throw new Error("Preview artifact URL is outside the trusted preview origin");
	let bundle = verifyBundle(artifact.bytes, definition.artifact.digest);
	return {
		version: 1 as const,
		origin,
		artifact: { ...definition.artifact },
		definitionRevision: definition.definitionRevision,
		bundle: { url: url.href, ...bundle },
	};
}

export async function previewResponse(
	definition: VisualDecision.Definition,
	appOrigin: string,
	resolve?: TrustedPreviewResolver,
) {
	try {
		let descriptor = await visualPreviewDescriptor(definition, appOrigin, resolve);
		if (!descriptor) {
			return Response.json({ error: "Preview is unavailable" }, { status: 503 });
		}
		return Response.json(descriptor, { headers: { "cache-control": "no-store" } });
	} catch {
		return Response.json({ error: "Preview could not be verified" }, { status: 503 });
	}
}

export function previewFramePolicy(appOrigin: string) {
	let origin = previewOrigin(appOrigin);
	return `frame-src ${origin ?? "'none'"}; object-src 'none'; base-uri 'self'`;
}
