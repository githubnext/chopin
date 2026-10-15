import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Drawer } from "@base-ui/react/drawer";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { CheckIcon, ChevronIcon, MachineIcon, PlusIcon, ServerIcon } from "@chopin/icons";

import { documentMenuKeyAction } from "./document-actions-menu";
import { FavoriteStar } from "./favorite-star";
import {
	chosenMachine,
	machineButtonLabel,
	machineRows,
	machineState,
	plannerButton,
} from "./machine-choice";
import { useMenuDismissal } from "./menu-dismissal";
import { motionImmediately } from "./motion-input";

import "./machine-button.css";
import "./phone-sheets.css";

import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import type { ChoosableMachine, MachineChoice, MachineRow, MachineState } from "./machine-choice";

/** Where the Machines page's Add machine flow starts: Add your computer, opened at once. */
export const ADD_MACHINE_PATH = "/machines?add";

/**
 * A machine as an icon with its state as a dot on the icon's corner: the server icon for one the
 * background service runs, the computer icon otherwise, the same two as Add machine's menu. The
 * dot is the Machines page's status dot. Automatic is the server icon in tertiary ink, no dot.
 */
export function MachineGlyph(
	{ machine, size = 16 }: {
		machine?: Pick<ChoosableMachine, "service" | "connected" | "reauthorize">;
		size?: 16 | 18;
	},
) {
	let Icon = machine && !machine.service ? MachineIcon : ServerIcon;
	let state: MachineState | undefined = machine && machineState(machine);
	return (
		<span
			aria-hidden="true"
			className="machine-glyph"
			data-automatic={machine ? undefined : ""}
			style={{ "--machine-glyph-size": `${size}px` } as CSSProperties}
		>
			<Icon size={size} />
			{state && <span className="status-dot machine-glyph-dot" data-state={state} />}
		</span>
	);
}

function go(path: string) {
	history.pushState(null, "", path);
	window.dispatchEvent(new PopStateEvent("popstate"));
}

function RowContent({ row }: { row: MachineRow }) {
	return (
		<>
			<MachineGlyph machine={row.machine} size={18} />
			<span className="machine-menu-option">
				<span className="machine-menu-title" title={row.label}>{row.label}</span>
				<span className="machine-menu-detail" title={row.detail}>{row.detail}</span>
			</span>
			<span className="machine-menu-check">
				{row.checked && <CheckIcon aria-hidden="true" size={14} />}
			</span>
		</>
	);
}

/**
 * Which of the person's machines works on this document: the chosen machine's icon, state dot and
 * name, then a chevron, as `[icon] build-box ▾`; Automatic until they choose. Its menu offers
 * Automatic (and the machine it uses now), their machines serving the repository, offline ones
 * disabled, and Add machine. Every button for a document shares one `choice`, so changing one
 * changes all. A phone opens the same rows as a sheet from the bottom edge.
 */
