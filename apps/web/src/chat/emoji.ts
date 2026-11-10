let EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u;
let graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function firstEmoji(text: string): string | undefined {
	for (let { segment } of graphemes.segment(text)) {
		if (EMOJI.test(segment)) return segment;
	}
	return undefined;
}
