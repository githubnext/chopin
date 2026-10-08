import type { ReactNode } from "react";

/** A message inside the workspace frame, so the sidebar and header stay in place. */
export function WorkspaceNotice(
	{ actions, body, title }: { actions?: ReactNode; body?: ReactNode; title: string },
) {
	return (
		<div className="flex h-full flex-col bg-ground" data-hosted="">
			<div className="room-header shrink-0" />
			<div className="m-2 flex min-h-0 flex-1 flex-col items-center justify-center gap-1 overflow-hidden rounded-xl bg-ground px-4 text-center shadow-resting ring-hairline md:mx-3 md:mb-3">
				<h1 className="text-sm font-semibold text-text-primary">{title}</h1>
				{body && <p className="max-w-sm break-words text-sm text-text-tertiary">{body}</p>}
				{actions && <div className="mt-3 flex flex-wrap justify-center gap-2">{actions}</div>}
			</div>
		</div>
	);
}