export function MachineButton(
	{ choice, compact = false, phone = false, planner = false }: {
		choice: MachineChoice;
		/** Chat's button: it says who runs the document's Planner. */
		planner?: boolean;
		/** The icon and dot alone; the accessible name still says which machine. */
		compact?: boolean;
		phone?: boolean;
	},
) {
	let id = useId();
	let trigger = useRef<HTMLButtonElement>(null);
	let menu = useRef<HTMLDivElement>(null);
	let [open, setOpen] = useState(false);
	let initialItem = useRef<"first" | "last">("first");
	let presence = useTransitionPresence(open && !phone ? true : undefined, 150, motionImmediately());
	let mounted = presence.phase !== "closed";
	let state = choice.state;
	let chosen = chosenMachine(state);
	let rows = state ? machineRows(state, Date.now(), planner) : [];
	let runner = planner ? plannerButton(state) : undefined;
	let close = (restoreFocus: boolean) => {
		setOpen(false);
		if (restoreFocus) trigger.current?.focus();
	};
	let openAt = (item: "first" | "last") => {
		initialItem.current = item;
		choice.refresh();
		setOpen(true);
	};
	let pick = (row: MachineRow) => {
		if (row.disabled) return;
		// A phone's sheet closes itself first, then forgets it was open.
		if (!phone) close(true);
		if (row.id !== (chosen?.id ?? null)) void choice.choose(row.id);
	};
	let add = () => {
		if (!phone) close(false);
		go(ADD_MACHINE_PATH);
	};
	useMenuDismissal(open && !phone, [trigger, menu], close);
	useLayoutEffect(() => {
		if (!mounted) return;
		let place = () => {
			let anchor = trigger.current?.getBoundingClientRect();
			let panel = menu.current;
			if (!anchor || !panel) return;
			let margin = 8;
			let viewport = document.documentElement.clientWidth;
			let height = document.documentElement.clientHeight;
			let width = panel.offsetWidth;
			let start = anchor.left + anchor.width / 2 < viewport / 2
				? anchor.left
				: anchor.right - width;
			let left = Math.max(margin, Math.min(start, viewport - width - margin));
			// Below the button where it fits, as in the header; else above, as from the composer;
			// else on the side with more room. It never leaves the window: the rows that don't fit
			// scroll inside it.
			let natural = panel.scrollHeight;
			let roomBelow = height - margin - anchor.bottom - 4;
			let roomAbove = anchor.top - 4 - margin;
			let below = natural <= roomBelow
				|| natural > roomAbove && roomBelow >= roomAbove;
			panel.style.maxHeight = `min(28rem, ${Math.max(0, below ? roomBelow : roomAbove)}px)`;
			panel.style.left = `${left}px`;
			panel.style.top = below ? `${anchor.bottom + 4}px` : "";
			panel.style.bottom = below ? "" : `${height - anchor.top + 4}px`;
			panel.dataset.side = below ? "below" : "above";
			panel.style.setProperty(
				"--motion-origin-x",
				`${Math.min(width, Math.max(0, anchor.left + anchor.width / 2 - left))}px`,
			);
		};
		place();
		window.addEventListener("resize", place);
		document.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			document.removeEventListener("scroll", place, true);
		};
	}, [mounted, rows.length]);
	useEffect(() => {
		if (!open || phone) return;
		let items = [...(menu.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])]
			.filter(item => item.getAttribute("aria-disabled") !== "true");
		let checked = items.find(item => item.getAttribute("aria-checked") === "true");
		let first = initialItem.current === "last" ? items.at(-1) : checked ?? items[0];
		first?.focus();
		first?.scrollIntoView({ block: "nearest" });
	}, [open, mounted]);
	let menuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Tab") {
			close(false);
			return;
		}
		let active = document.activeElement as HTMLElement | null;
		// Right from a machine's row reaches its star; Left goes back.
		if (event.key === "ArrowRight") {
			let star = active?.parentElement?.querySelector<HTMLElement>("[data-star]");
			if (star && star !== active) {
				event.preventDefault();
				star.focus();
			}
			return;
		}
		let action = documentMenuKeyAction(event.key);
		if (!action) return;
		event.preventDefault();
		if (action === "close") {
			close(true);
			return;
		}
		let items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role^=menuitem]")]
			.filter(item => item.getAttribute("aria-disabled") !== "true");
		// From a star, as from its row.
		let row = active?.hasAttribute("data-star")
			? active.parentElement?.querySelector<HTMLElement>("[role^=menuitem]")
			: active;
		let current = Math.max(0, items.indexOf(row as HTMLElement));
		let next = action === "first"
			? 0
			: action === "last"
			? items.length - 1
			: action === "next"
			? (current + 1) % items.length
			: (current - 1 + items.length) % items.length;
		items[next]?.focus();
		// A row scrolled out of the panel comes into view as it takes focus.
		items[next]?.scrollIntoView({ block: "nearest" });
	};
	let name = runner?.name ?? chosen?.label ?? "Default machine";
	let label = runner?.label ?? machineButtonLabel(state);
	// An offline machine dims the button, as its menu row is dimmed; it stays a button, so another
	// machine can be chosen. Only its accessible name says why.
	let offline = !!chosen && !chosen.connected;
	let item = (row: MachineRow, sheet: boolean) => {
		let button = (
			<button
				aria-checked={row.checked}
				aria-disabled={row.disabled || undefined}
				className={`${sheet ? "machine-sheet-item" : "app-menu-item machine-menu-item"}${
					row.disabled ? " machine-offline" : ""
				}`}
				data-density="detailed"
				data-disabled={row.disabled || undefined}
				key={row.id ?? "automatic"}
				onClick={() => pick(row)}
				role="menuitemradio"
				type="button"
			>
				<RowContent row={row} />
			</button>
		);
		let id = row.id;
		if (!id) return button;
		// A machine's star sets or clears the favorite without changing the document's choice.
		return (
			<div className="machine-menu-row" key={id}>
				{button}
				<FavoriteStar
					favorite={row.favorite}
					menu
					touch={sheet}
					label={row.label}
					onKeyDown={event => {
						if (event.key !== "ArrowLeft") return;
						event.preventDefault();
						event.currentTarget.parentElement?.querySelector<HTMLElement>("[role^=menuitem]")
							?.focus();
					}}
					onToggle={() => void choice.favor(id, !row.favorite)}
				/>
			</div>
		);
	};
	let addItem = (sheet: boolean) => (
		<button
			className={sheet ? "machine-sheet-item" : "app-menu-item machine-menu-item"}
			data-density="detailed"
			data-add=""
			onClick={add}
			role="menuitem"
			type="button"
		>
			<span aria-hidden="true" className="machine-glyph" data-automatic="">
				<PlusIcon size={18} />
			</span>
			<span className="machine-menu-option">
				<span className="machine-menu-title">Add machine…</span>
			</span>
		</button>
	);
	let [automatic, ...machines] = rows;
	// Another account holds the Planner: Chat's button says so and opens nothing.
	if (runner?.readOnly) {
		return (
			<button
				aria-disabled="true"
				aria-label={label}
				className="machine-button"
				data-compact={compact || undefined}
				data-phone={phone || undefined}
				data-read-only=""
				data-tooltip={compact ? name : undefined}
				data-tooltip-verbatim={compact ? "" : undefined}
				type="button"
			>
				<MachineGlyph />
				{!compact && <span className="machine-button-name">{name}</span>}
			</button>
		);
	}
	return (
		<>
			<button
				aria-busy={choice.saving || undefined}
				aria-controls={open && !phone ? id : undefined}
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={label}
				className={offline ? "machine-button machine-offline" : "machine-button"}
				data-compact={compact || undefined}
				data-phone={phone || undefined}
				data-tooltip={compact
					? runner?.name ?? chosen?.label ?? label.replace(/^Machine: /, "")
					: undefined}
				data-tooltip-verbatim={compact ? "" : undefined}
				onClick={() => open ? close(false) : openAt("first")}
				onKeyDown={event => {
					if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
					event.preventDefault();
					openAt(event.key === "ArrowUp" ? "last" : "first");
				}}
				ref={trigger}
				type="button"
			>
				<MachineGlyph machine={chosen} />
				{!compact && <span className="machine-button-name" title={name}>{name}</span>}
				{!compact && (
					<ChevronIcon
						aria-hidden="true"
						className="machine-button-chevron"
						size={12}
					/>
				)}
			</button>
			{choice.error && <span className="sr-only" role="alert">{choice.error}</span>}
			{!phone && mounted && createPortal(
				<div
					aria-hidden={presence.phase === "closing" ? "true" : undefined}
					aria-label="Machine for this document"
					className={`machine-menu motion-dropdown ${presence.className}`}
					id={id}
					inert={presence.phase === "closing"}
					onKeyDown={menuKeyDown}
					ref={menu}
					role="menu"
				>
					{automatic && item(automatic, false)}
					<div className="machine-menu-separator" role="separator" />
					{machines.map(row => item(row, false))}
					{machines.length > 0 && <div className="machine-menu-separator" role="separator" />}
					{addItem(false)}
				</div>,
				document.body,
			)}
			{phone && open && (
				<MachineSheet onClose={() => setOpen(false)}>
					{automatic && item(automatic, true)}
					<div className="machine-menu-separator" role="separator" />
					{machines.map(row => item(row, true))}
					{machines.length > 0 && <div className="machine-menu-separator" role="separator" />}
					{addItem(true)}
				</MachineSheet>
			)}
		</>
	);
}

