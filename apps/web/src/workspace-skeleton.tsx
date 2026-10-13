/**
 * The desktop loading shape: the workspace's panes and bars where the loaded workspace puts them,
 * so nothing moves when it arrives. Its elements take the workspace's own layout classes, and
 * `workspace-skeleton.e2e.ts` holds the two to the same geometry. Phones use `PhoneSkeleton`.
 */

import { useWorkspaceLayout } from "./workspace-layout";
import {
	CHAT_CHOICE_STORAGE_KEY,
	CHAT_PANE,
	storedDesktopChat,
	workspaceSizing,
} from "./workspace-sizing";
import { PhoneSkeletonPage } from "./phone-skeleton";
import "./workspace-sizing.css";

import type { CSSProperties } from "react";

// Document, Decisions and Build; compact puts Chat beside them.
const VIEWS = 3;

/** The loaded workspace's saved Chat choice and width, read before its first paint. */
function storedChat(): { open: boolean | undefined; width: number } {
	try {
		return {
			open: storedDesktopChat(localStorage.getItem(CHAT_CHOICE_STORAGE_KEY)),
			// workspaceSizing clamps it, as it does the restored width.
			width: Number(localStorage.getItem(CHAT_PANE.storageKey)) || CHAT_PANE.initial,
		};
	} catch {
		return { open: undefined, width: CHAT_PANE.initial };
	}
}

export function WorkspaceSkeleton({ label }: { label: string }) {
	let { available, frame, mode } = useWorkspaceLayout();
	let split = mode === "split";
	let stored = storedChat();
	let chat = split && (stored.open ?? true);
	let width = workspaceSizing(available, stored.width).chat;
	return (
		<div
			className="workspace-root workspace-skeleton flex h-full flex-col overflow-hidden bg-ground"
			data-document-expanded={(split && !chat) || undefined}
			data-workspace-mode={mode}
			style={split ? { "--chat-width": `${width}px` } as CSSProperties : undefined}
		>
			<p className="sr-only" role="status">{label}</p>
			{!split && (
				<>
					<div className="room-header shrink-0" />
					<div
						aria-hidden="true"
						className="workspace-navigation workspace-skeleton-tabs hairline-b grid shrink-0 grid-cols-4 bg-ground p-1"
					>
						{Array.from(
							{ length: VIEWS + 1 },
							(_, index) => <span className="min-h-11" key={index} />,
						)}
					</div>
				</>
			)}
			<div
				aria-hidden="true"
				className={`workspace-frame relative flex min-h-0 flex-1 ${
					split
						? "mx-3 mb-3"
						: "m-2 overflow-hidden rounded-panel bg-page shadow-resting ring-hairline"
				}`}
				ref={frame}
			>
				<div className="workspace-document-stack relative flex min-w-0 flex-1">
					<div className="workspace-document-panel relative w-full min-w-0 flex-1">
						<div className="relative flex h-full flex-col overflow-hidden">
							{split && (
								<>
									<div className="workspace-skeleton-title panel-header hairline-b flex shrink-0 items-center px-(--panel-toolbar-padding-inline)">
										<span />
									</div>
									<div className="workspace-skeleton-views panel-header flex shrink-0 items-center px-(--panel-toolbar-padding-inline)">
										{Array.from({ length: VIEWS }, (_, index) => <span key={index} />)}
									</div>
								</>
							)}
							<div className="workspace-skeleton-page min-h-0 flex-1">
								<PhoneSkeletonPage />
							</div>
						</div>
					</div>
				</div>
				{chat && (
					<div className="workspace-chat-panel is-open relative flex min-w-0 flex-col overflow-hidden">
						<div className="workspace-chat-body relative min-h-0 flex-1" />
					</div>
				)}
			</div>
		</div>
	);
}
