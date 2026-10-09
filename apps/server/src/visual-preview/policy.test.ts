import { expect, test } from "bun:test";
import { bundlePolicy, previewHeaders, sha256, verifyBundle } from "./policy";

let html =
	'<!doctype html><style>body{margin:0}</style><script type="module">console.log("fixture")</script>';
let bytes = new TextEncoder().encode(html);
let digest = `sha256:${sha256(bytes)}`;

test("generic immutable bundles require exact digest and hash-only inline policy", () => {
	let bundle = verifyBundle(bytes, digest);
	expect(bundle).toEqual({ bytes: bytes.length, sha256: digest.slice(7), csp: bundlePolicy(html) });
	expect(() => verifyBundle(bytes, `sha256:${"0".repeat(64)}`)).toThrow();
	expect(() => verifyBundle(new TextEncoder().encode(`${html} `), digest)).toThrow();
	expect(() => bundlePolicy("<script src='remote.js'></script>")).toThrow();
});

test("preview responses allow only the app ancestor and no network capability", () => {
	let headers = new Headers(previewHeaders(bundlePolicy(html), "https://chopin.test"));
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
