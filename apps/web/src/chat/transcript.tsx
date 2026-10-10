/** The shared chat, grouped for reading rather than event delivery. */

import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import {
	CloseIcon,
	MessageForwardIcon,
	MessageIcon,
	SignInIcon,
	SparkleIcon,
	WarningIcon,
} from "@chopin/icons";
import { parseChildDocumentPath } from "@chopin/protocol/document-url";

import { ChopinMark, Face, openCommentThread, useCardMeta } from "@chopin/editor";
import { EmptyState } from "@chopin/visuals";

import { MessageMarkdown } from "./markdown";
import { MessageMarkers } from "../conversation-plan/markers";
import type { ExcerptCorrectionAction } from "../conversation-plan/analysis-overview";
import type { CardLink } from "../conversation-plan/links";
import { capitalize, displayText, group, workAnnouncement, workPhase } from "./model";
import { WorkProgress } from "./work-progress";
import { clearSourceHighlight, highlightSource } from "../conversation-plan/source";
import type { ChatDestination } from "../conversation-plan/source";

import type { Chat, ConversationPlan } from "@chopin/protocol";
import type { CompletedWork, Group, Message } from "./model";
import type { CardMetaStore, QuestionnaireStore } from "@chopin/editor";
import type { Transport } from "@chopin/question/react";
import { ActivityLine, DecisionPrompt } from "./decision-entry";
import { ScopedChoicePrompt } from "./scoped-choice-entry";
import { ResearchOfferCard } from "./research-offer";
import type { ResearchOfferControls } from "./research-offer";
import { researchTranscript } from "./research-transcript";
import type { ResearchTranscriptItem } from "./research-transcript";

