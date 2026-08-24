import { useRef, useState } from "react";

import * as Api from "./api";
import { NavigationDialog } from "./navigation-dialog";

export function DeleteDocumentDialog(
	{
		channel,
		onDeleted,
		onDismiss,
	}: {
		channel: Api.Channel;
		onDeleted: () => void;
		onDismiss: () => void;
	},
) {
	let cancel = useRef<HTMLButtonElement>(null);
	let [deleting, setDeleting] = useState(false);
	let [error, setError] = useState<unknown>();
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
			setError(reason);
			setDeleting(false);
		}
	};

	return (
		<NavigationDialog
			initialFocus={cancel}
			onDismiss={dismiss}
			title="Delete document permanently?"
		>
			<p className="mt-3 text-sm text-text-secondary">
				<strong className="font-semibold text-text-primary">{channel.title}</strong>{" "}
				and its research workspaces will be permanently deleted. This cannot be undone.
			</p>
			{error !== undefined && (
				<p className="mt-3 text-sm text-destructive-ink" role="alert">
					{error instanceof Error ? error.message : "Could not delete the document."}
				</p>
			)}
			<div className="mt-5 flex justify-end gap-2">
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
					className="btn btn-md btn-destructive"
					disabled={deleting}
					onClick={() => void remove()}
					type="button"
				>
					{deleting ? "Deleting..." : "Delete permanently"}
				</button>
			</div>
		</NavigationDialog>
	);
}
