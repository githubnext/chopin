/** What is happening to a saved conversation decision's paragraph. */

import { useState } from "react";

import type { Question } from "@chopin/protocol";
import type { Transport } from "@chopin/question/react";

export function WriteupStatus(
	{ canEdit, connected, meta, wire }: {
		canEdit: boolean;
		connected: boolean;
		meta: Question.CardMeta;
		wire?: Transport;
	},
) {
	let [retrying, setRetrying] = useState(false);
	let [error, setError] = useState<string>();
	if (meta.proseOrphaned) return <span className="text-text-tertiary">· prose removed</span>;
	let writeup = meta.writeup;
	if (writeup?.status === "writing") {
		return (
			<span
				className="flex items-center gap-1.5 whitespace-nowrap text-text-tertiary"
				role="status"
			>
				<span aria-hidden="true" className="plan-research-dot" />
				Writing up…
			</span>
		);
	}
	if (writeup?.status !== "failed") return null;
	let retry = async () => {
		if (!wire) return;
		setError(undefined);
		setRetrying(true);
		try {
			// A false `queued` means another writer retried first; republished metadata shows that.
			await wire.ask("conversation-plan:retry-job", { jobId: writeup.job });
		} catch {
			setError("Couldn't retry. Try again.");
		}
		setRetrying(false);
	};
	return (
		<span className="flex items-center gap-1 whitespace-nowrap">
			<span className="text-text-tertiary" role="status">Couldn't write this up</span>
			<button
				aria-label="Retry write-up"
				className="btn btn-sm btn-ghost"
				disabled={!canEdit || !connected || !wire || retrying}
				onClick={() => void retry()}
				type="button"
			>
				Retry
			</button>
			{error && <span className="text-text-tertiary" role="alert">{error}</span>}
		</span>
	);
}
