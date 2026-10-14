import { useEffect, useId, useState } from "react";
import { CheckIcon, CopyIcon, GitHubIcon, RestartIcon } from "@chopin/icons";
import { AGENTS, findAgent } from "@chopin/protocol/agents";
import { InlineNotice } from "@chopin/visuals/inline-notice";
import { UnfoldPanel, UnfoldToggle, useUnfold } from "@chopin/visuals/unfold";
import { keyProblem } from "./pairing-problems";
import { expiryLabel, usePairingKey } from "./pairing-key";
import { agentCommand, runsAsService, SETUP_GUIDE, setupCommand } from "./setup-commands";

import type { ReactNode } from "react";
import type { CodingAgent } from "@chopin/protocol/agents";
import type { PairingKey } from "./pairing-key";
import type { SetupShell } from "./setup-commands";

/**
 * A command to run, under a bar that says where to run it and copies it, so the button never
 * covers the command. Each line is its own block: on a desktop a longer line scrolls; on a phone
 * it wraps under a hanging indent, so every word stays in view. Copy takes `text` as it is.
 */
function Command(
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
						<span className="machines-command-line" key={index}>{line}</span>
					))}
				</code>
			</pre>
		</div>
	);
}

/**
 * The setup command's place while it has no key to show: being made, waiting on GitHub, run out,
 * or refused. It keeps the well's shape, so the card doesn't jump when the command arrives.
 */
function Pending({ pairing, renew }: { pairing: PairingKey; renew: () => void }) {
	if (pairing.state === "failed") {
		let problem = keyProblem(pairing.code);
		return (
			<InlineNotice
				actions={problem.retry && (
					<button className="btn btn-compact btn-outline" onClick={renew} type="button">
						<RestartIcon aria-hidden="true" />
						Try again
					</button>
				)}
				message={problem.body}
				title={problem.title}
			/>
		);
	}
	let busy = pairing.state === "minting" || pairing.state === "authorize" && pairing.going;
	return (
		<div aria-busy={busy || undefined} className="machines-command" data-pending={pairing.state}>
			<div className="machines-command-pending">
				{pairing.state === "minting"
					? <p>Making a single-use key…</p>
					: pairing.state === "authorize"
					? (
						<>
							<p>
								{pairing.going
									? "Checking with GitHub…"
									: "GitHub confirms it's you before Chopin makes a key."}
							</p>
							{!pairing.going && (
								<button className="btn btn-md btn-primary" onClick={renew} type="button">
									<GitHubIcon aria-hidden="true" />
									Continue with GitHub
								</button>
							)}
						</>
					)
					: (
						<>
							<p>This key expired.</p>
							<button className="btn btn-md btn-primary" onClick={renew} type="button">
								<RestartIcon aria-hidden="true" />
								New key
							</button>
						</>
					)}
			</div>
		</div>
	);
}

/** A key's time left, said again each quarter minute. */
function Expiry({ expiresAt }: { expiresAt: number }) {
	let [now, setNow] = useState(Date.now);
	useEffect(() => {
		let timer = window.setInterval(() => setNow(Date.now()), 15_000);
		return () => window.clearInterval(timer);
	}, []);
	return <span className="machines-key-expiry">{expiryLabel(expiresAt, now)}</span>;
}

/** What the agent needs on the machine, with its install and sign-in commands on request. */
function Needs({ agent, shell }: { agent: CodingAgent; shell: SetupShell }) {
	let install = useUnfold();
	return (
		<div className="machines-needs">
			<p>
				Needs {agent.name}, signed in.{" "}
				<UnfoldToggle className="machines-needs-toggle" unfold={install}>
					{install.open ? "Hide install command" : "Show install command"}
				</UnfoldToggle>
			</p>
			<UnfoldPanel unfold={install}>
				<div className="machines-needs-command">
					<Command
						label="install command"
						place={shell === "powershell" ? "PowerShell" : "Terminal"}
						text={agentCommand(agent, shell)}
					/>
				</div>
			</UnfoldPanel>
		</div>
	);
}

const SHELLS: { shell: SetupShell; label: string }[] = [
	{ shell: "sh", label: "Linux and macOS" },
	{ shell: "powershell", label: "Windows" },
];

const AGENT_KEY = "chopin:machines:agent";

/**
 * Set up a machine with one command: pick the system and the coding agent, copy the command, run
 * it in a checkout. It installs chopin and pairs with a single-use key minted while the card is
 * `open`, so the machine needs no browser. `status` follows the command: the live wait for it.
 */
export function MachineSetup(
	{ headingId, open, status, title }: {
		headingId: string;
		open: boolean;
		status: ReactNode;
		title: string;
	},
) {
	let [shell, setShell] = useState<SetupShell>(() =>
		navigator.userAgent.includes("Windows") ? "powershell" : "sh"
	);
	let [agent, setAgent] = useState(() => findAgent(localStorage.getItem(AGENT_KEY)));
	let { key: pairing, renew } = usePairingKey(open);
	let pickerId = useId();
	return (
		<section aria-labelledby={headingId} className="machines-setup">
			<div className="machines-setup-head">
				<h2 className="text-base font-semibold" id={headingId}>{title}</h2>
				<a className="machines-docs" href={SETUP_GUIDE} rel="noreferrer" target="_blank">Docs</a>
			</div>
			<div className="machines-setup-choices">
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
			</div>
			<Needs agent={agent} shell={shell} />
			<div className="machines-run">
				{pairing.state === "ready"
					? (
						<Command
							label="setup command"
							place={`${shell === "powershell" ? "PowerShell" : "Terminal"}, in your repository`}
							text={setupCommand(location.origin, shell, agent, pairing.key)}
						/>
					)
					: <Pending pairing={pairing} renew={renew} />}
				<div className="machines-run-status">
					{status}
					{pairing.state === "ready" && (
						<span className="machines-key">
							<Expiry expiresAt={pairing.expiresAt} />
							<button className="btn btn-sm btn-ghost" onClick={renew} type="button">
								<RestartIcon aria-hidden="true" />
								New key
							</button>
						</span>
					)}
				</div>
				{!runsAsService(agent) && <p className="machines-detail">Keep this terminal open.</p>}
			</div>
		</section>
	);
}
