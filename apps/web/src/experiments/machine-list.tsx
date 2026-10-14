import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { usePhoneWidth } from "@chopin/editor/pointer";
import {
	ArrowUpIcon,
	ChevronIcon,
	CloseIcon,
	CopyIcon,
	MachineIcon,
	PencilIcon,
	PlayIcon,
	SearchIcon,
	ServerIcon,
	StarIcon,
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
import { ago } from "../build-model";
import { FavoriteStar } from "../favorite-star";
import { IconButton } from "../icon-button";
import { updateAvailable } from "../machine-summary";
import { motionImmediately } from "../motion-input";
import { NavigationDialog } from "../navigation-dialog";
import { TerminalAlert } from "../terminal-alert";
import { experimentRequest } from "./api";
import { AddMachineMenu } from "./machine-setup";
import {
	DisconnectMachineDialog,
	goTo,
	MachineActions,
	MachinesLoading,
	MachinesProblem,
} from "./machines";
import { pairCommand, UPDATE_COMMAND } from "./setup-commands";

import type { ReactNode } from "react";
import type { Machine } from "../machine-summary";
import type { NavigationDialogMotion } from "../navigation-dialog";
import type { MachineKind } from "./machine-setup";
import type { CopyItem, useMachines } from "./machines";

export type MachineState = "connected" | "offline" | "reauthorize";

export function machineState(machine: Machine): MachineState {
	return machine.reauthorize ? "reauthorize" : machine.connected ? "connected" : "offline";
}

/** What the dot means, in words: the status line beside it, and the dot's own name where alone. */
export function statusWords(machine: Machine, now: number): string {
	let state = machineState(machine);
	if (state === "reauthorize") return "Needs pairing again";
	if (state === "connected") return "Connected";
	return `Last seen ${ago(new Date(machine.lastSeenAt).toISOString(), now) ?? "a while ago"}`;
}

const OS: Record<string, string> = { linux: "Linux", darwin: "macOS", win32: "Windows" };

export function platformName(platform: Machine["platform"]): string | undefined {
	return platform ? `${OS[platform.os] ?? platform.os} ${platform.arch}` : undefined;
}

function agentName(agent: Machine["agent"]): string | undefined {
	return agent ? [agent.name, agent.version].filter(Boolean).join(" ") : undefined;
}

/** Whether a search finds the machine, by anything the list shows about it. */
export function machineMatches(machine: Machine, query: string, login: string | undefined) {
	let words = query.trim().toLowerCase();
	if (!words) return true;
	return [
		machine.label,
		login && `${login}@github`,
		...machine.repositories,
		machine.version,
		machine.hostname,
		agentName(machine.agent),
		platformName(machine.platform),
	].some(value => value?.toLowerCase().includes(words));
}

/**
 * A machine's state as a small solid dot: success when connected, tertiary ink when not, warning
 * when it needs pairing again. Static; it changes as the list does. The words beside it say the
 * same, except where the dot stands alone, which names it with `label`. The sidebar's Machines
 * entry draws the same dot with the same class.
 */
export function StatusDot({ label, state }: { label?: string; state: MachineState }) {
	return label
		? <span aria-label={label} className="status-dot" data-state={state} role="img" />
		: <span aria-hidden="true" className="status-dot" data-state={state} />;
}

/** The dot, then the state in quiet words, as the Last seen column shows it. */
function Status({ machine, now }: { machine: Machine; now: number }) {
	return (
		<span className="machines-status">
			<StatusDot state={machineState(machine)} />
			{statusWords(machine, now)}
		</span>
	);
}

function Dash({ label }: { label: string }) {
	return (
		<span className="text-text-tertiary">
			<span aria-hidden="true">—</span>
			<span className="sr-only">{label}</span>
		</span>
	);
}

function copiesFor(machine: Machine, recommended: string | null): CopyItem[] {
	return [
		...(updateAvailable(machine.version, recommended)
			? [{ label: "Copy update command", command: UPDATE_COMMAND }]
			: []),
		...(machine.reauthorize
			? [{ label: "Copy pair command", command: pairCommand(machine.label) }]
			: []),
	];
}

/**
 * Edit a machine's name: shown in Chopin and by `chopin status`. One line of at most 64
 * characters, as the server takes it.
 */
function RenameMachineDialog(
	{ machine, motion, onDismiss, onRenamed }: {
		machine: Machine;
		motion: NavigationDialogMotion;
		onDismiss: () => void;
		onRenamed: (label: string) => void;
	},
) {
	let field = useRef<HTMLInputElement>(null);
	let fieldId = useId();
	let helpId = useId();
	let [label, setLabel] = useState(machine.label);
	let [busy, setBusy] = useState(false);
	let [failed, setFailed] = useState(false);
	let trimmed = label.trim();
	let dismiss = () => {
		if (!busy) onDismiss();
	};
	async function save() {
		if (busy || !trimmed) return;
		setBusy(true);
		setFailed(false);
		try {
			let result = await experimentRequest<{ label: string }>(
				`/api/connector/machines/${encodeURIComponent(machine.id)}/label`,
				{ label: trimmed },
			);
			onRenamed(result.label);
		} catch {
			setFailed(true);
			setBusy(false);
		}
	}
	return (
		<NavigationDialog
			className="machines-rename-dialog"
			initialFocus={field}
			motion={motion}
			onDismiss={dismiss}
			title={`Edit machine name for ${machine.label}`}
		>
			<span className="machines-dialog-close">
				<IconButton aria-label="Close" data-tooltip="Close" onClick={dismiss}>
					<CloseIcon aria-hidden="true" />
				</IconButton>
			</span>
			<form
				className="machines-dialog-body"
				onSubmit={event => {
					event.preventDefault();
					void save();
				}}
			>
				<p className="machines-dialog-lead">This name is shown in Chopin and in chopin status.</p>
				<div className="machines-rename-field">
					<label className="font-medium text-text-primary" htmlFor={fieldId}>Machine name</label>
					<input
						aria-describedby={helpId}
						autoComplete="off"
						className="field"
						disabled={busy}
						id={fieldId}
						maxLength={64}
						onChange={event => setLabel(event.currentTarget.value)}
						ref={field}
						spellCheck={false}
						value={label}
					/>
					<p className="machines-detail" id={helpId}>
						One line, up to 64 characters. The machine keeps its hostname.
					</p>
				</div>
				{failed && (
					<TerminalAlert className="text-sm text-destructive-ink">
						Couldn't rename {machine.label}. Check your connection, then try again.
					</TerminalAlert>
				)}
				<div className="flex justify-end gap-2">
					<button
						className="btn btn-md btn-secondary"
						disabled={busy}
						onClick={dismiss}
						type="button"
					>
						Cancel
					</button>
					<button
						className="btn btn-md btn-primary"
						disabled={busy || !trimmed || trimmed === machine.label}
						type="submit"
					>
						{busy ? "Updating…" : "Update name"}
					</button>
				</div>
			</form>
		</NavigationDialog>
	);
}

/** The rename and disconnect dialogs a list or detail view opens, and how they end. */
function useMachineDialogs(machines: ReturnType<typeof useMachines>, onDisconnected?: () => void) {
	let [renaming, setRenaming] = useState<Machine>();
	let [confirming, setConfirming] = useState<Machine>();
	let rename = useTransitionPresence(renaming, 150, motionImmediately());
	let disconnect = useTransitionPresence(confirming, 150, motionImmediately());
	let dialogs = (
		<>
			{rename.phase !== "closed" && (
				<RenameMachineDialog
					machine={rename.value}
					motion={rename}
					onDismiss={() => setRenaming(undefined)}
					onRenamed={() => {
						setRenaming(undefined);
						machines.retry();
					}}
				/>
			)}
			{disconnect.phase !== "closed" && (
				<DisconnectMachineDialog
					machine={disconnect.value}
					motion={disconnect}
					onDisconnected={() => {
						machines.forget(disconnect.value.id);
						setConfirming(undefined);
						onDisconnected?.();
					}}
					onDismiss={() => setConfirming(undefined)}
				/>
			)}
		</>
	);
	return { dialogs, rename: setRenaming, disconnect: setConfirming };
}

/** The desktop table, as Tailscale's: machine, host, version, agent, last seen, and actions. */
function MachineTable(
	{ labelledBy, list, login, machines, onRename, onDisconnect }: {
		labelledBy: string;
		list: Machine[];
		login: string | undefined;
		machines: ReturnType<typeof useMachines>;
		onRename: (machine: Machine) => void;
		onDisconnect: (machine: Machine) => void;
	},
) {
	let now = Date.now();
	return (
		<Table aria-labelledby={labelledBy} className="machines-table" variant="contained">
			<TableHeader>
				<TableRow>
					<TableHead>Machine</TableHead>
					<TableHead>Host</TableHead>
					<TableHead>Version</TableHead>
					<TableHead>Agent</TableHead>
					<TableHead className="machines-status-column">Last seen</TableHead>
					<TableHead className="machines-actions-column">
						<span className="sr-only">Actions</span>
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{!list.length && (
					<TableRow>
						<TableCell className="machines-empty" colSpan={6}>No machines match.</TableCell>
					</TableRow>
				)}
				{list.map(machine => {
					let owner = login ? `${login}@github` : undefined;
					return (
						<TableRow key={machine.id}>
							<TableCell>
								<span className="machines-stack">
									<span className="machines-name-line">
										<FavoriteStar
											favorite={machine.favorite}
											label={machine.label}
											onToggle={() => void machines.favor(machine.id, !machine.favorite)}
										/>
										<span className="machines-name">{machine.label}</span>
										{machine.service && (
											<Badge
												icon={ServerIcon}
												label="Service"
												size="sm"
												textSize="2xs"
												tone="neutral"
											/>
										)}
										{machine.autoRun && (
											<Badge
												icon={PlayIcon}
												label="Auto builds"
												size="sm"
												textSize="2xs"
												tone="success"
											/>
										)}
									</span>
									<span className="machines-secondary machines-truncate">
										{[owner, machine.repositories.join(", ")].filter(Boolean).join(" · ")}
									</span>
								</span>
							</TableCell>
							<TableCell>
								<span className="machines-stack">
									{machine.hostname
										? <span>{machine.hostname}</span>
										: <Dash label="Hostname unknown" />}
								</span>
							</TableCell>
							<TableCell>
								<span className="machines-stack">
									<span className="machines-version">
										{machine.version
											? <span className="tabular-nums">chopin {machine.version}</span>
											: <Dash label="Version unknown" />}
										{updateAvailable(machine.version, machines.recommended) && (
											<Badge
												icon={ArrowUpIcon}
												label="Update"
												size="sm"
												textSize="2xs"
												tone="warning"
											/>
										)}
									</span>
									{machine.platform && (
										<span className="machines-secondary">{platformName(machine.platform)}</span>
									)}
								</span>
							</TableCell>
							<TableCell>
								<span className="machines-stack">
									{machine.agent
										? <span>{agentName(machine.agent)}</span>
										: <Dash label="Agent unknown" />}
									{machine.planner && <span className="machines-secondary">Planner</span>}
								</span>
							</TableCell>
							<TableCell className="machines-status-column">
								<Status machine={machine} now={now} />
							</TableCell>
							<TableCell className="machines-actions-column">
								<MachineActions
									copies={copiesFor(machine, machines.recommended)}
									machine={machine}
									onDisconnect={() => onDisconnect(machine)}
									onFavorite={() => void machines.favor(machine.id, !machine.favorite)}
									onRename={() => onRename(machine)}
								/>
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}

/** Where the phone list was scrolled, so coming back from a machine finds it there. */
const SCROLL_KEY = "chopin:machines:scroll";

function page() {
	return document.querySelector<HTMLElement>(".machines-page");
}

/**
 * The phone list, as Tailscale's app: each machine a full-width row with its dot before its name,
 * a quiet second line, and a chevron to its own view.
 */
function MachineRows(
	{ list, login, machines }: {
		list: Machine[];
		login: string | undefined;
		machines: ReturnType<typeof useMachines>;
	},
) {
	let headingId = useId();
	let now = Date.now();
	let restored = useRef(false);
	useLayoutEffect(() => {
		if (restored.current || !list.length) return;
		restored.current = true;
		let top = Number(sessionStorage.getItem(SCROLL_KEY));
		if (top > 0) page()?.scrollTo({ top });
		sessionStorage.removeItem(SCROLL_KEY);
	}, [list.length]);
	return (
		<section aria-labelledby={headingId} className="machines-rows">
			<h3 className="machines-rows-heading" id={headingId}>
				{login ? `@${login}` : "Your machines"}
			</h3>
			{!list.length && <p className="machines-empty">No machines match.</p>}
			<ul>
				{list.map(machine => {
					let state = machineState(machine);
					let detail = state === "connected"
						? [
							machine.hostname,
							machine.version && `chopin ${machine.version}`,
							OS[machine.platform?.os ?? ""],
						]
							.filter(Boolean).join(" · ") || machine.repositories[0] || "Connected"
						: statusWords(machine, now);
					return (
						<li className="machines-row-item" key={machine.id}>
							<FavoriteStar
								favorite={machine.favorite}
								label={machine.label}
								onToggle={() => void machines.favor(machine.id, !machine.favorite)}
								touch
							/>
							<button
								className="machines-row"
								onClick={() => {
									sessionStorage.setItem(SCROLL_KEY, String(page()?.scrollTop ?? 0));
									goTo(`/connect?machine=${encodeURIComponent(machine.id)}`);
								}}
								type="button"
							>
								<span className="machines-row-text">
									<span className="machines-row-name">
										<StatusDot label={statusWords(machine, now)} state={state} />
										<span className="machines-name">{machine.label}</span>
										<MachineIcon aria-hidden="true" className="machines-row-icon" size={14} />
									</span>
									<span className="machines-secondary machines-truncate">{detail}</span>
								</span>
								<ChevronIcon aria-hidden="true" className="machines-row-chevron" size={12} />
							</button>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/**
 * The person's machines: a search, how many there are, then the table on a desktop or the list on
 * a phone or a window as narrow as one, and a quiet way to add another. With none yet, nothing: the page's banner offers the
 * first. The table asks again every few seconds, so a machine appears as it connects.
 */
export function YourMachines(
	{ login, machines, onChoose }: {
		login: string | undefined;
		machines: ReturnType<typeof useMachines>;
		onChoose: (kind: MachineKind) => void;
	},
) {
	let headingId = useId();
	let phone = usePhoneWidth();
	let [query, setQuery] = useState("");
	let { dialogs, rename, disconnect } = useMachineDialogs(machines);
	let all = machines.machines;
	if (!all) {
		return machines.error
			? <MachinesProblem code={machines.error} onRetry={machines.retry} />
			: <MachinesLoading />;
	}
	if (!all.length) {
		return machines.error
			? <MachinesProblem code={machines.error} onRetry={machines.retry} />
			: null;
	}
	let list = all.filter(machine => machineMatches(machine, query, login));
	return (
		<section aria-labelledby={headingId} className="machines-section">
			<h2 className="sr-only" id={headingId}>Your machines</h2>
			{machines.error && <MachinesProblem code={machines.error} onRetry={machines.retry} />}
			<label className="machines-search">
				<SearchIcon aria-hidden="true" className="machines-search-icon" size={14} />
				<span className="sr-only">Search machines</span>
				<input
					className="field"
					onChange={event => setQuery(event.currentTarget.value)}
					placeholder={phone ? "Search" : "Search by name, owner, repository, version…"}
					type="search"
					value={query}
				/>
			</label>
			{!phone && (
				<span className="machines-count">
					{query ? `${list.length} of ${all.length}` : all.length}{" "}
					machine{all.length === 1 ? "" : "s"}
				</span>
			)}
			{phone
				? <MachineRows list={list} login={login} machines={machines} />
				: (
					<MachineTable
						labelledBy={headingId}
						list={list}
						login={login}
						machines={machines}
						onDisconnect={disconnect}
						onRename={rename}
					/>
				)}
			<p className="machines-more">
				Connect more machines with <AddMachineMenu appearance="link" onChoose={onChoose} />.
			</p>
			{dialogs}
		</section>
	);
}

/**
 * One machine on a phone, at /connect?machine=<id>: its name and state, what it is, and its
 * actions as full-width rows. Back returns to the list where it was.
 */
export function MachineDetail(
	{ id, login, machines }: {
		id: string;
		login: string | undefined;
		machines: ReturnType<typeof useMachines>;
	},
) {
	let machine = machines.machines?.find(value => value.id === id);
	let { dialogs, rename, disconnect } = useMachineDialogs(machines, () => goTo("/connect"));
	let [copied, setCopied] = useState<string>();
	useEffect(() => {
		if (!copied) return;
		let timer = window.setTimeout(() => setCopied(undefined), 1500);
		return () => window.clearTimeout(timer);
	}, [copied]);
	if (!machines.machines) {
		return machines.error
			? <MachinesProblem code={machines.error} onRetry={machines.retry} />
			: <MachinesLoading />;
	}
	if (!machine) return <p className="machines-empty">This machine isn't paired any more.</p>;
	let now = Date.now();
	let facts: [string, ReactNode][] = [
		["Status", <Status key="status" machine={machine} now={now} />],
		["Owner", login ? `${login}@github` : undefined],
		["Hostname", machine.hostname],
		["System", platformName(machine.platform)],
		[
			"Version",
			machine.version && (
				<span className="machines-version" key="version">
					chopin {machine.version}
					{updateAvailable(machine.version, machines.recommended) && (
						<Badge icon={ArrowUpIcon} label="Update available" size="sm" tone="warning" />
					)}
				</span>
			),
		],
		[
			"Agent",
			[agentName(machine.agent), machine.planner && "runs Planners"].filter(Boolean).join(", "),
		],
		["Repositories", machine.repositories.join(", ")],
		[
			"Runs",
			[machine.service && "as the service", machine.autoRun && "builds automatically"].filter(
				Boolean,
			)
				.join(", "),
		],
	];
	return (
		<div className="machines-detail-view">
			<dl className="machines-facts">
				{facts.filter(([, value]) => value).map(([name, value]) => (
					<div key={name}>
						<dt>{name}</dt>
						<dd>{value}</dd>
					</div>
				))}
			</dl>
			<ul aria-label={`Actions for ${machine.label}`} className="machines-detail-actions">
				<li>
					<button className="machines-row" onClick={() => rename(machine)} type="button">
						<PencilIcon aria-hidden="true" size={14} />
						Edit machine name…
					</button>
				</li>
				<li>
					<button
						aria-pressed={machine.favorite}
						className="machines-row"
						onClick={() => void machines.favor(machine.id, !machine.favorite)}
						type="button"
					>
						<StarIcon aria-hidden="true" filled={machine.favorite} size={14} />
						{machine.favorite ? "Remove favorite" : "Set as favorite"}
					</button>
				</li>
				{copiesFor(machine, machines.recommended).map(item => (
					<li key={item.command}>
						<button
							className="machines-row"
							onClick={() =>
								navigator.clipboard.writeText(item.command).then(
									() => setCopied(item.command),
									() => {},
								)}
							type="button"
						>
							<CopyIcon />
							<span className="machines-row-text">
								{copied === item.command ? "Copied" : item.label}
								<code className="machines-secondary">{item.command}</code>
							</span>
						</button>
					</li>
				))}
				<li>
					<button
						className="machines-row"
						data-tone="destructive"
						onClick={() => disconnect(machine)}
						type="button"
					>
						<CloseIcon aria-hidden="true" size={14} />
						Disconnect machine…
					</button>
				</li>
			</ul>
			{dialogs}
		</div>
	);
}
