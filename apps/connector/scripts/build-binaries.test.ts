import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { mxcExecutors, TARGETS } from "./build-binaries";

test("each release binary carries the MXC executor of its system, and Intel Macs have none", () => {
	let carried = Object.fromEntries(
		TARGETS.map(target => [
			target,
			mxcExecutors(target).map(file => `${basename(file.from)} as ${file.as}`),
		]),
	);
	expect(carried).toEqual({
		"bun-linux-x64": ["lxc-exec as mxc-executor"],
		"bun-linux-arm64": ["lxc-exec as mxc-executor"],
		"bun-darwin-x64": [],
		"bun-darwin-arm64": ["mxc-exec-mac as mxc-executor"],
		"bun-windows-x64": [
			"wxc-exec.exe as mxc-executor.exe",
			"winhttp-proxy-shim.exe as mxc-winhttp-proxy-shim.exe",
		],
	});
});

test("the files it embeds are the SDK package's own, for the architecture of the target", () => {
	for (let target of TARGETS) {
		for (let file of mxcExecutors(target)) {
			expect(existsSync(file.from)).toBe(true);
			expect(file.from).toContain(`/bin/${target.endsWith("arm64") ? "arm64" : "x64"}/`);
		}
	}
});
