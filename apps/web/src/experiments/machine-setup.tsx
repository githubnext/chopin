import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import {
	CheckIcon,
	ChevronIcon,
	CloseIcon,
	CopyIcon,
	MachineIcon,
	ServerIcon,
} from "@chopin/icons";
import { UnfoldPanel, UnfoldToggle, useUnfold } from "@chopin/visuals/unfold";
import { documentMenuKeyAction } from "../document-actions-menu";
import { IconButton } from "../icon-button";
import { useMenuDismissal } from "../menu-dismissal";
import { MenuItem } from "../menu-item";
import { motionImmediately } from "../motion-input";
import { NavigationDialog } from "../navigation-dialog";
import { session } from "../api";
import { useLogin } from "./machines";
import {
	agentCommand,
	agentOptions,
	chosenAgent,
	guessSystem,
	isSetupAgent,
	runsAsService,
	setupAgentCommand,
	setupAgentInstall,
	setupCommand,
	shellFor,
} from "./setup-commands";

import type { KeyboardEvent } from "react";
import type { SetupAgent } from "@chopin/protocol/agents";
import type { NavigationDialogMotion } from "../navigation-dialog";
import type { AgentOption, SetupShell, SetupSystem } from "./setup-commands";

/** A browser may wrap after a hyphen, so each flag, such as --install-service, is kept whole. */
function flagsWhole(line: string) {
	return line.split(/( )/).map((word, at) =>
		/^'?-/.test(word) ? <span className="machines-command-flag" key={at}>{word}</span> : word
	);
}

/**
 * A command to run, under a bar that says where to run it and copies it, so the button never
 * covers the command. Each line is its own block, and a longer one wraps under a hanging indent,
 * so every word stays in view. Copy takes `text` as it is.
 */
export function Command(
	{ label, place, text }: { label: string; place: string; text: string },
) {
	let [copied, setCopied] = useState<"copied" | "failed">();
	useEffect(() => {
		if (!copied) return;
		let timer = window.setTimeout(() => setCopied(undefined), 2000);
		return () => window.clearTimeout(timer);
	}, [copied]);
	return (
		<div className="machines-command">
			<div className="machines-command-head">
				<span className="machines-command-shell">{place}</span>
				<button
					aria-label={copied === "copied" ? "Copied" : `Copy ${label}`}
					className="btn btn-sm btn-ghost shrink-0"
					onClick={() =>
						navigator.clipboard.writeText(text).then(
							() => setCopied("copied"),
							() => setCopied("failed"),
						)}
					type="button"
				>
					{copied === "copied" ? <CheckIcon aria-hidden="true" /> : <CopyIcon />}
					{copied === "copied" ? "Copied" : copied === "failed" ? "Select to copy" : "Copy"}
				</button>
			</div>
			<pre>
				<code>
					{text.split("\n").map((line, index) => (
						<span className="machines-command-line" key={index}>{flagsWhole(line)}</span>
					))}
				</code>
			</pre>
		</div>
	);
}

/** Where a command for `shell` is run, as the bar over it says. */
export function shellPlace(shell: SetupShell) {
	return shell === "powershell" ? "PowerShell" : "Terminal";
}

/**
 * What the agent needs on the machine, with its install and sign-in commands on request. Where
 * npm's global folder belongs to root, `npm install -g` stops with EACCES; the fix that needs no
 * sudo is a global folder of the person's own.
 */
