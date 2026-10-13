import { useEffect, useState } from "react";
import { experimentRequest } from "./api";
import { LocalLoginShell } from "../local-login-shell";
import { Machines } from "./machines";

type Pairing = {
	input: { repository?: string; label: string };
	owner: string;
	code: string;
	/** Where to go once this pairing has its machine, after GitHub authorized it. */
	connected?: string;
};

export default function PairingPage() {
	let id = new URLSearchParams(location.search).get("pairing");
	let [pairing, setPairing] = useState<Pairing>();
	let [error, setError] = useState("");
	let [busy, setBusy] = useState(false);
	let [url, setUrl] = useState("");
	// Off by default: without it, work reaches this laptop only when a person presses Build or Run.
	let [autoRun, setAutoRun] = useState(false);
	useEffect(() => {
		let abort = new AbortController();
		// Without a pairing, /connect lists the person's machines.
		if (!id) return;
		experimentRequest<Pairing>(
			`/api/connector/pairings/${encodeURIComponent(id)}`,
			undefined,
			abort.signal,
		)
			.then(value => {
				setPairing(value);
				if (value.connected) setUrl(value.connected);
			}).catch(error => {
				if (!abort.signal.aborted) setError(String(error.message));
			});
		return () => abort.abort();
	}, [id]);
	async function connect() {
		setBusy(true);
		setError("");
		try {
			let result = await experimentRequest<{ url?: string; authorize?: string }>(
				`/api/connector/pairings/${encodeURIComponent(id!)}/approve`,
				{ autoRun },
			);
			// GitHub authorizes the machine on its own, then returns to this page.
			if (result.authorize) {
				location.assign(result.authorize);
				return;
			}
			setUrl(result.url ?? "/");
		} catch (error) {
			setError(error instanceof Error ? error.message : "Connection failed");
		} finally {
			setBusy(false);
		}
	}
	let repository = pairing?.input.repository;
	if (!id) {
		return (
			<LocalLoginShell title="Your local agents">
				<Machines />
			</LocalLoginShell>
		);
	}
	return (
		<LocalLoginShell title="Connect your local agent">
			{error && <p role="alert" className="m-0 text-sm text-destructive-ink">{error}</p>}
			{pairing && (
				<div className="flex flex-col gap-4 text-sm">
					{url
						? (
							<>
								<p className="m-0" role="status">Connected.</p>
								<a className="btn btn-md btn-primary" href={url}>
									{repository ? `Open ${repository}` : "Open Chopin"}
								</a>
								<Machines />
							</>
						)
						: (
							<>
								<p className="m-0">
									{repository
										? `Connect this checkout of ${repository} so Chopin can run work for you in any of its documents.`
										: `Connect ${pairing.input.label} so Chopin can run work for you on it.`}
								</p>
								<p className="m-0 text-text-secondary">
									Check that your terminal shows{" "}
									<code className="font-mono text-text-primary">{pairing.code}</code>
								</p>
								<label className="flex items-start gap-2">
									<input
										checked={autoRun}
										className="choice-control mt-0.5 size-4 shrink-0"
										disabled={busy}
										onChange={event => setAutoRun(event.target.checked)}
										type="checkbox"
									/>
									<span>Let Chopin build and prototype automatically on this laptop</span>
								</label>
								<button
									className="btn btn-md btn-primary"
									disabled={busy}
									onClick={() => void connect()}
								>
									Connect
								</button>
							</>
						)}
				</div>
			)}
		</LocalLoginShell>
	);
}
