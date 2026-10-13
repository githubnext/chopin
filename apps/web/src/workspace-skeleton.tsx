/**
 * The desktop loading shape: the workspace's panes and bars where the loaded workspace puts them,
 * so nothing moves when it arrives. It is in the initial bundle, so CSS does the layout:
 * a container query picks split or compact and sizes Chat as `workspaceSizing` does (see
 * phone-skeleton.css). `workspace-skeleton.e2e.ts` holds it to the loaded geometry. Phones use
 * `PhoneSkeleton`.
 */

import { PhoneSkeletonPage } from "./phone-skeleton";

import type { CSSProperties } from "react";

/** The root workspace's saved Chat choice and width, under the keys `workspace.tsx` writes. */
function savedChat(): { closed: boolean; width?: string } {
	try {
		let width = Number(localStorage.getItem("chopin:pane:chat"));
		return {
			closed: localStorage.getItem("chopin:pane:chat:choice") === "false",
			width: Number.isFinite(width) && width > 0 ? `${width}px` : undefined,
		};
	} catch {
		return { closed: false };
	}
}

export function WorkspaceSkeleton({ label }: { label: string }) {
	let chat = savedChat();
	return (
		<div
			className="workspace-skeleton"
			data-chat={chat.closed ? "closed" : undefined}
			style={{ "--saved-chat-width": chat.width } as CSSProperties}
		>
			<p className="sr-only" role="status">{label}</p>
			<div aria-hidden="true" className="room-header" />
			<div aria-hidden="true" className="workspace-skeleton-tabs">
				<span />
				<span />
				<span />
				<span />
			</div>
			<div aria-hidden="true" className="workspace-skeleton-frame">
				<div className="workspace-skeleton-chat" />
				<div className="workspace-skeleton-sheet">
					<div className="workspace-skeleton-title">
						<span />
					</div>
					<div className="workspace-skeleton-views">
						<span />
						<span />
						<span />
					</div>
					<div className="workspace-skeleton-page">
						<PhoneSkeletonPage />
					</div>
				</div>
			</div>
		</div>
	);
}
