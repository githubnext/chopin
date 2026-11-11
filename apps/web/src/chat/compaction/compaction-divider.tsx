import { ProgressRingIcon } from "@chopin/icons";
import { UnfoldPanel, UnfoldToggle, useUnfold } from "@chopin/visuals";

import "./compaction-divider.css";

import type { Chat } from "@chopin/protocol";

export function CompactingRow() {
	return (
		<div
			aria-live="polite"
			className="chat-compacting-row"
			data-chat-compacting=""
			role="status"
		>
			<span aria-hidden="true" className="chat-compacting-spinner">
				<ProgressRingIcon progress={0.32} size={14} />
			</span>
			<span>Compacting earlier messages…</span>
		</div>
	);
}

export function tokensSavedLabel(
	compaction: Pick<Chat.CompactionRecord, "tokensBefore" | "tokensAfter">,
):
	| string
	| undefined
{
	if (
		typeof compaction.tokensBefore !== "number"
		|| typeof compaction.tokensAfter !== "number"
	) {
		return undefined;
	}
	let saved = compaction.tokensBefore - compaction.tokensAfter;
	if (saved <= 0) return undefined;
	return `${saved.toLocaleString("en-US")} tokens saved`;
}

export function messagesSummarizedLabel(count: number): string | undefined {
	if (!(count > 0)) return undefined;
	return count === 1 ? "1 message" : `${count.toLocaleString("en-US")} messages`;
}

export function CompactionDivider(
	{ compaction, defaultOpen = false }: {
		compaction: Chat.CompactionRecord;
		defaultOpen?: boolean;
	},
) {
	let unfold = useUnfold(defaultOpen, "accordion");
	let messagesLabel = messagesSummarizedLabel(compaction.messagesSummarized);
	let savedLabel = tokensSavedLabel(compaction);
	return (
		<div className="chat-compaction-divider" data-chat-compaction={compaction.id}>
			<div className="chat-compaction-bar">
				<UnfoldToggle className="chat-compaction-toggle" unfold={unfold}>
					<span>Earlier messages were summarized</span>
					{(messagesLabel || savedLabel) && (
						<span className="chat-compaction-meta">
							{messagesLabel && <span>{messagesLabel}</span>}
							{savedLabel && <span>{savedLabel}</span>}
						</span>
					)}
				</UnfoldToggle>
			</div>
			<UnfoldPanel unfold={unfold}>
				<div className="chat-compaction-body" data-chat-compaction-summary="">
					{compaction.summary || "Earlier conversation context was compacted."}
				</div>
			</UnfoldPanel>
		</div>
	);
}
