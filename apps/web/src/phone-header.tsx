/**
 * The phone top bar: Documents on the left, the title over a line naming the project and the
 * build, and the people here, comments and actions on the right. An open child takes the bar:
 * Back on the left, and the child room renders its own title and trailing controls into it.
 */

import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Face } from "@chopin/editor/face";
import { personName } from "@chopin/editor/people";
import { ArrowLeftIcon, CommentIcon, DocumentsIcon, EllipsisIcon } from "@chopin/icons";
import type { ReactNode } from "react";

import { DocumentActionsMenu, loadActionSheet } from "./document-actions-menu";
import { DocumentRename } from "./document-rename";
import { loadDocumentsSheet } from "./navigation-shell";
import { peopleHere } from "./presence";
import { SidebarTrigger } from "./project-sidebar-chrome";

import type { Session } from "@chopin/protocol";
import type { DocumentMetadata } from "./document-actions";
import type { DocumentAction } from "./document-actions-menu";
import type { MachineChoice } from "./machine-choice";
import type { TitleEdit } from "./title-edit";
import type { WorkspacePresentation } from "./workspace-model";

/**
 * What a second face can give back to a centred title: its width less the overlap, from each
 * side, since the bar keeps its sides equal while it can.
 */
const FACE_ROOM = 28;

// Warmed before the first tap, so opening the sheet never waits on its code.
function prefetchDocumentsSheet() {
	void loadDocumentsSheet();
	void loadActionSheet();
}

/** The phone bar's own room: its title, subtitle and trailing controls. */
type PhoneHeaderDocument = {
	archivedAt?: string;
	/** The person's machine choice for this document, offered as Machine in the actions sheet. */
	machine?: MachineChoice;
	canManage: boolean;
	/** Open comment threads in the document; the bar offers a list of them when there are any. */
	comments?: number;
	editing?: TitleEdit;
	/** The document itself is in edit mode, which the subtitle says in place of the build. */
	editingDocument?: boolean;
	label: string;
	members: Session.Member[];
	onAction: (action: DocumentAction) => void;
	onComments?: () => void;
	onEditingChange: (editing?: TitleEdit) => void;
	onRenamed: (channel: DocumentMetadata) => void;
	room: string;
	/** What the subtitle says after its lead: the build's status. Editing or Archived replace it. */
	context?: ReactNode;
	/** The subtitle's lead, which always shows: the project, or for a child, where it sits. */
	lead?: string;
};

export function PhoneHeader(
	{ child, children, label, presentation }: {
		/** An open child holds the bar: Back returns to this document, the slot takes the child's own. */
		child?: { onReturn: () => void; slot: (element: HTMLElement | null) => void };
		/** This document's title and controls, shown while no child holds the bar. */
		children: ReactNode;
		label: string;
		presentation: WorkspacePresentation;
	},
) {
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

	return (
		<header className="room-header phone-top-bar" data-phone-child={child ? "" : undefined}>
			<div className="phone-top-bar-slot">
				{child
					? (
						<button
							aria-label={`Back to ${label}`}
							className="btn btn-icon btn-ghost"
							onClick={child.onReturn}
							type="button"
						>
							<ArrowLeftIcon aria-hidden="true" size={18} />
						</button>
					)
					: hostsTrigger && trigger && (
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
			{child ? <div className="contents" ref={child.slot} /> : children}
		</header>
	);
}

/**
 * A document's title, subtitle and trailing controls in the phone bar. An open child renders its
 * own into the parent's bar, with its parent as the subtitle.
 */
export function PhoneHeaderContent(
	{
		archivedAt,
		canManage,
		comments = 0,
		context,
		editing,
		editingDocument,
		label,
		machine,
		members,
		onAction,
		onComments,
		onEditingChange,
		onRenamed,
		lead,
		room,
	}: PhoneHeaderDocument,
) {
	let center = useRef<HTMLDivElement>(null);
	// Also runs as a save starts, not after it: keys typed while the rename travels would
	// otherwise land in a field that is about to close.
	let handOff = () => {
		// Naming a new document leads into writing it, unless the user already tapped elsewhere.
		if (editing === "new" && center.current?.contains(document.activeElement)) {
			center.current.closest(".workspace-root")
				?.querySelector<HTMLElement>(".plan-content[contenteditable='true']")
				?.focus();
		}
	};
	let finishEdit = () => {
		handOff();
		onEditingChange();
	};
	let status = archivedAt
		? <span>Archived</span>
		: editingDocument
		? <span className="phone-top-bar-mode">Editing</span>
		: context;
	let people = peopleHere(members);
	// A title that needs room takes it from the faces first: one face, and the rest counted.
	let [oneFace, setOneFace] = useState(false);
	let crowd = people.length > 1;
	useLayoutEffect(() => {
		let title = center.current?.querySelector<HTMLElement>(".phone-top-bar-title > .truncate");
		if (!title || !crowd) {
			setOneFace(false);
			return;
		}
		// Back to two only once the title would still fit beside them, so it never flickers.
		let measure = () =>
			setOneFace(one => title.scrollWidth > title.clientWidth - (one ? FACE_ROOM : 0));
		measure();
		let observer = new ResizeObserver(measure);
		observer.observe(title);
		return () => observer.disconnect();
	}, [crowd, editing, label]);
	let shown = oneFace ? 1 : 2;

	return (
		<>
			<div className="phone-top-bar-center" ref={center}>
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
									&& center.current?.querySelector<HTMLInputElement>(".document-title-input")
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
				</div>
				{(lead || status) && (
					<div className="phone-top-bar-subtitle">
						{lead && <span className="phone-top-bar-lead truncate">{lead}</span>}
						{status}
					</div>
				)}
			</div>
			<div className="phone-top-bar-slot">
				{people.length > 0 && (
					<div
						aria-label={`People here: ${people.map(personName).join(", ")}`}
						className="phone-top-bar-people"
						data-one-face={oneFace || undefined}
						role="group"
					>
						{people.slice(0, shown).map(handle => (
							<Face
								handle={handle}
								key={handle.toLowerCase()}
								ring="page"
								size={20}
								textSize="2xs"
								titled={false}
							/>
						))}
						{people.length > shown && (
							<span aria-hidden="true" className="phone-top-bar-more">
								+{people.length - shown}
							</span>
						)}
					</div>
				)}
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
						openDocument
						channel={{ archivedAt, title: label }}
						machine={machine}
						className="btn btn-icon btn-ghost"
						onAction={action => action === "rename" ? onEditingChange("rename") : onAction(action)}
						trigger={<EllipsisIcon aria-hidden="true" size={18} />}
					/>
				)}
			</div>
		</>
	);
}
