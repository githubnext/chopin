import { expect, test } from "bun:test";

import { isApplePlatform, shortcut } from "./shortcut";

test("formats hints for the platform", () => {
	expect(shortcut("B", { apple: true })).toBe("⌘B");
	expect(shortcut("X", { apple: true, shift: true })).toBe("⌘⇧X");
	expect(shortcut("B", { apple: false })).toBe("Ctrl+B");
	expect(shortcut("X", { apple: false, shift: true })).toBe("Ctrl+Shift+X");
});

test("detects Apple platforms", () => {
	expect(isApplePlatform({ platform: "MacIntel" })).toBe(true);
	expect(isApplePlatform({ userAgentData: { platform: "macOS" }, platform: "x" })).toBe(true);
	expect(isApplePlatform({ platform: "Win32" })).toBe(false);
	expect(isApplePlatform({})).toBe(false);
});
