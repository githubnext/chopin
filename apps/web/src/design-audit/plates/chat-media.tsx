import { ChatImage, ChatImageDocument, MessageImages } from "../../chat/image";
import { ImageGallery } from "../../chat/image-gallery";
import MessageFiles from "../../chat/attachments/message-files";
import StagedFiles from "../../chat/attachments/staged-files";
import { FileKindIcon } from "../../chat/media/file-icon";
import { AuditPlate, StateLabel } from "../frame";
import { SAMPLE_PNG } from "./assistant-ui";

import type { Chat } from "@chopin/protocol";
import type { ChatImageData } from "../../chat/image";
import type { FileView } from "../../chat/attachments/files";
import type { FileKind } from "../../chat/media/layout";

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

/** Two cards: the page-wide geometry and theme scans measure every copied element on the page. */
const FILES: Chat.Attachment[] = [
	{ id: "days", name: "latency-by-day.csv", kind: "file", mimeType: "text/plain", size: 22 },
	{ id: "other", name: "data.bin", kind: "file", mimeType: "text/plain", size: 64 },
];

const KINDS: FileKind[] = [
	"pdf",
	"document",
	"spreadsheet",
	"slides",
	"code",
	"text",
	"archive",
	"image",
	"video",
	"audio",
	"generic",
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
					<StateLabel>Three images, and four with the rest behind +N</StateLabel>
					<ImageGallery images={PICTURES.slice(0, 3)} />
					<ImageGallery images={PICTURES} />
					<StateLabel>Image that cannot be shown</StateLabel>
					<ChatImage image={{ src: "/auth/logout", alt: "floor-plan.png" }} />
					<StateLabel>Files, and the icon of every type</StateLabel>
					<MessageFiles channelId="audit" files={FILES} />
					<div className="design-audit-chat-media-kinds">
						{KINDS.map(kind => <FileKindIcon key={kind} kind={kind} />)}
					</div>
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
