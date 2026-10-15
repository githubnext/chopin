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
import { Face } from "@chopin/editor/face";
import {
	ArchiveIcon,
	ArrowUpIcon,
	ChevronIcon,
	CloseIcon,
	LinkIcon,
	PencilIcon,
	ServerIcon,
} from "@chopin/icons";

import { activeActorRoster, launchUrl } from "./demo-actor";
import { motionContract } from "./motion-contract";
import { useMenuDismissal } from "./menu-dismissal";
import { motionImmediately } from "./motion-input";
import { MenuItem, MenuSeparator } from "./menu-item";
import { IconButton } from "./icon-button";
import { MachineGlyph } from "./machine-button";
import { chosenMachine, machineRows, machineState } from "./machine-choice";

import type { IconProps } from "@chopin/icons";
import type * as Api from "./api";
import type { DemoActor } from "./demo-actor";
import type { MachineChoice, MachineRow } from "./machine-choice";
import type { ComponentProps, ComponentType, CSSProperties, KeyboardEvent, ReactNode } from "react";

// Once prefetched, the sheet renders directly: lazy() would still suspend its first render.
let actionSheet: typeof import("./action-sheet") | undefined;
export let loadActionSheet = () => import("./action-sheet").then(module => (actionSheet = module));
let LazyActionSheet = lazy(() =>
	loadActionSheet().then(module => ({ default: module.ActionSheet }))
);

export type DocumentAction = "copy-link" | "rename" | "archive" | "restore" | "delete";

export type CollaboratorAction = `collaborator:${string}`;

export type DocumentMenuItem = {
	action: DocumentAction | CollaboratorAction;
	label: string;
	destructive?: boolean;
	icon: (props: IconProps) => ReactNode;
};

export function documentMenuItems(
	channel: Pick<Api.Channel, "archivedAt">,
	collaborators: readonly DemoActor[] = [],
): DocumentMenuItem[] {
	let personas: DocumentMenuItem[] = channel.archivedAt ? [] : collaborators.map(actor => ({
		action: `collaborator:${actor.id}` as const,
		label: `Open as collaborator: ${actor.name}`,
		icon: () => <Face decorative handle={actor.id} size={16} titled={false} />,
	}));
	return channel.archivedAt
		? [
			{ action: "restore", label: "Restore", icon: ArrowUpIcon },
			{ action: "delete", label: "Delete permanently", destructive: true, icon: CloseIcon },
		]
		: [
			{ action: "copy-link", label: "Copy link", icon: LinkIcon },
			{ action: "rename", label: "Rename", icon: PencilIcon },
			...personas,
			{ action: "archive", label: "Archive", icon: ArchiveIcon },
		];
}

/** Machine is the title menu's alone: it opens the machine list rather than acting. */
type MenuEntry = Omit<DocumentMenuItem, "action"> & {
	action: DocumentMenuItem["action"] | "machine";
};

const DEFAULT_MACHINE = "default";

function rowLabel(row: MachineRow) {
	return row.id === null ? "Default machine" : row.label;
}

