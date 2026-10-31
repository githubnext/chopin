/**
 * An option's own visual.
 *
 * A member decides by looking, so each option can carry Markdown of its own: an image the Planner
 * made for this document, a Mermaid diagram, a table or a code sketch. It sits framed under the
 * option's label and description, in the option's own column, and belongs to the option's row, so
 * choosing the option is still one click anywhere on it. The application's Markdown renderer
 * draws it, with the document's images and diagrams; a view mounted without one shows its text.
 */

import { MarkdownBlocks } from "./question-markdown";
import { plainInlineText } from "./inline-segments";

export function OptionPreview(
	{ compact = false, label, text }: {
		/** A thumbnail beside other options in a matrix: images only, small. */
		compact?: boolean;
		/** The option's label, which names the group for assistive technology. */
		label: string;
		text: string;
	},
) {
	return (
		<div
			aria-label={`Preview of ${plainInlineText(label)}`}
			className="question-preview"
			data-compact={compact ? "" : undefined}
			data-question-preview=""
			role="group"
		>
			<MarkdownBlocks place="preview" text={text} />
		</div>
	);
}
