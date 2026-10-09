import { createHash } from "node:crypto";

export const MAX_BUNDLE_BYTES = 3_000_000;

export function sha256(value: string | Uint8Array, encoding: "hex" | "base64" = "hex") {
	return createHash("sha256").update(value).digest(encoding);
}

export function bundlePolicy(html: string) {
	let scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
	let styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
	if (scripts.length !== 1 || styles.length !== 1) throw new Error("Invalid preview inline assets");
	return [
		"default-src 'none'",
		`script-src 'sha256-${sha256(scripts[0]![1]!, "base64")}'`,
		`style-src 'sha256-${sha256(styles[0]![1]!, "base64")}'`,
		"style-src-attr 'none'",
		"font-src data:",
		"img-src data:",
		"connect-src 'none'",
		"frame-src 'none'",
		"worker-src 'none'",
		"object-src 'none'",
		"media-src 'none'",
		"form-action 'none'",
		"base-uri 'none'",
		"sandbox allow-scripts",
	].join("; ");
}

export function verifyBundle(bytes: Uint8Array, expectedDigest: string) {
	if (bytes.byteLength < 1 || bytes.byteLength > MAX_BUNDLE_BYTES) {
		throw new Error("Preview bundle size is invalid");
	}
	let digest = `sha256:${sha256(bytes)}`;
	if (digest !== expectedDigest) throw new Error("Preview artifact digest does not match");
	let html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	return { bytes: bytes.byteLength, sha256: digest.slice(7), csp: bundlePolicy(html) };
}

export function previewHeaders(csp: string, appOrigin: string) {
	return {
		"content-security-policy": `${csp}; frame-ancestors ${appOrigin}`,
		"cache-control": "no-store",
		"access-control-allow-origin": appOrigin,
		"access-control-expose-headers": "content-security-policy",
		"cross-origin-resource-policy": "cross-origin",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
	};
}
