import type { VisualDecision } from "@chopin/protocol";

export type Manifest = {
	version: 1;
	specimen: "decision-card-v1";
	bundle: { bytes: number; sha256: string };
	baseline: { optionPadding: 6; selectedColor: "#E1ECEF" };
	csp: string;
};
export type Descriptor = { origin: string; manifest: Manifest };

export function descriptorValid(
	value: unknown,
	definition: VisualDecision.Definition,
): value is Descriptor {
	if (!value || typeof value !== "object") return false;
	let descriptor = value as Descriptor;
	try {
		let origin = new URL(descriptor.origin);
		if (origin.origin !== descriptor.origin || origin.username || origin.password) return false;
		let manifest = descriptor.manifest;
		return Object.keys(descriptor).sort().join(",") === "manifest,origin"
			&& Object.keys(manifest).sort().join(",") === "baseline,bundle,csp,specimen,version"
			&& manifest.version === 1 && manifest.specimen === "decision-card-v1"
			&& /^[0-9a-f]{64}$/.test(manifest.bundle.sha256)
			&& definition.bundleDigest === `sha256:${manifest.bundle.sha256}`
			&& Number.isInteger(manifest.bundle.bytes) && manifest.bundle.bytes > 0
			&& manifest.bundle.bytes <= 3_000_000
			&& Object.keys(manifest.bundle).sort().join(",") === "bytes,sha256"
			&& Object.keys(manifest.baseline).sort().join(",") === "optionPadding,selectedColor"
			&& manifest.baseline.optionPadding === definition.baseline.optionPadding
			&& manifest.baseline.selectedColor === definition.baseline.selectedColor
			&& typeof manifest.csp === "string" && manifest.csp.length < 4096;
	} catch {
		return false;
	}
}

export async function verifiedPreview(definition: VisualDecision.Definition, signal: AbortSignal) {
	let response = await fetch("/api/visual-preview", { signal, redirect: "error" });
	if (!response.ok) throw new Error("Preview is not available");
	let descriptor: unknown = await response.json();
	if (!descriptorValid(descriptor, definition)) {
		throw new Error("Preview definition does not match this decision");
	}
	let { manifest, origin } = descriptor;
	let path = `${origin}/bundles/${manifest.bundle.sha256}/`;
	let options = { credentials: "omit" as const, signal, redirect: "error" as const };
	let [manifestResponse, bundleResponse] = await Promise.all([
		fetch(`${path}manifest.json`, options),
		fetch(`${path}bundle.html`, options),
	]);
	if (!manifestResponse.ok || !bundleResponse.ok) throw new Error("Preview could not be verified");
	if (
		bundleResponse.headers.get("content-security-policy")
			!== `${manifest.csp}; frame-ancestors ${location.origin}`
	) {
		throw new Error("Preview response policy changed");
	}
	let remote: unknown = await manifestResponse.json();
	if (
		!descriptorValid({ origin, manifest: remote }, definition)
		|| JSON.stringify(remote) !== JSON.stringify(manifest)
	) throw new Error("Preview manifest changed");
	let bytes = await bundleResponse.arrayBuffer();
	if (bytes.byteLength !== manifest.bundle.bytes) throw new Error("Preview bundle length changed");
	let digest = await crypto.subtle.digest("SHA-256", bytes);
	let hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
	if (hex !== manifest.bundle.sha256) throw new Error("Preview bundle changed");
	// HTML navigation has no SRI: the trusted immutable server and reviewed ingress
	// must serve these same bytes and CSP for the iframe's separate request.
	return `${path}bundle.html`;
}
