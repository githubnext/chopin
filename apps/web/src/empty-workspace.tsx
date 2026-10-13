import { useWorkspaceLayout } from "./workspace-layout";

export function EmptyWorkspace(
	{ disabled, hasProjects, onAddProject, onNewDocument }: {
		disabled: boolean;
		hasProjects: boolean;
		onAddProject: () => void;
		onNewDocument: () => void;
	},
) {
	let { frame, mode } = useWorkspaceLayout();
	let split = mode === "split";
	// Split has no ground header: the sheet rises to the top margin, as an expanded document does.
	return (
		<div
			className="workspace-root flex h-full flex-col bg-ground"
			data-document-expanded={split || undefined}
			data-workspace-mode={mode}
		>
			{!split && <div className="room-header shrink-0" />}
			<div
				className={`workspace-frame flex min-h-0 flex-1 ${split ? "mx-3 mb-3" : "m-2"}`}
				ref={frame}
			>
				<div
					className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-1 overflow-hidden rounded-panel bg-ground text-center ring-hairline ${
						split ? "mt-3 shadow-raised" : "shadow-resting"
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
		</div>
	);
}
