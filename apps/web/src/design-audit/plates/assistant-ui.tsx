import { GlobeIcon, SparklesIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import {
	ComposerCommandItem,
	ComposerContext,
	ComposerMenu,
	ComposerPersonItem,
	ComposerVoice,
	ComposerVoiceButton,
} from "@/components/assistant-ui/elements/composer";
import { ContextBreakdown } from "@/components/assistant-ui/elements/context-breakdown";
import { createDirectiveText } from "@/components/assistant-ui/elements/directive-text";
import {
	Image,
	ImageActions,
	ImageFilename,
	ImagePreview,
	ImageRoot,
	ImageSource,
	ImageZoom,
} from "@/components/assistant-ui/elements/image";
import { ImageGallery } from "@/components/assistant-ui/elements/image-gallery";
import { MessageAttachments } from "@/components/assistant-ui/elements/message-attachment";
import {
	ModelSelectorContent,
	ModelSelectorRoot,
	ModelSelectorTrigger,
} from "@/components/assistant-ui/elements/model-selector";
import { toBreakdownSegments, toComposerUsage } from "../../chat/context/context-usage";
import { modelOptions } from "../../chat/assistant-ui/model-options";
import StagedFiles from "../../chat/attachments/staged-files";
import { AuditPlate, StateLabel } from "../frame";

import type { Chat } from "@chopin/protocol";
import type { FileView } from "../../chat/attachments/files";

/** The shape of what a document's agent reports, which is all the element is given. */
const CATALOG: Chat.ModelCatalog = {
	models: [
		{
			id: "gpt-5",
			name: "GPT-5",
			description: "Strongest reasoning",
			thinkingLevels: ["low", "medium", "high"],
		},
		{
			id: "claude-sonnet-4",
			name: "Claude Sonnet 4",
			description: "Careful writing",
			thinkingLevels: ["low", "high"],
		},
		{ id: "gpt-5-mini", name: "GPT-5 mini", description: "Quick drafts" },
	],
};

const MENTION = {
	parse: () => [{ kind: "mention" as const, type: "agent", label: "Chopin", id: "chopin" }],
};
/** The chip as Directive text draws it for a mention, and with the control the patch lets it hold. */
const MentionChip = createDirectiveText(MENTION, { iconMap: { agent: SparklesIcon } });
const RemovableChip = createDirectiveText(MENTION, {
	iconMap: { agent: SparklesIcon },
	trailing: () => <XIcon />,
});

/** The files of a message being written, as Chat draws them in each state `useFiles` gives. */
const FILES: FileView[] = [
	{
		id: "uploading",
		name: "notes.md",
		kind: "file",
		size: 2048,
		sizeLabel: "40%",
		state: "uploading",
		progress: 40,
		retry: false,
	},
	{
		id: "done",
		name: "plan.txt",
		kind: "file",
		size: 2048,
		sizeLabel: "2 KB",
		state: "done",
		progress: 100,
		retry: false,
	},
	{
		id: "picture",
		name: "shot.png",
		kind: "image",
		size: 52_000,
		sizeLabel: "51 KB",
		state: "done",
		progress: 100,
		retry: false,
	},
	{
		id: "again",
		name: "draft.md",
		kind: "file",
		size: 2048,
		sizeLabel: "2 KB",
		state: "error",
		progress: 0,
		error: "draft.md didn't upload.",
		retry: true,
	},
	{
		id: "refused",
		name: "logo.svg",
		kind: "image",
		size: 900,
		sizeLabel: "900 B",
		state: "error",
		progress: 0,
		error: "logo.svg isn't a PNG, JPEG, WebP or GIF image.",
		retry: false,
	},
];

/** A sent message's files: an image as a picture, a document and a file. */
const SENT = [
	{
		id: "picture",
		name: "shot.png",
		size: "51 KB",
		kind: "image",
		swatch: "linear-gradient(135deg, var(--color-brand), var(--color-inset))",
	},
	{ id: "plan", name: "plan.md", size: "2 KB", kind: "document" },
	{ id: "notes", name: "notes.txt", size: "1 KB", kind: "file" },
] as const;

const SPECIMENS = [
	{ label: "Outline, default", variant: "outline", size: "default" },
	{ label: "Outline, small", variant: "outline", size: "sm" },
	{ label: "Outline, large", variant: "outline", size: "lg" },
	{ label: "Ghost", variant: "ghost", size: "default" },
	{ label: "Muted", variant: "muted", size: "default" },
] as const;

const MARKDOWN_SPECIMEN = [
	"# Rollout outline",
	"## Queue topology",
	"### Migration order",
	"#### Fallback rule",
	"##### Owner check",
	"###### Cutover note",
	"",
	"Move the **shared** queue to *per-team* lanes[^1], drop ~~manual routing~~, and read the [guide](https://example.com/guide) before `bun test`.",
	"",
	"> Keep the shared queue for seven days while traffic drains.",
	"",
	"- Provision per-team queues",
	"- Flip the routing flag",
	"",
	"1. Verify delivery metrics",
	"2. Retire the shared queue",
	"",
	"---",
	"",
	"| Queue | Owner | State |",
	"| --- | --- | --- |",
	"| shared | platform | retiring |",
	"| per-team | each team | live |",
	"",
	"```ts",
	"export function queueFor(team: string) {",
	"\treturn `queue:${team}`;",
	"}",
	"```",
	"",
	"[^1]: Retained for replay.",
].join("\n");

const NORMAL_USAGE: Chat.ContextUsage = {
	system: 2_000,
	tools: 4_000,
	messages: 36_000,
	inputTokens: 36_000,
	outputTokens: 6_000,
	cachedTokens: 12_000,
	totalTokens: 42_000,
	contextWindow: 128_000,
};

const WARN_USAGE: Chat.ContextUsage = {
	system: 4_000,
	tools: 8_000,
	messages: 100_000,
	inputTokens: 104_000,
	outputTokens: 8_000,
	cachedTokens: 20_000,
	totalTokens: 112_000,
	contextWindow: 128_000,
};

const SAMPLE_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAYAAAAEgCAIAAAAyuTMGAAACzElEQVR42u3UMQ0AAAgEsZeFKGb0IwOGJlVww6V6AE5EAsCAAAMCMCDAgAAMCDAgAAMCDAjAgAADAjAgwIAADAgwIAADAgwIMCAAAwIMCMCAAAMCMCDAgAAMCDAgAAMCDAjAgAADAjAgwIAADAgwIMCAAAwIMCAAAwIMCMCAAAMCMCDAgAAMCDAgAAMCDAjAgAADAgwIwIAAAwIwIMCAAAwIMCAAAwIMCMCAAAMCMCDAgAAMCDAgAAMCDAgwIAADAgwIwIAAAwIwIMCAAAwIMCAAAwIMCMCAAAMCMCDAgAADAjAgwIAADAgwIAADAgwIwIAAAwIwIMCAAAwIMCAAAwIMCMCAAAMCDAjAgAADAjAgwIAADAgwIAADAgwIwIAAAwIwIMCAAAwIMCDAgFQADAgwIAADAgwIwIAAAwIwIMCAAAwIMCAAAwIMCMCAAAMCMCDAgAADAjAgwIAADAgwIAADAgwIwIAAAwIwIMCAAAwIMCAAAwIMCMCAAAMCDAjAgAADAjAgwIAADAgwIAADAgwIwIAAAwIwIMCAAAwIMCDAgAAMCDAgAAMCDAjAgAADAjAgwIAADAgwIAADAgwIwIAAAwIwIMCAAAMCMCDAgAAMCDAgAAMCDAjAgAADAjAgwIAADAgwIAADAgwIMCAAAwIMCMCAAAMCMCDAgAAMCDAgAAMCDAjAgAADAjAgwIAADAgwIMCAAAwIMCAAAwIMCMCAAAMCMCDAgAAMCDAgAAMCDAjAgAADAgxIBcCAAAMCMCDAgAAMCDAgAAMCDAjAgAADAjAgwIAADAgwIAADAgwIMCAAAwIMCMCAAAMCMCDAgAAMCDAgAAMCDAjAgAADAjAgwIAAA5IAMCDAgAAMCDAgAAMCDAjAgAADAjAgwIAADAgwIAADAgwIwIAAAwIMCMCAAAMCMCDAgAAMCDAgAAMCDAjAgAADAjAg4K8Fn0771hKV5o8AAAAASUVORK5CYII=";
const BROKEN_PNG = "data:image/png;base64,AAAA";

const IMAGE_PART = {
	type: "image" as const,
	image: SAMPLE_PNG,
	filename: "write-back.png",
};

const GALLERY_IMAGES = [
	{
		id: "cap",
		src: SAMPLE_PNG,
		alt: "The cap is a balance of 100.",
		caption: "Faster, and a crash can lose the last writes.",
		source: { label: "Generated" },
	},
	{
		id: "back",
		src: SAMPLE_PNG,
		alt: "Write-back: write, cache, then database later",
		caption: "Reference diagram",
		source: { label: "example.com", url: "https://example.com" },
	},
	{
		id: "through",
		src: SAMPLE_PNG,
		alt: "Write-through: write, cache, database",
	},
	{
		id: "broken",
		src: BROKEN_PNG,
		alt: "A picture that could not load",
	},
	{
		id: "fifth",
		src: SAMPLE_PNG,
		alt: "Read-through cache",
	},
	{
		id: "sixth",
		src: SAMPLE_PNG,
		alt: "Write-around cache",
	},
	{
		id: "seventh",
		src: SAMPLE_PNG,
		alt: "Invalidation flow",
	},
] as const;

/**
 * Copied assistant-ui elements, drawn as assistant-ui draws them: the model selector,
 * markdown-text, image, image gallery, the context ring and the context breakdown from the
 * registry, driven by Chopin's own state through props. `e2e/design` measures them.
 */
export function AssistantUiPlate() {
	let models = modelOptions(CATALOG);
	let [model, setModel] = useState("gpt-5");
	let [effort, setEffort] = useState("medium");
	let normalComposerUsage = toComposerUsage(NORMAL_USAGE)!;
	let warnComposerUsage = toComposerUsage(WARN_USAGE)!;
	let normalBreakdown = toBreakdownSegments(NORMAL_USAGE)!;
	let warnBreakdown = toBreakdownSegments(WARN_USAGE)!;
	return (
		<AuditPlate
			description="Copied registry source, unmodified, with assistant-ui's own sizes and Chopin's colours."
			item="assistant-ui"
			title="assistant-ui elements"
		>
			<div className="design-audit-aui">
				{SPECIMENS.map(({ label, variant, size }) => (
					<div key={label}>
						<StateLabel>{label}</StateLabel>
						<ModelSelectorRoot
							effort={effort}
							models={models}
							onEffortChange={setEffort}
							onValueChange={setModel}
							value={model}
						>
							<ModelSelectorTrigger size={size} variant={variant} />
							<ModelSelectorContent searchable />
						</ModelSelectorRoot>
					</div>
				))}
				<div>
					<StateLabel>Mentions menu</StateLabel>
					<div className="design-audit-aui-menu">
						<ComposerMenu open>
							<ComposerPersonItem active person={{ name: "Chopin", role: "agent" }} />
							{/* The avatar slot the patch adds, drawn here as a plain node. */}
							<ComposerPersonItem
								active={false}
								person={{ name: "ana", role: "human", avatar: <span aria-hidden="true">A</span> }}
							/>
							<ComposerPersonItem active={false} person={{ name: "Overview", role: "H1" }} />
						</ComposerMenu>
					</div>
				</div>
				<div>
					<StateLabel>Slash commands menu</StateLabel>
					<div className="design-audit-aui-menu">
						<ComposerMenu open>
							<ComposerCommandItem
								active
								command={{
									name: "research",
									description: "Search the web for this document",
									icon: GlobeIcon,
								}}
							/>
							<ComposerCommandItem
								active={false}
								command={{ name: "skill:notes", description: "Draft notes", icon: SparklesIcon }}
							/>
						</ComposerMenu>
					</div>
				</div>
				<div>
					<StateLabel>Staged files: uploading, done, a picture, to try again, refused</StateLabel>
					<div className="design-audit-aui-staged">
						<StagedFiles
							files={FILES}
							onRemove={() => {}}
							onRetry={() => {}}
							source={() => undefined}
						/>
						<StagedFiles
							files={FILES.slice(-1)}
							onRemove={() => {}}
							onRetry={() => {}}
							source={() => undefined}
						/>
					</div>
				</div>
				<div>
					<StateLabel>Voice: listening, transcribing, and its button</StateLabel>
					<div className="design-audit-aui-staged">
						<ComposerVoice label="1:05" recording seconds={65} />
						<ComposerVoice recording={false} seconds={65} />
						<div className="design-audit-aui-chips">
							<ComposerVoiceButton active={false} />
							<ComposerVoiceButton active />
						</div>
					</div>
				</div>
				<div>
					<StateLabel>Files of a sent message</StateLabel>
					<MessageAttachments attachments={SENT} onOpen={() => {}} />
					<MessageAttachments attachments={SENT.slice(1, 2)} />
				</div>
				<div>
					<StateLabel>Mention chip, and with a trailing control</StateLabel>
					<div className="design-audit-aui-chips">
						<MentionChip text=":agent[Chopin]" />
						<RemovableChip text=":agent[Chopin]" />
					</div>
				</div>
				<div>
					<StateLabel>Context ring, normal</StateLabel>
					<ComposerContext usage={normalComposerUsage} />
				</div>
				<div>
					<StateLabel>Context ring, high usage</StateLabel>
					<ComposerContext usage={warnComposerUsage} />
				</div>
				<div>
					<StateLabel>Context breakdown, normal</StateLabel>
					<ContextBreakdown
						limit={normalBreakdown.limit}
						segments={normalBreakdown.segments}
					/>
				</div>
				<div>
					<StateLabel>Context breakdown, high usage</StateLabel>
					<ContextBreakdown
						limit={warnBreakdown.limit}
						segments={warnBreakdown.segments}
					/>
				</div>
				<div className="design-audit-aui-wide">
					<StateLabel>Image: outline, with actions and source</StateLabel>
					<ImageRoot size="default" variant="outline">
						<ImageZoom alt="Write-back diagram" src={SAMPLE_PNG}>
							<ImagePreview alt="Write-back diagram" fit="contain" ratio="4:3" src={SAMPLE_PNG} />
						</ImageZoom>
						<ImageFilename>write-back.png</ImageFilename>
						<ImageSource label="example.com" url="https://example.com" />
						<ImageActions onRegenerate={() => {}} part={IMAGE_PART} />
					</ImageRoot>
				</div>
				<div className="design-audit-aui-wide">
					<StateLabel>Image: outline small, outline large, ghost, muted broken</StateLabel>
					<ImageRoot size="sm" variant="outline">
						<ImagePreview alt="Small preview" ratio="4:3" src={SAMPLE_PNG} />
					</ImageRoot>
					<ImageRoot size="lg" variant="outline">
						<ImagePreview alt="Large preview" ratio="16:9" src={SAMPLE_PNG} />
					</ImageRoot>
					<ImageRoot size="default" variant="ghost">
						<ImagePreview alt="Ghost preview" ratio="1:1" src={SAMPLE_PNG} />
					</ImageRoot>
					<ImageRoot size="full" variant="muted">
						<ImagePreview alt="Broken preview" src={BROKEN_PNG} />
					</ImageRoot>
				</div>
				<div className="design-audit-aui-wide">
					<StateLabel>Image: generating and blocked</StateLabel>
					<Image
						filename="generating.png"
						image={SAMPLE_PNG}
						status={{ type: "running" }}
						type="image"
					/>
					<Image
						image={SAMPLE_PNG}
						status={{ reason: "content-filter", type: "incomplete" }}
						type="image"
					/>
				</div>
				<div className="design-audit-aui-wide">
					<StateLabel>Image gallery: tiles, broken tile, overflow and lightbox</StateLabel>
					<ImageGallery images={GALLERY_IMAGES} maxVisible={6} />
				</div>
			</div>
			<div className="design-audit-aui-markdown">
				<StateLabel>Markdown text</StateLabel>
				<MarkdownText defer={false} text={MARKDOWN_SPECIMEN} />
			</div>
		</AuditPlate>
	);
}
