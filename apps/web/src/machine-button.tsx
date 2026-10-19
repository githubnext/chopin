import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Drawer } from "@base-ui/react/drawer";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { CloudIcon, MachineIcon, PlusIcon } from "@chopin/icons";

import { documentMenuKeyAction } from "./document-actions-menu";
import {
	chosenMachine,
	machineButtonLabel,
	machineRows,
	machineState,
	shownMachine,
} from "./machine-choice";
import { useMenuDismissal } from "./menu-dismissal";
import { motionImmediately } from "./motion-input";
import { useNavigationMenu } from "./navigation-shell";

import "./machine-button.css";
import "./phone-sheets.css";

import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import type { ChoosableMachine, MachineChoice, MachineRow, MachineState } from "./machine-choice";

/** Where the Machines page's Add machine flow starts: Add your computer, opened at once. */
export const ADD_MACHINE_PATH = "/machines?add";

/**
 * A machine as an icon with its state as a dot on the icon's corner: the cloud icon for one the
 * background service runs, the laptop otherwise, the same two as Add machine's menu. The dot is
 * the Machines page's status dot. With no machine it is the laptop in tertiary ink, no dot.
 */
export function MachineGlyph(
	{ machine, size = 16 }: {
		machine?: Pick<ChoosableMachine, "service" | "connected" | "reauthorize">;
		size?: 16 | 18;
	},
) {
	let Icon = machine?.service ? CloudIcon : MachineIcon;
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
			<MachineGlyph machine={row.machine} />
			<span className="machine-menu-title" title={row.label}>{row.label}</span>
			<span className="app-menu-item-meta">{row.detail}</span>
		</>
	);
}

/**
 * Which machine runs this document's Planner and builds: an icon with its state dot, the chosen
 * machine's, or the one Automatic uses now. Its menu lists the person's machines serving the
 * repository under Local and Cloud, offline ones disabled, and Add machine. The sidebar's
 * Machines menu sets the default. Every button for a document shares one `choice`. A phone opens
 * the same rows as a sheet from the bottom edge.
 */
export function MachineButton(
	{ choice, phone = false }: { choice: MachineChoice; phone?: boolean },
) {
	let id = useId();
	let trigger = useRef<HTMLButtonElement>(null);
	let menu = useRef<HTMLDivElement>(null);
	let [open, setOpen] = useNavigationMenu();
	let initialItem = useRef<"first" | "last">("first");
	let presence = useTransitionPresence(open && !phone ? true : undefined, 150, motionImmediately());
	let mounted = presence.phase !== "closed";
	let state = choice.state;
	let shown = shownMachine(state);
	let rows = state ? machineRows(state) : [];
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
		// The default's machine shows checked too; choosing it pins it to the document.
		if (row.id !== chosenMachine(state)?.id) void choice.choose(row.id);
	};
	let add = () => {
		close(false);
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
		let action = documentMenuKeyAction(event.key);
		if (!action) return;
		event.preventDefault();
		if (action === "close") {
			close(true);
			return;
		}
		let items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role^=menuitem]")]
			.filter(item => item.getAttribute("aria-disabled") !== "true");
		let current = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
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
	let label = machineButtonLabel(state);
	// An offline machine dims the button, as its menu row is dimmed; it stays a button, so another
	// machine can be chosen. The menu row says why.
	let offline = !!shown && !shown.connected;
	let item = (row: MachineRow, sheet: boolean) => (
		<button
			aria-checked={row.checked}
			aria-disabled={row.disabled || undefined}
			className={sheet ? "machine-sheet-item" : "app-menu-item"}
			data-disabled={row.disabled || undefined}
			key={row.id}
			onClick={() => pick(row)}
			role="menuitemradio"
			type="button"
		>
			<RowContent row={row} />
		</button>
	);
	let group = (name: string, list: MachineRow[], sheet: boolean) =>
		list.length > 0 && (
			<div aria-label={name} key={name} role="group">
				<p aria-hidden="true" className="machine-menu-label">{name}</p>
				{list.map(row => item(row, sheet))}
			</div>
		);
	let body = (sheet: boolean) => (
		<>
			{group("Local", rows.filter(row => !row.cloud), sheet)}
			{group("Cloud", rows.filter(row => row.cloud), sheet)}
			{rows.length > 0 && <div className="app-menu-separator" role="separator" />}
			{addItem(sheet)}
		</>
	);
	let addItem = (sheet: boolean) => (
		<button
			className={sheet ? "machine-sheet-item" : "app-menu-item"}
			data-add=""
			onClick={add}
			role="menuitem"
			type="button"
		>
			<span aria-hidden="true" className="machine-glyph" data-automatic="">
				<PlusIcon size={16} />
			</span>
			<span className="machine-menu-title">Add machine</span>
		</button>
	);
	return (
		<>
			<button
				aria-busy={choice.saving || undefined}
				aria-controls={open && !phone ? id : undefined}
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={label}
				className={offline ? "machine-button machine-offline" : "machine-button"}
				data-phone={phone || undefined}
				data-tooltip={label}
				data-tooltip-verbatim=""
				onClick={() => open ? close(false) : openAt("first")}
				onKeyDown={event => {
					if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
					event.preventDefault();
					openAt(event.key === "ArrowUp" ? "last" : "first");
				}}
				ref={trigger}
				type="button"
			>
				<MachineGlyph machine={shown} />
			</button>
			{choice.error && <span className="sr-only" role="alert">{choice.error}</span>}
			{!phone && mounted && createPortal(
				<div
					aria-hidden={presence.phase === "closing" ? "true" : undefined}
					aria-label="Runs on"
					className={`machine-menu motion-dropdown ${presence.className}`}
					id={id}
					inert={presence.phase === "closing"}
					onKeyDown={menuKeyDown}
					ref={menu}
					role="menu"
				>
					{body(false)}
				</div>,
				document.body,
			)}
			{phone && open && <MachineSheet onClose={() => setOpen(false)}>{body(true)}</MachineSheet>}
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
						aria-label="Runs on"
						className="action-sheet machine-sheet"
					>
						<Drawer.Title className="sr-only">Runs on</Drawer.Title>
						<div
							className="machine-sheet-group"
							onClick={event => {
								let target = (event.target as HTMLElement).closest("button");
								if (target && target.getAttribute("aria-disabled") !== "true") setOpen(false);
							}}
							role="menu"
						>
							<p aria-hidden="true" className="action-sheet-title">Runs on</p>
							{children}
						</div>
						<Drawer.Close className="action-sheet-cancel">Cancel</Drawer.Close>
					</Drawer.Popup>
				</Drawer.Viewport>
			</Drawer.Portal>
		</Drawer.Root>
	);
}
