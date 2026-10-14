import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import {
	CheckIcon,
	CloseIcon,
	CopyIcon,
	EllipsisIcon,
	PencilIcon,
	RestartIcon,
	StarIcon,
} from "@chopin/icons";
import { InlineNotice } from "@chopin/visuals/inline-notice";
import { documentMenuKeyAction } from "../document-actions-menu";
import { IconButton } from "../icon-button";
import { setFavorite } from "../machine-choice";
import { listMachines } from "../machine-summary";
import { useMenuDismissal } from "../menu-dismissal";
import { MenuItem, MenuSeparator } from "../menu-item";
import { motionImmediately } from "../motion-input";
import { NavigationDialog } from "../navigation-dialog";
import { TerminalAlert } from "../terminal-alert";
import { session } from "../api";
import { experimentRequest } from "./api";
import { listProblem } from "./pairing-problems";

import type { KeyboardEvent } from "react";
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
	/** Set or clear the favorite: starred at once, then as the server says. */
	let favor = async (id: string, favorite: boolean) => {
		let mark = (chosen: string | null) =>
			setMachines(current => current?.map(value => ({ ...value, favorite: value.id === chosen })));
		let before = machines?.find(value => value.favorite)?.id ?? null;
		mark(favorite ? id : before === id ? null : before);
		try {
			mark(await setFavorite(id, favorite));
		} catch {
			reload.current();
		}
	};
	return { machines, error, recommended, forget, retry, favor };
}

/**
 * The latest machine to turn up while the page was open, so it can be announced. The first answer
 * only sets what was already there.
 */
export function useArrivedMachine(list: Machine[] | undefined) {
	let [arrived, setArrived] = useState<Machine>();
	let known = useRef<Set<string>>(undefined);
	useEffect(() => {
		if (!list) return;
		let previous = known.current;
		known.current = new Set(list.map(machine => machine.id));
		let fresh = previous && list.find(machine => !previous.has(machine.id));
		if (fresh) setArrived(fresh);
	}, [list]);
	return arrived;
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

/** The signed-in person's GitHub login, asked for here so the first page load needn't carry it. */
export function useLogin() {
	let [login, setLogin] = useState<string>();
	useEffect(() => {
		let current = true;
		session().then(value => current && setLogin(value.user?.login), () => {});
		return () => {
			current = false;
		};
	}, []);
	return login;
}

/** Move within /connect as the navigation shell does for a link, so it renders the new view. */
export function goTo(path: string) {
	history.pushState(null, "", path);
	window.dispatchEvent(new PopStateEvent("popstate"));
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

/** Asks before disconnecting a machine for good, which also stops the connector running on it. */
export function DisconnectMachineDialog(
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
export type CopyItem = { label: string; command: string };

/**
 * A row's actions menu: Edit machine name, copy the command the machine's state asks for, then
 * Disconnect, which asks first. The menu sits on the page, below its button, because the table's scrolling
 * container would clip it. Its keys are the document actions menu's: Up or Down on the button
 * opens it, arrows, Home and End move within it, and Escape closes it.
 */
export function MachineActions(
	{ copies, machine, onDisconnect, onFavorite, onRename }: {
		copies: CopyItem[];
		machine: Machine;
		onDisconnect: () => void;
		/** Set or clear the machine as the favorite. */
		onFavorite?: () => void;
		onRename: () => void;
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
					<MenuItem
						onClick={() => {
							setOpen(false);
							onRename();
						}}
					>
						<PencilIcon aria-hidden="true" size={14} />
						Edit machine name…
					</MenuItem>
					{onFavorite && (
						<MenuItem
							onClick={() => {
								close(true);
								onFavorite();
							}}
						>
							<StarIcon aria-hidden="true" filled={machine.favorite} size={14} />
							{machine.favorite ? "Remove favorite" : "Set as favorite"}
						</MenuItem>
					)}
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
					<MenuSeparator />
					<MenuItem
						onClick={() => {
							setOpen(false);
							onDisconnect();
						}}
						tone="destructive"
					>
						<CloseIcon aria-hidden="true" size={14} />
						Disconnect machine…
					</MenuItem>
				</div>,
				document.body,
			)}
		</>
	);
}
