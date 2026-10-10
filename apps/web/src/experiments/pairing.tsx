import { useEffect, useState } from "react";
import { experimentRequest } from "./api";
import { LocalLoginShell } from "../local-login-shell";

type Pairing = {
	input: { repository: string };
	owner: string;
};

export default function PairingPage() {
	let id = new URLSearchParams(location.search).get("pairing");
	let [pairing, setPairing] = useState<Pairing>();
	let [error, setError] = useState("");
	let [busy, setBusy] = useState(false);
	let [url, setUrl] = useState("");
	useEffect(() => {
		let abort = new AbortController();
		if (!id) {
			setError("Pairing link is missing.");
			return;
		}
		experimentRequest<Pairing>(
			`/api/connector/pairings/${encodeURIComponent(id)}`,
			undefined,
			abort.signal,
		)
			.then(setPairing).catch(error => {
				if (!abort.signal.aborted) setError(String(error.message));
			});
		return () => abort.abort();
	}, [id]);
	async function connect() {
		setBusy(true);
		setError("");
		try {
			let result = await experimentRequest<{ url: string }>(
				`/api/connector/pairings/${encodeURIComponent(id!)}/approve`,
				{},
			);
			setUrl(result.url);
		} catch (error) {
			setError(error instanceof Error ? error.message : "Connection failed");
		} finally {
			setBusy(false);
		}
	}
	let repository = pairing?.input.repository;
	return (
		<LocalLoginShell>
			<h1 className="text-xl font-semibold">
				{repository ? `Connect this checkout of ${repository}` : "Connect your checkout"}
			</h1>
			{error && <p role="alert" className="text-sm text-destructive-ink">{error}</p>}
			{pairing && (
				<div className="flex flex-col gap-4 text-sm">
					{url
						? (
							<>
								<p className="m-0" role="status">
									Connected. Chopin can now run work for you in any {repository} document.
								</p>
								<a className="btn btn-md btn-primary" href={url}>Open {repository}</a>
							</>
						)
						: (
							<>
								<p className="m-0 text-text-secondary">Signed in as {pairing.owner}.</p>
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
