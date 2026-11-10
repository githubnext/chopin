/** Telling one emoji from another as typed, pasted or picked. */

let EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u;
let graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The first emoji in what a person typed or pasted, whole: a skin tone, a joined family, a flag or
 * a keycap stays one emoji, exactly as written.
 */
export function firstEmoji(text: string): string | undefined {
	for (let { segment } of graphemes.segment(text)) {
		if (EMOJI.test(segment)) return segment;
	}
	return undefined;
}
