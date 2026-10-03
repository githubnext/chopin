import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SearchIcon } from "@chopin/icons";

import type { ConversationPlan, Research } from "@chopin/protocol";
import type { ResearchRequestStore } from "../research-requests";
import type { Wire } from "../wire";

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

function LinkedResearch({ id, store }: { id: string; store: ResearchRequestStore }) {
	let subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
	let request = useSyncExternalStore(subscribe, () => store.get(id), () => undefined);
	useEffect(() => store.retain(id), [id, store]);
	if (!request) return <p className="m-0 text-sm text-text-secondary">Loading research…</p>;
	return (
		<div className="flex items-center justify-between gap-2 text-sm text-text-secondary">
			<span role="status">
				{request.stage === "ready"
					? "Research ready"
					: `Research ${request.stage}`}
			</span>
			{request.stage === "ready" && request.child && (
				<button
					className="btn btn-sm btn-secondary"
					onClick={event => store.open(request.child!, store.opener(id, event.currentTarget))}
					type="button"
				>
					Open research
				</button>
			)}
		</div>
	);
}

export function ResearchOfferCard(
	{ offer, controls }: { offer: ConversationPlan.ResearchOffer; controls: ResearchOfferControls },
) {
	let busy = controls.busy.has(offer.id);
	let link = controls.links[offer.id];
	let canResume = link?.status === "pending" || link?.status === "unlinked";
	let canRetryLink = link?.status === "error" && link.exhausted && controls.canCheckLink;
	return (
		<div
			aria-label="Research suggestion"
			aria-busy={busy}
			className="mt-2 flex flex-col gap-2 rounded-lg bg-inset px-3 py-2.5"
			data-research-offer={offer.id}
			role="group"
		>
			<div className="flex items-start gap-2">
				<SearchIcon aria-hidden="true" className="mt-0.5 shrink-0 text-text-tertiary" size={14} />
				<p className="m-0 min-w-0 whitespace-pre-wrap break-words text-sm text-text-primary">
					{offer.brief}
				</p>
			</div>
			{offer.status === "offered" && controls.canAct && (
				<div className="flex justify-end gap-1.5">
					<button
						className="btn btn-sm btn-ghost"
						disabled={busy}
						onClick={() => controls.onAction(offer.id, "dismiss")}
						type="button"
					>
						Dismiss
					</button>
					<button
						className="btn btn-sm btn-primary"
						disabled={busy}
						onClick={() => controls.onAction(offer.id, "research")}
						type="button"
					>
						Research
					</button>
				</div>
			)}
			{offer.status === "dismissed" && <p className="m-0 text-sm text-text-tertiary">Dismissed</p>}
			{offer.status === "accepted" && link?.status === "linked" && link.researchRequestId
				? <LinkedResearch id={link.researchRequestId} store={controls.store} />
				: offer.status === "accepted" && (
					<div className="flex items-center justify-between gap-2 text-sm text-text-secondary">
						<span role="status">
							{link?.exhausted || link?.status === "error"
								? "Accepted; request link not yet verified"
								: link?.status === "unlinked"
								? "Accepted; waiting to start"
								: "Research accepted"}
						</span>
						{controls.canAct && canResume && (
							<button
								className="btn btn-sm btn-secondary"
								disabled={busy}
								onClick={() => controls.onAction(offer.id, "resume")}
								type="button"
							>
								Resume
							</button>
						)}
						{canRetryLink && (
							<button
								className="btn btn-sm btn-secondary"
								onClick={() => controls.onRetryLink(offer.id)}
								type="button"
							>
								Retry link check
							</button>
						)}
					</div>
				)}
			{busy && <p className="m-0 text-xs text-text-tertiary" role="status">Saving…</p>}
			{link?.status !== "linked" && controls.errors[offer.id] && (
				<p className="m-0 text-sm text-destructive-ink" role="alert">
					{controls.errors[offer.id]}
				</p>
			)}
		</div>
	);
}
