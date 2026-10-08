import { expect, test } from "bun:test";
import { bundlePolicy, previewHeaders, sha256, verifyBundle } from "./policy";
import type { PreviewManifest } from "./policy";

let html =
	'<!doctype html><style>body{margin:0}</style><script type="module">console.log("fixture")</script>';
let bytes = new TextEncoder().encode(html);
let manifest: PreviewManifest = {
	version: 1,
	specimen: "decision-card-v1",
	bundle: { bytes: bytes.byteLength, sha256: sha256(bytes) },
	baseline: { optionPadding: 6, selectedColor: "#E1ECEF" },
	csp: bundlePolicy(html),
};

test("the immutable bundle and exact hash policy must match the manifest", () => {
	expect(verifyBundle(manifest, bytes)).toEqual(manifest);
	expect(() => verifyBundle(manifest, new TextEncoder().encode(`${html} `))).toThrow();
	expect(() => verifyBundle({ ...manifest, csp: "default-src *" }, bytes)).toThrow();
	expect(() =>
		verifyBundle(
			{ ...manifest, bundle: { ...manifest.bundle, url: "https://untrusted.test" } },
			bytes,
		)
	).toThrow();
	expect(() =>
		verifyBundle({ ...manifest, baseline: { ...manifest.baseline, optionPadding: 8 } }, bytes)
	).toThrow();
});

test("preview responses permit only the configured ancestor and no network capabilities", () => {
	let headers = new Headers(previewHeaders(verifyBundle(manifest, bytes), "https://chopin.test"));
	let csp = headers.get("content-security-policy")!;
	for (
		let directive of [
			"connect-src 'none'",
			"img-src data:",
			"sandbox allow-scripts",
			"frame-ancestors https://chopin.test",
			"frame-src 'none'",
			"form-action 'none'",
		]
	) expect(csp).toContain(directive);
	expect(csp).not.toContain("unsafe-inline");
	expect(csp).not.toContain("allow-same-origin");
	expect(headers.has("set-cookie")).toBe(false);
	expect(headers.get("access-control-allow-origin")).toBe("https://chopin.test");
	expect(headers.has("access-control-allow-credentials")).toBe(false);
});
