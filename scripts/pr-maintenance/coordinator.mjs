import { attachRun, begin, finish, initialState, observe, validateState } from "./state.mjs";

export async function coordinate({
	store,
	inspect,
	listRuns,
	dispatch,
	now,
	newId,
	humanChanges = [],
	retryPR = null,
	enabled = false,
}) {
	if (!Number.isFinite(now) || now < 0) throw new Error("Invalid coordinator timestamp");
	let previous = await store.load();
	let payload = structuredClone(previous.payload);
	for (let [number, state] of Object.entries(payload.prs)) {
		validateState(state);
		if (String(state.number) !== number) throw new Error("PR state identity mismatch");
	}
	let [rows, runs] = await Promise.all([inspect(), listRuns()]);
	let observed = new Set();
	for (let row of rows) {
		if (observed.has(row.number)) throw new Error("Duplicate PR observation");
		observed.add(row.number);
		let value = { number: row.number, head: row.head, baseHead: row.baseHead, action: row.action };
		let state = payload.prs[row.number];
		payload.prs[row.number] = state
			? observe(state, value, {
				now,
				humanChange: humanChanges.includes(row.number),
				authenticatedRetry: retryPR === row.number,
			})
			: initialState(value, now);
	}
	let runIds = new Set();
	for (let run of runs) {
		if (
			!run || typeof run.id !== "string" || !run.id || typeof run.attempt !== "string"
			|| !run.attempt || !["queued", "in_progress", "completed"].includes(run.status)
			|| runIds.has(run.id)
		) throw new Error("Invalid or duplicate trusted worker run");
		runIds.add(run.id);
	}
	let activeIds = new Set();
	for (let [number, state] of Object.entries(payload.prs)) {
		let active = state.active;
		if (!active) continue;
		if (activeIds.has(active.id)) throw new Error("Duplicate active attempt identity");
		activeIds.add(active.id);
		let matches = runs.filter((run) => run.attempt === active.id || run.id === active.runId);
		if (
			matches.length > 1
			|| matches.some((run) =>
				run.attempt !== active.id || (active.runId !== null && run.id !== active.runId)
			)
		) throw new Error(`Conflicting worker runs for PR #${number}`);
		let run = matches[0];
		if (run) {
			state = attachRun(state, active.id, run.id);
			if (run.status === "completed") {
				state = finish(
					state,
					active.id,
					run.outcome ?? {
						kind: "transient",
						reason: "Worker completed without a trusted application result",
					},
					now,
				);
				let row = rows.find((row) => row.number === state.number);
				if (run.outcome?.kind === "applied" && row?.head === run.outcome.head) {
					// Checks sampled on the published head supersede finish's waiting-CI default.
					state = observe(state, {
						number: row.number,
						head: row.head,
						baseHead: row.baseHead,
						action: row.action,
					}, { now });
				}
			}
		} else if (active.runId === null && now - active.createdAt > 45 * 60_000) {
			state = finish(state, active.id, {
				kind: "transient",
				reason: "Dispatch was not discovered within 45 minutes",
			}, now);
		}
		payload.prs[number] = state;
	}
	let capacity = Math.max(0, 3 - Object.values(payload.prs).filter((state) => state.active).length);
	let candidates = Object.values(payload.prs).filter((state) =>
		observed.has(state.number) && !state.active && !state.blocker
		&& ["repair", "conflict", "rebase"].includes(state.action)
		&& (state.nextRetryAt === null || now >= state.nextRetryAt)
	).sort((a, b) => a.lastAttemptAt - b.lastAttemptAt || a.number - b.number);
	let dispatches = [];
	for (let state of candidates.slice(0, capacity)) {
		let next = begin(state, newId(), now);
		payload.prs[state.number] = next;
		dispatches.push({
			number: state.number,
			attempt: next.active.id,
			head: next.active.head,
			baseHead: next.active.baseHead,
			action: next.active.action,
			operation: next.active.action === "repair" ? "fix" : "rebase",
		});
	}
	payload.revision++;
	let errors = [];
	if (!enabled) return { payload, dispatches, errors };
	try {
		previous = await store.save(previous, payload);
	} catch {
		errors.push("State reservation failed; no workers dispatched");
		return { payload: previous.payload, dispatches, errors };
	}
	let acknowledgementsAvailable = true;
	for (let intent of dispatches) {
		let runId;
		try {
			runId = await dispatch(intent);
		} catch {
			errors.push(`PR #${intent.number} attempt ${intent.attempt}: dispatch response unavailable`);
			continue;
		}
		if (runId === null || runId === undefined || !acknowledgementsAvailable) continue;
		let acknowledged = structuredClone(previous.payload);
		try {
			acknowledged.prs[intent.number] = attachRun(
				acknowledged.prs[intent.number],
				intent.attempt,
				runId,
			);
			acknowledged.revision++;
			previous = await store.save(previous, acknowledged);
		} catch {
			errors.push(
				`PR #${intent.number} attempt ${intent.attempt}: run acknowledgement unavailable`,
			);
			// A failed acknowledgement may be a CAS conflict; stop writes against this snapshot.
			acknowledgementsAvailable = false;
		}
	}
	return { payload: previous.payload, dispatches, errors };
}
