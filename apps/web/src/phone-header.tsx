/** The phone top bar: Documents on the left, a small centred title, and actions on the right. */

import { useContext, useLayoutEffect, useRef } from "react";
import { DocumentIcon, EllipsisIcon } from "@chopin/icons";

import { DocumentActionsMenu } from "./document-actions-menu";
import { DocumentRename } from "./document-rename";
import { SidebarTrigger } from "./project-sidebar-chrome";

import type { DocumentMetadata } from "./document-actions";
import type { DocumentAction } from "./document-actions-menu";
import type { TitleEdit } from "./title-edit";
import type { WorkspacePresentation } from "./workspace-model";

export function PhoneHeader(
	{
		archivedAt,
		canManage,
		editing,
		label,
		onAction,
		onEditingChange,
		onRenamed,
		presentation,
		room,
	}: {
		archivedAt?: string;
		canManage: boolean;
		editing?: TitleEdit;
		label: string;
		onAction: (action: DocumentAction) => void;
		onEditingChange: (editing?: TitleEdit) => void;
		onRenamed: (channel: DocumentMetadata) => void;
		presentation: WorkspacePresentation;
		room: string;
	},
) {
	let header = useRef<HTMLElement>(null);
	let trigger = useContext(SidebarTrigger);
	// A child room renders its document alone; the root's bar keeps the trigger while a child is open.
	let hostsTrigger = presentation.type !== "child" && trigger !== undefined;
	let claim = trigger?.claim;
	useLayoutEffect(() => hostsTrigger ? claim?.() : undefined, [claim, hostsTrigger]);

	let finishEdit = () => {
		// Naming a new document leads into writing it, unless the user already tapped elsewhere.
		if (editing === "new" && header.current?.contains(document.activeElement)) {
			header.current.closest(".workspace-root")
				?.querySelector<HTMLElement>(".plan-content[contenteditable='true']")
				?.focus();
		}
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
						ref={trigger.buttonRef}
						type="button"
					>
						<DocumentIcon aria-hidden="true" size={18} />
					</button>
				)}
			</div>
			<div className="phone-top-bar-title">
				{editing && canManage && !archivedAt
					? (
						<DocumentRename
							channel={{ id: room, title: label }}
							inline
							onCancel={finishEdit}
							replay={editing === "new"}
							onRenamed={detail => {
								onRenamed(detail.channel);
								finishEdit();
							}}
						/>
					)
					: <span className="truncate">{label}</span>}
				{archivedAt && <span className="phone-top-bar-subtitle">Archived</span>}
			</div>
			<div className="phone-top-bar-slot">
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
