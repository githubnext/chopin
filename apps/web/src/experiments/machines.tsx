import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { CloseIcon, EllipsisIcon } from "@chopin/icons";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@chopin/visuals";
import { ago } from "../build-model";
import { documentMenuKeyAction } from "../document-actions-menu";
import { IconButton } from "../icon-button";
import { listMachines, updateAvailable } from "../machine-summary";
import { useMenuDismissal } from "../menu-dismissal";
import { MenuItem } from "../menu-item";
import { motionImmediately } from "../motion-input";
import { NavigationDialog } from "../navigation-dialog";
import { TerminalAlert } from "../terminal-alert";
import { experimentRequest } from "./api";

import type { KeyboardEvent } from "react";
import type { Machine } from "../machine-summary";
import type { NavigationDialogMotion } from "../navigation-dialog";

/** How often /connect asks again, so a machine that pairs shows up without a reload. */
const POLL_MS = 3000;

/**
 * The signed-in person's machines, asked for again every few seconds while the page is in view.
 * `machines` is undefined until the first answer.
 */
export function useMachines() {
	let [machines, setMachines] = useState<Machine[]>();
	let [error, setError] = useState("");
	let [recommended, setRecommended] = useState<string | null>(null);
	useEffect(() => {
		let abort = new AbortController();
		let timer: number | undefined;
		let load = async () => {
			window.clearTimeout(timer);
			if (document.visibilityState !== "hidden") {
				try {
					setMachines(await listMachines(abort.signal));
					setError("");
				} catch (error) {
					if (abort.signal.aborted) return;
					setError(error instanceof Error ? error.message : "Could not load your machines");
				}
			}
			if (!abort.signal.aborted) timer = window.setTimeout(load, POLL_MS);
		};
		void load();
		document.addEventListener("visibilitychange", load);
		fetch("/api/connector/version", { signal: abort.signal })
			.then(response => response.ok ? response.json() : undefined)
			.then(value => setRecommended(value?.version ?? null), () => {});
		return () => {
			abort.abort();
			window.clearTimeout(timer);
			document.removeEventListener("visibilitychange", load);
		};
	}, []);
	let forget = (id: string) => setMachines(current => current?.filter(value => value.id !== id));
	return { machines, error, recommended, forget };
}

/** Asks before disconnecting a machine for good, which also stops the connector running on it. */
function DisconnectMachineDialog(
	{ machine, motion, onDisconnected, onDismiss }: {
		machine: Machine;
		motion: NavigationDialogMotion;
		onDisconnected: () => void;
		onDismiss: () => void;
	},
) {
	let cancel = useRef<HTMLButtonElement>(null);
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState("");
	let dismiss = () => {
		if (!busy) onDismiss();
	};
	async function disconnect() {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			await experimentRequest(
				`/api/connector/machines/${encodeURIComponent(machine.id)}/revoke`,
				{},
			);
			onDisconnected();
		} catch (error) {
			setError(error instanceof Error ? error.message : "Disconnect failed");
			setBusy(false);
		}
	}
	return (
		<NavigationDialog
			initialFocus={cancel}
			motion={motion}
			onDismiss={dismiss}
			title={`Disconnect ${machine.label}?`}
		>
			<p className="mt-2 text-sm text-text-secondary [overflow-wrap:anywhere]">
				The connector on{" "}
				<strong className="font-semibold text-text-primary">{machine.label}</strong>{" "}
				stops, and the machine is no longer paired with Chopin. To use it again, run{" "}
				<code className="font-mono text-text-primary">chopin connect</code> on it.
			</p>
			{error && (
				<TerminalAlert className="mt-3 text-sm text-destructive-ink">
					{error}
				</TerminalAlert>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<button
					className="btn btn-md btn-secondary"
					disabled={busy}
					onClick={dismiss}
					ref={cancel}
					type="button"
				>
					Cancel
				</button>
				<button
					className="btn btn-md btn-destructive"
					disabled={busy}
					onClick={() => void disconnect()}
					type="button"
				>
					{busy ? "Disconnecting..." : "Disconnect machine"}
				</button>
			</div>
		</NavigationDialog>
	);
}

/**
 * A row's actions menu. Disconnect is its one action, and it asks first. The menu sits on the
 * page, below its button, because the table's scrolling container would clip it. Its keys are the
 * document actions menu's: Up or Down on the button opens it, arrows, Home and End move within it,
 * and Escape closes it.
 */
function MachineActions({ machine, onDisconnect }: { machine: Machine; onDisconnect: () => void }) {
	let id = useId();
	let trigger = useRef<HTMLButtonElement>(null);
	let menu = useRef<HTMLDivElement>(null);
	let [open, setOpen] = useState(false);
	let initialItem = useRef<"first" | "last">("first");
	let presence = useTransitionPresence(open ? true : undefined, 150, motionImmediately());
	let mounted = presence.phase !== "closed";
	let close = (restoreFocus: boolean) => {
		setOpen(false);
		if (restoreFocus) trigger.current?.focus();
	};
	let openAt = (item: "first" | "last") => {
		initialItem.current = item;
		setOpen(true);
	};
	useMenuDismissal(open, [trigger, menu], close);
	useLayoutEffect(() => {
		if (!mounted) return;
		let place = () => {
			let anchor = trigger.current?.getBoundingClientRect();
			if (!anchor || !menu.current) return;
			menu.current.style.top = `${anchor.bottom + 4}px`;
			menu.current.style.right = `${document.documentElement.clientWidth - anchor.right}px`;
		};
		place();
		window.addEventListener("resize", place);
		document.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			document.removeEventListener("scroll", place, true);
		};
	}, [mounted]);
	useEffect(() => {
		if (!open) return;
		let items = menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]");
		items?.[initialItem.current === "last" ? items.length - 1 : 0]?.focus();
	}, [open]);
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
		let items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
		let current = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
		let next = action === "first"
			? 0
			: action === "last"
			? items.length - 1
			: action === "next"
			? (current + 1) % items.length
			: (current - 1 + items.length) % items.length;
		items[next]?.focus();
	};
	return (
		<>
			<IconButton
				aria-controls={open ? id : undefined}
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={`Actions for ${machine.label}`}
				data-tooltip="Machine actions"
				onClick={() => open ? close(false) : openAt("first")}
				onKeyDown={event => {
					if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
					event.preventDefault();
					openAt(event.key === "ArrowUp" ? "last" : "first");
				}}
				ref={trigger}
			>
				<EllipsisIcon aria-hidden="true" />
			</IconButton>
			{mounted && createPortal(
				<div
					aria-hidden={presence.phase === "closing" ? "true" : undefined}
					aria-label={`Actions for ${machine.label}`}
					className={`machines-menu motion-dropdown ${presence.className}`}
					id={id}
					inert={presence.phase === "closing"}
					onKeyDown={menuKeyDown}
					ref={menu}
					role="menu"
				>
					<MenuItem
						onClick={() => {
							setOpen(false);
							onDisconnect();
						}}
						tone="destructive"
					>
						<CloseIcon aria-hidden="true" size={14} />
						Disconnect machine
					</MenuItem>
				</div>,
				document.body,
			)}
		</>
	);
}

