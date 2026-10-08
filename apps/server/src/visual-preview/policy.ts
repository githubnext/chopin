import { createHash } from "node:crypto";

export type PreviewManifest = {
	version: 1;
	bundle: { bytes: number; sha256: string };
	specimen: "decision-card-v1";
	baseline: { optionPadding: 6; selectedColor: "#E1ECEF" };
	csp: string;
};

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

export function verifyBundle(value: unknown, bytes: Uint8Array): PreviewManifest {
	if (!value || typeof value !== "object") throw new Error("Invalid preview manifest");
	let manifest = value as PreviewManifest;
	if (
		Object.keys(manifest).sort().join(",") !== "baseline,bundle,csp,specimen,version"
		|| manifest.version !== 1 || manifest.specimen !== "decision-card-v1"
		|| !manifest.bundle || Object.keys(manifest.bundle).sort().join(",") !== "bytes,sha256"
		|| manifest.bundle.bytes !== bytes.byteLength || bytes.byteLength > 3_000_000
		|| manifest.bundle.sha256 !== sha256(bytes)
		|| !manifest.baseline || Object.keys(manifest.baseline).sort().join(",") !== "optionPadding,selectedColor"
		|| manifest.baseline.optionPadding !== 6 || manifest.baseline.selectedColor !== "#E1ECEF"
	) throw new Error("Preview manifest does not match immutable bundle");
	let html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	if (manifest.csp !== bundlePolicy(html)) throw new Error("Preview CSP does not match bundle");
	return manifest;
}

export function previewHeaders(manifest: PreviewManifest, appOrigin: string) {
	return {
		"content-security-policy": `${manifest.csp}; frame-ancestors ${appOrigin}`,
		"cache-control": "no-store",
		"access-control-allow-origin": appOrigin,
		"access-control-expose-headers": "content-security-policy",
		"cross-origin-resource-policy": "cross-origin",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
	};
}
