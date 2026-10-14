import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import {
	ArrowUpIcon,
	CheckIcon,
	CloseIcon,
	CopyIcon,
	EllipsisIcon,
	RestartIcon,
	SparkleIcon,
	WarningIcon,
} from "@chopin/icons";
import {
	Badge,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@chopin/visuals";
import { InlineNotice } from "@chopin/visuals/inline-notice";
import { ago } from "../build-model";
import { documentMenuKeyAction } from "../document-actions-menu";
import { IconButton } from "../icon-button";
import { listMachines, updateAvailable } from "../machine-summary";
import { useMenuDismissal } from "../menu-dismissal";
import { MenuItem, MenuSeparator } from "../menu-item";
import { motionImmediately } from "../motion-input";
import { NavigationDialog } from "../navigation-dialog";
import { TerminalAlert } from "../terminal-alert";
import { experimentRequest } from "./api";
import { listProblem } from "./pairing-problems";
import { pairCommand, SETUP_GUIDE_TROUBLESHOOTING, UPDATE_COMMAND } from "./setup-commands";

import type { KeyboardEvent, ReactNode } from "react";
import type { Machine } from "../machine-summary";
import type { NavigationDialogMotion } from "../navigation-dialog";

/** How often /connect asks again, so a machine that pairs shows up without a reload. */
const POLL_MS = 3000;

/**
 * The signed-in person's machines, asked for again every few seconds while the page is in view.
 * `machines` is undefined until the first answer; `error` is the server's code for the last
 * failed answer, which the page turns into words.
 */
export function useMachines() {
	let [machines, setMachines] = useState<Machine[]>();
	let [error, setError] = useState("");
	let [recommended, setRecommended] = useState<string | null>(null);
	let reload = useRef<() => void>(() => {});
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
					setError(error instanceof Error ? error.message : "unavailable");
				}
			}
			if (!abort.signal.aborted) timer = window.setTimeout(load, POLL_MS);
		};
		reload.current = () => void load();
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
	let retry = useCallback(() => reload.current(), []);
	return { machines, error, recommended, forget, retry };
}

/** Machines paired in this tab stay marked New until it closes, across /connect and pairing. */
const NEW_KEY = "chopin:new-machines";

function storedNew(): string[] {
	try {
		let value = JSON.parse(sessionStorage.getItem(NEW_KEY) ?? "[]");
		return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
	} catch {
		return [];
	}
}

/**
 * Which machines are new this session, and the latest to turn up while the page was open. The
 * first answer only sets what was already there; anything after it that was not is new.
 */
export function useNewMachines(list: Machine[] | undefined) {
	let [marked, setMarked] = useState<string[]>(storedNew);
	let [arrived, setArrived] = useState<Machine>();
	let known = useRef<Set<string>>(undefined);
	let mark = useCallback((ids: string[]) => {
		setMarked(current => {
			if (ids.every(id => current.includes(id))) return current;
			let next = [...new Set([...current, ...ids])];
			try {
				sessionStorage.setItem(NEW_KEY, JSON.stringify(next));
			} catch {
				// Without storage the mark lasts as long as the page.
			}
			return next;
		});
	}, []);
	useEffect(() => {
		if (!list) return;
		let previous = known.current;
		known.current = new Set(list.map(machine => machine.id));
		if (!previous) return;
		let fresh = list.filter(machine => !previous.has(machine.id));
		if (!fresh.length) return;
		setArrived(fresh[0]);
		mark(fresh.map(machine => machine.id));
	}, [list, mark]);
	return { arrived, marked: new Set(marked), mark };
}

/** A failed load of the machine list, in words, with a way to ask again now. */
export function MachinesProblem({ code, onRetry }: { code: string; onRetry: () => void }) {
	let problem = listProblem(code);
	return (
		<InlineNotice
			actions={problem.retry && (
				<button className="btn btn-compact btn-outline" onClick={onRetry} type="button">
					<RestartIcon aria-hidden="true" />
					Retry
				</button>
			)}
			message={problem.body}
			title={problem.title}
		/>
	);
}

/** Where the machine list will be, while its first answer is on the way. */
export function MachinesLoading() {
	return (
		<section aria-busy="true" aria-label="Your machines" className="machines-section">
			<h2 className="text-base font-semibold">Your machines</h2>
			<div aria-hidden="true" className="machines-skeleton">
				<span className="machines-skeleton-head" />
				<span className="machines-skeleton-row">
					<span className="machines-skeleton-stack">
						<span className="machines-skeleton-bar" data-width="name" />
						<span className="machines-skeleton-bar" data-width="detail" />
					</span>
					<span className="machines-skeleton-bar" data-width="status" />
				</span>
			</div>
			<p className="sr-only" role="status">Loading your machines…</p>
		</section>
	);
}

