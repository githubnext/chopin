import { useEffect, useRef, useState } from "react";

import * as Api from "./api";
import { heldTyping, holdTyping } from "./title-edit";
import { TerminalAlert } from "./terminal-alert";

import type { FormEvent, KeyboardEvent } from "react";

function message(error: unknown): string {
	if (error instanceof Api.ApiError && error.status === 409) {
		return "A document with this title already exists. Try a different title.";
	}
	return error instanceof Error ? error.message : "Could not rename document.";
}

/**
 * One server-backed title form shared by room navigation and repository rows.
 * `inline` renders only the field: Enter or blur commits, Escape reverts.
 */
export function DocumentRename(
	{
		channel,
		className = "",
		inline = false,
		onCancel,
		replay = false,
		onErrorChange,
		onRenamed,
		onSavingChange,
	}: {
		channel: Pick<Api.Channel, "id" | "title">;
		className?: string;
		inline?: boolean;
		onCancel: () => void;
		/** Takes over typing held since New document, replacing the generated name. */
		replay?: boolean;
		onErrorChange?: (error: unknown) => void;
		onRenamed: (detail: Api.ChannelDetail) => void;
		onSavingChange?: (saving: boolean) => void;
	},
) {
	let input = useRef<HTMLInputElement>(null);
	let [title, setTitle] = useState(channel.title);
	let [error, setError] = useState<unknown>();
	let [saving, setSaving] = useState(false);
	// Enter and the blur it can cause arrive before React re-renders `saving`.
	let busy = useRef(false);
	let cancelled = useRef(false);

	useEffect(() => {
		input.current?.focus();
		input.current?.select();
		// Taken in the same task as focus, so no key falls between the hold and the field.
		let held = replay ? heldTyping : undefined;
		if (replay) holdTyping(false);
		if (held?.text) setTitle(held.text);
		if (held?.enter) void save(held.text || channel.title);
	}, []);

	function report(next: unknown) {
		setError(next);
		onErrorChange?.(next);
	}

	function submit(event?: FormEvent) {
		event?.preventDefault();
		return save(title);
	}

	async function save(value: string) {
		let next = value.trim();
		if (busy.current || cancelled.current) return;
		if (inline && (!next || next === channel.title)) {
			cancelled.current = true;
			onCancel();
			return;
		}
		if (!next) return;
		busy.current = true;
		setSaving(true);
		onSavingChange?.(true);
		report(undefined);
		try {
			onRenamed(await Api.renameChannel(channel.id, next));
		} catch (reason) {
			report(reason);
			busy.current = false;
			setSaving(false);
			onSavingChange?.(false);
		}
	}

	function keyDown(event: KeyboardEvent) {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		if (saving) return;
		cancelled.current = true;
		onCancel();
	}

	if (inline) {
		return (
			<form className="document-title-form" onSubmit={submit}>
				<label className="sr-only" htmlFor={`document-title-${channel.id}`}>Document title</label>
				<input
					aria-invalid={error === undefined ? undefined : true}
					className="document-title-input"
					id={`document-title-${channel.id}`}
					maxLength={120}
					onBlur={() => {
						// Leaving a rejected title reverts it rather than repeating the failure.
						if (error === undefined) void submit();
						else if (!busy.current) {
							cancelled.current = true;
							onCancel();
						}
					}}
					onChange={event => {
						setTitle(event.target.value);
						if (error !== undefined) report(undefined);
					}}
					onKeyDown={keyDown}
					placeholder="Untitled"
					readOnly={saving}
					ref={input}
					value={title}
				/>
				{error !== undefined && (
					<TerminalAlert className="document-title-error text-sm text-destructive-ink">
						{message(error)}
					</TerminalAlert>
				)}
			</form>
		);
	}

	return (
		<form className={`flex min-w-0 flex-col gap-2 ${className}`} onSubmit={submit}>
			<label className="sr-only" htmlFor={`document-title-${channel.id}`}>Document title</label>
			<input
				aria-invalid={error === undefined ? undefined : true}
				className="field h-8 min-w-0 w-full px-2 text-sm"
				id={`document-title-${channel.id}`}
				maxLength={120}
				onChange={event => {
					setTitle(event.target.value);
					if (error !== undefined) report(undefined);
				}}
				onKeyDown={keyDown}
				ref={input}
				required
				value={title}
			/>
			{error !== undefined && (
				<TerminalAlert className="text-sm text-destructive-ink">
					{message(error)}
				</TerminalAlert>
			)}
			<div className="flex justify-end gap-2">
				<button
					className="btn btn-md btn-ghost"
					disabled={saving}
					onClick={onCancel}
					type="button"
				>
					Cancel
				</button>
				<button
					className="btn btn-md btn-primary"
					disabled={!title.trim() || saving}
					type="submit"
				>
					{saving ? "Saving..." : "Save"}
				</button>
			</div>
		</form>
	);
}
