import type { Question as Wire } from "@chopin/protocol";
import type { Server } from "bun";

import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import type { SocketData } from "../wire";

import { announce } from "./card-notifications";
import { findings as validate, MAX_FINDINGS } from "./record-validation";

/**
 * Change one decision's findings and persist the record before announcing it.
 *
 * `change` sees the current findings inside the room queue and returns the next list, or
 * `undefined` to leave the record untouched. Once the list is full the oldest settled research or
 * investigation makes room for a new finding; running findings and takes are never dropped.
 */
export function changeFindings(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	id: string,
	change: (findings: Wire.Finding[]) => Wire.Finding[] | undefined,
): Promise<Wire.Finding[] | undefined> {
	return Service.exclusive(plan, async () => {
		let record = plan.records.get(id);
		if (!record) throw new Error("decision not found");
		let next = change(record.findings ?? []);
		if (!next) return undefined;
		while (next.length > MAX_FINDINGS) {
			// Running work and an ask's reply (a take) are never dropped; the oldest other one goes.
			let oldest = next.findIndex(finding =>
				finding.status !== "running" && !(finding.kind === "ask" && finding.summary)
			);
			if (oldest < 0) {
				throw new Error("This decision has too many explorations and takes to add another");
			}
			next = next.toSpliced(oldest, 1);
		}
		validate(next);
		let previous = plan.records;
		plan.records = new Map(previous).set(id, { ...record, findings: next });
		try {
			await Service.persistExclusive(plan);
		} catch (error) {
			plan.records = previous;
			throw error;
		}
		announce(plan, server, roomId, id);
		return next;
	});
}

/** Replace the finding with `findingId`, leaving the others in place. */
export function updateFinding(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	id: string,
	findingId: string,
	patch: (finding: Wire.Finding) => Wire.Finding | undefined,
): Promise<Wire.Finding[] | undefined> {
	return changeFindings(plan, server, roomId, id, findings => {
		let index = findings.findIndex(finding => finding.id === findingId);
		if (index < 0) return undefined;
		let next = patch(findings[index]!);
		return next ? findings.with(index, next) : undefined;
	});
}

/** Ids of running findings of `kind` in a stored sidecar's decision records, without opening them. */
export function runningFindingRefs(sidecar: unknown, kind: Wire.Finding["kind"]): Set<string> {
	let refs = new Set<string>();
	let records = (sidecar as { questions?: unknown } | null | undefined)?.questions;
	if (!Array.isArray(records)) return refs;
	for (let record of records) {
		let list = (record as { findings?: unknown } | null)?.findings;
		if (!Array.isArray(list)) continue;
		for (let finding of list as Wire.Finding[]) {
			if (finding?.kind === kind && finding.status === "running") refs.add(finding.ref);
		}
	}
	return refs;
}
