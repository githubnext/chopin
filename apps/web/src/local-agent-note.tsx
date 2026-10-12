import { useEffect, useState } from "react";

/** Where pairing problems are explained; the docs ship with the repository. */
const TROUBLESHOOTING =
	"https://github.com/githubnext/chopin/blob/main/docs/local-experiments.md#trouble-connecting";

/**
 * Download the connector this server serves and connect the current folder's checkout. Bun must
 * not load that folder's .env (it could redirect pairing) or bunfig.toml (it could run code).
 */
export function connectorCommand(origin: string): string {
	return `mkdir -p ~/.chopin && curl -fsSL ${origin}/connector.js -o ~/.chopin/connector.js`
		+ ` && CHOPIN_URL=${origin} bun --no-env-file --config=/dev/null`
		+ " ~/.chopin/connector.js connect . -- copilot --acp --allow-all";
}

/**
 * The answer to a `no-workspace` refusal: how to start a local agent, then press `action` again.
 * It stays until the person presses again, so a refused press never silently resets.
 */
export function LocalAgentNote({ action }: { action: string }) {
	let command = connectorCommand(location.origin);
	let [copied, setCopied] = useState<"copied" | "failed">();
	useEffect(() => {
		if (!copied) return;
		let timer = window.setTimeout(() => setCopied(undefined), 2000);
		return () => window.clearTimeout(timer);
	}, [copied]);
	return (
		<div className="agent-note">
			<p className="m-0">
				Your local agent isn’t connected. Run this in your project folder, then press {action}{" "}
				again.
			</p>
			<div className="agent-command">
				<code>{command}</code>
				<button
					className="btn btn-sm btn-ghost shrink-0"
					onClick={() =>
						navigator.clipboard.writeText(command).then(
							() => setCopied("copied"),
							() => setCopied("failed"),
						)}
					type="button"
				>
					{copied === "copied" ? "Copied" : copied === "failed" ? "Select to copy" : "Copy"}
				</button>
			</div>
			<p className="agent-note-detail">
				Needs <a href="https://bun.sh" rel="noreferrer" target="_blank">Bun</a>.{" "}
				<a href={TROUBLESHOOTING} rel="noreferrer" target="_blank">Trouble connecting?</a>
			</p>
		</div>
	);
}
