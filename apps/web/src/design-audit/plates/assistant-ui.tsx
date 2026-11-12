import { cloneElement, useState } from "react";
import {
	CloseIcon,
	CopyIcon,
	EllipsisIcon,
	EllipsisVerticalIcon,
	GlobeIcon,
	MessageIcon,
	ReactionAddIcon,
	RestartIcon,
	SparkleIcon,
} from "@chopin/icons";

import { AgentHandoff } from "@/components/assistant-ui/elements/agent-handoff";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { MessageActions } from "@/components/assistant-ui/elements/message-actions";
import {
	ComposerCommandItem,
	ComposerMenu,
	ComposerPersonItem,
	ComposerVoice,
	ComposerVoiceButton,
} from "@/components/assistant-ui/elements/composer";
import { ContextBreakdown } from "@/components/assistant-ui/elements/context-breakdown";
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
import { toBreakdownSegments } from "../../chat/context/context-usage";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SubagentList } from "@/components/assistant-ui/elements/subagent-list";
import { ReactionPills } from "../../chat/actions/reaction-pills";
import { modelOptions } from "../../chat/assistant-ui/model-options";
import StagedFiles from "../../chat/attachments/staged-files";
import { QUICK_REACTIONS } from "../../chat/reactions";
import { AuditPlate, StateLabel } from "../frame";

import type { Reaction } from "@/components/assistant-ui/elements/message-actions";
import type { SubagentItem } from "@/components/assistant-ui/elements/subagent-list";
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

const ACTION_SPECIMENS: readonly {
	label: string;
	copied: boolean;
	reaction: Reaction;
	regenerating: boolean;
}[] = [
	{ label: "Message actions, default", copied: false, reaction: null, regenerating: false },
	{ label: "Copied", copied: true, reaction: null, regenerating: false },
	{ label: "Helpful", copied: false, reaction: "up", regenerating: false },
	{ label: "Unhelpful", copied: false, reaction: "down", regenerating: false },
];

export const SAMPLE_PNG =
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

const AUDIT_PENDING = new Set<string>();
const AUDIT_REACTIONS: readonly Chat.Reaction[] = [
	{ emoji: QUICK_REACTIONS[0].emoji, handles: ["ana", "ben"] },
	{ emoji: QUICK_REACTIONS[1].emoji, handles: ["ben"] },
];

const SUBAGENTS: readonly SubagentItem[] = [
	{ name: "Public web search", model: "web" },
	{ name: "Repository context", model: "repo" },
];

const SUMMARY_AGENT: SubagentItem = { name: "Write research report", model: "report" };

/**
 * Copied assistant-ui and shadcn elements, drawn as their registries draw them: the model
 * selector, markdown-text, image, image gallery, the context breakdown, message actions,
 * Chopin's toolbar extension and overflow dropdown menu, the reaction pills, and the agent handoff
 * and subagent list research delegation draws. `e2e/design` measures their geometry and colours.
 */
