import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { Face, ResearchBrief, ResearchCard } from "@chopin/editor";
import { CheckIcon, CloseIcon, PlusIcon, SearchIcon, WarningIcon } from "@chopin/icons";

import type { ConversationPlan, Research } from "@chopin/protocol";
import type { ResearchRequestStore } from "../research-requests";
import type { Wire } from "../wire";
import { ResearchDraftController } from "./research-draft-controller";
import { ResearchBriefEditor } from "./research-brief-editor";
import "./research-offer.css";

const RETRY_DELAYS = [2_000, 5_000, 10_000];

export type OfferLinkView = {
	status: "checking" | "pending" | "unlinked" | "linked" | "error";
	researchRequestId?: string;
	exhausted?: boolean;
};

export type ResearchOfferControls = {
	links: Readonly<Record<string, OfferLinkView>>;
	busy: ReadonlySet<string>;
	errors: Readonly<Record<string, string>>;
	canAct: boolean;
	canCheckLink: boolean;
	canExecute?: boolean;
	wire?: Wire;
	controllers?: Map<string, ResearchDraftController>;
	onSource?: (source: ConversationPlan.ResearchSource) => void;
	/** The viewer, left out of the card's list of other editors. */
	handle?: string;
	store: ResearchRequestStore;
	onAction: (offerId: string, choice: "research" | "dismiss" | "resume") => void;
	onRetryLink: (offerId: string) => void;
};

export function shouldShowResearchActionError(
	choice: "research" | "dismiss" | "resume",
	offerStatus: ConversationPlan.ResearchOffer["status"] | undefined,
	linkStatus: OfferLinkView["status"] | undefined,
): boolean {
	return choice === "resume"
		? offerStatus === "accepted" && linkStatus !== "linked"
		: offerStatus === "offered";
}

type Tracker = {
	id: string;
	inFlight: boolean;
	dirty: boolean;
	retries: number;
	status: OfferLinkView["status"];
	timer?: ReturnType<typeof setTimeout>;
};

/** Read-only accepted-offer observer; the timer boundary is injected for controlled-clock tests. */
export class ResearchOfferLinkObserver {
	#trackers = new Map<string, Tracker>();
	#links: Record<string, OfferLinkView> = {};
	#disposed = false;
	constructor(
		private readonly ask: (offerId: string) => Promise<ConversationPlan.ResearchLinkResult>,
		private readonly publish: (links: Readonly<Record<string, OfferLinkView>>) => void,
		private readonly schedule = (run: () => void, ms: number) => setTimeout(run, ms),
		private readonly cancel = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
	) {}

	accept(ids: ReadonlySet<string>): void {
		if (this.#disposed) return;
		let changed = false;
		for (let [id, tracker] of this.#trackers) {
			if (ids.has(id)) continue;
			if (tracker.timer !== undefined) this.cancel(tracker.timer);
			this.#trackers.delete(id);
			delete this.#links[id];
			changed = true;
		}
		for (let id of ids) {
			if (this.#trackers.has(id)) continue;
			this.#trackers.set(id, {
				id,
				inFlight: false,
				dirty: false,
				retries: 0,
				status: "checking",
			});
			this.#links[id] = { status: "checking" };
			changed = true;
			this.#read(id);
		}
		if (changed) this.#publish();
	}

	changed(): void {
		for (let tracker of this.#trackers.values()) {
			if (tracker.status !== "linked") this.#read(tracker.id);
		}
	}

	refresh(id: string, restart = false): void {
		let tracker = this.#trackers.get(id);
		if (!tracker) return;
		if (restart && tracker.status !== "linked") {
			tracker.retries = 0;
			tracker.status = "checking";
			this.#links[id] = { status: "checking" };
			this.#publish();
		}
		this.#read(id);
	}

	dispose(): void {
		this.#disposed = true;
		for (let tracker of this.#trackers.values()) {
			if (tracker.timer !== undefined) this.cancel(tracker.timer);
		}
		this.#trackers.clear();
	}

