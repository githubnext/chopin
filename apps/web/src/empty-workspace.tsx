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
				<h2
					className={`font-semibold text-text-primary ${hasProjects ? "text-sm" : "text-base"}`}
				>
					{hasProjects ? "No document open" : "Start with a repository"}
				</h2>
				<p className="max-w-[44ch] text-sm text-text-tertiary">
					{hasProjects
						? "Pick one from the sidebar or start a new one."
						: "Documents in Chopin belong to a GitHub repository, so you, your team and Chopin can write against the code."}
				</p>
				<div className="mt-3 flex items-center gap-2">
					<button
						className="btn btn-sm btn-primary"
						disabled={hasProjects && disabled}
						onClick={hasProjects ? onNewDocument : onAddProject}
						type="button"
					>
						{hasProjects ? "New document" : "Add project"}
					</button>
					{!hasProjects && (
						<a className="btn btn-sm btn-ghost" href="/auth/github/install">
							Manage repository access
						</a>
					)}
				</div>
			</div>
		</div>
	);
}
