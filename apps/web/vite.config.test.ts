import { describe, expect, it } from "bun:test";

import { devNetwork } from "./vite.config";

describe("the Vite development network", () => {
	it("keeps ordinary development on loopback", () => {
		expect(devNetwork(undefined)).toEqual({
			host: "127.0.0.1",
			allowedHosts: [],
			hmr: { protocol: "ws", host: "127.0.0.1", clientPort: 5173 },
		});
	});

	it("keeps HMR on an isolated local development port", () => {
		expect(devNetwork(undefined, 5199)).toEqual({
			host: "127.0.0.1",
			allowedHosts: [],
			hmr: { protocol: "ws", host: "127.0.0.1", clientPort: 5199 },
		});
	});

	it("uses the exact exe.dev host for remote HMR", () => {
		expect(devNetwork("sample-vm.exe.xyz")).toEqual({
			host: "0.0.0.0",
			allowedHosts: ["sample-vm.exe.xyz"],
			hmr: { protocol: "wss", host: "sample-vm.exe.xyz", clientPort: 5173 },
		});
	});

	it("does not accept a broad or malformed host", () => {
		for (let host of [".exe.xyz", "sample-vm.exe.xyz:5173", "evil.test", "Sample.exe.xyz"]) {
			expect(() => devNetwork(host)).toThrow("one exact");
		}
	});
});
