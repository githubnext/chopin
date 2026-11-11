/**
 * The images and files a message was sent with, under its text, for everyone who can read the
 * document.
 *
 * Every image in Chat is drawn one way: sent image attachments go through `TurnImages` (`ChatImage`
 * for one, `ImageGallery` for several, and the message's shared viewer), read at Slack's thumbnail
 * widths, so an image of any size shows. Other files are assistant-ui's copied `MessageAttachments`
 * tiles drawn as Slack's file cards (`media.css`): the type's coloured icon, the name in bold, the
 * type and size under it, and a toolbar of their own on hover; pressing one downloads it under its
 * own name.
 */

import { useState } from "react";
import { CheckIcon, DownloadIcon, LinkIcon } from "@chopin/icons";

import { attachmentPath, formatBytes } from "@chopin/protocol/attachment";
import { MessageAttachments } from "@/components/assistant-ui/elements/message-attachment";

import { ChatImageDocument, useImageDocument } from "../image";
import { FileKindIcon } from "../media/file-icon";
import { fileType } from "../media/layout";
import { TurnImages } from "../turn-images";
import "../media/media.css";

import type { Chat } from "@chopin/protocol";
import type { ChatImageData } from "../image";

function downloadFile(file: Chat.Attachment, href: string) {
	let link = document.createElement("a");
	link.href = href;
	link.download = file.name;
	link.click();
}

/** A file's own toolbar, as Slack's file has: download it, or copy where it can be read. */
function FileActions({ file, href }: { file: Chat.Attachment; href: string }) {
	let [copied, setCopied] = useState(false);
	return (
		<div aria-label={`Actions for ${file.name}`} className="chat-file-actions" role="group">
			<button
				aria-label={`Download ${file.name}`}
				className="chat-file-action"
				onClick={() => downloadFile(file, href)}
				type="button"
			>
				<DownloadIcon aria-hidden="true" size={16} />
			</button>
			<button
				aria-label={copied ? "Copied link" : `Copy link to ${file.name}`}
				className="chat-file-action"
				onClick={() => {
					navigator.clipboard?.writeText(new URL(href, location.origin).href).then(
						() => {
							setCopied(true);
							setTimeout(() => setCopied(false), 1600);
						},
						() => {},
					);
				}}
				type="button"
			>
				{copied
					? <CheckIcon aria-hidden="true" size={16} />
					: <LinkIcon aria-hidden="true" size={16} />}
			</button>
		</div>
	);
}

export default function MessageFiles(
	{ channelId, files }: { channelId: string; files: readonly Chat.Attachment[] },
) {
	let images: ChatImageData[] = [];
	let documents: Chat.Attachment[] = [];
	for (let file of files) {
		if (file.kind === "image") {
			images.push({
				src: attachmentPath(channelId, file.id),
				alt: file.name,
				mimeType: file.mimeType,
				...(file.original ? { original: file.original } : {}),
			});
		} else {
			documents.push(file);
		}
	}

	let documentId = useImageDocument();
	let content = (
		<>
			{images.length > 0 && (
				<TurnImages
					images={images.map(image => ({ ...image })) as readonly Chat.Image[]}
					refused={undefined}
				/>
			)}
			{documents.length > 0 && (
				<MessageAttachments
					aria-label="Files sent with this message"
					attachments={documents.map(file => {
						let type = fileType(file.name);
						let href = attachmentPath(channelId, file.id);
						return {
							id: file.id,
							name: file.name,
							// The type and the size are two elements, apart by the line's gap, as Slack draws them.
							size: (
								<>
									<span className="chat-file-type">{type.label}</span>
									<span>{formatBytes(file.size)}</span>
								</>
							),
							kind: "file" as const,
							icon: <FileKindIcon kind={type.kind} />,
							actions: <FileActions file={file} href={href} />,
						};
					})}
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
