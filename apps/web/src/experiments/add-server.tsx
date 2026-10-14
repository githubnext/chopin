import { useEffect, useId, useState } from "react";
import { GitHubIcon, RestartIcon } from "@chopin/icons";
import { InlineNotice } from "@chopin/visuals/inline-notice";
import {
	AgentChoice,
	Command,
	Needs,
	shellPlace,
	SystemChoice,
	useAgent,
	useSystem,
} from "./machine-setup";
import { expiryLabel, usePairingKey } from "./pairing-key";
import { keyProblem } from "./pairing-problems";
import { runsAsService, setupCommand, shellFor } from "./setup-commands";

import type { ReactNode } from "react";
import type { CodingAgent } from "@chopin/protocol/agents";
import type { PairingKey } from "./pairing-key";
import type { SetupSystem } from "./setup-commands";

/** The server page's choices, kept for this tab across the trip to GitHub and back. */
const SETTINGS_KEY = "chopin:machines:server";

type Settings = { system?: SetupSystem; background?: boolean; autoRun?: boolean; name?: string };

function storedSettings(): Settings {
	try {
		let value = JSON.parse(sessionStorage.getItem(SETTINGS_KEY) ?? "{}");
		return value && typeof value === "object" ? value as Settings : {};
	} catch {
		return {};
	}
}

/**
 * A setting that is on or off, as a switch at the end of its title with what it means under it.
 * `disabled` says why it can't change.
 */
function Setting(
	{ checked, children, disabled, onChange, title }: {
		checked: boolean;
		children: ReactNode;
		disabled?: ReactNode;
		onChange: (checked: boolean) => void;
		title: string;
	},
) {
	let titleId = useId();
	let detailId = useId();
	return (
		<div className="machines-setting">
			<div className="machines-setting-head">
				<h3 className="machines-setting-title" id={titleId}>{title}</h3>
				<button
					aria-checked={checked}
					aria-describedby={detailId}
					aria-labelledby={titleId}
					className="machines-switch"
					disabled={!!disabled}
					onClick={() => onChange(!checked)}
					role="switch"
					type="button"
				>
					<span aria-hidden="true" className="machines-switch-thumb" />
				</button>
			</div>
			<p className="machines-setting-detail" id={detailId}>{disabled ?? children}</p>
		</div>
	);
}