/** Copies `text`, then says Copied (or that it could not) for two seconds. */
function useCopy() {
	let [copied, setCopied] = useState<"copied" | "failed">();
	useEffect(() => {
		if (!copied) return;
		let timer = window.setTimeout(() => setCopied(undefined), 2000);
		return () => window.clearTimeout(timer);
	}, [copied]);
	let copy = (text: string) =>
		navigator.clipboard.writeText(text).then(
			() => setCopied("copied"),
			() => setCopied("failed"),
		);
	return { copied, copy };
}

/**
 * A command shown as itself, which copies on a press; its name says Copy, then Copied. The chip
 * is drawn inside the button, so on touch the button can take a full 44px row of its own.
 */
function CopyableCommand({ command }: { command: string }) {
	let { copied, copy } = useCopy();
	return (
		<button
			aria-label={copied === "copied" ? `Copied ${command}` : `Copy ${command}`}
			className="machines-copyable"
			data-tooltip={copied === "failed" ? "Select to copy" : undefined}
			onClick={() => void copy(command)}
			type="button"
		>
			<span className="machines-copyable-chip">
				<code>{command}</code>
				{copied === "copied"
					? <CheckIcon aria-hidden="true" className="machines-copyable-done" size={14} />
					: <CopyIcon />}
			</span>
		</button>
	);
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
	let [failed, setFailed] = useState(false);
	let dismiss = () => {
		if (!busy) onDismiss();
	};
	async function disconnect() {
		if (busy) return;
		setBusy(true);
		setFailed(false);
		try {
			await experimentRequest(
				`/api/connector/machines/${encodeURIComponent(machine.id)}/revoke`,
				{},
			);
			onDisconnected();
		} catch {
			setFailed(true);
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
			<p className="machines-dialog-copy mt-2 text-sm text-text-secondary">
				The connector on{" "}
				<strong className="font-semibold text-text-primary">{machine.label}</strong>{" "}
				stops, and the machine is no longer paired with Chopin. To use it again, run{" "}
				<code className="font-mono text-text-primary">chopin connect</code> on it.
			</p>
			{failed && (
				<TerminalAlert className="mt-3 text-sm text-destructive-ink">
					Couldn't disconnect {machine.label}. Check your connection, then try again.
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

/** A row menu item that copies a command; it says Copied, then the menu closes. */
type CopyItem = { label: string; command: string };

/**
 * A row's actions menu: copy the command the machine's state asks for, then Disconnect, which
 * asks first. The menu sits on the page, below its button, because the table's scrolling
 * container would clip it. Its keys are the document actions menu's: Up or Down on the button
 * opens it, arrows, Home and End move within it, and Escape closes it.
 */
function MachineActions(
	{ copies, machine, onDisconnect }: {
		copies: CopyItem[];
		machine: Machine;
		onDisconnect: () => void;
	},
) {
	let id = useId();
	let trigger = useRef<HTMLButtonElement>(null);
	let menu = useRef<HTMLDivElement>(null);
	let [open, setOpen] = useState(false);
	let [copied, setCopied] = useState<{ command: string; ok: boolean }>();
	let initialItem = useRef<"first" | "last">("first");
	let presence = useTransitionPresence(open ? true : undefined, 150, motionImmediately());
	let mounted = presence.phase !== "closed";
	let close = (restoreFocus: boolean) => {
		setOpen(false);
		if (restoreFocus) trigger.current?.focus();
	};
	let openAt = (item: "first" | "last") => {
		initialItem.current = item;
		setCopied(undefined);
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
	// A copied command shows its tick for a moment before the menu goes.
	useEffect(() => {
		if (!copied?.ok) return;
		let timer = window.setTimeout(() => {
			setOpen(false);
			trigger.current?.focus();
		}, 700);
		return () => window.clearTimeout(timer);
	}, [copied]);
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
					{copies.map(item => {
						let state = copied?.command === item.command ? copied : undefined;
						return (
							<MenuItem
								key={item.command}
								onClick={() =>
									navigator.clipboard.writeText(item.command).then(
										() => setCopied({ command: item.command, ok: true }),
										() => setCopied({ command: item.command, ok: false }),
									)}
							>
								{state?.ok
									? <CheckIcon aria-hidden="true" className="machines-copyable-done" size={14} />
									: <CopyIcon />}
								<span className="machines-menu-copy">
									{state?.ok ? "Copied" : item.label}
									<code>
										{state && !state.ok ? `Select to copy: ${item.command}` : item.command}
									</code>
								</span>
							</MenuItem>
						);
					})}
					{!!copies.length && <MenuSeparator />}
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
				<Badge
					className="machines-status-headline"
					icon={WarningIcon}
					label="Needs pairing again"
					size="sm"
					tone="warning"
				/>
				<span className="machines-detail">
					On it, run <CopyableCommand command={pairCommand(machine.label)} />
				</span>
			</span>
		);
	}
	if (machine.connected) {
		return (
			<span className="machines-connected machines-status-headline">
				<span aria-hidden="true" className="machines-connected-dot" />
				Connected
			</span>
		);
	}
	return (
		<span className="machines-status-headline text-text-secondary">
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
				<Badge icon={ArrowUpIcon} label="Update available" size="sm" tone="warning" />
			)}
		</span>
	);
}

/** The person's paired machines as a table: what each runs, whether it is up, and its actions. */
export function MachineTable(
	{ fresh, labelledBy, machines, onForget, recommended }: {
		/** Machines paired this session, marked New. */
		fresh: ReadonlySet<string>;
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
						<TableHead className="machines-status-column">Status</TableHead>
						<TableHead className="machines-actions-column">
							<span className="sr-only">Actions</span>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{!machines.length && (
						<TableRow>
							<TableCell className="machines-empty" colSpan={4}>No machines yet.</TableCell>
						</TableRow>
					)}
					{machines.map(machine => {
						let copies: CopyItem[] = [
							...(updateAvailable(machine.version, recommended)
								? [{ label: "Copy update command", command: UPDATE_COMMAND }]
								: []),
							...(machine.reauthorize
								? [{ label: "Copy pair command", command: pairCommand(machine.label) }]
								: []),
						];
						let isNew = fresh.has(machine.id);
						return (
							<TableRow data-new={isNew || undefined} key={machine.id}>
								<TableCell>
									<span className="machines-stack">
										<span className="machines-name-line">
											<span
												className="machines-name"
												data-tooltip={machine.label}
												data-tooltip-verbatim=""
											>
												{machine.label}
											</span>
											{isNew && (
												<Badge
													icon={SparkleIcon}
													label="New"
													size="sm"
													textSize="2xs"
													tone="neutral"
												/>
											)}
										</span>
										{!!machine.repositories.length && (
											<span className="machines-detail">{machine.repositories.join(", ")}</span>
										)}
										{machine.autoRun && (
											<span className="machines-detail">Builds and prototypes automatically</span>
										)}
										<span className="machines-version-inline machines-detail">
											<Version inline machine={machine} recommended={recommended} />
										</span>
										<span className="machines-status-inline">
											<Status machine={machine} now={now} />
										</span>
									</span>
								</TableCell>
								<TableCell className="machines-version-column">
									<Version machine={machine} recommended={recommended} />
								</TableCell>
								<TableCell className="machines-status-column">
									<Status machine={machine} now={now} />
								</TableCell>
								<TableCell className="machines-actions-column">
									<MachineActions
										copies={copies}
										machine={machine}
										onDisconnect={() => setConfirming(machine)}
									/>
								</TableCell>
							</TableRow>
						);
					})}
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

/** The person's machines under their heading, or what stopped them loading. */
export function YourMachines(
	{ fresh, machines }: {
		fresh: ReadonlySet<string>;
		machines: ReturnType<typeof useMachines>;
	},
) {
	let headingId = useId();
	let list = machines.machines;
	if (!list) {
		return machines.error
			? <MachinesProblem code={machines.error} onRetry={machines.retry} />
			: <MachinesLoading />;
	}
	return (
		<section aria-labelledby={headingId} className="machines-section">
			<h2 className="text-base font-semibold" id={headingId}>Your machines</h2>
			{machines.error && <MachinesProblem code={machines.error} onRetry={machines.retry} />}
			<MachineTable
				fresh={fresh}
				labelledBy={headingId}
				machines={list}
				onForget={machines.forget}
				recommended={machines.recommended}
			/>
		</section>
	);
}

/** How long step 5 waits before it links to troubleshooting when the machine hasn't turned up. */
const SLOW_HANDSHAKE_MS = 60_000;

/**
 * Step 5 of the first setup: waiting for the machine, then the machine, connected. A wait past a
 * minute adds a link to troubleshooting.
 */
export function Handshake({ machine }: { machine?: Machine }): ReactNode {
	let waiting = !machine?.connected;
	let [slow, setSlow] = useState(false);
	useEffect(() => {
		if (!waiting) return;
		let timer = window.setTimeout(() => setSlow(true), SLOW_HANDSHAKE_MS);
		return () => window.clearTimeout(timer);
	}, [waiting]);
	if (machine?.connected) {
		return (
			<p className="machines-handshake" data-state="connected">
				<CheckIcon aria-hidden="true" className="machines-handshake-check" size={16} />
				<span>{machine.label} connected</span>
			</p>
		);
	}
	return (
		<>
			<p className="machines-handshake">
				<span aria-hidden="true" className="machines-pulse" />
				<span>
					{machine
						? `${machine.label} is paired. Waiting for it to connect…`
						: "Waiting for your machine…"}
				</span>
			</p>
			{slow && (
				<p className="machines-detail">
					<a href={SETUP_GUIDE_TROUBLESHOOTING} rel="noreferrer" target="_blank">
						Troubleshooting
					</a>
				</p>
			)}
		</>
	);
}
