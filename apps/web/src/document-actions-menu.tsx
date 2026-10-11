import { createPortal } from "react-dom";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { usePhone } from "@chopin/editor/pointer";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { ArchiveIcon, ArrowUpIcon, CloseIcon, LinkIcon, PencilIcon } from "@chopin/icons";

import { motionContract } from "./motion-contract";
import { useMenuDismissal } from "./menu-dismissal";
import { motionImmediately } from "./motion-input";
import { MenuItem } from "./menu-item";
import { IconButton } from "./icon-button";

import type { IconProps } from "@chopin/icons";
import type * as Api from "./api";
import type { ComponentProps, ComponentType, CSSProperties, KeyboardEvent, ReactNode } from "react";

// Once prefetched, the sheet renders directly: lazy() would still suspend its first render.
let actionSheet: typeof import("./action-sheet") | undefined;
export let loadActionSheet = () => import("./action-sheet").then(module => (actionSheet = module));
let LazyActionSheet = lazy(() =>
	loadActionSheet().then(module => ({ default: module.ActionSheet }))
);

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
		iconButton = false,
		onAction,
		trigger,
	}: {
		align?: "start" | "end";
		channel: Pick<Api.Channel, "title" | "archivedAt">;
		className?: string;
		iconButton?: boolean;
		onAction: (action: DocumentAction) => void;
		trigger: ReactNode;
	},
) {
	let id = useId();
	let button = useRef<HTMLButtonElement>(null);
	let panel = useRef<HTMLDivElement>(null);
	let initialItem = useRef(0);
	let phone = usePhone();
	// Chosen when opened, so a load finishing later never remounts an open sheet.
	let sheet = useRef<
		ComponentType<ComponentProps<typeof LazyActionSheet>>
	>(LazyActionSheet);
	let Sheet = sheet.current;
	let [open, setOpen] = useState(false);
	let [sheetOpen, setSheetOpen] = useState(false);
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
	let toggleMenu = () => {
		if (phone) {
			sheet.current = actionSheet?.ActionSheet ?? LazyActionSheet;
			setSheetOpen(true);
		} else if (open) closeMenu();
		else openAt(0);
	};
	// A phone's first tap should open the sheet, not wait for its code.
	let preload = phone
		? () => {
			void loadActionSheet();
			void import("./copy-link");
		}
		: undefined;
	let triggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (phone) return;
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		openAt(event.key === "ArrowUp" ? items.length - 1 : 0);
	};

	return (
		<>
			{iconButton
				? (
					<IconButton
						aria-controls={open ? id : undefined}
						aria-expanded={open || sheetOpen}
						aria-haspopup="menu"
						aria-label={`Actions for ${channel.title}`}
						data-tooltip="Document actions"
						glyph="compact"
						onClick={toggleMenu}
						onKeyDown={triggerKeyDown}
						placement="sidebar-document"
						ref={button}
						size="compact"
					>
						{trigger}
					</IconButton>
				)
				: (
					<button
						aria-controls={open ? id : undefined}
						aria-expanded={open || sheetOpen}
						aria-haspopup={phone ? "dialog" : "menu"}
						aria-label={`Actions for ${channel.title}`}
						className={className}
						data-tooltip="Document actions"
						onClick={toggleMenu}
						onKeyDown={triggerKeyDown}
						onPointerDown={preload}
						ref={button}
						type="button"
					>
						{trigger}
					</button>
				)}
			{sheetOpen && (
				<Suspense fallback={null}>
					<Sheet
						immediate={["copy-link"]}
						items={items}
						label={`Actions for ${channel.title}`}
						onClose={() => setSheetOpen(false)}
						onSelect={action => onAction(action as DocumentAction)}
						title={channel.title}
					/>
				</Suspense>
			)}
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
						<MenuItem
							key={item.action}
							onClick={() => {
								closeMenu(true);
								onAction(item.action);
							}}
							tone={item.destructive ? "destructive" : "normal"}
						>
							<item.icon aria-hidden="true" size={14} />
							{item.label}
						</MenuItem>
					))}
				</div>,
				document.body,
			)}
		</>
	);
}
