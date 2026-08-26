import { useEffect, useRef, useState } from "react";

import * as Api from "./api";
import { TerminalAlert } from "./terminal-alert";

import type { FormEvent, KeyboardEvent } from "react";

function message(error: unknown): string {
	return error instanceof Error ? error.message : "Could not rename document.";
}

/** One server-backed title form shared by room navigation and repository rows. */
export function DocumentRename(
	{
		channel,
		className = "",
		onCancel,
		onErrorChange,
		onRenamed,
		onSavingChange,
	}: {
		channel: Pick<Api.Channel, "id" | "title">;
		className?: string;
		onCancel: () => void;
		onErrorChange?: (error: unknown) => void;
		onRenamed: (detail: Api.ChannelDetail) => void;
		onSavingChange?: (saving: boolean) => void;
	},
) {
	let input = useRef<HTMLInputElement>(null);
	let [title, setTitle] = useState(channel.title);
	let [error, setError] = useState<unknown>();
	let [saving, setSaving] = useState(false);

	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);

	function report(next: unknown) {
		setError(next);
		onErrorChange?.(next);
	}

	async function submit(event: FormEvent) {
		event.preventDefault();
		let next = title.trim();
		if (!next || saving) return;
		setSaving(true);
		onSavingChange?.(true);
		report(undefined);
		try {
			onRenamed(await Api.renameChannel(channel.id, next));
		} catch (reason) {
			report(reason);
			setSaving(false);
			onSavingChange?.(false);
		}
	}

	function keyDown(event: KeyboardEvent) {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		if (saving) return;
		onCancel();
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
