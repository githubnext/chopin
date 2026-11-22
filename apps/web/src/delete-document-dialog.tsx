import { useRef, useState } from "react";

import * as Api from "./api";
import { NavigationDialog } from "./navigation-dialog";
import { TerminalAlert } from "./terminal-alert";

import type { ReactNode } from "react";
import type { NavigationDialogMotion } from "./navigation-dialog";

/** What goes with the document, named so nobody is surprised by what a delete takes. */
function goesWith(research: readonly string[]): ReactNode {
	if (research.length === 0) return ", with its Chat and threads, its Decisions and its history.";
	let named = research.length === 1
		? (
			<>
				its research document{" "}
				<strong className="font-semibold text-text-primary">{research[0]}</strong>
			</>
		)
		: `its ${research.length} research documents`;
	return <>, with its Chat and threads, its Decisions, its history and {named}.</>;
}

/**
 * Asks before a document is deleted for good, saying what goes with it. Cancel, Escape or the
 * backdrop back out; the red button deletes it for everyone, and there is no Undo.
 */
export function DeleteDocumentDialog(
	{
		channel,
		known,
		motion,
		onDeleted,
		onDismiss,
	}: {
		channel: Api.Channel;
		/** The documents the page knows, by id, among them its research documents. */
		known?: ReadonlyMap<string, Api.Channel>;
		motion: NavigationDialogMotion;
		onDeleted: () => void;
		onDismiss: () => void;
	},
) {
	let [research] = useState(() =>
		[...known?.values() ?? []].filter(item => item.parentChannelId === channel.id)
			.map(item => item.title || "Untitled")
	);
	let cancel = useRef<HTMLButtonElement>(null);
	let [deleting, setDeleting] = useState(false);
	let [error, setError] = useState<string>();
	let dismiss = () => {
		if (!deleting) onDismiss();
	};
	let remove = async () => {
		if (deleting) return;
		setDeleting(true);
		setError(undefined);
		try {
			await Api.deleteChannel(channel.id);
			onDeleted();
		} catch (reason) {
			// Someone else deleted it meanwhile: it is gone all the same.
			if (reason instanceof Api.ApiError && reason.status === 404) {
				onDeleted();
				return;
			}
			setError(
				reason instanceof Api.ApiError
					? reason.message
					: "Couldn't delete the document. Check your connection, then try again.",
			);
			setDeleting(false);
		}
	};

	return (
		<NavigationDialog
			initialFocus={cancel}
			motion={motion}
			onDismiss={dismiss}
			title="Delete document?"
		>
			<p className="mt-2 text-sm text-text-secondary [overflow-wrap:anywhere]">
				<strong className="font-semibold text-text-primary">{channel.title || "Untitled"}</strong>
				{" "}
				is deleted for everyone{goesWith(research)} This cannot be undone.
			</p>
			{error !== undefined && (
				<TerminalAlert className="mt-3 text-sm text-destructive-ink">{error}</TerminalAlert>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<button
					className="btn btn-md btn-secondary"
					disabled={deleting}
					onClick={dismiss}
					ref={cancel}
					type="button"
				>
					Cancel
				</button>
				<button
					aria-busy={deleting || undefined}
					className="btn btn-md btn-destructive"
					disabled={deleting}
					onClick={() => void remove()}
					type="button"
				>
					{deleting ? "Deleting…" : "Delete document"}
				</button>
			</div>
		</NavigationDialog>
	);
}
