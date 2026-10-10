import { uncertain } from "./spikes";

import type { JevRequest, JevResult } from "../conversation-plan/jev";
import type { Investigation } from "@chopin/experiment/records";

export type SpikeBlock = {
	digest: string;
	text: string;
	/** Id of the Callout directly after this passage, if one is. */
	calloutAfter?: string;
};
export type SpikeSnapshot = {
	repositoryId: string;
	/** The document already has a living build; spikes are for the plan before it. */
	live: boolean;
	/** Eligible prose blocks, in document order. */
	blocks: SpikeBlock[];
	/** Callout ids currently in the document. */
	callouts: Set<string>;
};

/** The durable side of spikes; the scout only decides. */
export type SpikeHost = {
	snapshot(channelId: string): Promise<SpikeSnapshot | undefined>;
	spikes(channelId: string): Promise<Investigation[]>;
	/** The editor's live local-agent connection for the repository, if any. */
	connection(
		repositoryId: string,
		owner: string,
		channelId: string,
	): Promise<{ id: string; login: string } | undefined>;
	start(
		channelId: string,
		input: { owner: string; connection: { id: string; login: string }; block: SpikeBlock },
	): Promise<void>;
	/** A placed callout was removed: stop its spike and never re-trigger the passage. */
	dismiss(channelId: string, id: string): Promise<void>;
	/** Bring every placed callout up to its record's state. */
	refresh(channelId: string): Promise<void>;
};

/**
 * Which candidate passages would materially benefit from a quick prototype. `undefined` means
 * the judge could not decide, so every passage stays unjudged for the next scan.
 */
export type SpikeJudge = (blocks: SpikeBlock[]) => Promise<boolean[] | undefined>;

export const heuristicJudge: SpikeJudge = async blocks =>
	blocks.map(block => uncertain(block.text));

export const SPIKE_THRESHOLD = 0.6;
export const MAX_CANDIDATES = 5;
export const MAX_ACTIVE = 3;
/** How soon a scan that left passages unjudged looks at the next batch. */
export const FOLLOW_UP_MS = 5_000;
const ACTIVE = ["requested", "queued", "running", "publishing"];

/**
 * One Jev noul per passage. A failure decides nothing: explicit-uncertainty matching is only
 * for deployments with no Jev key, never a silent substitute for a configured judge.
 */
export function jevJudge(ask: (request: JevRequest) => Promise<JevResult>): SpikeJudge {
	return async blocks => {
		if (!blocks.length) return [];
		try {
			let questions = Object.fromEntries(blocks.map((_block, index) => [`spike_${index}`, {
				type: "noul" as const,
				instructions:
					`Would a small, quick prototype or proof of concept (under ~15 min of coding agent time) materially inform or de-risk passage spike_${index}?`,
				criteria: {
					true:
						"The passage hinges on an open technical, interaction, or feasibility question a quick prototype could answer.",
					false:
						"The passage is settled, descriptive, or a prototype would not change what the team decides.",
				},
			}]));
			let result = await ask({
				state: {
					passages: blocks.map((block, index) => ({ key: `spike_${index}`, text: block.text })),
				},
				questions,
			});
			return blocks.map((_block, index) => {
				let found = result.answers[`spike_${index}`];
				if (found?.type !== "noul" || !Number.isFinite(found.noul)) throw new Error("invalid");
				return found.noul >= SPIKE_THRESHOLD;
			});
		} catch {
			return undefined;
		}
	};
}

export type SpikeScoutOptions = {
	host: SpikeHost;
	judge?: SpikeJudge;
	debounceMs?: number;
	after?: (delayMs: number, action: () => void) => () => void;
	error?: (err: unknown) => void;
};

/**
 * Notices passages a quick prototype would inform, while a document has no living build yet,
 * and hands each to the local agent of the person who last edited the document.
 */
export class SpikeScout {
	#options: SpikeScoutOptions;
	#pending = new Map<string, { cancel: () => void }>();
	#chains = new Map<string, Promise<void>>();
	/** Digests already judged per document, so unchanged passages are never asked again. */
	#seen = new Map<string, Set<string>>();
	#editors = new Map<string, string>();
	#followUps = new Map<string, () => void>();
	/** Documents whose last scan left passages waiting for a spike to free capacity. */
	#waiting = new Set<string>();
	/** Documents with a dismissal check already queued, so a burst of edits shares one. */
	#dismissing = new Set<string>();
	#closed = false;

	constructor(options: SpikeScoutOptions) {
		this.#options = options;
	}

