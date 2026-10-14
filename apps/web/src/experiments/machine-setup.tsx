import { useEffect, useId, useState } from "react";
import { CheckIcon, CopyIcon, InfoIcon } from "@chopin/icons";
import { AGENTS, findAgent } from "./agents";
import {
	agentCommand,
	connectCommand,
	installCommand,
	runsAsService,
	SETUP_GUIDE,
} from "./setup-commands";

import type { ReactNode } from "react";
import type { CodingAgent } from "./agents";
import type { SetupShell } from "./setup-commands";

/**
 * A command to run, under a bar that names where to run it and copies it, so the button never
 * covers the command. Its lines break only where the command does; a longer line scrolls.
 */
function Command({ label, shell, text }: { label: string; shell: SetupShell; text: string }) {
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
			<pre>
				<code>{text}</code>
			</pre>
		</div>
	);
}

const SHELLS: { shell: SetupShell; label: string }[] = [
	{ shell: "sh", label: "Linux and macOS" },
	{ shell: "powershell", label: "Windows" },
];

const AGENT_KEY = "chopin:machines:agent";

/**
 * One note on what to know about the picked agent; nothing for a tested one that runs as the
 * service. The setup guide says how to let an agent that asks run as a service.
 */
function agentNote(agent: CodingAgent): string | undefined {
	let notes = [
		...(agent.testedWithChopin ? [] : ["Not yet tested with Chopin."]),
		...(runsAsService(agent) ? [] : [
			`${agent.name} asks for permission in the terminal, so it runs there instead of as a service. Keep that terminal open.`,
		]),
	];
	return notes.length ? notes.join(" ") : undefined;
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
	let note = agentNote(agent);
	let service = runsAsService(agent);
	return (
		<section aria-labelledby={headingId} className="machines-setup">
			<h2 className="text-base font-semibold" id={headingId}>{title}</h2>
			<div className="machines-setup-choices">
				<div className="machines-agent">
					<label htmlFor={pickerId}>Coding agent</label>
					<select
						aria-describedby={note ? noteId : undefined}
						className="field"
						id={pickerId}
						onChange={event => {
							let next = findAgent(event.currentTarget.value);
							localStorage.setItem(AGENT_KEY, next.id);
							setAgent(next);
						}}
						value={agent.id}
					>
						{AGENTS.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
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
				{note && (
					<p className="machines-agent-note" id={noteId}>
						<InfoIcon aria-hidden="true" size={14} />
						<span>{note}</span>
					</p>
				)}
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
						shell={shell}
						text={connectCommand(location.origin, shell, agent)}
					/>
				</li>
				<li>
					<p>
						Open the link it prints, check that the code matches, and choose Connect. GitHub may ask
						you to authorize the machine first.
						{service && " Then the service takes over; chopin status shows it."}
					</p>
				</li>
				<li>
					{last ?? <p>It appears below under Your machines.</p>}
				</li>
			</ol>
			<p className="machines-detail">
				<a href={SETUP_GUIDE} rel="noreferrer" target="_blank">Read the setup guide</a>{" "}
				for other coding agents and Planners.
			</p>
		</section>
	);
}
