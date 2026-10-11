import { z } from "zod";
import { requestSchema, resultSchema, scalarSchema } from "./index";

export const stateSchema = z.object({
	revision: z.number().int().nonnegative(),
	fields: z.record(
		z.string(),
		z.object({
			revision: z.number().int().nonnegative(),
			values: z.array(scalarSchema).max(50),
		}).strict(),
	),
}).strict();
export const decisionSchema = z.object({
	id: z.string().uuid(),
	view: z.string(),
	state: stateSchema,
	conclusion: z.string().min(1).max(4000),
	rationale: z.string().max(8000),
	by: z.string(),
	userId: z.string(),
	at: z.number(),
}).strict();
export type EvidenceDecision = z.infer<typeof decisionSchema>;

/**
 * A prototype the scout started under a passage. The callout is a projection; this record owns
 * whether the spike was dismissed, so a removed callout never re-triggers its passage.
 */
export const spikeSchema = z.object({
	/** Canonical digest of the source passage when the spike started. */
	digest: z.string().min(1).max(100),
	/** The passage text the brief was drafted from. */
	passage: z.string().min(1).max(4000),
	/** ULID of the Callout projected under the passage. */
	callout: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
	/** GitHub login of the person whose local agent runs it. */
	login: z.string().min(1).max(100),
	placed: z.boolean(),
	/**
	 * Set before the callout is first published and cleared once `placed` is persisted, so a
	 * crash in between recovers by finding the callout in place rather than inserting another.
	 */
	placing: z.boolean().optional(),
	/** The state last written into the callout, so progress renewals never rewrite edits. */
	rendered: z.string().max(40).optional(),
	/** Digest of the callout block as last rendered; a different block holds human edits. */
	calloutDigest: z.string().max(100).optional(),
	dismissed: z.boolean().optional(),
	/**
	 * Set with `rendered = completed` and cleared once Chat accepts the Planner turn that
	 * settles the passage, so a landing nobody could act on yet is retried.
	 */
	settle: z.boolean().optional(),
	/** Automatic re-dispatches after its local agent's connection was lost; capped. */
	retries: z.number().int().nonnegative().max(10).optional(),
}).strict();
export type Spike = z.infer<typeof spikeSchema>;

export const investigationSchema = z.object({
	id: z.string().uuid(),
	documentId: z.string(),
	revision: z.number().int().nonnegative(),
	brief: z.string().min(1).max(8000),
	requester: z.string(),
	state: z.enum([
		"requested",
		"queued",
		"running",
		"publishing",
		"completed",
		"failed",
		"cancelled",
		"interrupted",
	]),
	connectionId: z.string().optional(),
	input: requestSchema.optional(),
	generation: z.number().int().nonnegative(),
	expiresAt: z.number(),
	createdAt: z.number(),
	updatedAt: z.number(),
	progress: z.string().max(2000),
	parentId: z.string().uuid().optional(),
	spike: spikeSchema.optional(),
	candidate: resultSchema.optional(),
	result: resultSchema.optional(),
	views: z.record(z.string(), stateSchema),
	decisions: z.array(decisionSchema).max(100),
	receipts: z.record(z.string(), z.string()),
}).strict();
export type Investigation = z.infer<typeof investigationSchema>;
export type InvestigationState = Investigation["state"];
export type PublishedInvestigation = Omit<Investigation, "candidate" | "receipts">;
export type InvestigationSummary =
	& { decisionCount: number }
	& Pick<
		Investigation,
		"id" | "brief" | "state" | "revision" | "requester" | "progress" | "createdAt"
	>;
export function publicInvestigation(
	value: Investigation,
): Omit<Investigation, "candidate" | "receipts"> {
	let { candidate: _candidate, receipts: _receipts, ...rest } = value;
	return rest;
}
