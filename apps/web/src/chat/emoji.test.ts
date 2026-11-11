import { expect, test } from "bun:test";

import { emojiRemarkPlugin, emojiRuns, firstEmoji, jumbo } from "./emoji";

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

test("only what draws as an emoji is an emoji: a plain © or ❤ stays text", () => {
	expect(emojiRuns("Ship it 🚀 now ❤️ ©2026 ❤")).toEqual([
		{ text: "Ship it ", emoji: false },
		{ text: "🚀", emoji: true },
		{ text: " now ", emoji: false },
		{ text: "❤️", emoji: true },
		{ text: " ©2026 ❤", emoji: false },
	]);
	expect(emojiRuns("👍🏽👨‍👩‍👧 1️⃣ 🇳🇴").filter(run => run.emoji).map(run => run.text)).toEqual([
		"👍🏽",
		"👨‍👩‍👧",
		"1️⃣",
		"🇳🇴",
	]);
	expect(emojiRuns("123 # *")).toEqual([{ text: "123 # *", emoji: false }]);
});

test("a message of nothing but emoji, up to Slack's 23, is drawn large", () => {
	expect(jumbo("🎉")).toBe(true);
	expect(jumbo(" 🎉 🚀\n✅ ")).toBe(true);
	expect(jumbo("🎉".repeat(23))).toBe(true);
	expect(jumbo("🎉".repeat(24))).toBe(false);
	expect(jumbo("🎉 yes")).toBe(false);
	expect(jumbo("©")).toBe(false);
	expect(jumbo("")).toBe(false);
});

test("the Markdown plugin wraps each emoji of the words and leaves code alone", () => {
	let tree = {
		type: "root",
		children: [{
			type: "paragraph",
			children: [
				{ type: "text", value: "Done ✅" },
				{ type: "inlineCode", value: "🚀" },
				{ type: "strong", children: [{ type: "text", value: "🎉" }] },
			],
		}],
	};
	emojiRemarkPlugin()(tree);
	expect(tree.children[0]!.children).toEqual([
		{ type: "text", value: "Done " },
		{
			type: "emoji",
			children: [{ type: "text", value: "✅" }],
			data: { hName: "span", hProperties: { className: ["chat-emoji"] } },
		},
		{ type: "inlineCode", value: "🚀" },
		{
			type: "strong",
			children: [{
				type: "emoji",
				children: [{ type: "text", value: "🎉" }],
				data: { hName: "span", hProperties: { className: ["chat-emoji"] } },
			}],
		},
	] as never);
});
