import { useState } from "react";
import { InfoIcon, LoaderIcon, SearchIcon } from "@chopin/icons";

import { ReferencePicker } from "../chat/reference-picker";
import { ReferenceErrorIcon } from "./reference-status-icon";

import type { ComponentProps } from "react";

export function ReferenceMenu(
	{ active, id, onActive, onSelect, state }: ComponentProps<typeof ReferencePicker>,
) {
	let [animate] = useState(() => document.documentElement.dataset.motionInput === "pointer");
	let empty = state.status === "ready" && state.options.length === 0;
	let status = ["loading", "limit", "error"].includes(state.status) || empty;
	let message = state.status === "loading"
		? "Loading documents..."
		: state.status === "limit"
		? "A message can include up to 10 references."
		: state.status === "error"
		? state.error instanceof Error ? state.error.message : "Could not load references."
		: state.status === "ready" && state.truncated
		? "No matches in the available documents."
		: "No matching documents.";
	return (
		<div
			className="composer-reference-menu"
			data-animate={animate || undefined}
			data-truncated={state.status === "ready" && state.truncated || undefined}
		>
			{status && state.options.length === 0
				? (
					<div
						className="absolute inset-x-2.5 bottom-full z-30 mb-1 overflow-y-auto rounded-lg bg-page p-1 ring-hairline shadow-overlay"
						data-chat-reference-picker="document"
						data-focus-boundary=""
						style={{ maxHeight: "min(16rem, 45dvh, 45vh)" }}
					>
						<div
							aria-busy={state.status === "loading"}
							aria-label="Document references"
							id={id}
							role="listbox"
						>
							<p
								className="composer-picker-status"
								role={state.status === "error" ? "alert" : "status"}
								data-error={state.status === "error" || undefined}
							>
								<span className="composer-reference-status-icon">
									{state.status === "loading"
										? <LoaderIcon size={14} className="chat-tool-loader" />
										: state.status === "error"
										? <ReferenceErrorIcon />
										: state.status === "limit"
										? <InfoIcon size={16} />
										: <SearchIcon size={14} />}
								</span>
								<span>{message}</span>
							</p>
							{state.status === "ready" && state.truncated && (
								<p className="composer-picker-status" role="status">
									<InfoIcon size={14} />Some documents are not shown.
								</p>
							)}
						</div>
					</div>
				)
				: (
					<ReferencePicker
						active={active}
						id={id}
						onActive={onActive}
						onSelect={onSelect}
						state={state}
					/>
				)}
		</div>
	);
}
