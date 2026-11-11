/**
 * Asks for a link's address over the composer, as Slack's message box does for ⌘K and its Link
 * button: the address of the link the caret is in, to change or remove, or an empty field for the
 * words chosen. Enter saves, Escape returns to the draft as it was.
 */

import { useEffect, useId, useRef, useState } from "react";

/** What a person types as an address, with `https://` before a bare host. */
export function linkAddress(typed: string): string {
	let address = typed.trim();
	if (!address || /^[a-z][a-z\d+.-]*:/i.test(address) || /^[/#?]/.test(address)) return address;
	return `https://${address}`;
}

export function LinkForm(
	{ address, onDone, onDismiss }: {
		address: string;
		/** The address to link to, `null` to remove the link, or `undefined` to leave it as it was. */
		onDone: (url: string | null | undefined) => void;
		/** Focus went elsewhere, which keeps it. */
		onDismiss: () => void;
	},
) {
	let [value, setValue] = useState(address);
	let field = useRef<HTMLInputElement>(null);
	let id = useId();
	useEffect(() => {
		field.current?.focus();
		field.current?.select();
	}, []);
	return (
		<form
			aria-label="Link"
			className="composer-link absolute inset-x-2.5 bottom-full z-30 mb-1 menu-surface"
			data-chat-link-form=""
			onSubmit={event => {
				event.preventDefault();
				let url = linkAddress(value);
				onDone(url || (address ? null : undefined));
			}}
		>
			<label className="composer-link-label" htmlFor={id}>Link</label>
			<input
				className="field composer-link-field"
				id={id}
				onBlur={event => {
					// Leaving the form for anything but its own buttons leaves the draft as it was.
					if (!event.currentTarget.form?.contains(event.relatedTarget as Node | null)) {
						onDismiss();
					}
				}}
				onChange={event => setValue(event.currentTarget.value)}
				onKeyDown={event => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					event.stopPropagation();
					onDone(undefined);
				}}
				placeholder="https://"
				ref={field}
				type="text"
				inputMode="url"
				value={value}
			/>
			{address && (
				<button
					className="btn btn-sm btn-ghost"
					onClick={() => onDone(null)}
					type="button"
				>
					Remove
				</button>
			)}
			<button className="btn btn-sm btn-primary" type="submit">Save</button>
		</form>
	);
}
