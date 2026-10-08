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
import type { ExperimentStore } from "../storage/experiments";
import type { Lease } from "../storage/model";

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
			value.candidate = parsed;
			value.state = "publishing";
		});
	}
	complete(id: string, connectionId: string, generation: number) {
		return this.mutate(id, value => {
			if (
				value.state === "completed" && value.connectionId === connectionId
				&& value.generation === generation
			) return;
			this.assertClaim(value, connectionId, generation);
			if (!value.candidate) fail("missing-result");
			value.result = value.candidate;
			delete value.candidate;
			value.views = Object.fromEntries(
				value.result.views.map(view => [view.key, initialState(view)]),
			);
			value.state = "completed";
			value.expiresAt = 0;
		});
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
}
