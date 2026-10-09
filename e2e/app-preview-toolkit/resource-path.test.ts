import { describe, expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { resourcePath } from "./resource-path";

for (
	let [name, paths, output] of [
		["POSIX", posix, "/tmp/preview/.built"],
		["Windows", win32, "C:\\preview\\.built"],
		["Windows UNC", win32, "\\\\server\\share\\preview\\.built"],
	] as const
) {
	describe(name, () => {
		test("resolves the entry point and ordinary nested resources", () => {
			for (
				let [pathname, expected] of [
					["/", "index.html"],
					["/index.html", "index.html"],
					["/fixture-app/index.html", "fixture-app/index.html"],
					["/assets/font.woff2", "assets/font.woff2"],
					["/assets/mark%20copy.svg", "assets/mark copy.svg"],
				]
			) {
				expect(resourcePath(output, pathname, paths)).toBe(paths.join(output, expected));
			}
		});

		test("rejects URL-encoded backslashes and traversal", () => {
			for (
				let pathname of [
					"/..%5c..%5c..%5c.env",
					"/assets%5Cmark.svg",
					"/%2e%2e%2fsecret.txt",
					"/assets/%2e%2e/secret.txt",
				]
			) {
				expect(resourcePath(output, pathname, paths)).toBeUndefined();
			}
		});

		test("rejects decoded absolute paths outside the build directory", () => {
			for (let pathname of ["/%2Foutside/secret.txt", "/%2FC:/outside/secret.txt"]) {
				expect(resourcePath(output, pathname, paths)).toBeUndefined();
			}
		});

		test("rejects malformed escapes and null bytes", () => {
			for (let pathname of ["/assets/%", "/assets/%00mark.svg"]) {
				expect(resourcePath(output, pathname, paths)).toBeUndefined();
			}
		});

		if (paths === win32) {
			test("rejects drive-relative paths, sibling prefixes and other drives", () => {
				for (
					let pathname of ["/C:../.env", "/C:/preview/.built-other/secret.txt", "/D:/secret.txt"]
				) {
					expect(resourcePath(output, pathname, paths)).toBeUndefined();
				}
			});
		}
	});
}
