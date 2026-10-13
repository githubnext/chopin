import { useEffect, useRef, useState } from "react";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { ago } from "../build-model";
import { motionImmediately } from "../motion-input";
import { NavigationDialog } from "../navigation-dialog";
import { TerminalAlert } from "../terminal-alert";
import { experimentRequest } from "./api";

import type { NavigationDialogMotion } from "../navigation-dialog";

type Machine = {
	id: string;
	label: string;
	repositories: string[];
	autoRun: boolean;
	lastSeenAt: number;
	connected: boolean;
	/** GitHub stopped accepting the machine's authorization; it needs pairing again. */
	reauthorize: boolean;
};

function status(machine: Machine, now: number) {
	if (machine.reauthorize) return "Needs pairing again: run chopin pair on it";
	if (machine.connected) return "Connected";
	return `Last seen ${ago(new Date(machine.lastSeenAt).toISOString(), now) ?? "a while ago"}`;
}

/** Asks before disconnecting a machine for good, which also stops the connector running on it. */
function DisconnectMachineDialog(
	{ machine, motion, onDisconnected, onDismiss }: {
		machine: Machine;
		motion: NavigationDialogMotion;
		onDisconnected: () => void;
		onDismiss: () => void;
	},
) {
	let cancel = useRef<HTMLButtonElement>(null);
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState("");
	let dismiss = () => {
		if (!busy) onDismiss();
	};
	async function disconnect() {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			await experimentRequest(
				`/api/connector/machines/${encodeURIComponent(machine.id)}/revoke`,
				{},
			);
			onDisconnected();
		} catch (error) {
			setError(error instanceof Error ? error.message : "Disconnect failed");
			setBusy(false);
		}
	}
	return (
		<NavigationDialog
			initialFocus={cancel}
			motion={motion}
			onDismiss={dismiss}
			title={`Disconnect ${machine.label}?`}
		>
			<p className="mt-2 text-sm text-text-secondary [overflow-wrap:anywhere]">
				The connector on{" "}
				<strong className="font-semibold text-text-primary">{machine.label}</strong>{" "}
				stops, and the machine is no longer paired with Chopin. To use it again, run{" "}
				<code className="font-mono text-text-primary">chopin connect</code> on it.
			</p>
			{error && (
				<TerminalAlert className="mt-3 text-sm text-destructive-ink">
					{error}
				</TerminalAlert>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<button
					className="btn btn-md btn-secondary"
					disabled={busy}
					onClick={dismiss}
					ref={cancel}
					type="button"
				>
					Cancel
				</button>
				<button
					className="btn btn-md btn-destructive"
					disabled={busy}
					onClick={() => void disconnect()}
					type="button"
				>
					{busy ? "Disconnecting..." : "Disconnect machine"}
				</button>
			</div>
		</NavigationDialog>
	);
}

/**
 * The signed-in person's paired machines, each of which they can disconnect for good. `titled`
 * is false where the page's own heading already names the list.
 */
export function Machines({ titled = true }: { titled?: boolean }) {
	let [machines, setMachines] = useState<Machine[]>();
	let [error, setError] = useState("");
	let [confirming, setConfirming] = useState<Machine>();
	let presence = useTransitionPresence(confirming, 150, motionImmediately());
	useEffect(() => {
		let abort = new AbortController();
		experimentRequest<{ machines: Machine[] }>("/api/connector/machines", undefined, abort.signal)
			.then(value => setMachines(value.machines))
			.catch(error => {
				if (!abort.signal.aborted) setError(String(error.message));
			});
		return () => abort.abort();
	}, []);
	let now = Date.now();
	return (
		<section
			aria-labelledby={titled ? "machines-heading" : undefined}
			className="flex flex-col gap-3 text-sm"
		>
			{titled && (
				<h3 className="m-0 text-base font-semibold" id="machines-heading">Your machines</h3>
			)}
			{error && <p role="alert" className="m-0 text-destructive-ink">{error}</p>}
			{machines?.length === 0 && (
				<p className="m-0 text-text-secondary">No machines are paired with your account.</p>
			)}
			{!!machines?.length && (
				<ul aria-label="Paired machines" className="m-0 flex list-none flex-col gap-3 p-0">
					{machines.map(machine => (
						<li className="flex items-start justify-between gap-3" key={machine.id}>
							<div className="flex min-w-0 flex-col gap-0.5">
								<span className="font-medium">{machine.label}</span>
								<span className="text-text-secondary">{status(machine, now)}</span>
								{!!machine.repositories.length && (
									<span className="truncate text-text-tertiary">
										{machine.repositories.join(", ")}
									</span>
								)}
								{machine.autoRun && (
									<span className="text-text-tertiary">Builds and prototypes automatically</span>
								)}
							</div>
							<button
								aria-label={`Disconnect machine ${machine.label}`}
								className="btn btn-sm btn-outline-danger shrink-0"
								onClick={() =>
									setConfirming(machine)}
								type="button"
							>
								Disconnect machine
							</button>
						</li>
					))}
				</ul>
			)}
			{presence.phase !== "closed" && (
				<DisconnectMachineDialog
					machine={presence.value}
					motion={presence}
					onDisconnected={() => {
						let gone = presence.value.id;
						setMachines(current => current?.filter(value => value.id !== gone));
						setConfirming(undefined);
					}}
					onDismiss={() => setConfirming(undefined)}
				/>
			)}
		</section>
	);
}
