/** The shared chat, grouped for reading rather than event delivery. */

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { ChevronIcon, CloseIcon, LoaderIcon, SignInIcon } from "@chopin/icons";
import { parseChildDocumentPath } from "@chopin/protocol/document-url";

import {
	AgentFace,
	Face,
	MotionDisclosure,
	MotionDisclosureIcon,
	useCardMeta,
} from "@chopin/editor";

import { MessageMarkdown } from "./markdown";
import { MessageMarkers } from "../conversation-plan/markers";
import type { ExcerptCorrectionAction } from "../conversation-plan/analysis-overview";
import type { CardLink } from "../conversation-plan/links";
import { capitalize, displayText, duration, group, summarize, toolCopy } from "./model";
import { clearSourceHighlight, highlightSource } from "../conversation-plan/source";
import type { ChatDestination } from "../conversation-plan/source";
import { motionContract } from "../motion-contract";
import { motionImmediately } from "../motion-input";

import type { Chat, ConversationPlan } from "@chopin/protocol";
import type { Group, Message } from "./model";
import type { CardMetaStore, QuestionnaireStore } from "@chopin/editor";
import type { Transport } from "@chopin/question/react";
import { ActivityLine, DecisionPrompt } from "./decision-entry";
import { ScopedChoicePrompt } from "./scoped-choice-entry";
import { ResearchOfferCard } from "./research-offer";
import type { ResearchOfferControls } from "./research-offer";
import { researchTranscript } from "./research-transcript";

type PlanMarkers = {
	canEdit?: boolean;
	conversationPlanJobs?: ConversationPlan.Job[];
	onCardLink?: (link: CardLink) => void;
	onAddExcerpt?: (action: ExcerptCorrectionAction) => Promise<void>;
	onRetryAnalysis?: (
		messageId: string,
		actionId: string,
		lane?: "decision" | "research",
	) => Promise<void>;
	onRetryJob?: (jobId: string) => Promise<void>;
	sourceDestination?: ChatDestination;
	conversationPlan?: ConversationPlan.State;
	researchOffers?: ResearchOfferControls;
};

export type TranscriptDecisions = {
	questions: QuestionnaireStore;
	meta: CardMetaStore;
	wire?: Transport;
	connected: boolean;
	canEdit: boolean;
	onOpenCard: (questionnaireId: string) => void;
};

