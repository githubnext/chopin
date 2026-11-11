let EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u;
let graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function firstEmoji(text: string): string | undefined {
	for (let { segment } of graphemes.segment(text)) {
		if (EMOJI.test(segment)) return segment;
	}
	return undefined;
}

/**
 * Whether a grapheme draws as an emoji rather than as text: an emoji-presentation character, or a
 * text-default one asked for as an emoji (U+FE0F), a keycap, a flag or a skin tone. A plain © or ❤
 * written without the selector stays text, as Unicode says it should.
 */
let PRESENTED = /\p{Emoji_Presentation}|\uFE0F|\u20E3|\p{Regional_Indicator}|\p{Emoji_Modifier}/u;

export function isEmoji(grapheme: string): boolean {
	return PRESENTED.test(grapheme) && EMOJI.test(grapheme);
}

/** Text split into its runs of words and its emoji, each emoji whole. */
export function emojiRuns(text: string): { text: string; emoji: boolean }[] {
	let runs: { text: string; emoji: boolean }[] = [];
	for (let { segment } of graphemes.segment(text)) {
		let emoji = isEmoji(segment);
		let last = runs.at(-1);
		if (last && !emoji && !last.emoji) last.text += segment;
		else runs.push({ text: segment, emoji });
	}
	return runs;
}

/** Slack draws a message of only emoji, up to 23 of them, large ("jumbomoji"). */
export const JUMBO_LIMIT = 23;

export function jumbo(text: string): boolean {
	let count = 0;
	for (let { segment } of graphemes.segment(text.trim())) {
		if (/^\s+$/u.test(segment)) continue;
		if (!isEmoji(segment) || ++count > JUMBO_LIMIT) return false;
	}
	return count > 0;
}

type TextNode = { type: string; value?: string; children?: TextNode[]; data?: unknown };

/**
 * A remark plugin that puts each emoji of a message's words in a `span.chat-emoji`, so it can be
 * drawn in the emoji font at Slack's size while the words around it keep the text's. Code keeps its
 * characters as they are.
 */
export function emojiRemarkPlugin() {
	let visit = (node: TextNode) => {
		if (!node.children || node.type === "inlineCode" || node.type === "code") return;
		node.children = node.children.flatMap(child => {
			if (child.type !== "text" || !child.value) {
				visit(child);
				return [child];
			}
			let runs = emojiRuns(child.value);
			if (!runs.some(run => run.emoji)) return [child];
			return runs.map(run =>
				run.emoji
					? {
						type: "emoji",
						children: [{ type: "text", value: run.text }],
						data: { hName: "span", hProperties: { className: ["chat-emoji"] } },
					}
					: { type: "text", value: run.text }
			);
		});
	};
	return (tree: TextNode) => visit(tree);
}
