import { WorkspaceNotice } from "./workspace-notice";

export function EmptyWorkspace(
	{ disabled, hasProjects, onAddProject, onNewDocument }: {
		disabled: boolean;
		hasProjects: boolean;
		onAddProject: () => void;
		onNewDocument: () => void;
	},
) {
	return (
		<WorkspaceNotice
			actions={
				<button
					className="btn btn-sm btn-secondary"
					disabled={hasProjects && disabled}
					onClick={hasProjects ? onNewDocument : onAddProject}
					type="button"
				>
					{hasProjects ? "New document" : "Add project"}
				</button>
			}
			body={hasProjects
				? "Pick one from the sidebar or start a new one."
				: "Add a project to start your first document."}
			title="No document open"
		/>
	);
}
