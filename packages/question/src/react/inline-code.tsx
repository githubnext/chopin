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

/** Renders each item on its own so a stray backtick never pairs with the next item's. */
export function InlineCodeList(
	{ items, separator = ", " }: { items: string[]; separator?: string },
) {
	return (
		<>
			{items.map((item, index) => (
				<span key={index}>
					{index > 0 && separator}
					<InlineCode text={item} />
				</span>
			))}
		</>
	);
}