	#publish(): void {
		this.publish({ ...this.#links });
	}

	#read(id: string): void {
		let tracker = this.#trackers.get(id);
		if (!tracker || this.#disposed || tracker.status === "linked") return;
		if (tracker.timer !== undefined) this.cancel(tracker.timer);
		tracker.timer = undefined;
		if (tracker.inFlight) {
			tracker.dirty = true;
			return;
		}
		tracker.inFlight = true;
		void this.ask(id).then(result => {
			if (this.#trackers.get(id) !== tracker) return;
			if (
				result.offerId !== id
				|| !["pending", "unlinked", "linked"].includes(result.status)
				|| result.status === "pending" && result.researchRequestId !== undefined
				|| result.status !== "pending" && !result.researchRequestId
			) throw new Error("research link response did not match the offer");
			tracker.status = result.status;
			this.#links[id] = {
				status: result.status,
				...(result.researchRequestId
					? { researchRequestId: result.researchRequestId }
					: {}),
			};
			this.#publish();
		}).catch(() => {
			if (this.#trackers.get(id) !== tracker) return;
			tracker.status = "error";
			this.#links[id] = { status: "error" };
			this.#publish();
		}).finally(() => {
			if (this.#trackers.get(id) !== tracker) return;
			tracker.inFlight = false;
			if (tracker.status === "linked") return;
			if (tracker.dirty) {
				tracker.dirty = false;
				this.#read(id);
				return;
			}
			if (tracker.retries < RETRY_DELAYS.length) {
				let delay = RETRY_DELAYS[tracker.retries++]!;
				tracker.timer = this.schedule(() => this.#read(id), delay);
			} else {
				this.#links[id] = { ...this.#links[id]!, exhausted: true };
				this.#publish();
			}
		});
	}
}

/** Observe exact accepted-offer links without starting or resuming research. */
export function useResearchOfferLinks(
	wire: Wire | undefined,
	connected: boolean,
	offers: readonly ConversationPlan.ResearchOffer[],
): {
	links: Readonly<Record<string, OfferLinkView>>;
	refresh: (offerId: string, restart?: boolean) => void;
} {
	let [links, setLinks] = useState<Readonly<Record<string, OfferLinkView>>>({});
	let observer = useRef<ResearchOfferLinkObserver | undefined>(undefined);
	useEffect(() => {
		if (!wire || !connected) {
			setLinks({});
			return;
		}
		let current = new ResearchOfferLinkObserver(
			offerId =>
				wire.ask<ConversationPlan.ResearchLinkResult>(
					"conversation-plan:research-link",
					{ offerId },
				),
			setLinks,
		);
		observer.current = current;
		let off = wire.on<Research.Changed>("research:changed", () => current.changed());
		return () => {
			off();
			current.dispose();
			if (observer.current === current) observer.current = undefined;
		};
	}, [wire, connected]);
	useEffect(() => {
		observer.current?.accept(
			new Set(
				offers.filter(offer => offer.status === "accepted")
					.map(offer => offer.id),
			),
		);
	}, [wire, connected, offers]);
	let refresh = useCallback((offerId: string, restart = false) => {
		observer.current?.refresh(offerId, restart);
	}, []);
	return { links, refresh };
}

const RESUME_AFTER = 1_500;
const CANCEL_ATTEMPTS = 3;
const CANCEL_RETRY_MS = 600;

const TRACK: readonly Research.RequestStage[] = [
	"queued",
	"searching",
	"analyzing",
	"writing",
	"publishing",
];

/** Keep an active request's stage from stepping backwards; terminal stages always show. */
export function forwardStage(
	previous: Research.RequestStage | undefined,
	next: Research.RequestStage,
): Research.RequestStage {
	let from = previous ? TRACK.indexOf(previous) : -1;
	let to = TRACK.indexOf(next);
	return to >= 0 && from > to ? previous! : next;
}

function AcceptedResearch(
	{ offer, link, controls, canExecute }: {
		offer: ConversationPlan.ResearchOffer;
		link: OfferLinkView | undefined;
		controls: ResearchOfferControls;
		canExecute: boolean;
	},
) {
	let { store } = controls;
	let id = link?.status === "linked" ? link.researchRequestId : undefined;
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState<{ text: string; cancel: boolean }>();
	let subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
	let request = useSyncExternalStore(
		subscribe,
		() => id ? store.get(id) : undefined,
		() => undefined,
	);
	useEffect(() => id ? store.retain(id) : undefined, [id, store]);
	let [shown, setShown] = useState<{ id?: string; stage?: Research.RequestStage }>({});
	let stage = request
		? forwardStage(shown.id === id ? shown.stage : undefined, request.stage)
		: undefined;
	if (shown.id !== id || shown.stage !== stage) setShown({ id, stage });
	// A link that stays pending needs Resume; one about to link should not flash it.
	let [stalled, setStalled] = useState(false);
	useEffect(() => {
		setStalled(false);
		if (link?.status !== "pending") return;
		let timer = setTimeout(() => setStalled(true), RESUME_AFTER);
		return () => clearTimeout(timer);
	}, [link?.status]);
	// Until the request is readable the card shows the accepted brief as waiting work.
	let view = (request
		? { ...request, stage }
		: {
			id: offer.id,
			channelId: "",
			question: offer.brief,
			sources: [],
			createdAt: "",
			updatedAt: "",
			state: "pending",
			stage: "queued",
		}) as Research.RequestView;
	let canEdit = controls.canAct && canExecute && !!request;
	let action = (run: () => Promise<unknown>, failure: string, cancel = false) => {
		setBusy(true);
		setError(undefined);
		void run().catch(() => setError({ text: failure, cancel })).finally(() => setBusy(false));
	};
	// The server refuses a cancel until the worker has claimed the request; a settled
	// request makes an earlier cancel failure moot.
	let cancel = async (id: string) => {
		for (let attempt = 1;; attempt++) {
			try {
				return await store.cancel(id);
			} catch (failure) {
				if (attempt >= CANCEL_ATTEMPTS) throw failure;
				await new Promise(resolve => setTimeout(resolve, CANCEL_RETRY_MS));
			}
		}
	};
	let terminal = !!stage && !TRACK.includes(stage);
	let actionError = error && !(error.cancel && terminal) ? error.text : undefined;
	let canResume = link?.status === "unlinked" || link?.status === "pending" && stalled;
	let unverified = link?.status === "error" && link.exhausted;
	let note = !request && (unverified
		? "The research request could not be confirmed yet."
		: link?.status === "unlinked"
		? "Accepted but not started."
		: undefined);
	return (
		<div className="flex flex-col gap-2">
			<ResearchCard
				actionError={actionError}
				busy={busy}
				canEdit={canEdit}
				request={view}
				onCancel={id && canEdit
					? () => action(() => cancel(id), "Research could not be cancelled yet.", true)
					: undefined}
				onOpen={id && view.child
					? opener => store.open(view.child!, store.opener(id, opener))
					: undefined}
				openButtonRef={id ? button => store.opener(id, button) : undefined}
				onRetry={id && canEdit
					? () =>
						action(
							() => store.retry(id),
							"Research could not be retried. Try again when connected.",
						)
					: undefined}
			/>
			{(note
				|| controls.canAct && canExecute && canResume
				|| unverified && controls.canCheckLink) && (
				<div className="flex items-center justify-end gap-2 text-xs text-text-tertiary">
					{note && <span className="mr-auto">{note}</span>}
					{controls.canAct && canExecute && canResume && (
						<button
							className="btn btn-sm btn-outline"
							disabled={controls.busy.has(offer.id)}
							onClick={() => controls.onAction(offer.id, "resume")}
							type="button"
						>
							Resume
						</button>
					)}
					{unverified && controls.canCheckLink && (
						<button
							className="btn btn-sm btn-outline"
							onClick={() => controls.onRetryLink(offer.id)}
							type="button"
						>
							Retry link check
						</button>
					)}
				</div>
			)}
		</div>
	);
}

export function ResearchOfferCard(
	{ offer, controls }: { offer: ConversationPlan.ResearchOffer; controls: ResearchOfferControls },
) {
	let busy = controls.busy.has(offer.id);
	let [controller] = useState(() => {
		let controller = controls.controllers?.get(offer.id) ?? new ResearchDraftController(offer);
		controls.controllers?.set(offer.id, controller);
		return controller;
	});
	let draft = useSyncExternalStore(controller.subscribe, controller.get, controller.get);
	let [actionError, setActionError] = useState("");
	let [acting, setActing] = useState(false);
	let [editors, setEditors] = useState<Record<string, string>>({});
	let initial = useRef(offer.status);
	let [opening, setOpening] = useState(false);
	let [sourceAt, setSourceAt] = useState(0);
	let editButton = useRef<HTMLButtonElement>(null);
	useLayoutEffect(() => {
		controller.configure(controls.wire, !!controls.wire?.connected, offer);
	}, [controller, controls.wire, controls.canAct, offer]);
	useEffect(() => {
		setEditors({});
		if (!controls.wire?.connected) return;
		return controls.wire.on<ConversationPlan.ResearchPresenceChanged>(
			"conversation-plan:research-presence",
			frame => {
				if (frame.offerId !== offer.id) return;
				setEditors(previous => {
					let next = { ...previous };
					if (frame.editing) next[frame.client] = frame.handle;
					else delete next[frame.client];
					return next;
				});
			},
		);
	}, [controls.wire, controls.canAct, offer.id]);
	useEffect(() => () => controller.focus(false), [controller]);
	let perform = (run: () => Promise<void>, settled?: () => void) => {
		let blocking = !settled;
		if (blocking) setActing(true);
		setActionError("");
		void run().catch(error =>
			setActionError(error instanceof Error ? error.message : "Research action failed.")
		).finally(() => {
			if (blocking) setActing(false);
			settled?.();
		});
	};
	let edit = async (operation: ConversationPlan.ResearchEdit["operation"]) => {
		if (!controls.wire?.connected) throw new Error("Reconnect to edit research.");
		await controller.flush();
		let result = await controls.wire.ask<ConversationPlan.ResearchEdited>(
			"conversation-plan:research-edit",
			{ offerId: offer.id, operation },
		);
		controller.receive(result.offer);
	};
	let disabled = busy || acting;
	let canExecute = controls.canExecute ?? controls.canAct;
	let link = controls.links[offer.id];
	let entering = initial.current !== offer.status;
	if (offer.status === "accepted") {
		return (
			<div
				aria-label="Research suggestion"
				aria-busy={busy}
				className="chat-research ml-9 flex min-w-0 flex-col gap-2"
				data-entering={entering ? "" : undefined}
				data-research-offer={offer.id}
				role="group"
			>
				<AcceptedResearch
					canExecute={canExecute}
					controls={controls}
					link={link}
					offer={offer}
				/>
				{link?.status !== "linked" && controls.errors[offer.id] && (
					<p className="m-0 text-sm text-destructive-ink" role="alert">
						{controls.errors[offer.id]}
					</p>
				)}
			</div>
		);
	}
	if (offer.status === "dismissed") {
		return (
			<div
				aria-label="Research suggestion"
				className="chat-research ml-9 flex min-w-0 items-center gap-2 text-xs text-text-tertiary"
				data-entering={entering ? "" : undefined}
				data-research-offer={offer.id}
				role="group"
			>
				<SearchIcon aria-hidden="true" className="shrink-0" size={14} />
				<span className="min-w-0 truncate">Research suggestion dismissed</span>
			</div>
		);
	}
	let others = [
		...new Set(
			Object.values(editors).filter(handle =>
				handle.toLowerCase() !== controls.handle?.toLowerCase()
			),
		),
	];
	let sources = offer.workflow?.sources ?? [];
	let authors = [
		...new Set(
			sources.map(source =>
				source.author.kind === "member" ? `@${source.author.handle}` : "Chopin"
			),
		),
	];
	let editing = draft.editing && offer.status === "offered";
	let refinementFailed = offer.status === "offered" && offer.workflow?.preparation === "failed";
	let retryRefinement = () => perform(() => edit({ kind: "retry" }));
	let start = () =>
		perform(async () => {
			if (controls.wire) await controller.flush();
			controls.onAction(offer.id, "research");
		});
	let canStart = !disabled && canExecute && !!draft.text.trim();
	let finish = () => {
		controller.end();
		editButton.current?.focus({ preventScroll: true });
	};
	return (
		<div
			aria-label="Research suggestion"
			aria-busy={disabled}
			className="chat-research ml-9 flex min-w-0 flex-col gap-2 rounded-lg bg-page px-3 py-2.5 shadow-resting ring-hairline max-w-[28.125rem]"
			data-entering={entering ? "" : undefined}
			data-research-offer={offer.id}
			role="group"
		>
			<div className="flex min-h-6 items-center gap-2">
				<SearchIcon aria-hidden="true" className="shrink-0 text-text-tertiary" size={14} />
				<p className="m-0 min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
					Research suggestion
				</p>
				{others.length > 0 && (
					<span
						aria-label={`Also editing: ${others.map(handle => `@${handle}`).join(", ")}`}
						aria-live="polite"
						className="flex shrink-0 -space-x-1"
						role="img"
					>
						{others.slice(0, 3).map(handle => (
							<Face handle={handle} key={handle} ring="page" size={16} titled={false} />
						))}
					</span>
				)}
				{refinementFailed && controls.canAct && draft.text.trim() && (
					<button
						aria-label="Retry brief refinement"
						className="btn btn-icon btn-ghost -my-1 shrink-0"
						data-tooltip="Brief refinement failed. Retry"
						disabled={disabled}
						onClick={retryRefinement}
						type="button"
					>
						<WarningIcon aria-hidden="true" size={14} />
					</button>
				)}
				{authors.length > 0 && controls.onSource && (
					<button
						aria-label={`Show source ${sources.length === 1 ? "message" : "messages"}`}
						className="max-w-[45%] shrink-0 truncate text-xs text-text-tertiary hover:text-text-secondary"
						data-tooltip={sources.length > 1 ? `${sources.length} source messages` : undefined}
						onClick={() => {
							let source = sources[sourceAt % sources.length];
							if (source) controls.onSource?.(source);
							setSourceAt(sourceAt + 1);
						}}
						type="button"
					>
						from {authors.length > 2
							? `${authors.slice(0, 2).join(", ")} +${authors.length - 2}`
							: authors.join(", ")}
					</button>
				)}
			</div>
			{editing
				? (
					<ResearchBriefEditor
						controller={controller}
						onEscape={finish}
						onSubmit={() => {
							if (canStart) start();
						}}
						readOnly={!controls.canAct || disabled}
						text={draft.text}
					/>
				)
				: (
					<div className="min-w-0 break-words text-sm text-text-primary">
						<ResearchBrief text={offer.brief} />
					</div>
				)}
			{offer.status === "offered"
				&& offer.workflow?.additions.filter(item => item.status === "pending").map(addition => (
					<div
						aria-label="Suggested addition"
						className="flex items-start gap-1 rounded-md bg-inset py-1 pr-1 pl-2 text-sm text-text-secondary"
						key={addition.id}
						role="group"
					>
						<PlusIcon aria-hidden="true" className="mt-0.5 shrink-0 text-text-tertiary" size={14} />
						<p className="m-0 min-w-0 flex-1 break-words py-0.5">{addition.text}</p>
						{controls.canAct && (
							<>
								<button
									aria-label="Add to brief"
									className="btn btn-icon btn-ghost shrink-0"
									data-tooltip="Add to brief"
									disabled={disabled}
									onClick={() =>
										perform(() =>
											edit({
												kind: "addition",
												id: addition.id,
												actionId: crypto.randomUUID(),
												choice: "apply",
											})
										)}
									type="button"
								>
									<CheckIcon aria-hidden="true" size={14} />
								</button>
								<button
									aria-label="Dismiss addition"
									className="btn btn-icon btn-ghost shrink-0"
									data-tooltip="Dismiss"
									disabled={disabled}
									onClick={() =>
										perform(() =>
											edit({
												kind: "addition",
												id: addition.id,
												actionId: crypto.randomUUID(),
												choice: "dismiss",
											})
										)}
									type="button"
								>
									<CloseIcon aria-hidden="true" size={14} />
								</button>
							</>
						)}
					</div>
				))}
			{refinementFailed && !draft.text.trim() && (
				<div className="flex items-center justify-between gap-2 text-xs text-text-tertiary">
					Brief refinement failed.{controls.canAct && (
						<button
							className="btn btn-sm btn-ghost"
							disabled={disabled}
							onClick={retryRefinement}
							type="button"
						>
							Retry refinement
						</button>
					)}
				</div>
			)}
			{offer.status === "offered" && controls.canAct && (
				<div className="flex items-center justify-end gap-1.5">
					{busy && (
						<span className="mr-auto text-xs text-text-tertiary" role="status">Saving…</span>
					)}
					{!editing && (
						<button
							className="btn btn-sm btn-ghost"
							disabled={disabled}
							onClick={() => controls.onAction(offer.id, "dismiss")}
							type="button"
						>
							Dismiss
						</button>
					)}
					{offer.workflow && controls.wire && (
						<button
							aria-busy={opening}
							className={`btn btn-sm ${editing ? "btn-secondary" : "btn-ghost"}`}
							disabled={disabled || opening}
							onClick={() => {
								if (editing) {
									finish();
									return;
								}
								setOpening(true);
								perform(controller.begin, () => setOpening(false));
							}}
							ref={editButton}
							type="button"
						>
							{editing ? "Done" : opening ? "Opening…" : "Edit brief"}
						</button>
					)}
					<button
						aria-keyshortcuts={editing ? "Meta+Enter Control+Enter" : undefined}
						className="btn btn-sm btn-primary"
						disabled={!canStart}
						onClick={start}
						type="button"
					>
						Start research
					</button>
				</div>
			)}
			{offer.status === "offered" && controls.canAct && !canExecute && (
				<p className="m-0 text-xs text-text-tertiary">
					Research execution is unavailable on this instance.
				</p>
			)}
			{(actionError || draft.error) && (
				<p className="m-0 text-sm text-destructive-ink" role="alert">
					{actionError || draft.error}
				</p>
			)}
			{controls.errors[offer.id] && (
				<p className="m-0 text-sm text-destructive-ink" role="alert">
					{controls.errors[offer.id]}
				</p>
			)}
		</div>
	);
}
