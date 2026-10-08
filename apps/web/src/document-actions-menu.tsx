import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { ArchiveIcon, ArrowUpIcon, CloseIcon, LinkIcon, PencilIcon } from "@chopin/icons";

import { motionContract } from "./motion-contract";
import { useMenuDismissal } from "./menu-dismissal";
import { motionImmediately } from "./motion-input";

import type { IconProps } from "@chopin/icons";
import type * as Api from "./api";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

export type DocumentAction = "copy-link" | "rename" | "archive" | "restore" | "delete";

export type DocumentMenuItem = {
	action: DocumentAction;
	label: string;
	destructive?: boolean;
	icon: (props: IconProps) => ReactNode;
};

export function documentMenuItems(channel: Pick<Api.Channel, "archivedAt">): DocumentMenuItem[] {
	return channel.archivedAt
		? [
			{ action: "restore", label: "Restore", icon: ArrowUpIcon },
			{ action: "delete", label: "Delete permanently", destructive: true, icon: CloseIcon },
		]
		: [
			{ action: "copy-link", label: "Copy link", icon: LinkIcon },
			{ action: "rename", label: "Rename", icon: PencilIcon },
			{ action: "archive", label: "Archive", icon: ArchiveIcon },
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
		align = "end",
		className = "",
		onAction,
		trigger,
	}: {
		align?: "start" | "end";
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
	let [position, setPosition] = useState<CSSProperties>();
	let items = documentMenuItems(channel);
	let immediately = motionImmediately();
	let motion = motionContract("popover");
	let presence = useTransitionPresence(
		open && position ? position : undefined,
		motion.closeDuration,
		immediately,
	);
	let mounted = open || presence.phase !== "closed";
	let active = open && position !== undefined && presence.phase !== "closing";
	let closeMenu = useCallback((restoreFocus = false) => {
		setOpen(false);
		if (restoreFocus) button.current?.focus();
	}, []);

	useLayoutEffect(() => {
		if (!open) return;
		let fail = () => {
			setPosition(undefined);
			closeMenu(true);
		};
		let place = (): boolean => {
			let anchor = button.current?.getBoundingClientRect();
			let menu = panel.current;
			if (!anchor || !menu) {
				fail();
				return false;
			}
			let margin = 8;
			let gap = 4;
			let width = Math.min(208, document.documentElement.clientWidth - margin * 2);
			let height = menu.offsetHeight;
			if (width <= 0 || height <= 0) {
				fail();
				return false;
			}
			let below = window.innerHeight - anchor.bottom - margin;
			let top = below >= height || anchor.top < height + margin
				? anchor.bottom + gap
				: anchor.top - height - gap;
			let left = Math.max(
				margin,
				Math.min(
					align === "start" ? anchor.left : anchor.right - width,
					window.innerWidth - width - margin,
				),
			);
			let placedTop = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
			setPosition({
				"--motion-origin-x": `${
					Math.min(width, Math.max(0, anchor.left + anchor.width / 2 - left))
				}px`,
				"--motion-origin-y": `${
					Math.min(height, Math.max(0, anchor.top + anchor.height / 2 - placedTop))
				}px`,
				left,
				top: placedTop,
				visibility: "visible",
				width,
			} as CSSProperties);
			return true;
		};
		if (!place()) return;
		window.addEventListener("resize", place);
		document.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			document.removeEventListener("scroll", place, true);
		};
	}, [align, closeMenu, open]);

	useEffect(() => {
		if (!open) return;
		let frame = requestAnimationFrame(() => {
			panel.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]")[initialItem.current]
				?.focus();
		});
		return () => {
			cancelAnimationFrame(frame);
		};
	}, [open]);
	useMenuDismissal(open, [button, panel], closeMenu);

	let openAt = (index: number) => {
		initialItem.current = index;
		setPosition(undefined);
		setOpen(true);
	};
	let menuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Tab") {
			closeMenu();
			return;
		}
		let action = documentMenuKeyAction(event.key);
		if (!action) return;
		event.preventDefault();
		if (action === "close") {
			closeMenu(true);
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
				data-tooltip="Document actions"
				onClick={() => open ? closeMenu() : openAt(0)}
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
			{mounted && createPortal(
				<div
					aria-hidden={active ? undefined : "true"}
					aria-label={`Actions for ${channel.title}`}
					className={`document-actions-menu ${motion.className} ${presence.className}`}
					data-motion-immediate={immediately || undefined}
					id={id}
					inert={!active}
					onKeyDown={menuKeyDown}
					ref={panel}
					role="menu"
					style={presence.value ?? { visibility: "hidden" }}
				>
					{items.map(item => (
						<button
							className={item.destructive ? "document-actions-menu-destructive" : undefined}
							key={item.action}
							onClick={() => {
								closeMenu(true);
								onAction(item.action);
							}}
							role="menuitem"
							type="button"
						>
							<item.icon aria-hidden="true" size={14} />
							{item.label}
						</button>
					))}
				</div>,
				document.body,
			)}
		</>
	);
}
