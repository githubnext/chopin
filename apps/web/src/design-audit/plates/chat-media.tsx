import { ChatImage, ChatImageDocument, MessageImages } from "../../chat/image";
import { ImageGallery } from "../../chat/image-gallery";
import MessageFiles from "../../chat/attachments/message-files";
import StagedFiles from "../../chat/attachments/staged-files";
import { AuditPlate, StateLabel } from "../frame";
import { SAMPLE_PNG } from "./assistant-ui";

import type { Chat } from "@chopin/protocol";
import type { ChatImageData } from "../../chat/image";
import type { FileView } from "../../chat/attachments/files";

const PICTURE: ChatImageData = {
	src: SAMPLE_PNG,
	alt: "write-back.png",
	width: 384,
	height: 288,
};

const PICTURES: ChatImageData[] = Array.from({ length: 6 }, (_, index) => ({
	...PICTURE,
	alt: `Picture ${index + 1}`,
}));

const FILES: Chat.Attachment[] = [
	{ id: "brief", name: "brief.pdf", kind: "file", mimeType: "text/plain", size: 482_000 },
	{ id: "notes", name: "rollout-notes.md", kind: "file", mimeType: "text/plain", size: 38 },
	{ id: "days", name: "latency-by-day.csv", kind: "file", mimeType: "text/plain", size: 22 },
	{ id: "deck", name: "review.pptx", kind: "file", mimeType: "text/plain", size: 1_200_000 },
	{ id: "policy", name: "cache-policy.ts", kind: "file", mimeType: "text/plain", size: 24 },
	{ id: "bundle", name: "logs.tar.gz", kind: "file", mimeType: "text/plain", size: 9_000 },
	{ id: "doc", name: "decision.docx", kind: "file", mimeType: "text/plain", size: 18_000 },
	{ id: "other", name: "data.bin", kind: "file", mimeType: "text/plain", size: 64 },
];

const STAGED: FileView[] = [
	{
		id: "shot",
		name: "shot.png",
		kind: "image",
		size: 1234,
		sizeLabel: "48%",
		state: "uploading",
		progress: 48,
		retry: false,
	},
	{
		id: "notes",
		name: "rollout-notes.md",
		kind: "file",
		size: 38,
		sizeLabel: "38 B",
		state: "done",
		progress: 100,
		retry: false,
	},
	{
		id: "refused",
		name: "logo.svg",
		kind: "image",
		size: 900,
		sizeLabel: "900 B",
		state: "error",
		progress: 0,
		error: "logo.svg is not a PNG, JPEG, WebP or GIF image.",
		retry: false,
	},
];

/** Chat's images, placeholders and files, drawn as Slack draws them, every state once. */
export function ChatMediaPlate() {
	return (
		<AuditPlate
			description="Slack's image block and its toolbar, its grid, the placeholders of images that cannot load, and its file cards, sent and staged."
			item="chat-media"
			title="Chat media"
		>
			<ChatImageDocument value="audit">
				<div className="design-audit-chat-media chat-message-body">
					<StateLabel>Image with its toolbar</StateLabel>
					<MessageImages sender={{ name: "Ana", face: null, time: "9:14 AM" }}>
						<ChatImage image={PICTURE} />
					</MessageImages>
					<StateLabel>Two, three and four images, the rest behind +N</StateLabel>
					<ImageGallery images={PICTURES.slice(0, 2)} />
					<ImageGallery images={PICTURES.slice(0, 3)} />
					<ImageGallery images={PICTURES} />
					<StateLabel>Image that cannot be shown</StateLabel>
					<ChatImage image={{ src: "/auth/logout", alt: "floor-plan.png" }} />
					<StateLabel>Files</StateLabel>
					<MessageFiles channelId="audit" files={FILES} />
				</div>
				<div className="design-audit-chat-media chat-composer">
					<StateLabel>Staged: an image uploading, a file, a refused file</StateLabel>
					<StagedFiles
						files={STAGED}
						onRemove={() => {}}
						onRetry={() => {}}
						source={() => undefined}
					/>
				</div>
			</ChatImageDocument>
		</AuditPlate>
	);
}
