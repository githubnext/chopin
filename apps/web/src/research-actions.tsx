import { useRef, useState } from "react";

import * as Api from "./api";
import { NavigationDialog } from "./navigation-dialog";
import { beginResearchSubmission, editResearchSubmission } from "./research-workspace-model";

import type { Research } from "@chopin/protocol";
import type { ResearchSubmission } from "./research-workspace-model";

export function NewResearchDialog(
	{
		channel,
		onCreated,
		onDismiss,
	}: {
		channel: Api.Channel;
		onCreated: (workspace: Research.WorkspaceSummary) => void;
		onDismiss: () => void;
	},
) {
	let input = useRef<HTMLTextAreaElement>(null);
	let [submission, setSubmission] = useState<ResearchSubmission>({ text: "" });
	let [creating, setCreating] = useState(false);
	let [error, setError] = useState<unknown>();

	let create = async () => {
		if (creating || !submission.text.trim()) return;
		let next = beginResearchSubmission(submission, "create");
		setSubmission(next);
		setCreating(true);
		setError(undefined);
		try {
			let created = await Api.createResearchWorkspace(
				channel.id,
				next.submittedText,
				next.requestId,
			);
			onCreated(created.workspace);
		} catch (reason) {
			setError(reason);
			setCreating(false);
		}
	};

	return (
		<NavigationDialog
			initialFocus={input}
			onDismiss={creating ? () => {} : onDismiss}
			title={`New research in ${channel.title}`}
		>
			<form
				className="mt-4"
				onSubmit={event => {
					event.preventDefault();
					void create();
				}}
			>
				<label className="text-sm font-medium" htmlFor="new-research-query">
					Research question
				</label>
				<textarea
					className="field mt-2 min-h-28 w-full resize-y p-3 text-sm"
					id="new-research-query"
					maxLength={4096}
					onChange={event =>
						setSubmission(current => editResearchSubmission(current, event.target.value))}
					ref={input}
					value={submission.text}
				/>
				<p className="mt-2 text-sm text-text-secondary">
					This creates a private draft attached to this document. No public web search occurs until
					you review and confirm the question.
				</p>
				{error !== undefined && (
					<p className="mt-3 text-sm text-destructive-ink" role="alert">
						{error instanceof Error ? error.message : "Could not create the research draft."}
					</p>
				)}
				<div className="mt-5 flex justify-end gap-2">
					<button
						className="btn btn-md btn-secondary"
						disabled={creating}
						onClick={onDismiss}
						type="button"
					>
						Cancel
					</button>
					<button
						className="btn btn-md btn-primary"
						disabled={creating || !submission.text.trim()}
						type="submit"
					>
						{creating ? "Creating..." : "Create private draft"}
					</button>
				</div>
			</form>
		</NavigationDialog>
	);
}
