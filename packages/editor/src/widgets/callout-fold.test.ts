import { expect, test } from "bun:test";

import { foldOf } from "./callout-fold";

test("a callout folds only when it has more blocks than it keeps visible", () => {
	expect(foldOf({ fold: 0, blocks: 4, opened: false })).toBe("none");
	expect(foldOf({ fold: 1, blocks: 1, opened: false })).toBe("none");
	expect(foldOf({ fold: 1, blocks: 3, opened: false })).toBe("folded");
	expect(foldOf({ fold: 2, blocks: 3, opened: true })).toBe("open");
});

test("a caret in a hidden block opens the fold, one in a leading block does not", () => {
	expect(foldOf({ fold: 1, blocks: 3, opened: false, caret: 0 })).toBe("folded");
	expect(foldOf({ fold: 1, blocks: 3, opened: false, caret: 2 })).toBe("open");
});