/** One quiet word or two beside the name: what the default uses now, or the machine's state. */
function rowDetail(row: MachineRow) {
	if (!row.machine) return row.uses?.label ?? "None connected";
	let state = machineState(row.machine);
	return state === "connected" ? "Connected" : state === "offline" ? "Offline" : "Needs pairing";
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
		machine,
		openDocument = false,
		trigger,
	}: {
		align?: "start" | "end";
		channel: Pick<Api.Channel, "title" | "archivedAt">;
		className?: string;
		iconButton?: boolean;
		onAction: (action: DocumentAction) => void;
		/**
		 * The person's machine choice for this document: adds Machine, which opens the machine list in
		 * place of the actions. A rare override; the sidebar's Machines sets the default.
		 */
		machine?: MachineChoice;
		/** This menu is for the document open in this tab, so it can launch collaborator tabs. */
		openDocument?: boolean;
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
	let [view, setView] = useState<"actions" | "machines">("actions");
	let [machineSheet, setMachineSheet] = useState(false);
	let choice = machine?.state;
	let chosen = chosenMachine(choice);
	let rows = choice ? machineRows(choice, Date.now()) : [];
	let currentMachine = chosen?.label ?? "Default";
	let base = documentMenuItems(channel, openDocument ? activeActorRoster() : []);
	let items: MenuEntry[] = choice && !channel.archivedAt
		? base.flatMap(item =>
			item.action === "rename"
				? [item, {
					action: "machine" as const,
					label: `Machine: ${currentMachine}`,
					icon: ServerIcon,
				}]
				: [item]
		)
		: base;
	let pickMachine = (row: MachineRow) => {
		if (row.disabled || !machine) return;
		if (row.id !== (chosen?.id ?? null)) void machine.choose(row.id);
	};
	let select = (action: MenuEntry["action"]) => {
		if (action === "machine") {
			setMachineSheet(true);
			return;
		}
		if (action.startsWith("collaborator:")) {
			window.open(
				launchUrl(location.href, action.slice("collaborator:".length)),
				"_blank",
				"noopener",
			);
		} else onAction(action as DocumentAction);
	};
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
			let width = Math.min(
				view === "machines" ? 272 : 208,
				document.documentElement.clientWidth - margin * 2,
			);
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
	}, [align, closeMenu, open, view]);

	useEffect(() => {
		if (!open) return;
		let frame = requestAnimationFrame(() => {
			let controls = panel.current?.querySelectorAll<HTMLButtonElement>("[role^=menuitem]");
			// The machine list starts on the chosen row, after Back.
			let checked = view === "machines"
				? panel.current?.querySelector<HTMLButtonElement>("[aria-checked=true]")
				: undefined;
			(checked ?? controls?.[initialItem.current])?.focus();
		});
		return () => {
			cancelAnimationFrame(frame);
		};
	}, [open, view]);
	useMenuDismissal(open, [button, panel], closeMenu);

	let openAt = (index: number) => {
		initialItem.current = index;
		setView("actions");
		setPosition(undefined);
		setOpen(true);
	};
	let showMachines = () => {
		machine?.refresh();
		initialItem.current = 0;
		setView("machines");
	};
	let showActions = () => {
		initialItem.current = items.findIndex(item => item.action === "machine");
		setView("actions");
	};
	let menuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Tab") {
			closeMenu();
			return;
		}
		let focused = document.activeElement as HTMLElement | null;
		if (event.key === "ArrowRight" && focused?.dataset.action === "machine") {
			event.preventDefault();
			showMachines();
			return;
		}
		if (event.key === "ArrowLeft" && view === "machines") {
			event.preventDefault();
			showActions();
			return;
		}
		let action = documentMenuKeyAction(event.key);
		if (!action) return;
		event.preventDefault();
		if (action === "close") {
			closeMenu(true);
			return;
		}
		let controls = [
			...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role^=menuitem]"),
		].filter(control => control.getAttribute("aria-disabled") !== "true");
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
						onSelect={action => select(action as MenuEntry["action"])}
						title={channel.title}
					/>
				</Suspense>
			)}
			{machineSheet && (
				<Suspense fallback={null}>
					<Sheet
						items={rows.map(row => ({
							action: row.id ?? DEFAULT_MACHINE,
							checked: row.checked,
							detail: rowDetail(row),
							disabled: row.disabled,
							label: rowLabel(row),
						}))}
						label="Machine"
						onClose={() => setMachineSheet(false)}
						onSelect={action => {
							let row = rows.find(value => (value.id ?? DEFAULT_MACHINE) === action);
							if (row) pickMachine(row);
						}}
						title="Machine for this document"
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
					{view === "machines"
						? (
							<>
								<MenuItem onClick={showActions}>
									<ChevronIcon aria-hidden="true" className="rotate-180" />
									Machine
								</MenuItem>
								<MenuSeparator />
								{rows.map(row => (
									<button
										aria-checked={row.checked}
										aria-disabled={row.disabled || undefined}
										className="app-menu-item"
										data-density="normal"
										key={row.id ?? DEFAULT_MACHINE}
										onClick={() => {
											if (row.disabled) return;
											closeMenu(true);
											pickMachine(row);
										}}
										role="menuitemradio"
										type="button"
									>
										<MachineGlyph machine={row.machine} />
										<span className="truncate">{rowLabel(row)}</span>
										<span className="app-menu-item-meta">{rowDetail(row)}</span>
									</button>
								))}
							</>
						)
						: items.map(item =>
							item.action === "machine"
								? (
									<button
										className="app-menu-item"
										data-action="machine"
										data-density="normal"
										key={item.action}
										onClick={showMachines}
										role="menuitem"
										type="button"
									>
										<item.icon aria-hidden="true" />
										Machine
										<span className="app-menu-item-meta">{currentMachine}</span>
										<ChevronIcon aria-hidden="true" className="app-menu-item-chevron" size={12} />
									</button>
								)
								: (
									<MenuItem
										key={item.action}
										onClick={() => {
											closeMenu(true);
											select(item.action);
										}}
										tone={item.destructive ? "destructive" : "normal"}
									>
										<item.icon aria-hidden="true" size={16} />
										{item.label}
									</MenuItem>
								)
						)}
				</div>,
				document.body,
			)}
		</>
	);
}
