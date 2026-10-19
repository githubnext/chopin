import type { Question as Wire, Request } from "@chopin/protocol";
import type { Server } from "bun";

import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import { fail, reply } from "../wire";
import type { Socket, SocketData } from "../wire";

import { announce } from "./card-notifications";
import { isOpenStatus } from "./records";
import { MAX_FINDING_FOCUS, MAX_FINDING_SUMMARY } from "./record-validation";
import { changeFindings, updateFinding } from "./service-findings";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** A research request as a finding follows it. */
export type ResearchSnapshot = {
	id: string;
	stage: string;
	sources: readonly { title: string; url: string }[];
	child?: { id: string; title: string; summary: string; sourceCount: number };
};

/** An investigation as a finding follows it. */
export type SpikeSnapshot = {
	id: string;
	state: string;
	title?: string;
	summary?: string;
	branch?: string;
	childId?: string;
};

/** External work a finding can follow, supplied by the server that owns it. */
export type ExploreDeps = {
	/** Research request `ref` as it stands, or undefined when it is not part of document `roomId`. */
	research: (roomId: string, ref: string) => Promise<ResearchSnapshot | undefined>;
	/** Investigation `ref` as it stands, or undefined when it is not part of document `roomId`. */
	spike: (roomId: string, ref: string) => Promise<SpikeSnapshot | undefined>;
	/** Stop the external work behind a running finding. */
	stop: (roomId: string, finding: Wire.Finding, ws: Socket) => Promise<void>;
	/** Post a system notice in the document's Chat about decision `id`. */
	notice: (plan: Plan, roomId: string, id: string, text: string, label: string) => Promise<void>;
};

function question(plan: Plan, id: string): string {
	return plan.records.get(id)?.definition.questions[0]?.question ?? "this decision";
}

