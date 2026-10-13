import { useWorkspaceLayout } from "./workspace-layout";

import type { ReactNode } from "react";

/**
 * A message inside the workspace frame, so the sidebar and frame stay in place. Split has no
 * ground header, so the message rises to the sheet's top margin, as an expanded document does.
 */
export function WorkspaceNotice(
	{ actions, body, title }: { actions?: ReactNode; body?: ReactNode; title: string },
) {
	let { frame, mode } = useWorkspaceLayout();
	let split = mode === "split";
	return (
		<div
			className="workspace-root flex h-full flex-col bg-ground"
			data-document-expanded={split || undefined}
			data-hosted=""
			data-workspace-mode={mode}
		>
			{!split && <div className="room-header shrink-0" />}
			<div
				className={`workspace-frame flex min-h-0 flex-1 ${split ? "mx-3 mb-3" : "m-2"}`}
				ref={frame}
			>
				<div
					className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-1 overflow-hidden rounded-xl bg-ground px-4 text-center shadow-resting ring-hairline ${
						split ? "mt-3" : ""
					}`}
				>
					<h1 className="text-sm font-semibold text-text-primary">{title}</h1>
					{body && <p className="max-w-sm break-words text-sm text-text-tertiary">{body}</p>}
					{actions && <div className="mt-3 flex flex-wrap justify-center gap-2">{actions}</div>}
				</div>
			</div>
		</div>
	);
}
