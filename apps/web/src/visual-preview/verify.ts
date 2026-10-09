import type { VisualDecision } from "@chopin/protocol";

export type Descriptor = {
	version: 1;
	origin: string;
	artifact: { ref: string; digest: string };
	definitionRevision: string;
	bundle: { url: string; bytes: number; sha256: string; csp: string };
};

export class PreviewUnavailable extends Error {}

function keys(value: object) {
	return Object.keys(value).sort().join(",");
}

export function descriptorValid(
	value: unknown,
	definition: VisualDecision.Definition,
): value is Descriptor {
	if (!value || typeof value !== "object") return false;
	let descriptor = value as Descriptor;
	try {
		if (
			keys(descriptor) !== "artifact,bundle,definitionRevision,origin,version"
			|| descriptor.version !== 1
			|| descriptor.definitionRevision !== definition.definitionRevision
			|| keys(descriptor.artifact) !== "digest,ref"
			|| descriptor.artifact.ref !== definition.artifact.ref
			|| descriptor.artifact.digest !== definition.artifact.digest
			|| !/^sha256:[0-9a-f]{64}$/.test(descriptor.artifact.digest)
			|| keys(descriptor.bundle) !== "bytes,csp,sha256,url"
			|| descriptor.bundle.sha256 !== descriptor.artifact.digest.slice(7)
			|| !Number.isInteger(descriptor.bundle.bytes)
			|| descriptor.bundle.bytes < 1 || descriptor.bundle.bytes > 3_000_000
			|| typeof descriptor.bundle.csp !== "string"
			|| descriptor.bundle.csp.length < 1 || descriptor.bundle.csp.length > 4096
		) return false;
		let origin = new URL(descriptor.origin);
		let url = new URL(descriptor.bundle.url);
		return origin.origin === descriptor.origin && !origin.username && !origin.password
			&& url.origin === descriptor.origin && !url.username && !url.password
			&& !url.search && !url.hash && url.pathname.startsWith("/bundles/")
			&& descriptor.origin !== location.origin;
	} catch {
		return false;
	}
}

export async function verifiedPreview(
	channelId: string,
	decisionId: string,
	definition: VisualDecision.Definition,
	signal: AbortSignal,
) {
	let path = `/api/channels/${encodeURIComponent(channelId)}/visual-preview/${
		encodeURIComponent(decisionId)
	}`;
	let response = await fetch(path, { signal, redirect: "error" });
	if (response.status === 404 || response.status === 503) {
		throw new PreviewUnavailable("Preview is unavailable");
	}
	if (!response.ok) throw new Error("Preview could not be loaded");
	let descriptor: unknown = await response.json();
	if (!descriptorValid(descriptor, definition)) {
		throw new Error("Preview definition does not match this decision");
	}
	let { bundle } = descriptor;
	let bundleResponse = await fetch(bundle.url, {
		credentials: "omit",
		signal,
		redirect: "error",
	});
	if (!bundleResponse.ok) throw new PreviewUnavailable("Preview artifact is unavailable");
	if (
		bundleResponse.headers.get("content-security-policy")
			!== `${bundle.csp}; frame-ancestors ${location.origin}`
	) throw new Error("Preview response policy changed");
	let bytes = await bundleResponse.arrayBuffer();
	if (bytes.byteLength !== bundle.bytes) throw new Error("Preview bundle length changed");
	let digest = await crypto.subtle.digest("SHA-256", bytes);
	let hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
	if (hex !== bundle.sha256) throw new Error("Preview bundle changed");
	// Navigation makes a second request; the resolver must serve immutable bytes at this URL.
	return bundle.url;
}
