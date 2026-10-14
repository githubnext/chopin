import { useEffect, useId, useState } from "react";
import { CheckIcon, CopyIcon } from "@chopin/icons";
import { AGENTS, findAgent } from "@chopin/protocol/agents";
import {
	agentCommand,
	connectCommand,
	installCommand,
	runsAsService,
	SETUP_GUIDE,
} from "./setup-commands";

import type { ReactNode } from "react";
import type { SetupShell } from "./setup-commands";

/**
 * A command to run, under a bar that names where to run it and copies it, so the button never
 * covers the command. Each line is its own block: on a desktop a longer line scrolls; on a phone
 * it wraps under a hanging indent, so every word stays in view. Copy takes `text` as it is.
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

/**
 * What to run on a machine to set it up with this server: install chopin, install and sign in to
 * the picked coding agent, connect a checkout, then approve the pairing in the browser. The last
 * step is `last`: on a first run, the live wait for the machine.
 */
export function MachineSetup(
	{ headingId, last, title }: { headingId: string; last?: ReactNode; title: string },
) {
	let [shell, setShell] = useState<SetupShell>(() =>
		navigator.userAgent.includes("Windows") ? "powershell" : "sh"
	);
	let [agent, setAgent] = useState(() => findAgent(localStorage.getItem(AGENT_KEY)));
	let pickerId = useId();
	return (
		<section aria-labelledby={headingId} className="machines-setup">
			<h2 className="text-base font-semibold" id={headingId}>{title}</h2>
			<div className="machines-setup-choices">
				<div className="machines-agent">
					<label htmlFor={pickerId}>Coding agent</label>
					<select
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
			</div>
			<ol className="machines-steps">
				<li>
					<p>Install chopin</p>
					<Command label="install command" shell={shell} text={installCommand(shell)} />
				</li>
				<li>
					<p>Install {agent.name} and sign in</p>
					<Command label="agent commands" shell={shell} text={agentCommand(agent, shell)} />
				</li>
				<li>
					<p>Connect from your repository</p>
					<Command
						label="connect command"
						shell={shell}
						text={connectCommand(location.origin, shell, agent)}
					/>
					{!runsAsService(agent) && <p className="machines-detail">Keep this terminal open.</p>}
				</li>
				<li>
					<p>Open the link it prints, check the code, and approve</p>
				</li>
				<li>
					{last ?? <p>It appears below</p>}
				</li>
			</ol>
			<p className="machines-detail">
				<a href={SETUP_GUIDE} rel="noreferrer" target="_blank">Setup guide</a>
			</p>
		</section>
	);
}
