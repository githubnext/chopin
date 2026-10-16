import { Menu } from "@base-ui/react/menu";
import { Count } from "@chopin/editor/count";
import { MachineIcon, PlusIcon, ServerIcon, WarningIcon } from "@chopin/icons";
import { useLayoutEffect, useRef } from "react";

import { ago } from "./build-model";
import { setFavorite } from "./machine-choice";
import {
	machines as liveMachines,
	machinesLabel,
	summarizeMachines,
	useLiveMachines,
} from "./machine-summary";

import "./machines-entry.css";

import type { Machine } from "./machine-summary";
import type { ReactNode } from "react";

/** Where the Machines page's Add machine flow starts: Add your computer, opened at once. */
const ADD_MACHINE_PATH = "/machines?add";
/** The radio value for no default: Chopin uses whichever machine is free. */
const ANY = "any";

/**
 * The navigation's way to the person's machines. In the sidebar it opens a menu first: the
 * machine their work runs on by default (their favorite, which Automatic prefers), every paired
 * machine with its state, Add machine, and Manage machines for the full page. Until a machine
 * is paired, and on a phone's documents sheet, it is a link to /machines. Either way it shows how many are connected out of
 * those paired, with a dot while any is connected, or a warning while the default is offline.
 */
export function MachinesEntry(
	{ current = false, placement }: { current?: boolean; placement: "sidebar" | "sheet" },
) {
	let { machines: list, error } = useLiveMachines();
	let summary = list && !error ? summarizeMachines(list) : undefined;
	let favorite = list?.find(machine => machine.favorite);
	let warn = !!favorite && !favorite.connected;
	let label = machinesLabel(summary);
	let adornment = !!summary?.paired && (
		<span aria-hidden="true" className="machines-entry-count">
			{warn
				? <WarningIcon className="machines-entry-warning" size={12} />
				: summary.connected > 0 && <span className="status-dot" data-state="connected" />}
			<Count appearance="quiet" typography="metadata">
				{summary.connected}/{summary.paired}
			</Count>
		</span>
	);
	// With nothing paired yet the page itself is the way in, so the entry goes straight there.
	if (placement === "sheet" || !list?.length) {
		return (
			<a
				aria-current={current ? "page" : undefined}
				aria-label={label}
				className={placement === "sheet"
					? "documents-sheet-link"
					: "project-sidebar-primary-action"}
				href="/machines"
			>
				<MachineIcon aria-hidden="true" className="machines-entry-icon" />
				<span className="truncate">Machines</span>
				{adornment}
			</a>
		);
	}
	let choose = async (value: string) => {
		let id = value === ANY ? favorite?.id : value;
		if (!id) return;
		let mark = (chosen: string | null) =>
			liveMachines.update(machines =>
				machines.map(machine => ({ ...machine, favorite: machine.id === chosen }))
			);
		mark(value === ANY ? null : id);
		try {
			mark(await setFavorite(id, value !== ANY));
		} catch {
			void liveMachines.load();
		}
	};
	let uses = list?.find(machine => machine.connected)?.label;
	return (
		<Menu.Root onOpenChange={open => open && void liveMachines.load()}>
			<Menu.Trigger
				aria-current={current ? "page" : undefined}
				aria-label={warn ? `${label}, your default is offline` : label}
				className="project-sidebar-primary-action machines-entry"
			>
				<MachineIcon aria-hidden="true" className="machines-entry-icon" />
				<span className="truncate">Machines</span>
				{adornment}
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					align="start"
					className="machines-menu-positioner"
					side="top"
					sideOffset={4}
				>
					<MachinesMenuPopup>
						<Menu.RadioGroup
							onValueChange={value => void choose(value as string)}
							value={favorite?.id ?? ANY}
						>
							<Menu.GroupLabel className="app-menu-label">Default machine</Menu.GroupLabel>
							<Menu.RadioItem className="app-menu-item" closeOnClick value={ANY}>
								<span aria-hidden="true" className="machines-menu-glyph">
									<ServerIcon />
								</span>
								<span className="truncate">Any available</span>
								<span className="app-menu-item-meta" title={uses ? `Uses ${uses}` : undefined}>
									{uses ? `Uses ${uses}` : "None connected"}
								</span>
							</Menu.RadioItem>
							{list.map(machine => (
								<Menu.RadioItem
									className="app-menu-item"
									closeOnClick
									key={machine.id}
									value={machine.id}
								>
									<MachineMark machine={machine} />
									<span className="truncate" title={machine.label}>{machine.label}</span>
									<span className="app-menu-item-meta">{state(machine)}</span>
								</Menu.RadioItem>
							))}
						</Menu.RadioGroup>
						<Menu.Separator className="app-menu-separator" />
						<Menu.LinkItem className="app-menu-item" closeOnClick href={ADD_MACHINE_PATH}>
							<span aria-hidden="true" className="machines-menu-glyph">
								<PlusIcon />
							</span>
							Add machine…
						</Menu.LinkItem>
						<Menu.LinkItem className="app-menu-item" closeOnClick href="/machines">
							<span aria-hidden="true" className="machines-menu-glyph">
								<MachineIcon />
							</span>
							Manage machines
						</Menu.LinkItem>
					</MachinesMenuPopup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

function MachinesMenuPopup({ children }: { children: ReactNode }) {
	let popup = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		let panel = popup.current;
		if (!panel) return;
		// Placement remeasures on resize, but a smaller scrollport can hide the focused row.
		let observer = new ResizeObserver(() => {
			let focused = document.activeElement;
			if (focused instanceof HTMLElement && panel.contains(focused)) {
				focused.scrollIntoView({ block: "nearest" });
			}
		});
		observer.observe(panel);
		return () => observer.disconnect();
	}, []);
	return <Menu.Popup className="machines-menu" ref={popup}>{children}</Menu.Popup>;
}

/** A machine's icon with its state as a dot on the corner, as the Machines page draws it. */
function MachineMark({ machine }: { machine: Machine }) {
	let Icon = machine.service ? ServerIcon : MachineIcon;
	let dot = machine.reauthorize ? "reauthorize" : machine.connected ? "connected" : "offline";
	return (
		<span aria-hidden="true" className="machines-menu-glyph">
			<Icon />
			<span className="status-dot machines-menu-dot" data-state={dot} />
		</span>
	);
}

/** A few quiet words on the row: connected, or when an offline machine was last seen. */
function state(machine: Machine) {
	if (machine.reauthorize) return "Needs pairing";
	if (machine.connected) return "Connected";
	let seen = ago(new Date(machine.lastSeenAt).toISOString(), Date.now());
	return seen ? `Last seen ${seen}` : "Offline";
}