export function AssistantUiPlate() {
	let models = modelOptions(CATALOG);
	let [model, setModel] = useState("gpt-5");
	let [effort, setEffort] = useState("medium");
	let normalBreakdown = toBreakdownSegments(NORMAL_USAGE)!;
	let warnBreakdown = toBreakdownSegments(WARN_USAGE)!;
	let [reaction, setReaction] = useState<Reaction>("up");
	let [copied, setCopied] = useState(false);
	let [reactions, setReactions] = useState(AUDIT_REACTIONS);
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
							<ComposerPersonItem active person={{ name: "chopin", role: "agent" }} />
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
								command={{ name: "skill:notes", description: "Draft notes", icon: SparkleIcon }}
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
			<div className="design-audit-aui">
				{ACTION_SPECIMENS.map(specimen => (
					<div key={specimen.label}>
						<StateLabel>{specimen.label}</StateLabel>
						<MessageActions
							copied={specimen.copied || (specimen.label === "Message actions, default" && copied)}
							onCopy={() => setCopied(value => !value)}
							onMore={() => {}}
							onReactionChange={setReaction}
							onRegenerate={() => {}}
							reaction={specimen.reaction ?? (specimen.label === "Helpful" ? reaction : null)}
							regenerating={specimen.regenerating}
						/>
					</div>
				))}
				<div>
					<StateLabel>Chopin toolbar</StateLabel>
					<MessageActions
						aria-label="Reactions and actions"
						className="chat-message-toolbar"
						items={[
							...QUICK_REACTIONS.map((item, index) => ({
								key: item.emoji,
								label: item.label,
								pressed: index === 0,
								children: (
									<span aria-hidden="true" className="message-actions-emoji">{item.emoji}</span>
								),
							})),
							{
								key: "add",
								label: "Add reaction",
								children: <ReactionAddIcon aria-hidden="true" />,
							},
							{
								key: "thread",
								label: "Reply in thread",
								children: <MessageIcon aria-hidden="true" />,
							},
						]}
						moreProps={{ "aria-label": "Message actions" }}
						renderMore={button =>
							cloneElement(button, {}, <EllipsisVerticalIcon aria-hidden="true" />)}
						role="toolbar"
					/>
				</div>
				<div>
					<StateLabel>Reactions</StateLabel>
					<div data-audit-reactions="">
						<ReactionPills
							handle="ana"
							onToggle={(emoji, on) =>
								setReactions(current =>
									current.map(item =>
										item.emoji !== emoji
											? item
											: {
												emoji,
												handles: on
													? [...item.handles, "ana"]
													: item.handles.filter(handle => handle !== "ana"),
											}
									)
								)}
							pending={AUDIT_PENDING}
							reactions={reactions}
						/>
					</div>
				</div>
				<div>
					<StateLabel>Overflow menu</StateLabel>
					<DropdownMenu modal={false}>
						<DropdownMenuTrigger
							render={
								<Button aria-label="More actions" size="icon-sm" variant="ghost">
									<EllipsisIcon />
								</Button>
							}
						/>
						<DropdownMenuContent align="end" aria-label="More actions" className="w-auto">
							<DropdownMenuItem>
								<CopyIcon />
								Copy
							</DropdownMenuItem>
							<DropdownMenuItem>
								<CopyIcon />
								Copy as plain text
							</DropdownMenuItem>
							<DropdownMenuItem>
								<RestartIcon />
								Try again
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem variant="destructive">
								<CloseIcon />
								Delete
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
			<div className="design-audit-aui-markdown">
				<StateLabel>Markdown text</StateLabel>
				<MarkdownText defer={false} text={MARKDOWN_SPECIMEN} />
			</div>
			<div className="design-audit-aui design-audit-aui-blocks">
				<div>
					<StateLabel>Handoff, in transit</StateLabel>
					<AgentHandoff
						carried={["Compare self-hosted options", "Keep single-sign-on support"]}
						from="chopin"
						reason="Handing off the research brief to a child document."
						settled={false}
						to="Research"
					/>
				</div>
				<div>
					<StateLabel>Handoff, settled</StateLabel>
					<AgentHandoff
						carried={[]}
						from="chopin"
						reason="Published findings in a child document."
						settled
						to="Research"
					/>
				</div>
				<div>
					<StateLabel>Subagent list, partly done</StateLabel>
					<SubagentList
						agents={SUBAGENTS}
						completedCount={1}
						progress={[100, 60]}
						showSummary={false}
						summaryAgent={SUMMARY_AGENT}
					/>
				</div>
				<div>
					<StateLabel>Subagent list, summarizing</StateLabel>
					<SubagentList
						agents={SUBAGENTS}
						completedCount={2}
						progress={[100, 100]}
						showSummary
						summaryAgent={SUMMARY_AGENT}
					/>
				</div>
			</div>
		</AuditPlate>
	);
}
