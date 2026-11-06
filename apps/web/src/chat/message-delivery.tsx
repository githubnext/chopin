/** The delivery mark on a person's own message, its menu, and the line a message that failed carries. */

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ClockIcon, CloseIcon, EllipsisIcon, WarningIcon } from "@chopin/icons";

import { useMenuDismissal } from "../menu-dismissal";
import { MenuItem } from "../menu-item";
import { FAILED_LABEL, MARK_LABEL } from "./delivery";
import "./message-delivery.css";

import type { CSSProperties, KeyboardEvent } from "react";
import type { Mark } from "./delivery";

/** A clock while only this browser has the message, one tick once the server has it, two once taken. */
export function DeliveryMark({ mark }: { mark: Mark }) {
	return (
		<span
			aria-label={MARK_LABEL[mark]}
			className="chat-delivery icon-first-line"
			data-chat-delivery={mark}
			data-tooltip={MARK_LABEL[mark]}
			role="img"
		>
			{mark === "waiting"
				? <ClockIcon aria-hidden="true" size={14} />
				: (
					<>
						<CheckIcon aria-hidden="true" size={14} />
						{mark === "delivered" && <CheckIcon aria-hidden="true" size={14} />}
					</>
				)}
		</span>
	);
}

/** Taking a message back, from its own menu. It opens above or below the button, as there is room. */
export function MessageMenu({ onDelete }: { onDelete: () => void }) {
	let id = useId();
	let button = useRef<HTMLButtonElement>(null);
	let panel = useRef<HTMLDivElement>(null);
	let [open, setOpen] = useState(false);
	let [position, setPosition] = useState<CSSProperties>();
	let close = (restoreFocus = false) => {
		setOpen(false);
		setPosition(undefined);
		if (restoreFocus) button.current?.focus();
	};

	useLayoutEffect(() => {
		if (!open) return;
		let anchor = button.current?.getBoundingClientRect();
		let menu = panel.current;
		if (!anchor || !menu) return;
		let margin = 8;
		let gap = 4;
		let width = menu.offsetWidth;
		let height = menu.offsetHeight;
		let below = anchor.bottom + gap;
		let top = below + height + margin <= window.innerHeight
			? below
			: Math.max(margin, anchor.top - gap - height);
		let left = Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin));
		setPosition({ left, top, visibility: "visible" });
	}, [open]);

	useEffect(() => {
		if (position) panel.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
	}, [position]);
	useMenuDismissal(open, [button, panel], close);

	let keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Tab") return close();
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		close(true);
	};

	return (
		<span className="chat-message-menu-anchor" data-open={open || undefined}>
			<button
				aria-controls={open ? id : undefined}
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label="Message actions"
				className="btn btn-icon btn-ghost shrink-0"
				data-tooltip="Message actions"
				onClick={() => open ? close() : setOpen(true)}
				ref={button}
				type="button"
			>
				<EllipsisIcon aria-hidden="true" size={16} />
			</button>
			{open && createPortal(
				<div
					aria-label="Message actions"
					className="chat-message-menu"
					id={id}
					onKeyDownCapture={keyDown}
					ref={panel}
					role="menu"
					style={position ?? { visibility: "hidden" }}
				>
					<MenuItem
						onClick={() => {
							close();
							onDelete();
						}}
						tone="destructive"
					>
						<CloseIcon aria-hidden="true" size={16} />
						Delete
					</MenuItem>
				</div>,
				document.body,
			)}
		</span>
	);
}

/** What a message that can never be delivered as sent says on itself, with what can be done about it. */
export function FailedLine(
	{ onDelete, onRetry, reason }: { onDelete: () => void; onRetry: () => void; reason: string },
) {
	return (
		<div className="chat-message-failed" data-chat-failed="" role="status">
			<WarningIcon
				aria-hidden="true"
				className="chat-message-failed-icon icon-first-line"
				size={14}
			/>
			<p className="chat-message-failed-text">
				<span className="chat-message-failed-title">{FAILED_LABEL}.</span> {reason}
			</p>
			<div className="chat-message-failed-actions">
				<button className="btn btn-xs btn-ghost" onClick={onRetry} type="button">Try again</button>
				<button className="btn btn-xs btn-ghost" onClick={onDelete} type="button">Delete</button>
			</div>
		</div>
	);
}