/** A phone's machine menu: the same rows on a sheet rising from the bottom edge. */
function MachineSheet({ children, onClose }: { children: ReactNode; onClose: () => void }) {
	let [open, setOpen] = useState(false);
	useEffect(() => {
		let frame = requestAnimationFrame(() => setOpen(true));
		return () => cancelAnimationFrame(frame);
	}, []);
	return (
		<Drawer.Root
			onOpenChange={setOpen}
			onOpenChangeComplete={next => !next && onClose()}
			open={open}
		>
			<Drawer.Portal>
				<Drawer.Backdrop className="phone-sheet-backdrop" />
				<Drawer.Viewport className="phone-sheet-viewport">
					<Drawer.Popup
						aria-label="Machine for this document"
						className="action-sheet machine-sheet"
					>
						<Drawer.Title className="sr-only">Machine for this document</Drawer.Title>
						<div
							className="machine-sheet-group"
							onClick={event => {
								let target = (event.target as HTMLElement).closest("button");
								// A star sets the favorite; the sheet stays for the choice.
								if (
									target && target.getAttribute("aria-disabled") !== "true"
									&& !target.hasAttribute("data-star")
								) setOpen(false);
							}}
							role="menu"
						>
							<p aria-hidden="true" className="action-sheet-title">Machine for this document</p>
							{children}
						</div>
						<Drawer.Close className="action-sheet-cancel">Cancel</Drawer.Close>
					</Drawer.Popup>
				</Drawer.Viewport>
			</Drawer.Portal>
		</Drawer.Root>
	);
}
