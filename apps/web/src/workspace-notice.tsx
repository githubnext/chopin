import type { ReactNode } from "react";

/**
 * A message inside the workspace frame, so the sidebar and frame stay in place. Its sheet sits
 * where the document's does: at the top margin in split, below the ground header in compact
 * (navigation.css).
 */
export function WorkspaceNotice(
	{ actions, body, title }: { actions?: ReactNode; body?: ReactNode; title: string },
) {
	return (
		<div className="workspace-notice" data-hosted="">
			<div className="room-header" />
			<div className="workspace-notice-frame">
				<div className="workspace-notice-sheet">
					<h1 className="text-sm font-semibold text-text-primary">{title}</h1>
					{body && <p className="max-w-sm break-words text-sm text-text-tertiary">{body}</p>}
					{actions && <div className="mt-3 flex flex-wrap justify-center gap-2">{actions}</div>}
				</div>
			</div>
		</div>
	);
}
