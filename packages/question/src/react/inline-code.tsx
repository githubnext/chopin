import { inlineSegments } from "./inline-segments";

/** Renders `code` spans as <code>; everything else is plain text. */
export function InlineCode({ text }: { text: string }) {
	return (
		<>
			{inlineSegments(text).map((segment, index) =>
				segment.code
					? <code key={index} className="inline-code">{segment.text}</code>
					: segment.text
			)}
		</>
	);
}
