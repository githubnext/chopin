import type { Scenario } from "./scenarios";

let statuses: [Scenario, string, string][] = [
	["working", "Chopin is working · follow-ups will queue", "Stop button beside Send."],
	["paused", "Chopin is paused", "Play button beside Send."],
	["sending", "Sending…", "Spinner inside the Send button."],
	["queued", "1 message queued · send another follow-up", "Queued message in chat, with Withdraw."],
	[
		"error",
		"Message not sent. Your draft is here.",
		"Attached light-red panel above the input, with Retry.",
	],
	[
		"agent-off",
		"Chopin is unavailable. You can still chat.",
		"Attached light-grey panel; collaborator chat stays available.",
	],
	[
		"readonly",
		"You need write access to join the conversation.",
		"Read-only notice replaces the input inside the composer.",
	],
	[
		"archived",
		"Restore this document to continue the conversation.",
		"Archived notice replaces the input inside the composer.",
	],
	[
		"offline",
		"Connection lost. Your draft is here.",
		"Attached grey panel above the input, with Reconnect.",
	],
	[
		"connecting",
		"Connecting and synchronizing…",
		"Attached grey panel above the input, with a spinner and Retry.",
	],
];

export function StatusInventory({ onPreview }: { onPreview: (state: Scenario) => void }) {
	return (
		<section className="status-inventory" aria-label="Status locations">
			<h2>Where each status goes</h2>
			<p>All ten former messages below the input. Preview each replacement.</p>
			<div className="status-list">
				{statuses.map(([state, message, location]) => (
					<div className="status-row" key={state}>
						<span>{message}</span>
						<p>{location}</p>
						<button
							className="btn btn-sm btn-outline"
							onClick={() => onPreview(state)}
							aria-label={`Preview ${state}`}
						>
							Preview
						</button>
					</div>
				))}
			</div>
		</section>
	);
}