export function Needs({ agent, system }: { agent: AgentOption; system: SetupSystem }) {
	let install = useUnfold();
	let shell = shellFor(system);
	if (isSetupAgent(agent)) {
		return (
			<div className="machines-needs">
				<p>
					Install {agent.name} first.{" "}
					<UnfoldToggle className="machines-needs-toggle" unfold={install}>
						{install.open ? "Hide install steps" : "Show install steps"}
					</UnfoldToggle>
				</p>
				<UnfoldPanel unfold={install}>
					<div className="machines-needs-command">
						<Command
							label="install steps"
							place={shellPlace(shell)}
							text={setupAgentInstall(agent, system)}
						/>
					</div>
				</UnfoldPanel>
			</div>
		);
	}
	return (
		<div className="machines-needs">
			<p>
				Needs {agent.name}, signed in, and Node.js {agent.node} or newer.{" "}
				<UnfoldToggle className="machines-needs-toggle" unfold={install}>
					{install.open ? "Hide install command" : "Show install command"}
				</UnfoldToggle>
			</p>
			<UnfoldPanel unfold={install}>
				<div className="machines-needs-command">
					<Command
						label="install command"
						place={shellPlace(shell)}
						text={agentCommand(agent, shell)}
					/>
					{shell === "sh" && (
						<p className="machines-detail mt-2">
							If npm stops with EACCES, don't use sudo: run{" "}
							<code className="font-mono text-text-primary">
								npm config set prefix ~/.npm-global
							</code>, add <code className="font-mono text-text-primary">~/.npm-global/bin</code>
							{" "}
							to your PATH, then install again.
						</p>
					)}
				</div>
			</UnfoldPanel>
		</div>
	);
}

const SYSTEMS: { system: SetupSystem; label: string }[] = [
	{ system: "linux", label: "Linux" },
	{ system: "macos", label: "macOS" },
	{ system: "windows", label: "Windows" },
];

