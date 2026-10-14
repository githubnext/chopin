import { useEffect, useId, useState } from "react";
import { CheckIcon, CopyIcon, InfoIcon } from "@chopin/icons";
import { AGENTS, findAgent } from "./agents";
import {
	agentCommand,
	connectCommand,
	installCommand,
	runsAsService,
	SETUP_GUIDE_AGENTS,
	SETUP_GUIDE_TROUBLESHOOTING,
} from "./setup-commands";

import type { CSSProperties, ReactNode } from "react";
import type { CodingAgent } from "./agents";
import type { SetupShell } from "./setup-commands";

/**
 * A command to run, under a bar that names where to run it and copies it, so the button never
 * covers the command. Each line is its own block: on a desktop a longer line scrolls; on a phone
 * it wraps under a hanging indent, so every word stays in view. Copy takes `text` as it is. `rows`
 * keeps room for that many lines, so a shorter command doesn't pull up what follows.
 */
function Command(
	{ label, rows, shell, text }: { label: string; rows?: number; shell: SetupShell; text: string },
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
				<span className="machines-command-shell">
					{shell === "powershell" ? "PowerShell" : "Terminal"}
				</span>
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
			<pre style={rows ? { "--machines-command-rows": rows } as CSSProperties : undefined}>
				<code>
					{text.split("\n").map((line, index) => (
						<span className="machines-command-line" key={index}>{line}</span>
					))}
				</code>
			</pre>
		</div>
	);
}

const SHELLS: { shell: SetupShell; label: string }[] = [
	{ shell: "sh", label: "Linux and macOS" },
	{ shell: "powershell", label: "Windows" },
];

const AGENT_KEY = "chopin:machines:agent";

/** The picker's groups: what Chopin has been tried with first. */
const AGENT_GROUPS = [
	{ label: "Tested with Chopin", agents: AGENTS.filter(agent => agent.testedWithChopin) },
	{ label: "Not yet tested", agents: AGENTS.filter(agent => !agent.testedWithChopin) },
];

/**
 * Under the connect command: why the agent can run with nobody watching, or, for one that asks
 * for permission, that its terminal has to stay open and where the setting to change that is.
 */
function approvalNote(agent: CodingAgent): ReactNode {
	if (!runsAsService(agent)) {
		return (
			<p>
				Leave this terminal open: {agent.name}{" "}
				asks for permission here, so closing it disconnects the machine.{" "}
				<a href={SETUP_GUIDE_AGENTS} rel="noreferrer" target="_blank">Coding agents</a>{" "}
				in the setup guide has the setting that lets it run as a service.
			</p>
		);
	}
	return (
		<p className="machines-detail">
			{agent.autoApprove
				? (
					<>
						<code>{agent.autoApprove}</code> lets {agent.name}{" "}
						use its tools without asking, because nobody can answer a prompt in the background.
					</>
				)
				: `${agent.name} doesn't ask before it uses its tools, so nothing waits on a prompt in the background.`}
		</p>
	);
}

/**
 * What to run on a machine to set it up with this server: install chopin, install and sign in to
 * the picked coding agent, then connect a checkout, which pairs the machine through this browser
 * and installs the background service, unless the agent must ask in the terminal. The last step
 * is `last`: on a first run, the live wait for the machine.
 */
export function MachineSetup(
	{ headingId, last, title }: { headingId: string; last?: ReactNode; title: string },
) {
	let [shell, setShell] = useState<SetupShell>(() =>
		navigator.userAgent.includes("Windows") ? "powershell" : "sh"
	);
	let [agent, setAgent] = useState(() => findAgent(localStorage.getItem(AGENT_KEY)));
	let pickerId = useId();
	let noteId = useId();
	let service = runsAsService(agent);
	// The tallest connect command for this shell, whichever agent is picked.
	let connectRows = Math.max(
		...AGENTS.map(option => connectCommand(location.origin, shell, option).split("\n").length),
	);
	return (
		<section aria-labelledby={headingId} className="machines-setup">
			<h2 className="text-base font-semibold" id={headingId}>{title}</h2>
			<div className="machines-setup-choices">
				<div className="machines-agent">
					<label htmlFor={pickerId}>Coding agent</label>
					<select
						aria-describedby={noteId}
						className="field"
						id={pickerId}
						onChange={event => {
							let next = findAgent(event.currentTarget.value);
							localStorage.setItem(AGENT_KEY, next.id);
							setAgent(next);
						}}
						value={agent.id}
					>
						{AGENT_GROUPS.map(group => (
							<optgroup key={group.label} label={group.label}>
								{group.agents.map(option => (
									<option key={option.id} value={option.id}>{option.name}</option>
								))}
							</optgroup>
						))}
					</select>
				</div>
				<div aria-label="Operating system" className="machines-shells" role="group">
					{SHELLS.map(option => (
						<button
							aria-pressed={shell === option.shell}
							className="btn btn-sm"
							key={option.shell}
							onClick={() => setShell(option.shell)}
							type="button"
						>
							{option.label}
						</button>
					))}
				</div>
				{/* One line for every agent, so switching never moves the steps below. */}
				<p className="machines-agent-note" id={noteId}>
					{agent.testedWithChopin
						? <CheckIcon aria-hidden="true" size={14} />
						: <InfoIcon aria-hidden="true" size={14} />}
					<span>
						{agent.testedWithChopin ? "Tested with Chopin." : "Not yet tested with Chopin."}
					</span>
				</p>
			</div>
			<ol className="machines-steps">
				<li>
					<p>Install chopin.</p>
					<Command label="install command" shell={shell} text={installCommand(shell)} />
				</li>
				<li>
					<p>Install {agent.name} and sign in.</p>
					<Command label="agent commands" shell={shell} text={agentCommand(agent, shell)} />
				</li>
				<li>
					<p>
						{service
							? "In a checkout of your repository, run this. It pairs the machine and installs a background service, so it keeps running after you close the terminal or SSH."
							: "In a checkout of your repository, connect this machine."}
					</p>
					<Command
						label="connect command"
						rows={connectRows}
						shell={shell}
						text={connectCommand(location.origin, shell, agent)}
					/>
					{approvalNote(agent)}
				</li>
				<li>
					<p>
						Open the link it prints, check that the code matches, and choose Connect. GitHub may ask
						you to authorize the machine first.
						{service && (
							<>
								{" "}Then the service takes over; <code>chopin status</code> shows it.
							</>
						)}
					</p>
				</li>
				<li>
					{last ?? <p>It appears below under Your machines.</p>}
				</li>
			</ol>
			<p className="machines-detail">
				If a step doesn't work, see{" "}
				<a href={SETUP_GUIDE_TROUBLESHOOTING} rel="noreferrer" target="_blank">Troubleshooting</a>
				{" "}
				in the setup guide.
			</p>
		</section>
	);
}
