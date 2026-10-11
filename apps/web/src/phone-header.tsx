/** The phone top bar: Documents on the left, a small centred title, and actions on the right. */

import { useContext, useLayoutEffect, useRef } from "react";
import { ArrowLeftIcon, EllipsisIcon } from "@chopin/icons";

import { DocumentActionsMenu } from "./document-actions-menu";
import { DocumentRename } from "./document-rename";
import { ProjectSidebarExpandButton, SidebarTrigger } from "./project-sidebar-chrome";

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
	// A child's own header is never shown: its parent's bar, with the way back, hosts the trigger.
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
	let title = presentation.type === "parent-with-child" ? presentation.childLabel : label;

	return (
		<header className="room-header phone-top-bar" ref={header}>
			<div className="phone-top-bar-slot">
				{hostsTrigger && trigger && (
					<ProjectSidebarExpandButton buttonRef={trigger.buttonRef} onExpand={trigger.onExpand} />
				)}
				{presentation.type === "parent-with-child" && (
					<button
						aria-label={`Return to ${label}`}
						className="btn btn-icon btn-ghost"
						onClick={presentation.onChildClose}
						type="button"
					>
						<ArrowLeftIcon aria-hidden="true" size={18} />
					</button>
				)}
			</div>
			<div className="phone-top-bar-title">
				{editing && canManage && !archivedAt && presentation.type !== "parent-with-child"
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
					: <span className="truncate">{title}</span>}
				{archivedAt && <span className="phone-top-bar-subtitle">Archived</span>}
			</div>
			<div className="phone-top-bar-slot">
				{canManage && presentation.type !== "parent-with-child" && (
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
