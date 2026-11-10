import { expect, test } from "bun:test";

import { firstEmoji } from "./emoji";

test("any emoji typed or pasted is taken whole, exactly as written", () => {
	expect(firstEmoji("🎉")).toBe("🎉");
	expect(firstEmoji("  🎉 party")).toBe("🎉");
	expect(firstEmoji("👍🏽")).toBe("👍🏽");
	expect(firstEmoji("👨‍👩‍👧‍👦 family")).toBe("👨‍👩‍👧‍👦");
	expect(firstEmoji("🇳🇴")).toBe("🇳🇴");
	expect(firstEmoji("1️⃣")).toBe("1️⃣");
	expect(firstEmoji("❤️")).toBe("❤️");
	expect(firstEmoji("a🙌b")).toBe("🙌");
	expect(firstEmoji("plain words")).toBeUndefined();
	expect(firstEmoji("123")).toBeUndefined();
	expect(firstEmoji("")).toBeUndefined();
});

test("what is typed or pasted keeps every code point, a variation selector included", () => {
	expect(firstEmoji("👎\uFE0F")).toBe("👎\uFE0F");
	expect(firstEmoji("👎")).toBe("👎");
	expect(firstEmoji("❤")).toBe("❤");
	expect(firstEmoji("❤\uFE0F")).toBe("❤\uFE0F");
	expect(firstEmoji("🏳\uFE0F\u200D🌈")).toBe("🏳\uFE0F\u200D🌈");
	expect(firstEmoji("🏳\u200D🌈")).toBe("🏳\u200D🌈");
	expect(firstEmoji("👍🏽")).toBe("👍🏽");
	expect(firstEmoji("👍\u{1F3FD}")).toBe("👍🏽");
});
