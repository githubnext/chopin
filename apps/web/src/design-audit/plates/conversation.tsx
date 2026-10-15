import { SendAction } from "@chopin/editor";

import { Transcript } from "../../chat/transcript";
import { TerminalAlert } from "../../terminal-alert";
import { AuditPlate } from "../frame";

import type { Chat } from "@chopin/protocol";

let CHAT_ENTRIES: Chat.Entry[] = [
	{
		author: { kind: "member", handle: "maggieappleton" },
		id: "audit-member",
		text: "Can you make the empty state clearer?",
		ts: 1_787_913_600,
	},
	{
		author: { kind: "agent" },
		id: "audit-planner",
		text: "I’ll compare the existing states and propose a smaller, consistent pattern.",
		tools: [
			{ id: "audit-tool-1", name: "read_plan", status: "done", took: 420 },
			{ id: "audit-tool-2", name: "update_plan", status: "done", took: 180 },
		],
		ts: 1_787_913_660,
	},
];

export function ConversationPlate() {
	return (
		<AuditPlate
			description="Member, Planner, tool activity, queued work, composer, and error states."
			item="chat"
			title="Conversation"
		>
			<div className="design-audit-chat">
				<Transcript
					active
					entries={CHAT_ENTRIES}
					handle="maggieappleton"
					onWithdraw={() => {}}
					queued={[{
						id: "audit-queued",
						handle: "maggieappleton",
						text: "Also check the compact layout.",
					}]}
				/>
				<div className="chat-composer px-2.5 pb-2.5">
					<div className="field flex flex-col">
						<textarea aria-label="Message" defaultValue="@chopin Review the spacing" rows={2} />
						<div className="design-audit-composer-actions">
							<span>Use # to reference a document</span>
							<SendAction label="Send message" onClick={() => {}} />
						</div>
					</div>
					<TerminalAlert className="design-audit-chat-error">
						Message could not be sent. Try again.
					</TerminalAlert>
				</div>
			</div>
		</AuditPlate>
	);
}
