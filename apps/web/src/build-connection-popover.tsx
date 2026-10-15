import { Popover } from "@base-ui/react/popover";
import { UnfoldSection } from "@chopin/visuals/unfold";
import { useId, useState } from "react";

import { plannerConnectCommand } from "./build-connection";
import { connectorCommand } from "./local-agent-note";
import "./build-connection-popover.css";

export function BuildConnectionPopover({ documentURL, kind, outline, phone }: {
	documentURL: string;
	kind: "planner" | "agent";
	outline?: boolean;
	phone?: boolean;
}) {
	let field = useId();
	let [backend, setBackend] = useState("");
	let [copied, setCopied] = useState("");
	let planner = kind === "planner";
	let label = planner ? "Connect Chopin" : "Connect agent";
	let command = planner
		? plannerConnectCommand(documentURL, backend)
		: connectorCommand(new URL(documentURL).origin);
	let copy = (text: string, notice: string) => {
		void navigator.clipboard.writeText(text).then(
			() => setCopied(notice),
			() => setCopied("Select the text to copy"),
		);
	};
	let terminal = (
		<>
			{planner && (
				<label className="build-connection-field" htmlFor={field}>
					Planner command
					<input
						autoComplete="off"
						className="field"
						id={field}
						onChange={event => {
							setBackend(event.target.value);
							setCopied("");
						}}
						placeholder="Command that starts your Planner"
						spellCheck={false}
						value={backend}
					/>
				</label>
			)}
			{command && <pre className="build-connection-code"><code>{command}</code></pre>}
			<div className="build-connection-actions">
				<button
					className="btn btn-compact btn-outline"
					disabled={!command}
					onClick={() => copy(command, "Command copied")}
					type="button"
				>
					Copy command
				</button>
				<span className="text-xs text-text-tertiary">
					{planner ? "Chopin CLI required" : "Bun and Copilot CLI required"}
				</span>
			</div>
			{planner && (
				<p className="build-connection-note">
					Run in your project folder and keep the terminal open.
				</p>
			)}
		</>
	);
	return (
		<Popover.Root onOpenChange={() => setCopied("")}>
			<Popover.Trigger
				className={`build-connection-trigger ${
					phone
						? "build-status-link"
						: outline
						? "btn btn-compact btn-outline"
						: "btn btn-compact btn-primary build-plan shrink-0"
				}`}
			>
				{label}
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner align="end" className="build-connection-positioner" sideOffset={4}>
					<Popover.Popup aria-label={label} className="build-connection-popover">
						<p className="m-0">
							{planner
								? "Open your Planner and attach this document."
								: "Run this in your project folder, then approve the pairing page."}
						</p>
						{planner
							? (
								<>
									<div className="build-connection-url">
										<code>{documentURL}</code>
										<button
											className="btn btn-compact btn-outline shrink-0"
											onClick={() => copy(documentURL, "URL copied")}
											type="button"
										>
											Copy URL
										</button>
									</div>
									<UnfoldSection label="Use the terminal">{terminal}</UnfoldSection>
								</>
							)
							: terminal}
						<div className="build-connection-footer">
							<a
								href={planner
									? "https://github.com/githubnext/chopin/blob/main/docs/agent-connection.md#planner-backend-commands"
									: "https://github.com/githubnext/chopin/blob/main/docs/local-experiments.md#trouble-connecting"}
								rel="noreferrer"
								target="_blank"
							>
								{planner ? "Setup guide" : "Trouble connecting?"}
							</a>
							<span role="status">{copied}</span>
						</div>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
