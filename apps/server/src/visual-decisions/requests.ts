import { ULID, ulid } from "@chopin/dialect";
import * as Service from "../plan/service";

export type PendingVisualRequest = {
	id: string;
	channelId: string;
	originMessageId: string;
	instruction: string;
	requestedBy: string;
	requestedByHandle: string;
	sourceDocumentRevision: number;
	createdAt: string;
	state: "pending";
};

export type Requests = Map<string, PendingVisualRequest>;
export type Source = { entryId: string; userId: string; handle: string; text: string };

const MAX_REQUESTS = 20;
const MAX_INSTRUCTION_BYTES = 4_096;
const FIELDS = [
	"channelId",
	"createdAt",
	"id",
	"instruction",
	"originMessageId",
	"requestedBy",
	"requestedByHandle",
	"sourceDocumentRevision",
	"state",
];

function bounded(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function instruction(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0
		&& Buffer.byteLength(value, "utf8") <= MAX_INSTRUCTION_BYTES;
}

function sourceEntry(
	transcript: Service.Plan["chat"]["entries"],
	entryId: string,
	text: string,
	handle: string,
): boolean {
	let entry = transcript.find(value => value.id === entryId);
	return entry?.author.kind === "member" && entry.author.handle === handle
		&& entry.text === text;
}

export function restore(
	raw: unknown,
	channelId: string | undefined,
	transcript: Service.Plan["chat"]["entries"],
	revision: number,
): Requests {
	if (raw === undefined) return new Map();
	if (!Array.isArray(raw) || raw.length > MAX_REQUESTS || !channelId) {
		throw new Error("Invalid visual preview requests");
	}
	let requests: Requests = new Map();
	let origins = new Set<string>();
	for (let candidate of raw) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
			throw new Error("Invalid visual preview request");
		}
		let item = candidate as Record<string, unknown>;
		let keys = Object.keys(item).sort();
		if (
			keys.length !== FIELDS.length || keys.some((key, index) => key !== FIELDS[index])
			|| !bounded(item.id, 26) || !ULID.test(item.id)
			|| item.channelId !== channelId
			|| !bounded(item.originMessageId, 26) || !ULID.test(item.originMessageId)
			|| !instruction(item.instruction)
			|| !bounded(item.requestedBy, 200)
			|| !bounded(item.requestedByHandle, 100)
			|| typeof item.sourceDocumentRevision !== "number"
			|| !Number.isSafeInteger(item.sourceDocumentRevision)
			|| item.sourceDocumentRevision < 0 || item.sourceDocumentRevision > revision
			|| typeof item.createdAt !== "string"
			|| !Number.isFinite(Date.parse(item.createdAt))
			|| new Date(item.createdAt).toISOString() !== item.createdAt
			|| item.state !== "pending"
			|| !sourceEntry(transcript, item.originMessageId, item.instruction, item.requestedByHandle)
			|| requests.has(item.id) || origins.has(item.originMessageId)
		) throw new Error("Invalid visual preview request");
		let request = item as PendingVisualRequest;
		requests.set(request.id, request);
		origins.add(request.originMessageId);
	}
	return requests;
}

export function dump(requests: Requests): PendingVisualRequest[] {
	return [...requests.values()];
}

/** The source is supplied by the verified foreground Chat turn, never by tool arguments. */
export function create(
	plan: Service.Plan,
	source: Source,
	stillCurrent?: () => boolean,
): Promise<PendingVisualRequest> {
	return Service.exclusive(plan, async () => {
		if (stillCurrent && !stillCurrent()) {
			throw new Error("The member request is no longer driving the current Planner turn");
		}
		if (Service.implementationActive(plan)) throw new Error("Implementation is active");
		if (
			!ULID.test(source.entryId) || !bounded(source.userId, 200)
			|| !bounded(source.handle, 100) || !instruction(source.text)
			|| !sourceEntry(plan.chat.entries, source.entryId, source.text, source.handle)
		) throw new Error("A saved member message is required for a visual preview request");
		let existing = [...plan.visualRequests.values()].find(
			request => request.originMessageId === source.entryId,
		);
		if (existing) {
			if (
				existing.instruction !== source.text || existing.requestedBy !== source.userId
				|| existing.requestedByHandle !== source.handle
			) throw new Error("Visual preview request source changed");
			return existing;
		}
		if (plan.visualRequests.size >= MAX_REQUESTS) {
			throw new Error("This document already has 20 visual preview requests");
		}
		let request: PendingVisualRequest = {
			id: ulid(),
			channelId: plan.id,
			originMessageId: source.entryId,
			instruction: source.text,
			requestedBy: source.userId,
			requestedByHandle: source.handle,
			sourceDocumentRevision: plan.revision,
			createdAt: new Date().toISOString(),
			state: "pending",
		};
		await Service.publishStaged(plan, plan.server, plan.id, {
			...plan,
			visualRequests: new Map(plan.visualRequests).set(request.id, request),
		});
		return request;
	});
}
