/**
 * What the composer's field is told and tells, whatever draws it: the draft's Markdown, its
 * references over that text, and its selection in offsets of it (`rich/rich-draft-input.tsx`).
 */

import type { HTMLAttributes } from "react";
import type { ReferenceDraft } from "./references";

export type DraftInputHandle = {
	focus: () => void;
	setSelectionRange: (start: number, end: number) => void;
	readonly selectionStart: number;
	readonly selectionEnd: number;
};
type DraftEvent = {
	currentTarget: {
		value: string;
		selectionStart: number;
		selectionEnd: number;
		references?: ReferenceDraft[];
	};
};
export type DraftInputProps =
	& Pick<
		HTMLAttributes<HTMLDivElement>,
		| "role"
		| "aria-label"
		| "aria-disabled"
		| "aria-invalid"
		| "aria-describedby"
		| "aria-autocomplete"
		| "aria-expanded"
		| "aria-controls"
		| "aria-activedescendant"
		| "onKeyDown"
		| "onBlur"
	>
	& {
		value: string;
		references: ReferenceDraft[];
		mentions: readonly string[];
		readOnly: boolean;
		placeholder: string;
		resetKey: number;
		onSubmit: () => void;
		onChange: (event: DraftEvent) => void;
		onSelect: (event: DraftEvent) => void;
		/** What is being dictated and not yet settled, drawn beside the caret and not part of the draft. */
		interim?: { at: number; text: string };
		/** Files pasted into the field: the image a screenshot copies, or files copied from a folder. */
		onFiles?: (files: File[]) => void;
	};