function Status({ machine, now }: { machine: Machine; now: number }) {
	if (machine.reauthorize) {
		return (
			<span className="machines-stack">
				<span className="text-warning-ink">Needs pairing again</span>
				<span className="machines-detail">
					Run <code className="font-mono">chopin pair</code> on it
				</span>
			</span>
		);
	}
	if (machine.connected) {
		return (
			<span className="machines-connected">
				<span aria-hidden="true" className="machines-connected-dot" />
				Connected
			</span>
		);
	}
	return (
		<span className="text-text-secondary">
			Last seen {ago(new Date(machine.lastSeenAt).toISOString(), now) ?? "a while ago"}
		</span>
	);
}

/**
 * The machine's chopin release. Unknown reads as a dash under the Version heading; on a phone,
 * where the version sits under the name without that heading, it says so in words.
 */
function Version(
	{ inline = false, machine, recommended }: {
		inline?: boolean;
		machine: Machine;
		recommended: string | null;
	},
) {
	if (!machine.version) {
		if (inline) return <span className="text-text-tertiary">Version unknown</span>;
		return (
			<span className="text-text-tertiary">
				<span aria-hidden="true">—</span>
				<span className="sr-only">Version unknown</span>
			</span>
		);
	}
	return (
		<span className="machines-version">
			<span className="tabular-nums">{machine.version}</span>
			{updateAvailable(machine.version, recommended) && (
				<span className="machines-update">Update available</span>
			)}
		</span>
	);
}

/** The person's paired machines as a table: what each runs, whether it is up, and its actions. */
export function MachineTable(
	{ labelledBy, machines, onForget, recommended }: {
		labelledBy: string;
		machines: Machine[];
		onForget: (id: string) => void;
		recommended: string | null;
	},
) {
	let [confirming, setConfirming] = useState<Machine>();
	let presence = useTransitionPresence(confirming, 150, motionImmediately());
	let now = Date.now();
	return (
		<>
			<Table aria-labelledby={labelledBy} className="machines-table" variant="contained">
				<TableHeader>
					<TableRow>
						<TableHead>Machine</TableHead>
						<TableHead className="machines-version-column">Version</TableHead>
						<TableHead>Status</TableHead>
						<TableHead className="machines-actions-column">
							<span className="sr-only">Actions</span>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{machines.map(machine => (
						<TableRow key={machine.id}>
							<TableCell>
								<span className="machines-stack">
									<span className="font-medium [overflow-wrap:anywhere]">{machine.label}</span>
									{!!machine.repositories.length && (
										<span className="machines-detail">{machine.repositories.join(", ")}</span>
									)}
									{machine.autoRun && (
										<span className="machines-detail">Builds and prototypes automatically</span>
									)}
									<span className="machines-version-inline machines-detail">
										<Version inline machine={machine} recommended={recommended} />
									</span>
								</span>
							</TableCell>
							<TableCell className="machines-version-column">
								<Version machine={machine} recommended={recommended} />
							</TableCell>
							<TableCell>
								<Status machine={machine} now={now} />
							</TableCell>
							<TableCell className="machines-actions-column">
								<MachineActions machine={machine} onDisconnect={() => setConfirming(machine)} />
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
			{presence.phase !== "closed" && (
				<DisconnectMachineDialog
					machine={presence.value}
					motion={presence}
					onDisconnected={() => {
						onForget(presence.value.id);
						setConfirming(undefined);
					}}
					onDismiss={() => setConfirming(undefined)}
				/>
			)}
		</>
	);
}
