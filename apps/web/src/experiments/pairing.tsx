import { useEffect, useState } from "react";
import { experimentRequest } from "./api";
import { LocalLoginShell } from "../local-login-shell";

type Pairing = {
	input: { label: string; repository: string; commit: string };
	owner: string;
	documents: Array<{ id: string; title: string }>;
};

export default function PairingPage() {
	let id = new URLSearchParams(location.search).get("pairing");
	let [pairing, setPairing] = useState<Pairing>();
	let [documentId, setDocumentId] = useState("");
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
				{ documentId },
			);
			setUrl(result.url);
		} catch (error) {
			setError(error instanceof Error ? error.message : "Connection failed");
		} finally {
			setBusy(false);
		}
	}
	return (
		<LocalLoginShell>
			<h1 className="text-xl font-semibold">Connect local workspace</h1>
			{error && <p role="alert" className="text-sm text-destructive-ink">{error}</p>}
			{pairing && (
				<div className="flex flex-col gap-4 text-sm">
					<p>
						{pairing.input.label} · {pairing.input.repository} · {pairing.input.commit.slice(0, 8)}
					</p>
					<p>Connected as {pairing.owner}. You authorize each investigation on this workspace.</p>
					<label className="flex flex-col gap-2">
						Document
						<select
							aria-label="Document"
							className="rounded-md border p-2"
							value={documentId}
							onChange={event => setDocumentId(event.target.value)}
							disabled={!!url}
						>
							<option value="">Choose a document</option>
							{pairing.documents.map(document => (
								<option key={document.id} value={document.id}>{document.title}</option>
							))}
						</select>
					</label>
					{url
						? <a className="btn btn-md btn-primary" href={url}>Open document</a>
						: (
							<button
								className="btn btn-md btn-primary"
								disabled={!documentId || busy}
								onClick={() => void connect()}
							>
								Connect
							</button>
						)}
				</div>
			)}
		</LocalLoginShell>
	);
}