type PlanMarkers = {
	decisions?: TranscriptDecisions;
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

const READY = /^Research is ready\. \[Open the research document\]\((\/documents\/\S+)\)\.$/;

function readyChild(text: string): string | undefined {
	let path = READY.exec(text)?.[1];
	return path ? parseChildDocumentPath(path)?.childSlug : undefined;
}

function SystemEntry(
	{ enter, item }: { enter: boolean; item: Extract<Group, { kind: "system" }> },
) {
	let readyPath = READY.exec(item.text)?.[1];
	let linked = readyPath !== undefined && parseChildDocumentPath(readyPath) !== undefined;
	let Icon = readyPath
		? SparkleIcon
		: item.text.startsWith("Research could not be completed")
		? WarningIcon
		: SignInIcon;
	return (
		<div
			className="flex items-center justify-start gap-3 text-text-tertiary"
			data-chat-enter={enter || undefined}
			data-chat-system
		>
			<div className="shrink-0">
				<Icon aria-hidden="true" size={14} />
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

/** A comment sent to Chopin: what it was about and what it said, linking back to the thread. */
function CommentSystemEntry(
	{ comment, enter }: {
		comment: NonNullable<Chat.Entry["comment"]>;
		enter: boolean;
	},
) {
	return (
		<button
			className="chat-comment-notice"
			data-chat-comment={comment.thread}
			data-chat-enter={enter || undefined}
			onClick={() => openCommentThread(comment.thread)}
			type="button"
		>
			<span className="chat-comment-notice-head">
				<MessageForwardIcon aria-hidden="true" className="icon-first-line" size={14} />
				<span>
					Comment on <span className="chat-comment-notice-title">“{comment.excerpt}”</span>{" "}
					sent to Chopin
				</span>
			</span>
			<span className="chat-comment-notice-body">
				<span className="chat-comment-notice-mention">@Chopin</span> {comment.note}
			</span>
		</button>
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

/** A leading @chopin is the Planner address; the prefix is drawn from `to`, so it is not shown twice. */
let LEADING_MENTION = /^\s*@chopin\b[^\S\n]*/i;

function MessageBody(
	{ enter, handle, message, onWithdraw, ...markers }: {
		enter: boolean;
		handle: string;
		message: Message;
		onWithdraw: (id: string) => void;
	} & PlanMarkers,
) {
	let toPlanner = message.to === "planner" && message.author.kind === "member";
	let lead = toPlanner ? LEADING_MENTION.exec(message.text)?.[0].length ?? 0 : 0;
	let text = toPlanner ? message.text.slice(lead) : message.text;
	let references = lead
		? message.references?.filter(item => item.start >= lead)
			.map(item => ({ ...item, start: item.start - lead, end: item.end - lead }))
		: message.references;
	if (!toPlanner && !displayText(text) && message.author.kind === "member") text = "Ask Chopin";

	return (
		<div
			className="chat-message-body relative"
			data-chat-enter={enter || undefined}
			data-chat-source={markers.sourceDestination?.source.messageId === message.id || undefined}
			data-chat-message-id={message.id}
			data-chat-raw={message.text}
			data-chat-state={message.working
				? "working"
				: message.workDisconnected
				? "disconnected"
				: undefined}
		>
			{(message.working || message.workDisconnected || !!message.tools?.length) && (
				<WorkProgress
					decisions={markers.decisions}
					active={!!message.working}
					disconnected={!!message.workDisconnected}
					responseSeen={!!message.workResponseSeen}
					streaming={!!message.workStreaming || !!message.streaming}
					tools={message.tools ?? []}
				/>
			)}
			{markers.sourceDestination?.source.messageId === message.id && (
				<span
					aria-hidden="true"
					className="chat-source-tint"
					key={markers.sourceDestination.token}
				/>
			)}
			{(text || toPlanner) && (
				<div className="flex items-start gap-1">
					<div className="min-w-0 flex-1" data-chat-message-text>
						<MessageMarkdown
							className="break-words text-chat-body [overflow-wrap:anywhere]"
							mention={toPlanner ? "@chopin" : undefined}
							references={references}
							source={text}
						/>
						{message.streaming && <span className="ml-0.5">▍</span>}
					</div>
					{message.queued && message.author.kind === "member" && message.author.handle === handle
						&& (
							<button
								aria-label="Withdraw queued message"
								data-tooltip="Withdraw message"
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
	{ enter, entering, group: item, handle, onWithdraw, ...markers }: {
		/** The whole group entered; `entering` holds messages that joined it later. */
		enter: boolean;
		entering: ReadonlySet<string>;
		group: Extract<ResearchTranscriptItem, { kind: "messages" }>;
		handle: string;
		onWithdraw: (id: string) => void;
	} & PlanMarkers,
) {
	let first = item.messages[0]!;
	let active = item.messages.find(message => message.working);
	let name = item.author.kind === "agent" ? "Chopin" : capitalize(item.author.handle);

	return (
		<div
			className={`flex gap-3 ${item.queued ? "text-text-quaternary" : ""}`}
			data-chat-enter={enter || undefined}
			data-chat-entry
			data-chat-state={item.queued ? "queued" : undefined}
		>
			<div className={`w-6 shrink-0 ${item.queued ? "opacity-45" : ""}`}>
				{item.continued
					? null
					: item.author.kind === "agent"
					? <ChopinMark circle />
					: <Face decorative handle={item.author.handle} size={24} titled={false} />}
			</div>
			<div
				className={`flex min-w-0 flex-1 flex-col gap-1 ${item.continued ? "" : "-mt-0.5"} ${
					item.queued ? "opacity-60" : ""
				}`}
			>
				{!item.continued && (
					<div className="flex items-baseline gap-1.5 text-sm">
						<span className="min-w-0 break-all font-semibold">{name}</span>
						<span
							className={item.queued
								? "text-sm text-text-quaternary tabular-nums"
								: "text-2xs text-text-tertiary tabular-nums"}
						>
							{item.queued
								? "queued"
								: active
								? `Started at ${when(active.ts!)}`
								: when(first.ts!)}
						</span>
					</div>
				)}
				{item.messages.map(message => (
					<MessageBody
						enter={entering.has(message.id)}
						decisions={markers.decisions}
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
		completedWork,
		conversationPlan,
		conversationPlanJobs,
		decisions,
		empty,
		researchOffers,
		emptyHint,
		entries,
		handle,
		live,
		onCardLink,
		onAddExcerpt,
		onRetryAnalysis,
		onRetryJob,
		onWithdraw,
		queued,
		sourceDestination,
		suspendedWork,
		working,
	}: {
		active: boolean;
		canEdit?: boolean;
		completedWork?: CompletedWork[];
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
		empty?: string;
		emptyHint?: { planner: boolean; references: boolean };
		researchOffers?: ResearchOfferControls;
		entries: Chat.Entry[];
		handle: string;
		/** False until the current connection's history has arrived. */
		live?: boolean;
		onWithdraw: (id: string) => void;
		queued: Chat.Waiting[];
		suspendedWork?: CompletedWork;
		working?: Pick<Chat.Turn, "id" | "started" | "entryOffset">;
		sourceDestination?: ChatDestination;
	},
) {
	let scroller = useRef<HTMLDivElement>(null);
	let stack = useRef<HTMLDivElement>(null);
	let pinned = useRef(true);
	// Growth follows only a reader resting on the last line, not one a few pixels up.
	let flush = useRef(true);
	let previous = useRef<{ groups: Set<string>; atoms: Set<string>; planned: boolean }>(undefined);
	let entered = useRef(new Set<string>());
	let places = useRef(new Map<string, { at: string; top: number }>());
	let sourceOwner = useRef({});
	let groups = researchTranscript(
		group(entries, queued, working, completedWork, suspendedWork),
		researchOffers ? conversationPlan?.researchOffers ?? [] : [],
	);
	let messages = groups.flatMap(item => item.kind === "messages" ? item.messages : []);
	// A turn keeps one row from its placeholder through completion, so it enters once.
	let turns = new Map(
		[...completedWork ?? [], ...suspendedWork ? [suspendedWork] : []].map(work => [
			work.anchorId,
			work.turnId,
		]),
	);
	let keyed = groups.map(item => {
		if (item.kind === "research") return { item, key: `research:${item.offer.id}` };
		if (item.kind === "system") return { item, key: item.id };
		let first = item.messages[0]!;
		let turn = first.working ? working?.id : turns.get(first.id);
		return { item, key: turn ? `turn:${turn}` : `${item.queued ? "queued" : "sent"}-${first.id}` };
	});
	let atoms = new Set(
		groups.flatMap(item =>
			item.kind === "messages"
				? item.messages.map(message => message.id)
				: [item.kind === "research" ? `research:${item.offer.id}` : item.id]
		),
	);
	let before = previous.current;
	let entering = new Set(before ? [...atoms].filter(atom => !before.atoms.has(atom)) : []);
	// History, reconnects and document switches arrive in bulk; only live arrivals move.
	let animate = !!live && !!before && entering.size <= 3;
	// Marks stay for the row's lifetime: dropping one on the next render would cut its fade short.
	if (animate) {
		for (let { item, key } of keyed) {
			if (!before!.groups.has(key)) {
				if (item.kind !== "research" || before!.planned) entered.current.add(`row:${key}`);
			} else if (item.kind === "messages") {
				for (let message of item.messages) {
					if (entering.has(message.id)) entered.current.add(message.id);
				}
			}
		}
	}
	let enters = (key: string) => entered.current.has(`row:${key}`);
	let readySubscribe = useCallback(
		(listener: () => void) => researchOffers?.store.subscribe(listener) ?? (() => {}),
		[researchOffers?.store],
	);
	// A ready request linked from a visible offer card already says so there.
	let readySnapshot = () =>
		groups.flatMap(item => {
			if (item.kind !== "research") return [];
			let id = researchOffers?.links[item.offer.id]?.researchRequestId;
			let slug = id ? researchOffers?.store.get(id)?.child?.slug : undefined;
			return slug ? [slug] : [];
		}).join("\n");
	let readySlugs = useSyncExternalStore(readySubscribe, readySnapshot, readySnapshot);
	let announced = new Set(readySlugs ? readySlugs.split("\n") : []);
	let currentWork = messages.find(message => message.working);
	let phase = currentWork
		? workPhase(
			currentWork.tools ?? [],
			!!currentWork.workStreaming || !!currentWork.streaming,
			true,
			!!currentWork.workResponseSeen,
		)
		: undefined;
	let announcement = "";
	if (phase) announcement = workAnnouncement(phase);
	else if (suspendedWork) {
		let hasDetails = !!messages.find(message => message.id === suspendedWork.anchorId)?.tools
			?.length;
		announcement = hasDetails
			? "Chopin connection lost. Work details remain available."
			: "Chopin connection lost.";
	} else if (completedWork?.length) {
		let anchorId = completedWork.at(-1)?.anchorId;
		let hasDetails = !!messages.find(message => message.id === anchorId)?.tools?.length;
		announcement = hasDetails
			? "Chopin turn ended. Work details remain available."
			: "Chopin turn ended.";
	}
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

	useLayoutEffect(() => {
		// Your own message always comes into view, wherever you had scrolled.
		if (
			messages.some(message =>
				entering.has(message.id) && message.author.kind === "member"
				&& message.author.handle === handle
			)
		) pinned.current = true;
		// Rows that arrived behind a hidden Chat (the phone tab) are not news when it opens.
		if (!active || !scroller.current?.getClientRects().length) {
			entered.current.clear();
			for (let row of stack.current?.querySelectorAll("[data-chat-enter]") ?? []) {
				row.removeAttribute("data-chat-enter");
			}
		}
		let rows = new Set(keyed.map(entry => entry.key));
		previous.current = { groups: rows, atoms, planned: !!conversationPlan };
		for (let mark of entered.current) {
			if (!atoms.has(mark) && !rows.has(mark.slice(4))) entered.current.delete(mark);
		}
	});

	// An offer that follows a newer message slides from where it was last painted rather than
	// teleporting. Positions are kept content-relative so the reader's own scrolling is not motion.
	useLayoutEffect(() => {
		let element = scroller.current;
		if (!element) return;
		let scrolled = element.scrollTop;
		if (active && pinned.current) element.scrollTop = element.scrollHeight;
		let reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
		let cards = () => [
			...element.querySelectorAll<HTMLElement>("[data-chat-placement]"),
		];
		let place = (card: HTMLElement) =>
			card.getBoundingClientRect().top - element.getBoundingClientRect().top;
		for (let card of cards()) {
			let last = places.current.get(card.dataset.chatOffer!);
			if (!last || last.at === card.dataset.chatPlacement || reduce) continue;
			for (let running of card.getAnimations()) running.cancel();
			let offset = last.top - scrolled - place(card);
			if (Math.abs(offset) < 1) continue;
			let tokens = getComputedStyle(card);
			let duration = tokens.getPropertyValue("--acc-expand").trim();
			card.animate([{ transform: `translateY(${offset}px)` }, { transform: "none" }], {
				duration: parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000),
				easing: tokens.getPropertyValue("--motion-move"),
			});
		}
		let frame = requestAnimationFrame(() => {
			places.current = new Map(
				cards().map(card => [card.dataset.chatOffer!, {
					at: card.dataset.chatPlacement!,
					top: place(card) + element.scrollTop,
				}]),
			);
		});
		return () => cancelAnimationFrame(frame);
	});

	useLayoutEffect(() => {
		let element = scroller.current;
		if (active && pinned.current && element) element.scrollTop = element.scrollHeight;
	}, [active, entries, queued]);

	// Rows grow after they mount (streaming, work details, offer cards) and the pane resizes
	// (phone keyboard, composer, window); a reader at the bottom stays on the newest line.
	useLayoutEffect(() => {
		let element = scroller.current;
		if (!active || !element || !stack.current) return;
		let observer = new ResizeObserver(() => {
			if (flush.current) element.scrollTop = element.scrollHeight;
		});
		observer.observe(stack.current);
		observer.observe(element);
		return () => observer.disconnect();
	}, [active]);

	useEffect(() => {
		if (!active || !sourceDestination) return;
		let message = Array.from(
			scroller.current?.querySelectorAll<HTMLElement>("[data-chat-message-id]") ?? [],
		)
			.find(element => element.dataset.chatMessageId === sourceDestination.source.messageId);
		if (!message) return;
		pinned.current = false;
		flush.current = false;
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
			className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto px-5 py-3"
			data-focus-boundary=""
			ref={scroller}
			onScroll={event => {
				let element = event.currentTarget;
				let distance = element.scrollHeight - element.scrollTop - element.clientHeight;
				pinned.current = distance < 48;
				flush.current = distance <= 2;
			}}
		>
			<span
				aria-atomic="true"
				aria-live="polite"
				className="sr-only"
				data-chat-work-announcer
				role="status"
			>
				{announcement}
			</span>
			<div
				className="relative flex min-h-full shrink-0 flex-col gap-4 [&>*:first-child]:mt-auto"
				data-chat-stack
				ref={stack}
			>
				{empty && (
					<p
						className="px-1 text-center text-sm text-balance text-text-tertiary"
						data-chat-empty=""
					>
						{empty}
					</p>
				)}
				{keyed.map(({ item, key }) =>
					item.kind === "research"
						? (
							<div
								data-chat-enter={enters(key) || undefined}
								data-chat-offer={item.offer.id}
								data-chat-placement={item.offer.workflow?.placementMessageId
									?? item.offer.source.messageId}
								key={key}
							>
								<ResearchOfferCard controls={researchOffers!} offer={item.offer} />
							</div>
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
									key={key}
									latest={item.decision.kind === "prompt"
										? latestPrompt.get(item.decision.questionnaireId) === item.id
										: item.decision.kind === "scoped-choice"
										? latestScoped.get(item.decision.proposalId) === item.id
										: true}
								/>
							)
							: item.comment
							? <CommentSystemEntry comment={item.comment} enter={enters(key)} key={key} />
							: announced.has(readyChild(item.text) ?? "")
							? null
							: <SystemEntry enter={enters(key)} item={item} key={key} />
						: (
							<MessageGroup
								decisions={decisions}
								canEdit={canEdit}
								conversationPlanJobs={conversationPlanJobs}
								onCardLink={onCardLink}
								onAddExcerpt={onAddExcerpt}
								onRetryAnalysis={onRetryAnalysis}
								onRetryJob={onRetryJob}
								conversationPlan={conversationPlan}
								researchOffers={researchOffers}
								enter={enters(key)}
								entering={entered.current}
								group={item}
								handle={handle}
								key={key}
								onWithdraw={onWithdraw}
								sourceDestination={sourceDestination}
							/>
						)
				)}
				<div className="h-4 shrink-0" />
				{emptyHint && (
					<div
						aria-hidden={groups.length > 0 || undefined}
						className={`pointer-events-none absolute inset-0 flex items-center justify-center px-6 transition-opacity motion-reduce:transition-none ${
							groups.length > 0 ? "opacity-0" : "opacity-100"
						}`}
						data-chat-empty=""
					>
						<EmptyState
							density="compact"
							icon={MessageIcon}
							measure="short"
							description={
								<>
									Talk it through with your collaborators.
									{emptyHint.planner && (
										<>
											{" "}Mention{" "}
											<strong className="font-medium text-text-secondary">@chopin</strong>{" "}
											to ask the Planner
											{emptyHint.references ? ", or " : "."}
										</>
									)}
									{emptyHint.references && (
										<>
											{emptyHint.planner ? "" : " Use "}
											<strong className="font-medium text-text-secondary">#</strong>{" "}
											to point at a document.
										</>
									)}
								</>
							}
						/>
					</div>
				)}
			</div>
		</div>
	);
}
