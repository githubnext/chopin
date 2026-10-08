import { useWorkspaceLayout } from "./workspace";

export function EmptyWorkspace(
	{ disabled, hasProjects, onAddProject, onNewDocument }: {
		disabled: boolean;
		hasProjects: boolean;
		onAddProject: () => void;
		onNewDocument: () => void;
	},
) {
	let { frame, mode } = useWorkspaceLayout();
	return (
		<div className="flex h-full flex-col bg-ground" ref={frame}>
			<div className="room-header shrink-0" />
			<div
				className={`flex min-h-0 flex-1 flex-col items-center justify-center gap-1 text-center ${
					mode === "split"
						? "mx-3 mb-3 overflow-hidden rounded-[12px] bg-ground shadow-raised ring-hairline"
						: "m-2 overflow-hidden rounded-[12px] bg-ground shadow-resting ring-hairline"
				}`}
			>
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
