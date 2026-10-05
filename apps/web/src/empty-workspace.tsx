import { DocumentIcon } from "@chopin/icons";

export function EmptyWorkspace(
	{ disabled, hasProjects, onAddProject, onNewDocument }: {
		disabled: boolean;
		hasProjects: boolean;
		onAddProject: () => void;
		onNewDocument: () => void;
	},
) {
	return (
		<div className="h-full bg-ground p-2">
			<div className="overflow-hidden rounded-[12px] bg-page shadow-resting ring-hairline flex h-full flex-col items-center justify-center gap-1 text-center">
				<DocumentIcon className="mb-1 text-text-quaternary" />
				<h2 className="text-sm font-semibold text-text-primary">No document open</h2>
				<p className="text-sm text-text-tertiary">
					{hasProjects
						? "Pick one from the sidebar or start a new one."
						: "Add a project to start your first document."}
				</p>
				<button
					className="btn btn-sm btn-secondary mt-3"
					disabled={hasProjects && disabled}
					onClick={hasProjects ? onNewDocument : onAddProject}
					type="button"
				>
					{hasProjects ? "New document" : "Add project"}
				</button>
			</div>
		</div>
	);
}
