import { useLayoutEffect, useRef } from "react";
import type { Model } from "@chopin/draft";
import type { ResearchDraftController } from "./research-draft-controller";

/** Adjust a selection for a remote splice; local input already has the new selection. */
export function researchCaret(before: string, after: string, position: number): number {
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	let end = before.length;
	let nextEnd = after.length;
	while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) {
		end--;
		nextEnd--;
	}
	return position <= start ? position : position >= end ? position + nextEnd - end : nextEnd;
}

export function ResearchBriefEditor(
	{ controller, text, readOnly }: {
		controller: ResearchDraftController;
		text: string;
		readOnly: boolean;
	},
) {
	let input = useRef<HTMLTextAreaElement>(null);
	let displayed = useRef<Model | undefined>(controller.base());
	let composition = useRef<Model | undefined>(undefined);
	useLayoutEffect(() => {
		let field = input.current;
		if (!field || composition.current) return;
		let focused = document.activeElement === field;
		let start = researchCaret(field.value, text, field.selectionStart);
		let end = researchCaret(field.value, text, field.selectionEnd);
		field.value = text;
		if (focused) field.setSelectionRange(start, end);
		displayed.current = controller.base();
	}, [controller, text]);
	useLayoutEffect(() => {
		input.current?.focus({ preventScroll: true });
	}, []);
	return (
		<textarea
			aria-label="Research brief"
			className="w-full resize-y rounded-md bg-page p-2 text-sm text-text-primary ring-hairline"
			defaultValue={text}
			maxLength={2048}
			readOnly={readOnly}
			ref={input}
			rows={5}
			onFocus={() => controller.focus(true)}
			onBlur={() => controller.focus(false)}
			onChange={event => {
				if (composition.current) return;
				controller.change(event.currentTarget.value, displayed.current);
				displayed.current = controller.base();
			}}
			onCompositionStart={() => {
				composition.current = displayed.current;
			}}
			onCompositionEnd={event => {
				controller.change(event.currentTarget.value, composition.current);
				composition.current = undefined;
				displayed.current = controller.base();
				event.currentTarget.value = controller.get().text;
			}}
		/>
	);
}
