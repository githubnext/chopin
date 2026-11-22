import { expect, test } from "bun:test";

import { directStorageUses } from "./check-storage";

test("finds the browser's storage named in code, however it is reached", () => {
	let source = [
		"let width = localStorage.getItem('chopin:pane');",
		"window.sessionStorage.setItem(key, value);",
		"let store = globalThis['localStorage'];",
		"let kind: 'sessionStorage' = 'sessionStorage';",
		"if (typeof localStorage === 'undefined') {}",
	].join("\n");
	expect(directStorageUses(source, "example.ts")).toEqual([1, 2, 3, 4, 5]);
});

test("passes prose about storage, types and the safe helpers", () => {
	let source = [
		"// Kept in localStorage, which a browser may refuse.",
		"/** sessionStorage holds the draft across a reload. */",
		"import { safeLocalStorage, safeSessionStorage } from '@chopin/editor/browser-storage';",
		"type Kept = Pick<Storage, 'getItem'>;",
		"safeLocalStorage.setItem('chopin:pane', String(width));",
		"let draft = safeSessionStorage.getItem(key);",
	].join("\n");
	expect(directStorageUses(source, "example.tsx")).toEqual([]);
});