/** The machine's operating system, as a row of buttons; the one pressed picks the command. */
export function SystemChoice(
	{ onChange, system }: { onChange: (system: SetupSystem) => void; system: SetupSystem },
) {
	return (
		<div aria-label="Operating system" className="machines-systems" role="group">
			{SYSTEMS.map(option => (
				<button
					aria-pressed={system === option.system}
					className="btn btn-md btn-outline"
					key={option.system}
					onClick={() => onChange(option.system)}
					type="button"
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

/** Starts on `initial`, else the browser's own system, as the likeliest machine to set up. */
export function useSystem(initial?: SetupSystem) {
	return useState<SetupSystem>(() => initial ?? guessSystem(navigator.userAgent));
}

const AGENT_KEY = "chopin:machines:agent";

/** The deployment's setup agents, from the session; none until it answers. */
function useSetupAgents() {
	let [agents, setAgents] = useState<SetupAgent[]>([]);
	useEffect(() => {
		let current = true;
		session().then(value => current && setAgents(value.setupAgents ?? []), () => {});
		return () => {
			current = false;
		};
	}, []);
	return agents;
}

/**
 * What the command sets up for a server or your computer, and the options to pick from: the
 * person's own pick, remembered in this browser for next time, else the deployment's default.
 */
export function useAgent(kind: "server" | "computer") {
	let setupAgents = useSetupAgents();
	let [picked, setPicked] = useState(() => localStorage.getItem(AGENT_KEY));
	let choose = (id: string) => {
		localStorage.setItem(AGENT_KEY, id);
		setPicked(id);
	};
	return {
		agent: chosenAgent(picked, setupAgents, kind),
		options: agentOptions(setupAgents, kind),
		choose,
	};
}

export function AgentChoice(
	{ agent, onChange, options }: {
		agent: AgentOption;
		onChange: (id: string) => void;
		options: AgentOption[];
	},
) {
	let pickerId = useId();
	return (
		<div className="machines-agent">
			<label htmlFor={pickerId}>Coding agent</label>
			<select
				className="field"
				id={pickerId}
				onChange={event => onChange(event.currentTarget.value)}
				value={agent.id}
			>
				{options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
			</select>
		</div>
	);
}

export type MachineKind = "computer" | "server";

const KINDS: {
	kind: MachineKind;
	title: string;
	detail: string;
	Icon: typeof MachineIcon;
}[] = [
	{
		kind: "computer",
		title: "Your computer",
		detail: "Connect a laptop or desktop you use. You approve it in this browser.",
		Icon: MachineIcon,
	},
	{
		kind: "server",
		title: "Server or VM",
		detail: "Keep a remote machine connected in the background, with a one-time key.",
		Icon: ServerIcon,
	},
];

/**
 * Add machine, and its menu of the two kinds of machine. The menu sits on the page under its
 * button, at the button's end where it fits. Its keys are the document actions menu's: Up or Down
 * on the button opens it, arrows, Home and End move within it, and Escape closes it.
 */
export function AddMachineMenu(
	{ appearance = "button", onChoose }: {
		/** `link`: the words "Add machine" in running text, as under the table. */
		appearance?: "button" | "link";
		onChoose: (kind: MachineKind) => void;
	},
) {
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
			let margin = 8;
			let viewport = document.documentElement.clientWidth;
			let width = menu.current.offsetWidth;
			// Under the button's end on the page's right half, as in the header; else under its start.
			let start = anchor.left + anchor.width / 2 < viewport / 2
				? anchor.left
				: anchor.right - width;
			let left = Math.max(margin, Math.min(start, viewport - width - margin));
			menu.current.style.top = `${anchor.bottom + 4}px`;
			menu.current.style.left = `${left}px`;
			menu.current.style.setProperty(
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
			<button
				aria-controls={open ? id : undefined}
				aria-expanded={open}
				aria-haspopup="menu"
				className={appearance === "link"
					? "machines-link machines-add-link"
					: "btn btn-md btn-primary machines-add shrink-0"}
				onClick={() => open ? close(false) : openAt("first")}
				onKeyDown={event => {
					if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
					event.preventDefault();
					openAt(event.key === "ArrowUp" ? "last" : "first");
				}}
				ref={trigger}
				type="button"
			>
				Add machine
				{appearance === "button" && (
					<ChevronIcon aria-hidden="true" className="machines-add-chevron" size={12} />
				)}
			</button>
			{mounted && createPortal(
				<div
					aria-hidden={presence.phase === "closing" ? "true" : undefined}
					aria-label="Add machine"
					className={`machines-add-menu motion-dropdown ${presence.className}`}
					id={id}
					inert={presence.phase === "closing"}
					onKeyDown={menuKeyDown}
					ref={menu}
					role="menu"
				>
					{KINDS.map(({ kind, title, detail, Icon }) => (
						<MenuItem
							density="detailed"
							key={kind}
							onClick={() => {
								close(kind === "server");
								onChoose(kind);
							}}
						>
							<Icon aria-hidden="true" className="machines-add-icon" size={18} />
							<span className="machines-add-option">
								<span className="machines-add-title">{title}</span>
								<span className="machines-add-detail">{detail}</span>
							</span>
						</MenuItem>
					))}
				</div>,
				document.body,
			)}
		</>
	);
}

/**
 * Add your computer: install chopin and connect, with no key. The command prints a link to
 * approve in this browser; the machine then appears in the table, as in Tailscale.
 */
export function AddComputerDialog(
	{ motion, onDismiss }: { motion: NavigationDialogMotion; onDismiss: () => void },
) {
	let login = useLogin();
	let [system, setSystem] = useSystem();
	let { agent, options, choose } = useAgent("computer");
	let shell = shellFor(system);
	return (
		<NavigationDialog
			className="machines-computer-dialog"
			motion={motion}
			onDismiss={onDismiss}
			title="Add your computer"
		>
			<span className="machines-dialog-close">
				<IconButton aria-label="Close" data-tooltip="Close" onClick={onDismiss}>
					<CloseIcon aria-hidden="true" />
				</IconButton>
			</span>
			<div className="machines-dialog-body">
				<p className="machines-dialog-lead">
					Install chopin on it and connect as {login
						? <strong className="font-semibold text-text-primary">@{login}</strong>
						: "your GitHub account"}.
				</p>
				<SystemChoice onChange={setSystem} system={system} />
				<div className="machines-dialog-agent">
					<AgentChoice agent={agent} onChange={choose} options={options} />
					<Needs agent={agent} system={system} />
				</div>
				<div className="machines-run">
					<p className="machines-run-lead">In a terminal, run:</p>
					<Command
						label="setup command"
						place={shellPlace(shell)}
						text={isSetupAgent(agent)
							? setupAgentCommand(agent, system, { origin: location.origin }) ?? ""
							: setupCommand(location.origin, shell, agent)}
					/>
					{!isSetupAgent(agent) && (
						<p className="machines-detail">
							It prints a link; open it here and approve.
							{!runsAsService(agent) && " Keep the terminal open."}
						</p>
					)}
				</div>
			</div>
		</NavigationDialog>
	);
}
