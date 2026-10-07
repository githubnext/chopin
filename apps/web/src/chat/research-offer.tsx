import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { ResearchCard } from "@chopin/editor";
import { SearchIcon } from "@chopin/icons";

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
	let [error, setError] = useState<string>();
	let subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
	let request = useSyncExternalStore(
		subscribe,
		() => id ? store.get(id) : undefined,
		() => undefined,
	);
	useEffect(() => id ? store.retain(id) : undefined, [id, store]);
	let shown = useRef<Research.RequestStage | undefined>(undefined);
	let stage = request ? forwardStage(shown.current, request.stage) : undefined;
	shown.current = stage;
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
	let action = (run: () => Promise<Research.RequestView>, failure: string) => {
		setBusy(true);
		setError(undefined);
		void run().catch(() => setError(failure)).finally(() => setBusy(false));
	};
	let canResume = link?.status === "pending" || link?.status === "unlinked";
	let unverified = link?.status === "error" && link.exhausted;
	let note = !request && (unverified
		? "The research request could not be confirmed yet."
		: link?.status === "unlinked"
		? "Accepted but not started."
		: undefined);
	return (
		<div className="flex flex-col gap-2">
			<ResearchCard
				actionError={error}
				busy={busy}
				canEdit={canEdit}
				request={view}
				onCancel={id && canEdit
					? () => action(() => store.cancel(id), "Research could not be cancelled.")
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
	let perform = (run: () => Promise<void>) => {
		setActing(true);
		setActionError("");
		void run().catch(error =>
			setActionError(error instanceof Error ? error.message : "Research action failed.")
		).finally(() => setActing(false));
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
	return (
		<div
			aria-label="Research suggestion"
			aria-busy={disabled}
			className="flex min-w-0 flex-col gap-2 rounded-lg bg-inset px-3 py-2.5"
			data-research-offer={offer.id}
			role="group"
		>
			<div className="flex items-start gap-2">
				<SearchIcon aria-hidden="true" className="mt-0.5 shrink-0 text-text-tertiary" size={14} />
				<div className="min-w-0 flex-1">
					<p className="m-0 mb-1 text-sm font-medium text-text-primary">Research suggestion</p>
					{draft.editing && offer.status === "offered"
						? (
							<ResearchBriefEditor
								controller={controller}
								text={draft.text}
								readOnly={!controls.canAct || disabled}
							/>
						)
						: (
							<p className="m-0 whitespace-pre-wrap break-words text-sm text-text-primary">
								{offer.brief}
							</p>
						)}
				</div>
			</div>
			{offer.workflow?.previousOfferId && (
				<p className="m-0 text-xs text-text-tertiary">Follow-up to earlier research</p>
			)}
			{offer.status === "offered" && Object.keys(editors).length > 0 && (
				<p className="m-0 text-xs text-text-tertiary" aria-live="polite">
					Editing: {[...new Set(Object.values(editors))].map(handle =>
						`@${handle}`
					).join(", ")}
				</p>
			)}
			{offer.workflow && controls.onSource && (
				<div className="flex flex-wrap gap-1" aria-label="Research sources">
					{offer.workflow.sources.map(source => (
						<button
							className="btn btn-sm btn-ghost"
							key={`${source.messageId}:${source.start}`}
							onClick={() => controls.onSource?.(source)}
							type="button"
						>
							@{source.author.kind === "member" ? source.author.handle : "Planner"}
						</button>
					))}
				</div>
			)}
			{offer.status === "offered"
				&& offer.workflow?.additions.filter(item => item.status === "pending").map(addition => (
					<div className="rounded-md bg-page p-2 text-sm" key={addition.id}>
						<p className="m-0 font-medium">Suggested addition</p>
						<p className="m-0">{addition.text}</p>
						{controls.canAct && (
							<div className="mt-1 flex justify-end gap-1">
								<button
									className="btn btn-sm btn-ghost"
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
									Dismiss addition
								</button>
								<button
									className="btn btn-sm btn-secondary"
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
									Add to brief
								</button>
							</div>
						)}
					</div>
				))}
			{offer.status === "offered" && controls.canAct && (
				<div className="flex justify-end gap-1.5">
					{offer.workflow && controls.wire && (
						<button
							className="btn btn-sm btn-ghost"
							disabled={disabled}
							onClick={() => draft.editing ? controller.end() : perform(controller.begin)}
							type="button"
						>
							{draft.editing ? "Done" : "Edit brief"}
						</button>
					)}
					<button
						className="btn btn-sm btn-ghost"
						disabled={disabled}
						onClick={() => controls.onAction(offer.id, "dismiss")}
						type="button"
					>
						Dismiss
					</button>
					<button
						className="btn btn-sm btn-primary"
						disabled={disabled || !canExecute || !draft.text.trim()}
						onClick={() =>
							perform(async () => {
								if (controls.wire) await controller.flush();
								controls.onAction(offer.id, "research");
							})}
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
			{offer.status === "offered" && offer.workflow?.preparation === "failed" && (
				<div className="flex items-center justify-between gap-2 text-xs text-text-tertiary">
					Brief refinement failed.{controls.canAct && (
						<button
							className="btn btn-sm btn-ghost"
							disabled={disabled}
							onClick={() => perform(() => edit({ kind: "retry" }))}
							type="button"
						>
							Retry refinement
						</button>
					)}
				</div>
			)}
			{offer.status === "dismissed" && <p className="m-0 text-sm text-text-tertiary">Dismissed</p>}
			{busy && <p className="m-0 text-xs text-text-tertiary" role="status">Saving…</p>}
			{(actionError || draft.error) && (
				<p className="m-0 text-sm text-destructive-ink" role="alert">
					{actionError || draft.error}
				</p>
			)}
			{link?.status !== "linked" && controls.errors[offer.id] && (
				<p className="m-0 text-sm text-destructive-ink" role="alert">
					{controls.errors[offer.id]}
				</p>
			)}
		</div>
	);
}
