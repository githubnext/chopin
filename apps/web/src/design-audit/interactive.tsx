import { useState } from "react";
import { useTransitionPresence } from "@chopin/editor/transition-presence";

import { DocumentActionsMenu } from "../document-actions-menu";
import { motionImmediately } from "../motion-input";
import { NavigationDialog } from "../navigation-dialog";
import { TerminalAlert } from "../terminal-alert";
import { AuditPlate } from "./frame";

import type { FormEvent } from "react";
import type { DocumentAction } from "../document-actions-menu";

export function InteractiveSpecimens() {
	let [title, setTitle] = useState("Design system audit");
	let [draft, setDraft] = useState(title);
	let [archived, setArchived] = useState(false);
	let [deleted, setDeleted] = useState(false);
	let [dialog, setDialog] = useState<"rename" | "delete" | undefined>();
	let [failure, setFailure] = useState(false);
	let [error, setError] = useState(false);
	let presence = useTransitionPresence(dialog, 220, motionImmediately());

	function action(value: DocumentAction) {
		if (value === "archive" || value === "restore") {
			setArchived(value === "archive");
			return;
		}
		setDraft(title);
		setError(false);
		setDialog(value);
	}

	function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!draft.trim()) return;
		if (failure) {
			setError(true);
			return;
		}
		setTitle(draft.trim());
		setDialog(undefined);
	}

	return (
		<AuditPlate
			description="Open the production menu and modal shell. Changes stay in this local specimen."
			item="interactive-document-actions"
			title="Interactive document actions"
		>
			<div className="flex flex-wrap items-center gap-3">
				<span className="text-sm font-medium">{deleted ? "Document deleted" : title}</span>
				{deleted
					? (
						<button
							className="btn btn-md btn-secondary"
							onClick={() => {
								setTitle("Design system audit");
								setArchived(false);
								setDeleted(false);
							}}
							type="button"
						>
							Reset specimen
						</button>
					)
					: (
						<DocumentActionsMenu
							channel={{
								title,
								archivedAt: archived ? "2026-09-28T00:00:00.000Z" : undefined,
							}}
							className="btn btn-md btn-secondary"
							onAction={action}
							trigger="Document actions"
						/>
					)}
				<label className="flex items-center gap-2 text-sm text-text-secondary">
					<input
						checked={failure}
						className="choice-control"
						onChange={event => setFailure(event.target.checked)}
						type="checkbox"
					/>
					Simulate save error
				</label>
			</div>
			{presence.phase !== "closed" && presence.value === "rename" && (
				<NavigationDialog
					motion={presence}
					onDismiss={() => setDialog(undefined)}
					title="Rename document"
				>
					<form className="mt-3 flex min-w-0 flex-col gap-2" onSubmit={save}>
						<label className="sr-only" htmlFor="audit-interactive-title">Document title</label>
						<input
							aria-invalid={error || undefined}
							className="field h-8 min-w-0 w-full px-2 text-sm"
							id="audit-interactive-title"
							maxLength={120}
							onChange={event => {
								setDraft(event.target.value);
								setError(false);
							}}
							value={draft}
						/>
						{error && (
							<TerminalAlert className="text-sm text-destructive-ink">
								Could not rename document.
							</TerminalAlert>
						)}
						<div className="flex justify-end gap-2">
							<button
								className="btn btn-md btn-ghost"
								onClick={() => setDialog(undefined)}
								type="button"
							>
								Cancel
							</button>
							<button className="btn btn-md btn-primary" disabled={!draft.trim()} type="submit">
								Save
							</button>
						</div>
					</form>
				</NavigationDialog>
			)}
			{presence.phase !== "closed" && presence.value === "delete" && (
				<NavigationDialog
					motion={presence}
					onDismiss={() => setDialog(undefined)}
					title="Delete document permanently?"
				>
					<p className="mt-2 text-sm text-text-secondary">
						<strong className="font-semibold text-text-primary">{title}</strong>{" "}
						will be permanently deleted. This cannot be undone.
					</p>
					<div className="mt-4 flex justify-end gap-2">
						<button
							className="btn btn-md btn-secondary"
							onClick={() => setDialog(undefined)}
							type="button"
						>
							Cancel
						</button>
						<button
							className="btn btn-md btn-destructive"
							onClick={() => {
								setDeleted(true);
								setDialog(undefined);
							}}
							type="button"
						>
							Delete permanently
						</button>
					</div>
				</NavigationDialog>
			)}
		</AuditPlate>
	);
}
