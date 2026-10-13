import { useEffect, useState } from "react";
import { ago } from "../build-model";
import { experimentRequest } from "./api";

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

/** The signed-in person's paired machines, each of which they can disconnect for good. */
export function Machines() {
	let [machines, setMachines] = useState<Machine[]>();
	let [error, setError] = useState("");
	let [busy, setBusy] = useState<string>();
	useEffect(() => {
		let abort = new AbortController();
		experimentRequest<{ machines: Machine[] }>("/api/connector/machines", undefined, abort.signal)
			.then(value => setMachines(value.machines))
			.catch(error => {
				if (!abort.signal.aborted) setError(String(error.message));
			});
		return () => abort.abort();
	}, []);
	async function disconnect(machine: Machine) {
		setBusy(machine.id);
		setError("");
		try {
			await experimentRequest(
				`/api/connector/machines/${encodeURIComponent(machine.id)}/revoke`,
				{},
			);
			setMachines(current => current?.filter(value => value.id !== machine.id));
		} catch (error) {
			setError(error instanceof Error ? error.message : "Disconnect failed");
		} finally {
			setBusy(undefined);
		}
	}
	let now = Date.now();
	return (
		<section aria-labelledby="machines-heading" className="flex flex-col gap-3 text-sm">
			<h3 className="m-0 text-base font-semibold" id="machines-heading">Your machines</h3>
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
								disabled={busy === machine.id}
								onClick={() =>
									void disconnect(machine)}
								type="button"
							>
								Disconnect machine
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
