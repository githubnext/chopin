import { expect, test } from "bun:test";
import { previewOrigin } from "./site";

test("preview is disabled by default and loopback must use separate cookie hosts", () => {
	expect(previewOrigin("http://127.0.0.1:8788", "")).toBeUndefined();
	expect(previewOrigin("http://127.0.0.1:8788", "http://localhost:8793")).toBe("http://localhost:8793");
	expect(() => previewOrigin("http://127.0.0.1:8788", "http://127.0.0.1:8793")).toThrow();
});

test("production needs an asserted credential-free site with a distinct registrable domain", () => {
	expect(() => previewOrigin("https://app.example.co.uk", "https://preview.example.co.uk", "1")).toThrow();
	expect(() => previewOrigin("https://app.example.com", "https://preview.other.com", "")).toThrow();
	expect(() => previewOrigin("https://app.example.com", "http://preview.other.com", "1")).toThrow();
	expect(() => previewOrigin("https://app.example.com", "https://user:pass@preview.other.com", "1")).toThrow();
	expect(() => previewOrigin("https://app.example.com", "https://preview.other.com/path", "1")).toThrow();
	expect(previewOrigin("https://app.example.com", "https://preview.other.com", "1")).toBe("https://preview.other.com");
	// Hosted private suffixes define separate registrable sites too.
	expect(previewOrigin("https://one.github.io", "https://two.github.io", "1")).toBe("https://two.github.io");
});
