import type { Question as Wire, Request } from "@chopin/protocol";
import type { Server } from "bun";

import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import { fail, reply } from "../wire";
import type { Socket, SocketData } from "../wire";

import { isOpenStatus } from "./records";
import { MAX_FINDING_FOCUS, MAX_FINDING_SUMMARY } from "./record-validation";
import { changeFindings, updateFinding } from "./service-findings";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** External work a finding can follow, supplied by the server that owns it. */
export type ExploreDeps = {
	/** True when research request `ref` belongs to document `roomId`. */
	research: (roomId: string, ref: string) => Promise<boolean>;
	/** True when investigation `ref` belongs to document `roomId`. */
	spike: (roomId: string, ref: string) => Promise<boolean>;
	/** Stop the external work behind a running finding. */
	stop: (roomId: string, finding: Wire.Finding, ws: Socket) => Promise<void>;
	/** Post a system notice in the document's Chat about decision `id`. */
	notice: (plan: Plan, roomId: string, id: string, text: string, label: string) => Promise<void>;
};

function question(plan: Plan, id: string): string {
	return plan.records.get(id)?.definition.questions[0]?.question ?? "this decision";
}

function label(text: string): string {
	return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** Record a running finding for work the member just started, or ask another member. */
export async function explore(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.Explore.Ask>,
	deps: ExploreDeps,
): Promise<void> {
	let refuse = (reason: Wire.Explore.Refusal, message: string) =>
		reply(
			ws,
			msg.rid,
			{
				kind: "question:explore",
				ts: 0,
				id: msg.id,
				ok: false,
				reason,
				message,
			} satisfies Wire.Explore.Reply,
		);
	let focus = typeof msg.focus === "string" ? msg.focus.trim() : "";
	if (
		typeof msg.id !== "string" || typeof msg.key !== "string" || !UUID.test(msg.key)
		|| focus.length > MAX_FINDING_FOCUS
		|| (msg.action !== "research" && msg.action !== "spike" && msg.action !== "ask")
		|| msg.action === "ask" && (typeof msg.login !== "string" || !LOGIN.test(msg.login))
		|| msg.action === "research" && (typeof msg.ref !== "string" || !UUID.test(msg.ref))
	) return refuse("invalid", "This exploration is not valid");
	if (Service.implementationActive(plan)) {
		return refuse("implementation", "An implementation is running; decisions cannot change");
	}
	let record = plan.records.get(msg.id);
	if (!record || !isOpenStatus(record.status)) {
		return refuse("resolved", "This decision is no longer open");
	}
	let existing = record.findings?.find(finding => finding.id === msg.key);
	if (existing) {
		return reply(
			ws,
			msg.rid,
			{
				kind: "question:explore",
				ts: 0,
				id: msg.id,
				ok: true,
				finding: existing,
				repeated: true,
			} satisfies Wire.Explore.Reply,
		);
	}
	let ref = msg.action === "ask" ? msg.login! : msg.action === "research" ? msg.ref! : msg.key;
	if (msg.action === "ask" && msg.login === ws.data.handle) {
		return refuse("invalid", "Ask someone else");
	}
	if (msg.action === "research" && !await deps.research(roomId, ref)) {
		return refuse("unavailable", "That research request is not part of this document");
	}
	if (msg.action === "spike" && !await deps.spike(roomId, ref)) {
		return refuse("unavailable", "That spike is not part of this document");
	}
	let finding: Wire.Finding = {
		id: msg.key,
		kind: msg.action,
		status: "running",
		...(focus ? { focus } : {}),
		ref,
		by: ws.data.handle,
		at: Math.floor(Date.now() / 1_000),
	};
	try {
		let stored = await changeFindings(plan, server, roomId, msg.id, findings => {
			let current = plan.records.get(msg.id);
			if (!current || !isOpenStatus(current.status)) return undefined;
			if (findings.some(value => value.id === finding.id)) return undefined;
			return [...findings, finding];
		});
		if (!stored) return refuse("resolved", "This decision is no longer open");
	} catch (error) {
		return fail(ws, msg.rid, error instanceof Error ? error.message : "cannot explore");
	}
	reply(
		ws,
		msg.rid,
		{
			kind: "question:explore",
			ts: 0,
			id: msg.id,
			ok: true,
			finding,
		} satisfies Wire.Explore.Reply,
	);
	if (msg.action === "ask") {
		let asked = question(plan, msg.id);
		await deps.notice(
			plan,
			roomId,
			msg.id,
			`@${ws.data.handle} asked @${msg.login} about ${label(asked)}`,
			label(asked),
		).catch(error => console.error("[questions] could not post an ask notice:", error));
	}
}

/** Stop a running finding and the work behind it. */
export async function stop(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.Explore.Stop>,
	deps: ExploreDeps,
): Promise<void> {
	let finding = plan.records.get(msg.id)?.findings?.find(value => value.id === msg.finding);
	if (!finding || finding.status !== "running") {
		return reply(
			ws,
			msg.rid,
			{
				kind: "question:explore-stop",
				ts: 0,
				id: msg.id,
				ok: true,
			} satisfies Wire.Explore.Stopped,
		);
	}
	try {
		if (finding.kind !== "ask") await deps.stop(roomId, finding, ws);
		await updateFinding(
			plan,
			server,
			roomId,
			msg.id,
			msg.finding,
			value => value.status === "running" ? { ...value, status: "stopped" } : undefined,
		);
		reply(
			ws,
			msg.rid,
			{
				kind: "question:explore-stop",
				ts: 0,
				id: msg.id,
				ok: true,
			} satisfies Wire.Explore.Stopped,
		);
	} catch (error) {
		reply(
			ws,
			msg.rid,
			{
				kind: "question:explore-stop",
				ts: 0,
				id: msg.id,
				ok: false,
				message: error instanceof Error ? error.message : "cannot stop",
			} satisfies Wire.Explore.Stopped,
		);
	}
}

/** The asked member's reply settles their ask. Nobody else may answer for them. */
export async function take(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.Explore.Take>,
): Promise<void> {
	let answer = (body: { ok: true } | { ok: false; message: string }) =>
		reply(
			ws,
			msg.rid,
			{
				kind: "question:take",
				ts: 0,
				id: msg.id,
				...body,
			} satisfies Wire.Explore.Taken,
		);
	let text = typeof msg.text === "string" ? msg.text.trim() : "";
	if (!text || text.length > MAX_FINDING_SUMMARY) {
		return answer({ ok: false, message: "Write a reply first" });
	}
	try {
		let stored = await updateFinding(
			plan,
			server,
			roomId,
			msg.id,
			msg.finding,
			value =>
				value.kind === "ask" && value.ref === ws.data.handle
					? { ...value, status: "ready", summary: text }
					: undefined,
		);
		answer(stored ? { ok: true } : { ok: false, message: "You were not asked about this" });
	} catch (error) {
		answer({ ok: false, message: error instanceof Error ? error.message : "cannot reply" });
	}
}

/**
 * Bring each running research finding in line with its request. Idempotent: called whenever a
 * request settles, and safe to repeat.
 */
export async function settleResearch(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	request: {
		id: string;
		stage: string;
		sources: readonly { title: string; url: string }[];
		child?: { id: string; title: string; summary: string; sourceCount: number };
	},
	notice: ExploreDeps["notice"],
): Promise<void> {
	for (let [id, record] of plan.records) {
		let finding = record.findings?.find(value =>
			value.kind === "research" && value.ref === request.id && value.status === "running"
		);
		if (!finding) continue;
		let ready = request.stage === "ready" && request.child;
		if (!ready && request.stage !== "failed" && request.stage !== "cancelled") continue;
		let stored = await updateFinding(plan, server, roomId, id, finding.id, value => {
			if (value.status !== "running") return undefined;
			if (!ready || !request.child) {
				return { ...value, status: request.stage === "cancelled" ? "stopped" : "failed" };
			}
			return {
				...value,
				status: "ready",
				title: clip(request.child.title || "Research", 300),
				...(request.child.summary.trim()
					? { summary: clip(request.child.summary, MAX_FINDING_SUMMARY) }
					: {}),
				sources: request.sources.filter(source => /^https?:\/\//.test(source.url)).slice(0, 20)
					.map(source => ({ title: clip(source.title || source.url, 300), url: source.url })),
				sourceCount: request.child.sourceCount,
				childId: request.child.id,
			};
		});
		if (stored && ready) {
			let asked = question(plan, id);
			await notice(plan, roomId, id, `Research finished for ${label(asked)}`, label(asked))
				.catch(error => console.error("[questions] could not post a research notice:", error));
		}
	}
}

/** Bring a running spike finding in line with its investigation. Idempotent. */
export async function settleSpike(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	investigation: {
		id: string;
		state: string;
		title?: string;
		summary?: string;
		branch?: string;
		childId?: string;
	},
	notice: ExploreDeps["notice"],
): Promise<void> {
	let done = investigation.state === "completed";
	if (!done && !["failed", "cancelled", "interrupted"].includes(investigation.state)) return;
	for (let [id, record] of plan.records) {
		let finding = record.findings?.find(value =>
			value.kind === "spike" && value.ref === investigation.id && value.status === "running"
		);
		if (!finding) continue;
		let stored = await updateFinding(plan, server, roomId, id, finding.id, value => {
			if (value.status !== "running") return undefined;
			if (!done) {
				return { ...value, status: investigation.state === "cancelled" ? "stopped" : "failed" };
			}
			return {
				...value,
				status: "ready",
				title: clip(investigation.title || "Spike", 300),
				...(investigation.summary?.trim()
					? { summary: clip(investigation.summary, MAX_FINDING_SUMMARY) }
					: {}),
				...(investigation.branch?.trim() ? { branch: clip(investigation.branch, 256) } : {}),
				...(investigation.childId ? { childId: investigation.childId } : {}),
			};
		});
		if (stored && done) {
			let asked = question(plan, id);
			await notice(plan, roomId, id, `Spike finished for ${label(asked)}`, label(asked))
				.catch(error => console.error("[questions] could not post a spike notice:", error));
		}
	}
}

function clip(text: string, max: number): string {
	let value = text.trim();
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
