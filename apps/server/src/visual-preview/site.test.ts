import { expect, test } from "bun:test";
import { previewOrigin } from "./site";

test("preview is disabled by default and local development uses separate cookie hosts", () => {
	expect(previewOrigin("http://127.0.0.1:8840", "")).toBeUndefined();
	expect(previewOrigin("http://127.0.0.1:8840", "http://localhost:8841")).toBe(
		"http://localhost:8841",
	);
	expect(() => previewOrigin("http://127.0.0.1:8840", "http://127.0.0.1:8841"))
		.toThrow();
});

test("hosted preview requires HTTPS on a distinct credential-free registrable site", () => {
	expect(() => previewOrigin("https://app.example.co.uk", "https://preview.example.co.uk", "1"))
		.toThrow();
	expect(() => previewOrigin("https://app.example.com", "https://preview.other.com", ""))
		.toThrow();
	expect(() => previewOrigin("https://app.example.com", "http://preview.other.com", "1"))
		.toThrow();
	expect(() => previewOrigin("https://app.example.com", "https://preview.other.com/path", "1"))
		.toThrow();
	expect(previewOrigin("https://app.example.com", "https://preview.other.com", "1"))
		.toBe("https://preview.other.com");
});
