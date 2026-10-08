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
	at: z.number(),
}).strict();
export type EvidenceDecision = z.infer<typeof decisionSchema>;

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
	candidate: resultSchema.optional(),
	result: resultSchema.optional(),
	views: z.record(z.string(), stateSchema),
	decisions: z.array(decisionSchema).max(100),
	receipts: z.record(z.string(), z.string()),
}).strict();
export type Investigation = z.infer<typeof investigationSchema>;
export type InvestigationState = Investigation["state"];
export type PublishedInvestigation = Omit<Investigation, "candidate" | "receipts">;
export type InvestigationSummary = Pick<
	Investigation,
	"id" | "brief" | "state" | "revision" | "requester" | "progress" | "createdAt"
>;
export type WorkspaceConnection = {
	id: string;
	documentId: string;
	owner: string;
	login: string;
	label: string;
	source: import("./index").Source;
	expiresAt: number;
};

export function publicInvestigation(
	value: Investigation,
): Omit<Investigation, "candidate" | "receipts"> {
	let { candidate: _candidate, receipts: _receipts, ...rest } = value;
	return rest;
}
