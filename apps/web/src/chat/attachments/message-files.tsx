/**
 * The images and files a message was sent with, under its text, for everyone who can read the
 * document: assistant-ui's received-files design (`MessageAttachments`, copied and recorded). An
 * image is drawn from the stored file as the picture of its tile, and pressing a file opens an image
 * in its own tab and downloads a text file.
 */

import { attachmentPath } from "@chopin/protocol/attachment";
import { MessageAttachments } from "@/components/assistant-ui/elements/message-attachment";
import { messageFileProps } from "./files";

import type { Chat } from "@chopin/protocol";

function open(file: Chat.Attachment, href: string) {
	if (file.kind === "image") {
		window.open(href, "_blank", "noopener,noreferrer");
		return;
	}
	let link = document.createElement("a");
	link.href = href;
	link.download = file.name;
	link.click();
}

export default function MessageFiles(
	{ channelId, files }: { channelId: string; files: readonly Chat.Attachment[] },
) {
	return (
		<MessageAttachments
			aria-label="Files sent with this message"
			attachments={files.map(file => ({
				...messageFileProps(file),
				...(file.kind === "image"
					? { swatch: `url("${attachmentPath(channelId, file.id)}")` }
					: {}),
			}))}
			data-chat-files=""
			onOpen={id => {
				let file = files.find(candidate => candidate.id === id);
				if (file) open(file, attachmentPath(channelId, id));
			}}
			role="group"
		/>
	);
}
