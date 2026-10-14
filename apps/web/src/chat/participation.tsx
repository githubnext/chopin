import { useEffect, useRef, useState } from "react";
import { WarningIcon } from "@chopin/icons";
import type { Chat } from "@chopin/protocol";
import type { Wire } from "../wire";

/** A shared setting: the label changes only when the server confirms it. */
export function Participation(
	{ state, wire, disabled }: {
		state: Chat.Participation;
		wire: Wire;
		disabled: boolean;
	},
) {
	let [pending, setPending] = useState(false);
	let [error, setError] = useState(false);
	let request = useRef<object | undefined>(undefined);
	useEffect(() => () => {
		request.current = undefined;
	}, []);
	if (!state.enabled) return null;
	let label = state.paused ? "Enable automatic participation" : "Pause automatic participation";
	let description = state.paused
		? "Automatic participation is paused for everyone. @chopin still works."
		: "Chopin can join this conversation. Pause for everyone; @chopin still works.";
	let toggle = () => {
		if (disabled || request.current || !wire.connected) return;
		let token = {};
		request.current = token;
		setPending(true);
		setError(false);
		void wire.ask<Chat.ParticipationState>("chat:participation", { paused: !state.paused })
			.catch(() => {
				if (request.current === token) setError(true);
			}).finally(() => {
				if (request.current !== token) return;
				request.current = undefined;
				setPending(false);
			});
	};
	return (
		<div className="mt-1 flex flex-col items-start gap-1" data-chat-participation="">
			<button
				type="button"
				className="btn btn-sm btn-ghost px-2 text-text-tertiary"
				aria-label={label}
				aria-pressed={!state.paused}
				aria-busy={pending}
				data-tooltip={description}
				data-tooltip-verbatim=""
				title={description}
				disabled={disabled || pending}
				onClick={toggle}
			>
				{state.paused ? "Chopin is listening" : "Chopin joins in"}
			</button>
			{error && (
				<p className="composer-notice" data-error="" role="alert">
					<WarningIcon className="icon-danger icon-first-line" size={14} />
					<span>Couldn’t change participation. Try again.</span>
				</p>
			)}
		</div>
	);
}
