import { Menu } from "@base-ui/react/menu";
import { Count } from "@chopin/editor/count";
import { CloudIcon, MachineIcon, PlusIcon, ServerIcon, WarningIcon } from "@chopin/icons";
import { Fragment, useLayoutEffect, useRef } from "react";

import { ago } from "./build-model";
import { setFavorite } from "./machine-choice";
import {
	allMachines,
	machines as liveMachines,
	machinesLabel,
	ownerHint,
	summarizeLive,
	useLiveMachines,
} from "./machine-summary";

import { useNavigationDocument, useNavigationMenu } from "./navigation-shell";
import "./machines-entry.css";

import type { Machine, TeammateMachine } from "./machine-summary";
import type { ReactNode } from "react";

/** Where the Machines page's Add machine flow starts: Add a local machine, opened at once. */
const ADD_MACHINE_PATH = "/machines?add";
/** The radio value for no default: Chopin uses whichever machine is free. */
const ANY = "any";

/**
 * The navigation's way to the machines the person can use. In the sidebar it opens a menu first:
 * the machine their work runs on by default (their favorite, which Automatic prefers), every
 * machine of theirs and every one a teammate shares with them, with its state, Add machine, and
 * Manage machines for the full page. Until there is a machine, and on a phone's documents sheet,
 * it is a link to /machines. Either way it shows how many are connected out of all of them, with
 * a dot while any is connected, or a warning while the default is offline.
 */
export function MachinesEntry(
	{ current = false, placement }: { current?: boolean; placement: "sidebar" | "sheet" },
) {
	let [open, setOpen] = useNavigationMenu();
	let { navigationRevision } = useNavigationDocument();
	let live = useLiveMachines();
	let { machines: own, error } = live;
	let list = allMachines(live);
	let summary = error ? undefined : summarizeLive(live);
	let favorite = list?.find(machine => machine.favorite);
	let warn = !!favorite && !favorite.connected;
	let label = machinesLabel(summary);
	let adornment = !!summary?.total && (
		<span aria-hidden="true" className="machines-entry-count">
			{warn
				? <WarningIcon className="machines-entry-warning" size={12} />
				: summary.connected > 0 && <span className="status-dot" data-state="connected" />}
			<Count appearance="quiet" typography="metadata">
				{summary.connected}/{summary.total}
			</Count>
		</span>
	);
	// With no machine yet the page itself is the way in, so the entry goes straight there.
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
		liveMachines.favor(value === ANY ? null : id);
		try {
			liveMachines.favor(await setFavorite(id, value !== ANY));
		} catch {
			void liveMachines.load();
		}
	};
	// Automatic works on the person's own machines, and on a teammate's only once it is their favorite.
	let uses = own?.find(machine => machine.connected)?.label;
	return (
		<Menu.Root
			key={navigationRevision}
			open={open}
			onOpenChange={next => {
				setOpen(next);
				if (next) void liveMachines.load();
			}}
		>
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
							<Menu.GroupLabel className="app-menu-label">Default</Menu.GroupLabel>
							<Menu.RadioItem className="app-menu-item" closeOnClick value={ANY}>
								<span aria-hidden="true" className="machines-menu-glyph">
									<ServerIcon />
								</span>
								<span className="truncate">Any connected</span>
								<span className="app-menu-item-meta" title={uses ? `Uses ${uses}` : undefined}>
									{uses ? `Uses ${uses}` : "None connected"}
								</span>
							</Menu.RadioItem>
							{[
								{ name: "Local", machines: list.filter(machine => !machine.service) },
								{ name: "Cloud", machines: list.filter(machine => machine.service) },
							].filter(group => group.machines.length).map(group => (
								<Fragment key={group.name}>
									<Menu.GroupLabel className="app-menu-label">{group.name}</Menu.GroupLabel>
									{group.machines.map(machine => (
										<Menu.RadioItem
											className="app-menu-item"
											closeOnClick
											key={machine.id}
											value={machine.id}
										>
											<MachineMark machine={machine} />
											<span className="truncate" title={machine.label}>
												{machine.label}
												<MachineOwner machine={machine} all={list} />
											</span>
											<span className="app-menu-item-meta">{state(machine)}</span>
										</Menu.RadioItem>
									))}
								</Fragment>
							))}
						</Menu.RadioGroup>
						<Menu.Separator className="app-menu-separator" />
						<Menu.LinkItem className="app-menu-item" closeOnClick href={ADD_MACHINE_PATH}>
							<span aria-hidden="true" className="machines-menu-glyph">
								<PlusIcon />
							</span>
							Add machine
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
	let openedOn = useRef(location.href);
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
	return (
		<Menu.Popup
			className="machines-menu"
			finalFocus={() => openedOn.current === location.href}
			ref={popup}
		>
			{children}
		</Menu.Popup>
	);
}

/** A teammate's login after a machine name another machine has too, so the two can be told apart. */
function MachineOwner(
	{ machine, all }: { machine: Machine | TeammateMachine; all: readonly { label: string }[] },
) {
	let owner = ownerHint(machine, all);
	return owner && (
		<>
			{" "}
			<span className="machines-menu-owner">{owner}</span>
		</>
	);
}

/** A machine's icon with its state as a dot on the corner, as the Machines page draws it. */
function MachineMark({ machine }: { machine: Machine | TeammateMachine }) {
	let Icon = machine.service ? CloudIcon : MachineIcon;
	let dot = "reauthorize" in machine && machine.reauthorize
		? "reauthorize"
		: machine.connected
		? "connected"
		: "offline";
	return (
		<span aria-hidden="true" className="machines-menu-glyph">
			<Icon />
			<span className="status-dot machines-menu-dot" data-state={dot} />
		</span>
	);
}

/** A few quiet words on the row: connected, or when an offline machine was last seen. */
function state(machine: Machine | TeammateMachine) {
	if ("reauthorize" in machine && machine.reauthorize) return "Needs reconnecting";
	if (machine.connected) return "Connected";
	let seen = ago(new Date(machine.lastSeenAt).toISOString(), Date.now());
	return seen ? `Last seen ${seen}` : "Offline";
}
