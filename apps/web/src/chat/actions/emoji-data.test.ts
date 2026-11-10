import { expect, test } from "bun:test";

import { buildGroups, fullyQualified, loadEmoji, searchEmoji, shownAt } from "./emoji-data";

let everything = async () => await loadEmoji();
let all = (groups: Awaited<ReturnType<typeof everything>>) =>
	groups.flatMap(group => group.entries.map(entry => entry.emoji));

test("the catalog is Unicode's own list: every emoji, each once, with a name", async () => {
	let groups = await loadEmoji();
	let emoji = all(groups);
	expect(emoji.length).toBeGreaterThan(1900);
	expect(new Set(emoji).size).toBe(emoji.length);
	expect(groups.every(group => group.entries.every(entry => entry.name && entry.words))).toBe(true);
	for (
		let sample of [
			"✅",
			"❓",
			"👎",
			"👍",
			"🎉",
			"🪼",
			"🫠",
			"🧑‍💻",
			"👩‍👩‍👧‍👦",
			"🏳️‍🌈",
			"🇳🇴",
			"🏴󠁧󠁢󠁥󠁮󠁧󠁿",
			"#️⃣",
			"❤️‍🔥",
		]
	) {
		expect(emoji, sample).toContain(sample);
	}
});

test("a search by name finds an uncommon emoji and a sequence of several code points whole", async () => {
	let groups = await loadEmoji();
	expect(searchEmoji("jellyfish", groups).map(item => item.emoji)).toEqual(["🪼"]);
	let family = searchEmoji("family woman woman girl boy", groups).map(item => item.emoji);
	expect(family).toContain("👩‍👩‍👧‍👦");
	expect([...family[0]!].length).toBeGreaterThan(1);
	expect(searchEmoji("rainbow flag", groups).map(item => item.emoji)).toContain("🏳️‍🌈");
	expect(searchEmoji("norway", groups).map(item => item.emoji)).toContain("🇳🇴");
	expect(searchEmoji("zzzzzz", groups)).toEqual([]);
});

test("search matches every word, in any case, and keywords as well as names", async () => {
	let groups = await loadEmoji();
	expect(searchEmoji("THUMBS DOWN", groups).map(item => item.emoji)).toEqual([
		"👎",
	]);
	expect(searchEmoji("thumbs down", groups).map(item => item.emoji)).not.toContain(
		"👍",
	);
	expect(searchEmoji("lol", groups).length).toBeGreaterThan(0);
	expect(searchEmoji("  ", groups)).toHaveLength(all(groups).length);
});

test("skin tones: the setting picks one of five, and searching reaches every variant", async () => {
	let groups = await loadEmoji();
	let wave = groups.flatMap(group => group.entries).find(entry => entry.emoji === "👋")!;
	expect(wave.tones).toHaveLength(5);
	expect(shownAt(wave, 0).emoji).toBe("👋");
	expect(shownAt(wave, 3).emoji).toBe("👋🏽");
	let plain = groups.flatMap(group => group.entries).find(entry => entry.emoji === "🎉")!;
	expect(shownAt(plain, 4).emoji).toBe("🎉");

	let found = searchEmoji("waving hand medium skin tone", groups).map(item => item.emoji);
	expect(found).toContain("👋🏽");
	let handshake = searchEmoji("handshake medium-dark skin tone medium-light", groups).map(item =>
		item.emoji
	);
	expect(handshake.length).toBeGreaterThan(0);
});

test("a short list builds into groups in Unicode's order and drops the empty ones", () => {
	let groups = buildGroups([
		{ unicode: "😀", label: "grinning face", group: 0, tags: ["smile"] },
		{ unicode: "🇦", label: "regional indicator A" },
	]);
	expect(groups.map(group => group.label)).toEqual(["Smileys and emotion", "Flags"]);
	expect(groups[0]!.entries[0]).toMatchObject({ emoji: "😀", name: "grinning face" });
});

test("the catalog spells an emoji as Unicode's fully-qualified form, so a picked one is the quick reaction's own string", async () => {
	let emoji = all(await loadEmoji());
	for (let quick of ["✅", "❓", "👎", "👍"]) expect(emoji, quick).toContain(quick);
	expect(emoji).toContain("❤\uFE0F");
	expect(emoji).not.toContain("👎\uFE0F");
	expect(fullyQualified("👎\uFE0F")).toBe("👎");
	expect(fullyQualified("❤\uFE0F")).toBe("❤\uFE0F");
	expect(fullyQualified("🏳\uFE0F\u200D🌈")).toBe("🏳\uFE0F\u200D🌈");
	expect(fullyQualified("👍🏽")).toBe("👍🏽");
});
