/**
 * The images and files a message was sent with, under its text, for everyone who can read the
 * document: an image as its thumbnail, a text file as a chip that downloads it.
 */

import { PageIcon } from "@chopin/icons";
import { attachmentPath, formatBytes } from "@chopin/protocol/attachment";

import type { Chat } from "@chopin/protocol";
import "./attachments.css";

export default function MessageFiles(
	{ channelId, files }: { channelId: string; files: readonly Chat.Attachment[] },
) {
	return (
		<ul aria-label="Files sent with this message" className="message-files" data-chat-files="">
			{files.map(file => {
				let href = attachmentPath(channelId, file.id);
				return (
					<li className="message-file" data-kind={file.kind} key={file.id}>
						{file.kind === "image"
							? (
								<a
									aria-label={`Open ${file.name}, ${formatBytes(file.size)}`}
									className="message-file-image"
									href={href}
									rel="noreferrer"
									target="_blank"
								>
									<img alt={file.name} loading="lazy" src={href} />
								</a>
							)
							: (
								<a className="message-file-chip" download={file.name} href={href}>
									<span aria-hidden="true" className="composer-file-visual" data-kind="file">
										<PageIcon size={16} />
									</span>
									<span className="composer-file-text">
										<span className="composer-file-name" title={file.name}>{file.name}</span>
										<span className="composer-file-meta">{formatBytes(file.size)}</span>
									</span>
								</a>
							)}
					</li>
				);
			})}
		</ul>
	);
}
