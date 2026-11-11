/**
 * The images and files a message was sent with, under its text, for everyone who can read the
 * document.
 *
 * Every image in Chat is drawn one way: sent image attachments go through `TurnImages` (`ChatImage`
 * for one, `ImageGallery` for several, `RefusedImage` when over the 10 MiB display cap, and the
 * message's shared `<Dialog>` lightbox), while non-image text files keep assistant-ui's copied
 * `MessageAttachments` tiles and download under their own names.
 */

import { attachmentPath } from "@chopin/protocol/attachment";
import { MessageAttachments } from "@/components/assistant-ui/elements/message-attachment";

import { ChatImageDocument, useImageDocument } from "../image";
import { MAX_SHOWN_IMAGE_BYTES, tooLargeImageReason } from "../image-state";
import { TurnImages } from "../turn-images";
import { messageFileProps } from "./files";

import type { Chat } from "@chopin/protocol";
import type { ChatImageData } from "../image";

function downloadFile(file: Chat.Attachment, href: string) {
	let link = document.createElement("a");
	link.href = href;
	link.download = file.name;
	link.click();
}

export default function MessageFiles(
	{ channelId, files }: { channelId: string; files: readonly Chat.Attachment[] },
) {
	let images: ChatImageData[] = [];
	let refused: Array<{ before: number; reason: string }> = [];
	let documents: Chat.Attachment[] = [];
	for (let file of files) {
		if (file.kind === "image") {
			if (file.size > MAX_SHOWN_IMAGE_BYTES) {
				refused.push({
					before: images.length,
					reason: tooLargeImageReason(file.size, MAX_SHOWN_IMAGE_BYTES),
				});
			} else {
				images.push({
					src: attachmentPath(channelId, file.id),
					alt: file.name,
					mimeType: file.mimeType,
				});
			}
		} else {
			documents.push(file);
		}
	}

	let documentId = useImageDocument();
	let content = (
		<>
			{(images.length > 0 || refused.length > 0) && (
				<TurnImages
					images={images.map(image => ({ ...image })) as readonly Chat.Image[]}
					refused={refused.length > 0 ? refused : undefined}
				/>
			)}
			{documents.length > 0 && (
				<MessageAttachments
					aria-label="Files sent with this message"
					attachments={documents.map(messageFileProps)}
					data-chat-files=""
					onOpen={id => {
						let file = documents.find(candidate => candidate.id === id);
						if (file) downloadFile(file, attachmentPath(channelId, id));
					}}
					role="group"
				/>
			)}
		</>
	);
	return documentId === channelId
		? content
		: <ChatImageDocument value={channelId}>{content}</ChatImageDocument>;
}