function when(ts: number): string {
	return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function ToolRun({ tools }: { tools: Chat.Activity[] }) {
	let [open, setOpen] = useState(false);
	let contentId = useId();
	let summary = summarize(tools);
	let motion = motionContract("collapse");
	if (summary.state === "running") {
		return (
			<div className="flex min-h-7 min-w-0 flex-wrap items-center gap-2 py-1 text-sm text-text-quaternary">
				<LoaderIcon aria-hidden="true" className="chat-tool-loader" size={14} />
				<span className="min-w-0 break-all font-mono text-text-secondary">{summary.name}</span>
				<span className="tabular-nums">{summary.completed} done</span>
			</div>
		);
	}

	return (
		<div>
			<button
				aria-controls={open ? contentId : undefined}
				aria-expanded={open}
				className="flex min-h-7 min-w-0 flex-wrap items-center gap-2 bg-transparent py-1 text-sm text-text-quaternary"
				onClick={() => setOpen(value => !value)}
				type="button"
			>
				<MotionDisclosureIcon
					className="motion-feedback size-[14px]"
					closed={<ChevronIcon aria-hidden="true" size={14} />}
					open={open}
					opened={<ChevronIcon aria-hidden="true" className="rotate-90" size={14} />}
				/>
				<span className="tabular-nums">
					{summary.count} {summary.count === 1 ? "tool" : "tools"}
				</span>
				{summary.failures > 0 && (
					<span className="text-destructive-ink tabular-nums">
						{summary.failures} failed
					</span>
				)}
				<span className="tabular-nums">{duration(summary.elapsed)}</span>
			</button>

			<MotionDisclosure
				id={contentId}
				immediately={motionImmediately()}
				motion={motion}
				open={open}
				surface="chat-tools"
			>
				<ul
					aria-label="Tool calls"
					className="m-0 flex list-none flex-col pl-6 text-sm text-text-quaternary"
				>
					{tools.map(tool => (
						<li
							className="flex min-h-6 items-start gap-3"
							data-tool-status={tool.status}
							key={tool.id}
						>
							<span className="min-w-0 flex-1 break-all font-mono text-text-secondary">
								{toolCopy(tool.name)}
							</span>
							{tool.status === "failed" && (
								<span className="shrink-0 text-destructive-ink">Failed</span>
							)}
							<span className="shrink-0 tabular-nums">
								{tool.took === undefined ? "—" : duration(tool.took)}
							</span>
						</li>
					))}
				</ul>
			</MotionDisclosure>
		</div>
	);
}

function SystemEntry({ item }: { item: Extract<Group, { kind: "system" }> }) {
	let readyPath = /^Research is ready\. \[Open the research document\]\((\/documents\/\S+)\)\.$/
		.exec(item.text)?.[1];
	let linked = readyPath !== undefined && parseChildDocumentPath(readyPath) !== undefined;
	return (
		<div className="flex items-start gap-3 text-text-tertiary" data-chat-system>
			<div className="shrink-0">
				<SignInIcon aria-hidden="true" size={14} />
			</div>
			{linked
				? (
					<MessageMarkdown
						className="min-w-0 break-words text-sm [overflow-wrap:anywhere]"
						source={item.text}
					/>
				)
				: (
					<p className="m-0 min-w-0 break-words text-sm [overflow-wrap:anywhere]">
						{displayText(item.text)}
					</p>
				)}
		</div>
	);
}

function DecisionSystemEntry(
	{ conversationPlan, decisions, item, latest }: {
		conversationPlan?: ConversationPlan.State;
		decisions: TranscriptDecisions;
		item: Extract<Group, { kind: "system" }> & { decision: NonNullable<Chat.Entry["decision"]> };
		latest: boolean;
	},
) {
	let id = item.decision.questionnaireId;
	let values = useSyncExternalStore(
		decisions.questions.subscribe,
		decisions.questions.snapshot,
		decisions.questions.snapshot,
	);
	let value = values.find(entry => entry.id === id)?.value;
	let meta = useCardMeta(decisions.meta, id);
	let entry: Chat.Entry & { decision: NonNullable<Chat.Entry["decision"]> } = {
		id: item.id,
		author: { kind: "system" },
		text: item.text,
		ts: item.ts!,
		decision: item.decision,
	};
	let props = {
		entry,
		latest,
		value,
		meta,
		wire: decisions.wire,
		connected: decisions.connected,
		canEdit: decisions.canEdit,
		onOpenCard: decisions.onOpenCard,
	};

	if (entry.decision.kind === "scoped-choice") {
		return (
			<ScopedChoicePrompt
				canEdit={decisions.canEdit}
				connected={decisions.connected}
				decision={entry.decision}
				latest={latest}
				meta={meta}
				state={conversationPlan}
				value={value}
				wire={decisions.wire}
			/>
		);
	}
	return entry.decision.kind === "prompt"
		? <DecisionPrompt {...props} />
		: <ActivityLine {...props} />;
}

function MessageBody(
	{ handle, message, onWithdraw, ...markers }: {
		handle: string;
		message: Message;
		onWithdraw: (id: string) => void;
	} & PlanMarkers,
) {
	let text = displayText(message.text) ? message.text : message.author.kind === "member"
		? "Ask Planner"
		: "";

	return (
		<div
			className={`chat-message-body relative ${
				markers.sourceDestination?.source.messageId === message.id
					? "rounded-md bg-inset px-1"
					: ""
			}`}
			data-chat-message-id={message.id}
			data-chat-raw={message.text}
			data-chat-state={message.working ? "working" : undefined}
		>
			{text && (
				<div className="flex items-start gap-1">
					<div className="min-w-0 flex-1" data-chat-message-text>
						<MessageMarkdown
							className="break-words text-chat-body [overflow-wrap:anywhere]"
							references={message.references}
							source={text}
						/>
						{message.streaming && <span className="ml-0.5">▍</span>}
					</div>
					{message.queued && message.author.kind === "member" && message.author.handle === handle
						&& (
							<button
								aria-label="Withdraw queued message"
								data-tooltip="Withdraw Message"
								className="btn btn-icon btn-ghost -my-1 shrink-0"
								onClick={() => onWithdraw(message.id)}
								title="Withdraw"
								type="button"
							>
								<CloseIcon aria-hidden="true" size={14} />
							</button>
						)}
				</div>
			)}
			{message.tools && message.tools.length > 0 && <ToolRun tools={message.tools} />}
			{markers.sourceDestination?.source.messageId === message.id && (
				<p className="m-0 mt-1 text-xs text-text-secondary" data-source-preview>
					Source: “{markers.sourceDestination.source.quote}”
				</p>
			)}
			{!message.queued && markers.onCardLink && markers.onRetryAnalysis && (
				<MessageMarkers
					canEdit={!!markers.canEdit}
					messageId={message.id}
					messageText={message.text}
					jobs={markers.conversationPlanJobs}
					onCard={markers.onCardLink}
					onAddExcerpt={markers.onAddExcerpt}
					onRetry={markers.onRetryAnalysis}
					onRetryJob={markers.onRetryJob}
					state={markers.conversationPlan}
				/>
			)}
		</div>
	);
}

function MessageGroup(
	{ group: item, handle, onWithdraw, ...markers }: {
		group: Extract<Group, { kind: "messages" }>;
		handle: string;
		onWithdraw: (id: string) => void;
	} & PlanMarkers,
) {
	let first = item.messages[0]!;
	let name = item.author.kind === "agent" ? "Chopin" : capitalize(item.author.handle);

	return (
		<div
			className={`flex gap-3 ${item.queued ? "text-text-quaternary" : ""}`}
			data-chat-entry
			data-chat-state={item.queued ? "queued" : undefined}
		>
			<div className={`shrink-0 ${item.queued ? "opacity-45" : ""}`}>
				{item.author.kind === "agent"
					? <AgentFace size={24} />
					: <Face handle={item.author.handle} size={24} />}
			</div>
			<div
				className={`-mt-0.5 flex min-w-0 flex-1 flex-col gap-1 ${item.queued ? "opacity-60" : ""}`}
			>
				<div className="flex items-baseline gap-1.5 text-sm">
					<span className="min-w-0 break-all font-semibold">{name}</span>
					<span className="text-sm text-text-quaternary tabular-nums">
						{item.queued ? "queued" : when(first.ts!)}
					</span>
				</div>
				{item.messages.map(message => (
					<MessageBody
						canEdit={markers.canEdit}
						conversationPlanJobs={markers.conversationPlanJobs}
						onCardLink={markers.onCardLink}
						onAddExcerpt={markers.onAddExcerpt}
						onRetryAnalysis={markers.onRetryAnalysis}
						onRetryJob={markers.onRetryJob}
						conversationPlan={markers.conversationPlan}
						researchOffers={markers.researchOffers}
						sourceDestination={markers.sourceDestination}
						handle={handle}
						key={message.id}
						message={message}
						onWithdraw={onWithdraw}
					/>
				))}
			</div>
		</div>
	);
}

export function Transcript(
	{
		active,
		canEdit,
		conversationPlan,
		conversationPlanJobs,
		decisions,
		researchOffers,
		entries,
		handle,
		onCardLink,
		onAddExcerpt,
		onRetryAnalysis,
		onRetryJob,
		onWithdraw,
		queued,
		sourceDestination,
		working,
	}: {
		active: boolean;
		canEdit?: boolean;
		conversationPlan?: ConversationPlan.State;
		conversationPlanJobs?: ConversationPlan.Job[];
		onCardLink?: (link: CardLink) => void;
		onAddExcerpt?: (action: ExcerptCorrectionAction) => Promise<void>;
		onRetryAnalysis?: (
			messageId: string,
			actionId: string,
			lane?: "decision" | "research",
		) => Promise<void>;
		onRetryJob?: (jobId: string) => Promise<void>;
		decisions?: TranscriptDecisions;
		researchOffers?: ResearchOfferControls;
		entries: Chat.Entry[];
		handle: string;
		onWithdraw: (id: string) => void;
		queued: Chat.Waiting[];
		working?: Pick<Chat.Turn, "id" | "started">;
		sourceDestination?: ChatDestination;
	},
) {
	let bottom = useRef<HTMLDivElement>(null);
	let scroller = useRef<HTMLDivElement>(null);
	let pinned = useRef(true);
	let sourceOwner = useRef({});
	let groups = researchTranscript(
		group(entries, queued, working),
		researchOffers ? conversationPlan?.researchOffers ?? [] : [],
	);
	let latestPrompt = new Map<string, string>();
	let latestScoped = new Map<string, string>();
	for (let entry of entries) {
		if (entry.decision?.kind === "prompt") {
			latestPrompt.set(entry.decision.questionnaireId, entry.id);
		}
		if (entry.decision?.kind === "scoped-choice") {
			latestScoped.set(entry.decision.proposalId, entry.id);
		}
	}

	useEffect(() => {
		if (active && pinned.current) bottom.current?.scrollIntoView({ block: "end" });
	}, [active, entries, queued]);

	useEffect(() => {
		if (!active || !sourceDestination) return;
		let message = Array.from(
			scroller.current?.querySelectorAll<HTMLElement>("[data-chat-message-id]") ?? [],
		)
			.find(element => element.dataset.chatMessageId === sourceDestination.source.messageId);
		if (!message) return;
		pinned.current = false;
		message.scrollIntoView({ block: "center", inline: "nearest" });
		let exact = highlightSource(sourceOwner.current, message, sourceDestination.source);
		message.dataset.sourceExact = String(exact);
		return () => {
			clearSourceHighlight(sourceOwner.current);
			delete message.dataset.sourceExact;
		};
	}, [active, sourceDestination]);

	return (
		<div
			className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto p-3"
			data-focus-boundary=""
			ref={scroller}
			onScroll={event => {
				let element = event.currentTarget;
				let distance = element.scrollHeight - element.scrollTop - element.clientHeight;
				pinned.current = distance < 40;
			}}
		>
			<div
				className="flex min-h-full flex-col gap-4 [&>*:first-child]:mt-auto"
				data-chat-stack
			>
				{groups.map(item =>
					item.kind === "research"
						? (
							<ResearchOfferCard
								key={`research:${item.offer.id}`}
								controls={researchOffers!}
								offer={item.offer}
							/>
						)
						: item.kind === "system"
						? decisions && item.decision && item.ts !== undefined
							? (
								<DecisionSystemEntry
									conversationPlan={conversationPlan}
									decisions={decisions}
									item={item as Extract<Group, { kind: "system" }> & {
										decision: NonNullable<Chat.Entry["decision"]>;
									}}
									key={item.id}
									latest={item.decision.kind === "prompt"
										? latestPrompt.get(item.decision.questionnaireId) === item.id
										: item.decision.kind === "scoped-choice"
										? latestScoped.get(item.decision.proposalId) === item.id
										: true}
								/>
							)
							: <SystemEntry item={item} key={item.id} />
						: (
							<MessageGroup
								canEdit={canEdit}
								conversationPlanJobs={conversationPlanJobs}
								onCardLink={onCardLink}
								onAddExcerpt={onAddExcerpt}
								onRetryAnalysis={onRetryAnalysis}
								onRetryJob={onRetryJob}
								conversationPlan={conversationPlan}
								researchOffers={researchOffers}
								group={item}
								handle={handle}
								key={`${item.queued ? "queued" : "sent"}-${item.messages[0]!.id}`}
								onWithdraw={onWithdraw}
								sourceDestination={sourceDestination}
							/>
						)
				)}
				<div className="h-4 shrink-0" ref={bottom} />
			</div>
		</div>
	);
}