/** What stands in the command's place before there is a key to put in it. */
function Generate(
	{ autoRun, generate, pairing }: {
		autoRun: boolean;
		generate: (autoRun: boolean) => void;
		pairing: Exclude<PairingKey, { state: "ready" }>;
	},
) {
	if (pairing.state === "failed") {
		let problem = keyProblem(pairing.code);
		return (
			<InlineNotice
				actions={problem.retry && (
					<button
						className="btn btn-compact btn-outline"
						onClick={() => generate(autoRun)}
						type="button"
					>
						<RestartIcon aria-hidden="true" />
						Try again
					</button>
				)}
				message={problem.body}
				title={problem.title}
			/>
		);
	}
	if (pairing.state === "authorize") {
		return (
			<div className="machines-generate" aria-busy={pairing.going || undefined}>
				{pairing.going
					? <p className="machines-detail">Checking with GitHub…</p>
					: (
						<>
							<button
								className="btn btn-md btn-primary"
								onClick={() => generate(autoRun)}
								type="button"
							>
								<GitHubIcon aria-hidden="true" />
								Continue with GitHub
							</button>
							<p className="machines-detail">GitHub confirms it's you before Chopin makes a key.</p>
						</>
					)}
			</div>
		);
	}
	let busy = pairing.state === "minting";
	return (
		<div className="machines-generate">
			<button
				aria-busy={busy || undefined}
				className="btn btn-md btn-primary"
				disabled={busy}
				onClick={() => generate(autoRun)}
				type="button"
			>
				{busy
					? "Generating…"
					: pairing.state === "expired"
					? "Re-generate install script"
					: "Generate install script"}
			</button>
			{pairing.state === "expired" && <p className="machines-detail">That key expired.</p>}
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

/** The machine's name in Chopin, optional: chopin uses the machine's hostname without one. */
function MachineName({ name, onChange }: { name: string; onChange: (name: string) => void }) {
	let fieldId = useId();
	let helpId = useId();
	return (
		<div className="machines-setting">
			<div className="machines-name">
				<label htmlFor={fieldId}>Machine name</label>
				<input
					aria-describedby={helpId}
					autoComplete="off"
					className="field"
					id={fieldId}
					maxLength={64}
					onChange={event => onChange(event.currentTarget.value)}
					placeholder="hostname"
					spellCheck={false}
					value={name}
				/>
			</div>
			<p className="machines-setting-detail" id={helpId}>
				Optional. Without one, Chopin names the machine after its hostname.
			</p>
		</div>
	);
}

/** Why an agent that asks permission in the terminal can't run as the background service. */
function foreground(agent: CodingAgent) {
	if (agent.unattended === true) return undefined;
	return `${agent.name} asks for permission in the terminal, so it runs there. To run it in the background, ${agent.unattended.setting}, then use chopin connect --install-service.`;
}

/**
 * Add a server: name the machine if you like, choose the agent, whether it runs in the background and whether Chopin may build
 * and prototype on it by itself, then generate an install script with a single-use key, which
 * pairs the machine with no browser. The key is made only when Generate is pressed. The page ends
 * at the command; the machine appears in the Machines table when it connects.
 */
export function AddServerPage() {
	let [saved] = useState(storedSettings);
	let [system, setSystem] = useSystem(saved.system);
	let [agent, setAgent] = useAgent();
	let [background, setBackground] = useState(saved.background ?? true);
	let [autoRun, setAutoRun] = useState(saved.autoRun ?? false);
	let [name, setName] = useState(saved.name ?? "");
	let { key: pairing, generate, reset } = usePairingKey();
	useEffect(() => {
		try {
			sessionStorage.setItem(
				SETTINGS_KEY,
				JSON.stringify({ system, background, autoRun, name }),
			);
		} catch {
			// Without storage the page starts from its defaults after GitHub.
		}
	}, [system, background, autoRun, name]);
	let shell = shellFor(system);
	let unattended = runsAsService(agent);
	let runsInBackground = unattended && background;
	return (
		<ol className="machines-steps">
			<li className="machines-step">
				<h2 className="machines-step-title">Set up the machine</h2>
				<div className="machines-settings">
					<MachineName name={name} onChange={setName} />
					<div className="machines-setting">
						<AgentChoice agent={agent} onChange={setAgent} />
						<Needs agent={agent} shell={shell} />
					</div>
					<Setting
						checked={runsInBackground}
						disabled={foreground(agent)}
						onChange={setBackground}
						title="Run in the background"
					>
						chopin runs as a service that starts with the machine and stays connected after you log
						out.
					</Setting>
					<Setting
						checked={autoRun}
						onChange={value => {
							setAutoRun(value);
							// A key carries the choice it was made with, so a new choice needs a new key.
							if (pairing.state !== "idle") reset();
						}}
						title="Build and prototype automatically"
					>
						Off: work runs here only when you press Build or Run. On: Chopin can also rebuild what
						you built when its document changes, and prototype passages you write. Nobody else's
						work runs here.
					</Setting>
				</div>
			</li>
			<li className="machines-step">
				<h2 className="machines-step-title">Generate install script</h2>
				<SystemChoice onChange={setSystem} system={system} />
				{pairing.state === "ready"
					? (
						<div className="machines-run">
							<div className="machines-key">
								<button
									className="btn btn-md btn-secondary"
									onClick={() => generate(autoRun)}
									type="button"
								>
									Re-generate install script
								</button>
								<Expiry expiresAt={pairing.expiresAt} />
							</div>
							<p className="machines-run-lead">In your terminal, run:</p>
							<Command
								label="install script"
								place={shellPlace(shell)}
								text={setupCommand(location.origin, shell, agent, {
									key: pairing.key,
									background: runsInBackground,
									name,
								})}
							/>
							{!runsInBackground && <p className="machines-detail">Keep the terminal open.</p>}
						</div>
					)
					: <Generate autoRun={autoRun} generate={generate} pairing={pairing} />}
			</li>
		</ol>
	);
}
