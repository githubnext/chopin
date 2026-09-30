import { useId, useRef, useState } from "react";

import { NavigationDialog } from "./navigation-dialog";
import { canManageProject } from "./navigation-model";
import { TerminalAlert } from "./terminal-alert";

import type * as Api from "./api";
import type { NavigationDialogMotion } from "./navigation-dialog";
import type { DocumentCreationPhase } from "./use-document-creation";

export function NewDocumentDialog(
	{ projects, pending, error, motion, onCreate, onAddProject, onDismiss, onRetry }: {
		projects: Api.NavigationProject[];
		pending: ReadonlyMap<string, DocumentCreationPhase>;
		error?: string;
		motion: NavigationDialogMotion;
		onCreate: (project: Api.NavigationProject) => void;
		onAddProject: () => void;
		onDismiss: () => void;
		onRetry?: () => void;
	},
) {
	let input = useRef<HTMLInputElement>(null);
	let searchId = useId();
	let [query, setQuery] = useState("");
	let eligible = projects.filter(project => project.available && canManageProject(project))
		.sort((first, second) => first.position - second.position);
	let normalized = query.trim().toLocaleLowerCase();
	let visible = eligible.filter(project =>
		`${project.repositoryOwner}/${project.repositoryName}`.toLocaleLowerCase().includes(normalized)
	);
	return (
		<NavigationDialog
			initialFocus={eligible.length > 0 ? input : undefined}
			motion={motion}
			onDismiss={onDismiss}
			title="New document"
		>
			{error && (
				<TerminalAlert className="mt-4 text-sm text-destructive-ink">
					{error}
					{onRetry && (
						<button className="btn btn-sm btn-secondary ml-2" onClick={onRetry} type="button">
							Try again
						</button>
					)}
				</TerminalAlert>
			)}
			{eligible.length > 0
				? (
					<>
						<p className="mt-4 text-sm text-text-tertiary">
							Choose a project for your new document.
						</p>
						<label className="sr-only" htmlFor={searchId}>Search projects</label>
						<input
							className="field mt-3 h-9 w-full px-3 text-sm"
							id={searchId}
							onChange={event => setQuery(event.target.value)}
							placeholder="Search projects"
							ref={input}
							value={query}
						/>
						<div className="navigation-dialog-list">
							{visible.length === 0 && (
								<p className="text-sm text-text-tertiary">No matching projects.</p>
							)}
							{visible.map(project => {
								let phase = pending.get(project.repositoryId);
								return (
									<div key={project.repositoryId}>
										<button
											aria-busy={!!phase}
											className="navigation-dialog-option"
											disabled={!!phase}
											onClick={() => onCreate(project)}
											type="button"
										>
											<span className="min-w-0 text-left">
												<span className="block truncate text-sm font-medium">
													{project.repositoryName}
												</span>
												<span className="block truncate text-sm text-text-tertiary">
													{project.repositoryOwner}
												</span>
											</span>
											<span className="text-sm text-text-tertiary">Create document</span>
										</button>
										<div className="text-sm text-text-tertiary" role="status">
											{phase === "creating"
												? "Creating document…"
												: phase
												? "Opening document…"
												: ""}
										</div>
									</div>
								);
							})}
						</div>
					</>
				)
				: (
					<div className="mt-4 space-y-3">
						<p className="text-sm text-text-tertiary">
							{projects.length === 0
								? "Add a project to create your first document."
								: "You need write access to an available project to create a document."}
						</p>
						<button className="btn btn-md btn-primary" onClick={onAddProject} type="button">
							Add Project
						</button>
						<a
							className="block text-sm font-medium text-brand underline"
							href="/auth/github/install"
						>
							Manage repository access
						</a>
					</div>
				)}
		</NavigationDialog>
	);
}
