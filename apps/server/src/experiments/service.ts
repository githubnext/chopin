import { createHash } from "node:crypto";
import {
	canonical,
	ExperimentError,
	initialState,
	parseResult,
	requestSchema,
} from "@chopin/experiment";
import type { Investigation, InvestigationState } from "@chopin/experiment/records";
import type { RunInput } from "@chopin/experiment";
import { applySelection, selectionPatchSchema } from "@chopin/experiment/selection";
import type { ExperimentStore } from "../storage/experiments";
import type { Lease } from "../storage/model";
import { z } from "zod";
import * as Plan from "../plan/service";
import { investigationDocument } from "./document";

export const CLAIM_MS = 60_000;
export function fingerprint(value: unknown) {
	return createHash("sha256").update(canonical(value)).digest("hex");
}
export function fail(code: string, message = code): never {
	throw new ExperimentError(code, message);
}

export class Experiments {
	constructor(
		readonly store: ExperimentStore,
		private lease: () => Lease,
		private changed: (documentId: string) => void = () => {},
		private now = () => Date.now(),
	) {}
	async create(
		documentId: string,
		requester: string,
		brief: string,
		id: string = crypto.randomUUID(),
		parentId?: string,
	) {
		let existing = await this.store.get(id);
		if (existing) {
			if (
				existing.documentId !== documentId || existing.requester !== requester
				|| existing.brief !== brief
			) fail("idempotency-conflict");
			return existing;
		}
		if (!brief.trim() || brief.length > 8000) fail("invalid-brief");
		if ((await this.store.list(documentId)).length >= 100) fail("experiment-limit");
		let at = this.now();
		let value: Investigation = {
			id,
			documentId,
			requester,
			brief,
			parentId,
			revision: 0,
			state: "requested",
			generation: 0,
			expiresAt: 0,
			createdAt: at,
			updatedAt: at,
			progress: "",
			views: {},
			decisions: [],
			receipts: {},
		};
		if (!await this.store.save(value, undefined, this.lease())) fail("revision-conflict");
		this.changed(documentId);
		return value;
	}
	async mutate(id: string, action: (value: Investigation) => void) {
		for (let attempt = 0; attempt < 5; attempt++) {
			let current = await this.store.get(id);
			if (!current) fail("not-found");
			let value = structuredClone(current);
			action(value);
			if (canonical(value) === canonical(current)) return current;
			value.revision++;
			value.updatedAt = this.now();
			if (await this.store.save(value, current.revision, this.lease())) {
				this.changed(value.documentId);
				if (value.childId) this.changed(value.childId);
				return value;
			}
		}
		fail("revision-conflict");
	}
	authorize(id: string, connectionId: string, input: RunInput) {
		let parsed = requestSchema.parse(input);
		return this.mutate(id, value => {
			if (
				value.input && value.connectionId === connectionId
				&& canonical(value.input) === canonical(parsed)
			) return;
			if (
				value.state !== "requested" || parsed.id !== value.id
				|| parsed.documentId !== value.documentId
				|| parsed.brief !== value.brief || parsed.requester !== value.requester
			) fail("invalid-state");
			value.input = parsed;
			value.connectionId = connectionId;
			value.state = "queued";
		});
	}
	claim(id: string, connectionId: string) {
		return this.mutate(id, value => {
			if (value.connectionId !== connectionId) fail("connection-forbidden");
			if (value.state === "running" && value.expiresAt > this.now()) return;
			if (value.state !== "queued") fail("invalid-state");
			value.generation++;
			value.expiresAt = this.now() + CLAIM_MS;
			value.state = "running";
		});
	}
	assertClaim(value: Investigation, connectionId: string, generation: number) {
		if (
			value.connectionId !== connectionId || value.generation !== generation
			|| value.expiresAt <= this.now()
			|| !["running", "publishing"].includes(value.state)
		) fail("stale-claim");
	}
	renew(id: string, connectionId: string, generation: number, progress?: string) {
		return this.mutate(id, value => {
			this.assertClaim(value, connectionId, generation);
			value.expiresAt = this.now() + CLAIM_MS;
			if (progress !== undefined) value.progress = progress.slice(0, 2000);
		});
	}
	candidate(id: string, connectionId: string, generation: number, result: unknown) {
		let parsed = parseResult(result);
		return this.mutate(id, value => {
			this.assertClaim(value, connectionId, generation);
			// Completion must not fail on content, so the child document is proven here.
			investigationDocument(value.id, value.brief, parsed);
			value.candidate = parsed;
			value.state = "publishing";
		});
	}
	/**
	 * Promote the candidate and publish it as a child document in the same commit, so a ready card
	 * never links a child that is not there yet.
	 */
	async complete(id: string, connectionId: string, generation: number) {
		for (let attempt = 0; attempt < 5; attempt++) {
			let current = await this.store.get(id);
			if (!current) fail("not-found");
			if (
				current.state === "completed" && current.connectionId === connectionId
				&& current.generation === generation
			) return current;
			this.assertClaim(current, connectionId, generation);
			if (!current.candidate) fail("missing-result");
			let value = structuredClone(current);
			let result = current.candidate;
			value.result = result;
			delete value.candidate;
			value.views = Object.fromEntries(result.views.map(view => [view.key, initialState(view)]));
			value.state = "completed";
			value.expiresAt = 0;
			value.revision++;
			value.updatedAt = this.now();
			let document = investigationDocument(value.id, value.brief, result);
			let saved = await this.store.publish(value, current.revision, {
				title: document.title,
				initial: await Plan.initial(document.source),
				now: new Date(value.updatedAt),
			}, this.lease());
			if (saved) {
				this.changed(saved.documentId);
				if (saved.childId) this.changed(saved.childId);
				return saved;
			}
		}
		fail("revision-conflict");
	}
	stop(
		id: string,
		state: Extract<InvestigationState, "failed" | "cancelled" | "interrupted">,
		progress = "",
	) {
		return this.mutate(id, value => {
			if (["completed", "cancelled", "failed", "interrupted"].includes(value.state)) return;
			value.state = state;
			value.progress = progress.slice(0, 2000);
			value.expiresAt = 0;
			delete value.candidate;
		});
	}
	/** Return settled, unfinished work to its card under the same identity; Run starts it again. */
	retry(id: string) {
		return this.mutate(id, value => {
			if (value.state === "requested") return;
			if (!["failed", "cancelled", "interrupted"].includes(value.state)) fail("invalid-state");
			value.state = "requested";
			value.progress = "";
			value.expiresAt = 0;
			delete value.connectionId;
			delete value.input;
			delete value.candidate;
		});
	}
	async recover(all = false) {
		for (let value of await this.store.active()) {
			if (all || value.state !== "queued" && value.expiresAt <= this.now()) {
				await this.stop(
					value.id,
					"interrupted",
					"Connection interrupted. Authorize a new attempt to retry.",
				);
			}
		}
	}
	select(id: string, actor: string, viewKey: string, raw: unknown) {
		let patch = selectionPatchSchema.parse(raw);
		let key = `selection:${actor}:${patch.mutationId}`;
		let digest = fingerprint({ viewKey, patch });
		return this.mutate(id, value => {
			if (Object.hasOwn(value.receipts, key)) {
				if (value.receipts[key] !== digest) fail("idempotency-conflict");
				return;
			}
			if (Object.keys(value.receipts).length >= 2048) fail("selection-limit");
			let view = value.result?.views.find(view => view.key === viewKey);
			let dataset = value.result?.datasets.find(dataset => dataset.key === view?.datasetKey);
			if (value.state !== "completed" || !view || !dataset) fail("not-ready");
			value.views[viewKey] = applySelection(value.views[viewKey], dataset, patch);
			value.receipts[key] = digest;
		});
	}
	decide(id: string, actor: { id: string; login: string }, raw: unknown) {
		let input = z.object({
			id: z.string().uuid(),
			view: z.string().min(1).max(64),
			revision: z.number().int().nonnegative(),
			conclusion: z.string().trim().min(1).max(4000),
			rationale: z.string().max(8000),
		}).strict().parse(raw);
		let key = `decision:${input.id}`;
		let digest = fingerprint({ actorId: actor.id, input });
		return this.mutate(id, value => {
			if (Object.hasOwn(value.receipts, key)) {
				if (value.receipts[key] !== digest) fail("idempotency-conflict");
				return;
			}
			if (value.decisions.length >= 100 || Object.keys(value.receipts).length >= 2048) {
				fail("decision-limit");
			}
			if (!value.result || !Object.hasOwn(value.views, input.view)) fail("not-ready");
			let state = value.views[input.view];
			if (state.revision !== input.revision) {
				fail(
					"selection-conflict",
					"Shared selections changed. Review them before recording a decision.",
				);
			}
			value.decisions.push({
				id: input.id,
				view: input.view,
				state: structuredClone(state),
				conclusion: input.conclusion,
				rationale: input.rationale,
				by: actor.login,
				userId: actor.id,
				at: this.now(),
			});
			value.receipts[key] = digest;
		});
	}
}
