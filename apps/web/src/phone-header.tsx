/**
 * The phone top bar: Documents on the left, a small centred title, and the document's
 * comments and actions on the right.
 */

import { useContext, useEffect, useLayoutEffect, useRef } from "react";
import { CommentIcon, DocumentsIcon, EllipsisIcon } from "@chopin/icons";
import type { ReactNode } from "react";

import { DocumentActionsMenu, loadActionSheet } from "./document-actions-menu";
import { DocumentRename } from "./document-rename";
import { loadDocumentsSheet } from "./navigation-shell";
import { SidebarTrigger } from "./project-sidebar-chrome";

import type { DocumentMetadata } from "./document-actions";
import type { DocumentAction } from "./document-actions-menu";
import type { TitleEdit } from "./title-edit";
import type { WorkspacePresentation } from "./workspace-model";

// Warmed before the first tap, so opening the sheet never waits on its code.
function prefetchDocumentsSheet() {
	void loadDocumentsSheet();
	void loadActionSheet();
}

export function PhoneHeader(
	{
		archivedAt,
		canManage,
		comments = 0,
		editing,
		editingDocument,
		label,
		onAction,
		onComments,
		onEditingChange,
		onRenamed,
		presentation,
		room,
		build,
	}: {
		archivedAt?: string;
		canManage: boolean;
		/** Open comment threads in the document; the bar offers a list of them when there are any. */
		comments?: number;
		editing?: TitleEdit;
		/** The document itself is in edit mode, which the bar says under the title. */
		editingDocument?: boolean;
		label: string;
		onAction: (action: DocumentAction) => void;
		onComments?: () => void;
		onEditingChange: (editing?: TitleEdit) => void;
		onRenamed: (channel: DocumentMetadata) => void;
		presentation: WorkspacePresentation;
		room: string;
		/** The build capsule's glyph, beside the document's actions. */
		build?: ReactNode;
	},
) {
	let header = useRef<HTMLElement>(null);
	let trigger = useContext(SidebarTrigger);
	// A child room renders its document alone; the root's bar keeps the trigger while a child is open.
	let hostsTrigger = presentation.type !== "child" && trigger !== undefined;
	let claim = trigger?.claim;
	useLayoutEffect(() => hostsTrigger ? claim?.() : undefined, [claim, hostsTrigger]);
	useEffect(() => {
		if (!hostsTrigger) return;
		let idle = window.requestIdleCallback ?? ((task: () => void) => window.setTimeout(task, 1500));
		let cancel = window.cancelIdleCallback ?? window.clearTimeout;
		let handle = idle(prefetchDocumentsSheet);
		return () => cancel(handle);
	}, [hostsTrigger]);

	// Also runs as a save starts, not after it: keys typed while the rename travels would
	// otherwise land in a field that is about to close.
	let handOff = () => {
		// Naming a new document leads into writing it, unless the user already tapped elsewhere.
		if (editing === "new" && header.current?.contains(document.activeElement)) {
			header.current.closest(".workspace-root")
				?.querySelector<HTMLElement>(".plan-content[contenteditable='true']")
				?.focus();
		}
	};
	let finishEdit = () => {
		handOff();
		onEditingChange();
	};

	return (
		<header className="room-header phone-top-bar" ref={header}>
			<div className="phone-top-bar-slot">
				{hostsTrigger && trigger && (
					<button
						aria-haspopup="dialog"
						aria-label="Documents"
						className="btn btn-icon btn-ghost"
						onClick={trigger.onExpand}
						onPointerDown={prefetchDocumentsSheet}
						ref={trigger.buttonRef}
						type="button"
					>
						<DocumentsIcon />
					</button>
				)}
			</div>
			<div className="phone-top-bar-center">
				<div className="phone-top-bar-title">
					{editing && canManage && !archivedAt
						? (
							<DocumentRename
								channel={{ id: room, title: label }}
								inline
								onCancel={finishEdit}
								// The body took focus as the save started; a refusal needs the field back.
								onErrorChange={error =>
									error !== undefined
									&& header.current?.querySelector<HTMLInputElement>(".document-title-input")
										?.focus()}
								onSavingChange={saving => saving && handOff()}
								replay={editing === "new"}
								onRenamed={detail => {
									onRenamed(detail.channel);
									finishEdit();
								}}
							/>
						)
						: <span className="truncate">{label}</span>}
					{archivedAt
						? <span className="phone-top-bar-subtitle">Archived</span>
						: editingDocument && <span className="phone-top-bar-subtitle">Editing</span>}
				</div>
				{/* The title waits for the heading to scroll away; the mode must show regardless. */}
				{editingDocument && !archivedAt && (
					<span aria-hidden="true" className="phone-top-bar-mode">Editing</span>
				)}
			</div>
			<div className="phone-top-bar-slot">
				{build}
				{comments > 0 && onComments && (
					<button
						aria-haspopup="dialog"
						aria-label={comments === 1 ? "1 open comment" : `${comments} open comments`}
						className="phone-top-bar-comments btn btn-md btn-ghost"
						data-phone-comments=""
						onClick={onComments}
						type="button"
					>
						<CommentIcon aria-hidden="true" size={18} />
						<span aria-hidden="true">{comments}</span>
					</button>
				)}
				{canManage && (
					<DocumentActionsMenu
						channel={{ archivedAt, title: label }}
						className="btn btn-icon btn-ghost"
						onAction={action => action === "rename" ? onEditingChange("rename") : onAction(action)}
						trigger={<EllipsisIcon aria-hidden="true" size={18} />}
					/>
				)}
			</div>
		</header>
	);
}
