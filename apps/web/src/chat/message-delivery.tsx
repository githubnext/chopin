/** The mark on a person's own message while only this browser has it, and the line a refused one carries. */

import { WarningIcon } from "@chopin/icons";

import { FAILED_LABEL, MARK_LABEL } from "./delivery";
import "./message-delivery.css";

import type { Mark } from "./delivery";

/** Says Sending while only this browser has the message; once the server has it, there is no mark. */
export function DeliveryMark({ mark }: { mark: Mark }) {
	return <span className="chat-delivery" data-chat-delivery={mark}>{MARK_LABEL[mark]}</span>;
}

/** What a message the server refused says on itself. Try again and Delete are in its menu. */
export function FailedLine({ reason }: { reason: string }) {
	return (
		<div className="chat-message-failed" data-chat-failed="" role="status">
			<WarningIcon
				aria-hidden="true"
				className="chat-message-failed-icon icon-first-line"
				size={14}
			/>
			<p className="chat-message-failed-text">
				<span className="chat-message-failed-title">{FAILED_LABEL}.</span> {reason}
			</p>
		</div>
	);
}
