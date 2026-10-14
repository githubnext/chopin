import { expect, it } from "bun:test";

import { loadRoomWorkspace } from "./document-workspace-host";

it("retries a failed workspace import and shares the recovered module", async () => {
	let failure = new Error("chunk unavailable");
	let attempts = 0;
	await expect(loadRoomWorkspace(async () => {
		attempts++;
		throw failure;
	})).rejects.toBe(failure);
	let module = { RoomWorkspace: () => null } as unknown as typeof import("./room-workspace");
	let imported = () => {
		attempts++;
		return Promise.resolve(module);
	};
	expect(await loadRoomWorkspace(imported)).toBe(module);
	expect(await loadRoomWorkspace(imported)).toBe(module);
	expect(attempts).toBe(2);
});
