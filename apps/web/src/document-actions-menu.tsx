import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import type * as Api from "./api";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

export type DocumentAction = "rename" | "archive" | "restore" | "delete";

export type DocumentMenuItem = {
	action: DocumentAction;
	label: string;
	destructive?: boolean;
};

export function documentMenuItems(channel: Pick<Api.Channel, "archivedAt">): DocumentMenuItem[] {
	return channel.archivedAt
		? [
			{ action: "restore", label: "Restore" },
			{ action: "delete", label: "Delete permanently", destructive: true },
		]
		: [
			{ action: "rename", label: "Rename" },
			{ action: "archive", label: "Archive" },
		];
}

export type DocumentMenuKeyAction = "close" | "first" | "last" | "next" | "previous";

export function documentMenuKeyAction(key: string): DocumentMenuKeyAction | undefined {
	if (key === "Escape") return "close";
	if (key === "Home") return "first";
	if (key === "End") return "last";
	if (key === "ArrowDown") return "next";
	if (key === "ArrowUp") return "previous";
	return undefined;
}

export function DocumentActionsMenu(
	{
		channel,
		className = "",
		onAction,
		trigger,
	}: {
		channel: Pick<Api.Channel, "title" | "archivedAt">;
		className?: string;
		onAction: (action: DocumentAction) => void;
		trigger: ReactNode;
	},
) {
	let id = useId();
	let button = useRef<HTMLButtonElement>(null);
	let panel = useRef<HTMLDivElement>(null);
	let initialItem = useRef(0);
	let [open, setOpen] = useState(false);
	let [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
	let items = documentMenuItems(channel);

	useLayoutEffect(() => {
		if (!open) return;
		let place = () => {
			let anchor = button.current?.getBoundingClientRect();
			let menu = panel.current;
			if (!anchor || !menu) return;
			let margin = 8;
			let gap = 4;
			let width = Math.min(208, document.documentElement.clientWidth - margin * 2);
			let height = menu.offsetHeight;
			let below = window.innerHeight - anchor.bottom - margin;
			let top = below >= height || anchor.top < height + margin
				? anchor.bottom + gap
				: anchor.top - height - gap;
			setPosition({
				left: Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin)),
				top: Math.max(margin, Math.min(top, window.innerHeight - height - margin)),
				visibility: "visible",
				width,
			});
		};
		place();
		window.addEventListener("resize", place);
		document.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			document.removeEventListener("scroll", place, true);
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		let frame = requestAnimationFrame(() => {
			panel.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]")[initialItem.current]
				?.focus();
		});
		let outside = (event: Event) => {
			let target = event.target;
			if (!(target instanceof Node)) return;
			if (!button.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("focusin", outside);
		return () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("focusin", outside);
		};
	}, [open]);

	let openAt = (index: number) => {
		initialItem.current = index;
		setPosition({ visibility: "hidden" });
		setOpen(true);
	};
	let menuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Tab") {
			setOpen(false);
			return;
		}
		let action = documentMenuKeyAction(event.key);
		if (!action) return;
		event.preventDefault();
		if (action === "close") {
			setOpen(false);
			button.current?.focus();
			return;
		}
		let controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
		if (controls.length === 0) return;
		let current = Math.max(0, controls.indexOf(document.activeElement as HTMLButtonElement));
		let next = action === "first"
			? 0
			: action === "last"
			? controls.length - 1
			: action === "next"
			? (current + 1) % controls.length
			: (current - 1 + controls.length) % controls.length;
		controls[next]?.focus();
	};

	return (
		<>
			<button
				aria-controls={open ? id : undefined}
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={`Actions for ${channel.title}`}
				className={className}
				onClick={() => open ? setOpen(false) : openAt(0)}
				onKeyDown={event => {
					if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
					event.preventDefault();
					openAt(event.key === "ArrowUp" ? items.length - 1 : 0);
				}}
				ref={button}
				type="button"
			>
				{trigger}
			</button>
			{open && createPortal(
				<div
					aria-label={`Actions for ${channel.title}`}
					className="document-actions-menu"
					id={id}
					onKeyDown={menuKeyDown}
					ref={panel}
					role="menu"
					style={position}
				>
					{items.map(item => (
						<button
							className={item.destructive ? "document-actions-menu-destructive" : undefined}
							key={item.action}
							onClick={() => {
								setOpen(false);
								button.current?.focus();
								onAction(item.action);
							}}
							role="menuitem"
							type="button"
						>
							{item.label}
						</button>
					))}
				</div>,
				document.body,
			)}
		</>
	);
}
