import type { FilePart, ImagePart, TextPart, UserModelMessage } from "ai";
import type { StoredChatAttachment } from "../storage/model";

export type SentAttachment = Pick<StoredChatAttachment, "name" | "kind" | "mimeType" | "bytes">;

/**
 * A turn's prompt with the images and files sent with the message that began it, as one user
 * message: the text, an image part for each image where the model reads images, and a file part for
 * each text file. An image the model cannot read is not dropped without a word: the text says it was
 * sent, so the model can tell the person it could not see it.
 */
export function promptWithAttachments(
	text: string,
	attachments: readonly SentAttachment[],
	readsImages: boolean,
): UserModelMessage {
	let unread = attachments.filter(value => value.kind === "image" && !readsImages);
	let note = unread.length
		? `\n\n(Sent with this message but not shown, because this model can't read images: ${
			unread.map(value => value.name).join(", ")
		}.)`
		: "";
	let content: Array<TextPart | ImagePart | FilePart> = [{ type: "text", text: text + note }];
	for (let value of attachments) {
		if (value.kind === "image") {
			if (readsImages) {
				// The name is for a harness that has to say in words which image it was given.
				content.push({
					type: "image",
					image: value.bytes,
					mediaType: value.mimeType,
					providerOptions: { chopin: { name: value.name } },
				});
			}
		} else {
			content.push({
				type: "file",
				data: value.bytes,
				mediaType: value.mimeType,
				filename: value.name,
			});
		}
	}
	return { role: "user", content };
}