/** Logins compare case-insensitively; they are stored as given. */
function sameLogin(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
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
	let ref = msg.action === "ask" ? msg.login! : msg.action === "research" ? msg.ref! : msg.key;
	if (msg.action === "ask" && sameLogin(msg.login!, ws.data.handle)) {
		return refuse("invalid", "Ask someone else");
	}
	let research: ResearchSnapshot | undefined;
	let spike: SpikeSnapshot | undefined;
	if (msg.action === "research" && !(research = await deps.research(roomId, ref))) {
		return refuse("unavailable", "That research request is not part of this document");
	}
	if (msg.action === "spike" && !(spike = await deps.spike(roomId, ref))) {
		return refuse("unavailable", "That investigation is not part of this document");
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
	let repeated: Wire.Finding | undefined;
	try {
		// The repeat check runs in the room queue, so a retry mid-commit sees committed state only.
		let stored = await changeFindings(plan, server, roomId, msg.id, findings => {
			let current = plan.records.get(msg.id);
			if (!current || !isOpenStatus(current.status)) return undefined;
			repeated = findings.find(value => value.id === finding.id);
			if (repeated) return undefined;
			return [...findings, finding];
		});
		if (repeated) {
			return reply(
				ws,
				msg.rid,
				{
					kind: "question:explore",
					ts: 0,
					id: msg.id,
					ok: true,
					finding: repeated,
					repeated: true,
				} satisfies Wire.Explore.Reply,
			);
		}
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
	// The work may already be over when it is attached.
	try {
		if (research) await settleResearch(plan, server, roomId, research, deps.notice);
		if (spike) await settleSpike(plan, server, roomId, spike, deps.notice);
	} catch (error) {
		console.error("[questions] could not settle a finding on attach:", error);
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
	let refused = (message: string) =>
		reply(
			ws,
			msg.rid,
			{
				kind: "question:explore-stop",
				ts: 0,
				id: msg.id,
				ok: false,
				message,
			} satisfies Wire.Explore.Stopped,
		);
	if (finding?.status === "running") {
		if (Service.implementationActive(plan)) {
			return refused("An implementation is running; decisions cannot change");
		}
		if (!sameLogin(finding.by, ws.data.handle)) {
			return refused(`Only @${finding.by} can stop this`);
		}
	}
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
	if (msg.stance !== undefined && msg.stance !== "supports" && msg.stance !== "objects") {
		return answer({ ok: false, message: "Choose Supports or Objects, or neither" });
	}
	let stance = msg.stance;
	if (Service.implementationActive(plan)) {
		return answer({ ok: false, message: "An implementation is running; decisions cannot change" });
	}
	try {
		let stored = await updateFinding(
			plan,
			server,
			roomId,
			msg.id,
			msg.finding,
			value =>
				value.kind === "ask" && value.status === "running" && sameLogin(value.ref, ws.data.handle)
					&& isOpenStatus(plan.records.get(msg.id)?.status ?? "discarded")
					? { ...value, status: "ready", summary: text, ...(stance ? { stance } : {}) }
					: undefined,
		);
		answer(
			stored ? { ok: true } : { ok: false, message: "This ask is not waiting for your reply" },
		);
	} catch (error) {
		answer({ ok: false, message: error instanceof Error ? error.message : "cannot reply" });
	}
}

/**
 * Bring each research finding in line with its request. Idempotent: called whenever a request
 * settles, and safe to repeat. A running finding settles to ready, failed or stopped; a failed
 * one follows a retry of the same request to ready.
 */
export async function settleResearch(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	request: ResearchSnapshot,
	notice: ExploreDeps["notice"],
): Promise<void> {
	for (let [id, record] of plan.records) {
		let finding = record.findings?.find(value =>
			value.kind === "research" && value.ref === request.id
			&& (value.status === "running" || value.status === "failed" && request.stage === "ready")
		);
		if (!finding) continue;
		let ready = request.stage === "ready" && request.child;
		if (!ready && request.stage !== "failed" && request.stage !== "cancelled") continue;
		let stored = await updateFinding(plan, server, roomId, id, finding.id, value => {
			if (value.status !== "running" && !(ready && value.status === "failed")) return undefined;
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
	investigation: SpikeSnapshot,
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
				title: clip(investigation.title || "Investigation", 300),
				...(investigation.summary?.trim()
					? { summary: clip(investigation.summary, MAX_FINDING_SUMMARY) }
					: {}),
				...(investigation.branch?.trim() ? { branch: clip(investigation.branch, 256) } : {}),
				...(investigation.childId ? { childId: investigation.childId } : {}),
			};
		});
		if (stored && done) {
			let asked = question(plan, id);
			await notice(plan, roomId, id, `Investigation finished for ${label(asked)}`, label(asked))
				.catch(error =>
					console.error("[questions] could not post an investigation notice:", error)
				);
		}
	}
}

/**
 * Settle every running research or investigation finding whose work already finished, and let a
 * failed research finding follow a retried request to ready. Cheap when nothing is running.
 * Failures are logged; the next sweep tries again.
 */
export async function sweep(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	deps: ExploreDeps,
): Promise<void> {
	let follows = (record: { findings?: Wire.Finding[] }) =>
		record.findings?.filter(finding =>
			finding.kind === "research" && (finding.status === "running" || finding.status === "failed")
			|| finding.kind === "spike" && finding.status === "running"
		) ?? [];
	if (![...plan.records.values()].some(record => follows(record).length > 0)) return;
	let seen = new Set<string>();
	for (let record of [...plan.records.values()]) {
		for (let finding of follows(record)) {
			let key = `${finding.kind}:${finding.ref}`;
			if (seen.has(key)) continue;
			seen.add(key);
			try {
				if (finding.kind === "research") {
					let request = await deps.research(roomId, finding.ref);
					if (request) await settleResearch(plan, server, roomId, request, deps.notice);
				} else {
					let investigation = await deps.spike(roomId, finding.ref);
					if (investigation) await settleSpike(plan, server, roomId, investigation, deps.notice);
				}
			} catch (error) {
				console.error(`[questions] could not settle a ${finding.kind} finding:`, error);
			}
		}
	}
}

function clip(text: string, max: number): string {
	let value = text.trim();
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Open a decision as its own child document. The channel id is deterministic, so a retry or a
 * second member finds the same page; the record learns its child only after the channel exists.
 */
export async function page(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.Explore.Page>,
	create: (input: { roomId: string; recordId: string; title: string; by: string }) => Promise<
		string
	>,
): Promise<void> {
	let answer = (body: { ok: true; childId: string } | { ok: false; message: string }) =>
		reply(
			ws,
			msg.rid,
			{
				kind: "question:page",
				ts: 0,
				id: msg.id,
				...body,
			} satisfies Wire.Explore.Paged,
		);
	let record = plan.records.get(msg.id);
	if (!record || record.status === "discarded" || record.status === "cancelled") {
		return answer({ ok: false, message: "This decision is no longer here" });
	}
	if (plan.parentChannelId) {
		return answer({ ok: false, message: "A child document’s decisions can’t open as pages" });
	}
	if (record.childId) return answer({ ok: true, childId: record.childId });
	if (Service.implementationActive(plan)) {
		return answer({ ok: false, message: "An implementation is running; decisions cannot change" });
	}
	try {
		let title = record.definition.questions[0]?.question.trim() || "Decision";
		let childId = await create({ roomId, recordId: msg.id, title, by: ws.data.principalId });
		await Service.exclusive(plan, async () => {
			let current = plan.records.get(msg.id);
			if (!current || current.childId === childId) return;
			let previous = plan.records;
			plan.records = new Map(previous).set(msg.id, { ...current, childId });
			try {
				await Service.persistExclusive(plan);
			} catch (error) {
				plan.records = previous;
				throw error;
			}
		});
		announce(plan, server, roomId, msg.id);
		answer({ ok: true, childId });
	} catch (error) {
		answer({ ok: false, message: error instanceof Error ? error.message : "cannot open page" });
	}
}
