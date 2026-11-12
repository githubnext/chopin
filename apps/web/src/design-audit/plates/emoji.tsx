import { useState } from "react";

import { EmojiPicker } from "../../chat/actions/emoji-picker";
import { MessageMarkdown } from "../../chat/markdown";
import { AuditPlate, StateLabel } from "../frame";

/**
 * The platform's own emoji in a message, and Slack's emoji picker, every state once. The picker
 * holds every emoji, so the plate draws it only once asked, as Chat does, and the rest of the
 * audit page stays light.
 */
export function EmojiPlate() {
	let [open, setOpen] = useState(false);
	return (
		<AuditPlate
			description="Native emoji in a message and alone and large, and Slack's emoji picker with its tabs, sections, preview and skin tones. Reaction pills are on the assistant-ui plate."
			item="emoji"
			title="Emoji"
		>
			<div className="design-audit-emoji chat-message-body">
				<StateLabel>In words, and a message of only emoji</StateLabel>
				<MessageMarkdown
					source={"Staging is green \u2705 and the canary held \u{1F680} \u00A9 2026"}
				/>
				<MessageMarkdown source={"\u{1F64C}\u{1F3FD}\u{1F525}"} />
				<StateLabel>Picker</StateLabel>
				{open
					? (
						<div className="chat-message-picker" data-audit-picker="">
							<EmojiPicker id="audit-emoji-picker" onPick={() => {}} />
						</div>
					)
					: (
						<button className="btn btn-sm btn-outline" onClick={() => setOpen(true)} type="button">
							Show the emoji picker
						</button>
					)}
			</div>
		</AuditPlate>
	);
}
