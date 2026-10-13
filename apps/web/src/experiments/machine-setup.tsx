import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "@chopin/icons";
import { connectCommand, installCommand, SETUP_GUIDE } from "./setup-commands";

import type { SetupShell } from "./setup-commands";

/**
 * A command to run, with a button above it that copies it, so the button never covers the command.
 * Its lines break only where the command does; a longer line scrolls.
 */
function Command({ label, text }: { label: string; text: string }) {
	let [copied, setCopied] = useState<"copied" | "failed">();
	useEffect(() => {
		if (!copied) return;
		let timer = window.setTimeout(() => setCopied(undefined), 2000);
		return () => window.clearTimeout(timer);
	}, [copied]);
	return (
		<div className="machines-command">
			<div className="machines-command-head">
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

/**
 * What to run on a machine to set it up with this server: install chopin, then connect a checkout,
 * which pairs the machine through this browser and keeps it running as a service.
 */
export function MachineSetup({ headingId, title }: { headingId: string; title: string }) {
	let [shell, setShell] = useState<SetupShell>(() =>
		navigator.userAgent.includes("Windows") ? "powershell" : "sh"
	);
	return (
		<section aria-labelledby={headingId} className="machines-setup">
			<div className="machines-setup-head">
				<h2 className="text-base font-semibold" id={headingId}>{title}</h2>
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
					<p>Install chopin.</p>
					<Command label="install command" text={installCommand(shell)} />
				</li>
				<li>
					<p>
						In a checkout of your repository, connect with your coding agent. It prints a link: open
						it in this browser to confirm the machine.
					</p>
					<Command label="connect command" text={connectCommand(location.origin, shell)} />
				</li>
				<li>
					<p>It appears below under Your machines.</p>
				</li>
			</ol>
			<p className="machines-detail">
				<a href={SETUP_GUIDE} rel="noreferrer" target="_blank">Read the setup guide</a>{" "}
				for other coding agents and Planners.
			</p>
		</section>
	);
}