	/** A person's edit persisted; scan once everyone has been quiet for the debounce window. */
	schedule(target: { channelId: string; editor?: string }): void {
		if (this.#closed || !target.editor) return;
		let id = target.channelId;
		this.#editors.set(id, target.editor);
		this.#pending.get(id)?.cancel();
		this.#followUps.get(id)?.();
		this.#followUps.delete(id);
		// A deleted callout stops its spike now rather than after the scan's debounce.
		if (!this.#dismissing.has(id)) {
			this.#dismissing.add(id);
			void this.#serial(id, async () => {
				this.#dismissing.delete(id);
				let snapshot = await this.#options.host.snapshot(id);
				if (snapshot) await this.#dismiss(id, snapshot);
			});
		}
		let entry = { cancel: () => {} };
		entry.cancel = this.#after(this.#options.debounceMs ?? 20_000, () => {
			if (this.#pending.get(id) !== entry) return;
			this.#pending.delete(id);
			void this.check(id);
		});
		this.#pending.set(id, entry);
	}

	#after(delay: number, action: () => void): () => void {
		if (this.#options.after) return this.#options.after(delay, action);
		let timer = setTimeout(action, delay);
		return () => clearTimeout(timer);
	}

	/** Stop the spikes whose placed callouts are gone; returns every spike of the document. */
	async #dismiss(channelId: string, snapshot: SpikeSnapshot): Promise<Investigation[]> {
		let host = this.#options.host;
		let spikes = await host.spikes(channelId);
		for (let value of spikes) {
			let spike = value.spike!;
			if (spike.placed && !spike.dismissed && !snapshot.callouts.has(spike.callout)) {
				await host.dismiss(channelId, value.id);
				spike.dismissed = true;
			}
		}
		return spikes;
	}

	/** A spike record changed; project it into its callout, and scan again if it freed capacity. */
	refresh(channelId: string): Promise<void> {
		return this.#serial(channelId, async () => {
			await this.#options.host.refresh(channelId);
			if (this.#waiting.delete(channelId)) await this.#check(channelId);
		});
	}

	check(channelId: string): Promise<void> {
		return this.#serial(channelId, () => this.#check(channelId));
	}

	#serial(channelId: string, action: () => Promise<void>): Promise<void> {
		let previous = this.#chains.get(channelId) ?? Promise.resolve();
		let operation = previous.then(() => this.#closed ? undefined : action()).catch(err => {
			this.#options.error?.(err);
		});
		this.#chains.set(channelId, operation);
		void operation.then(() => {
			if (this.#chains.get(channelId) === operation) this.#chains.delete(channelId);
		});
		return operation;
	}

	async #check(channelId: string): Promise<void> {
		let host = this.#options.host;
		let snapshot = await host.snapshot(channelId);
		if (!snapshot) return;
		let spikes = await this.#dismiss(channelId, snapshot);
		// A living build ends new scouting, but deleting a callout must still stop its spike.
		if (snapshot.live) return;
		let editor = this.#editors.get(channelId);
		if (!editor) return;
		let capacity = MAX_ACTIVE
			- spikes.filter(value => ACTIVE.includes(value.state) && !value.spike!.dismissed).length;
		let seen = this.#seen.get(channelId) ?? new Set<string>();
		this.#seen.set(channelId, seen);
		let started = new Set(spikes.map(value => value.spike!.digest));
		let spikeCallouts = new Set(spikes.map(value => value.spike!.callout));
		// A rewritten passage keeps the spike callout under it, so it is not spiked again.
		let unjudged = snapshot.blocks.filter(block =>
			!seen.has(block.digest) && !started.has(block.digest)
			&& !(block.calloutAfter && spikeCallouts.has(block.calloutAfter))
		);
		this.#waiting.delete(channelId);
		if (!unjudged.length) return;
		// A finished, failed or dismissed spike refreshes the document and resumes this scan.
		if (capacity <= 0) {
			this.#waiting.add(channelId);
			return;
		}
		let candidates = unjudged.slice(0, MAX_CANDIDATES);
		// Without the editor's local agent there is nowhere to run; judge these again after an edit.
		let connection = await host.connection(snapshot.repositoryId, editor, channelId);
		if (!connection) return;
		let verdicts = await (this.#options.judge ?? heuristicJudge)(candidates);
		if (!verdicts) return;
		// Approved passages beyond capacity stay unseen so a later scan can start them.
		let approved = candidates.filter((_block, index) => verdicts[index]);
		let hits = approved.slice(0, capacity);
		if (approved.length > hits.length) this.#waiting.add(channelId);
		for (let [index, block] of candidates.entries()) {
			if (!verdicts[index]) seen.add(block.digest);
		}
		for (let block of hits) {
			if (this.#closed) return;
			seen.add(block.digest);
			await host.start(channelId, { owner: editor, connection, block });
		}
		// Later passages are judged in the next batch soon, not only after another edit.
		if (unjudged.length > candidates.length && !this.#closed && !this.#pending.has(channelId)) {
			this.#followUps.get(channelId)?.();
			let cancel = this.#after(FOLLOW_UP_MS, () => {
				if (this.#followUps.get(channelId) !== cancel) return;
				this.#followUps.delete(channelId);
				void this.check(channelId);
			});
			this.#followUps.set(channelId, cancel);
		}
	}

	close(): void {
		this.#closed = true;
		for (let pending of this.#pending.values()) pending.cancel();
		this.#pending.clear();
		for (let cancel of this.#followUps.values()) cancel();
		this.#followUps.clear();
		this.#seen.clear();
		this.#editors.clear();
		this.#waiting.clear();
	}
}
