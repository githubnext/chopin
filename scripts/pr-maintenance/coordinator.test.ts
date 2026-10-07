import { expect, test } from "bun:test";
import { coordinate } from "./coordinator.mjs";
import { begin, initialState } from "./state.mjs";

function fixture(count = 1) {
	let rows = Array.from({ length: count }, (_, index) => ({
		number: index + 1,
		head: `head${index + 1}`,
		baseHead: "base",
		action: "repair",
	}));
	let durable: any = {
		sha: "initial",
		payload: { schemaVersion: 1, repository: "o/r", revision: 0, prs: {} },
	};
	let runs: any[] = [];
	let sent: any[] = [];
	let serial = 0;
	let failSave = false;
	let loseResponse = false;
	let options = {
		store: {
			load: async () => structuredClone(durable),
			save: async (previous: any, payload: any) => {
				if (failSave || previous.sha !== durable.sha) throw new Error("CAS secret");
				durable = { sha: `revision${payload.revision}`, payload: structuredClone(payload) };
				return structuredClone(durable);
			},
		},
		inspect: async () => rows,
		listRuns: async () => runs,
		dispatch: async (intent: any) => {
			for (let item of sent) expect(durable.payload.prs[item.number]?.active).toBeTruthy();
			expect(durable.payload.prs[intent.number].active.id).toBe(intent.attempt);
			sent.push(intent);
			if (loseResponse) throw new Error("token secret");
			return null;
		},
		now: 1,
		newId: () => `attempt-${++serial}`,
		enabled: true,
	};
	return {
		options,
		rows,
		runs,
		sent,
		get durable() {
			return durable;
		},
		set failSave(value) {
			failSave = value;
		},
		set loseResponse(value) {
			loseResponse = value;
		},
	};
}

test("durable intent makes duplicate scans and lost responses safe", async () => {
	let f = fixture();
	f.loseResponse = true;
	let first = await coordinate(f.options);
	expect(first.errors).toHaveLength(1);
	expect(first.errors.join()).not.toContain("secret");
	await coordinate(f.options);
	expect(f.sent).toHaveLength(1);
	f.runs.push({
		id: "run1",
		attempt: f.sent[0].attempt,
		status: "completed",
		conclusion: "success",
		outcome: { kind: "applied", head: "new-head" },
	});
	await coordinate(f.options);
	expect(f.durable.payload.prs[1].active).toBeNull();
	expect(f.durable.payload.prs[1].action).toBe("waiting-ci");
});

test("CAS failure dispatches nothing and dry run writes nothing", async () => {
	let f = fixture(4);
	f.failSave = true;
	let result = await coordinate(f.options);
	expect(result.errors).toHaveLength(1);
	expect(f.sent).toHaveLength(0);
	let dry = await coordinate({ ...f.options, enabled: false });
	expect(dry.dispatches).toHaveLength(3);
	expect(f.durable.payload.revision).toBe(0);
});

test("thirty PRs get fair batches before any repeated attempt", async () => {
	let f = fixture(30);
	for (let batch = 0; batch < 10; batch++) {
		f.options.now = batch + 1;
		let result = await coordinate(f.options);
		expect(result.dispatches.map((item: any) => item.number)).toEqual([
			batch * 3 + 1,
			batch * 3 + 2,
			batch * 3 + 3,
		]);
		for (let intent of result.dispatches) {
			f.runs.push({
				id: `run-${intent.attempt}`,
				attempt: intent.attempt,
				status: "completed",
				conclusion: "failure",
				outcome: { kind: "failed", fingerprint: "same", progress: true },
			});
		}
	}
});

test("unknown timeout releases lock while known running lock survives", async () => {
	for (let known of [false, true]) {
		let f = fixture();
		await coordinate(f.options);
		if (known) {
			f.runs.push({
				id: "run",
				attempt: f.sent[0].attempt,
				status: "in_progress",
				conclusion: null,
			});
		}
		f.options.now = 46 * 60_000;
		await coordinate(f.options);
		expect(Boolean(f.durable.payload.prs[1].active)).toBe(known);
		if (!known) expect(f.durable.payload.prs[1].transientCount).toBe(1);
	}
});

test("closed and opted out attempts still occupy capacity", async () => {
	let f = fixture(5);
	await coordinate(f.options);
	f.rows.splice(0, 1);
	f.rows[0].action = "opted-out";
	let result = await coordinate(f.options);
	expect(result.dispatches).toHaveLength(0);
	expect(f.durable.payload.prs[1].active).toBeTruthy();
	expect(f.durable.payload.prs[2].active).toBeTruthy();
});

test("trusted human flags reset episode; automation and base changes do not", async () => {
	let f = fixture();
	await coordinate(f.options);
	f.rows[0].head = "automation";
	f.rows[0].baseHead = "new-base";
	await coordinate(f.options);
	expect(f.durable.payload.prs[1].episode).toBe(1);
	await coordinate({ ...f.options, humanChanges: [1] });
	expect(f.durable.payload.prs[1].episode).toBe(2);
	expect(f.durable.payload.prs[1].active).toBeTruthy();
});

test("cancelled missing result consumes transient budget", async () => {
	let f = fixture();
	await coordinate(f.options);
	f.runs.push({
		id: "run",
		attempt: f.sent[0].attempt,
		status: "completed",
		conclusion: "cancelled",
	});
	await coordinate(f.options);
	expect(f.durable.payload.prs[1].repairCount).toBe(0);
	expect(f.durable.payload.prs[1].nextRetryAt).toBe(300_001);
});

test("malformed absent state and ambiguous run identity fail closed", async () => {
	let f = fixture();
	await coordinate(f.options);
	f.runs.push(
		...["a", "b"].map((id) => ({
			id,
			attempt: f.sent[0].attempt,
			status: "queued",
			conclusion: null,
		})),
	);
	await expect(coordinate(f.options)).rejects.toThrow();
	let state = begin(initialState(f.rows[0], 1), "attempt", 1);
	await expect(
		coordinate({
			...f.options,
			store: {
				...f.options.store,
				load: async () => ({
					sha: "x",
					payload: { ...f.durable.payload, prs: { 99: { ...state, status: "broken" } } },
				}),
			},
		}),
	).rejects.toThrow();
});

test("acknowledgement CAS loss retains every intent and continues independent dispatch", async () => {
	let f = fixture(3);
	let result = await coordinate({
		...f.options,
		dispatch: async (intent: any) => {
			f.sent.push(intent);
			f.failSave = true;
			return `run-${intent.attempt}`;
		},
	});
	expect(f.sent).toHaveLength(3);
	expect(result.errors).toHaveLength(1);
	for (let intent of f.sent) {
		expect(f.durable.payload.prs[intent.number].active.id).toBe(intent.attempt);
		f.runs.push({
			id: `run-${intent.attempt}`,
			attempt: intent.attempt,
			status: "in_progress",
			conclusion: null,
		});
	}
	f.failSave = false;
	await coordinate(f.options);
	for (let intent of f.sent) {
		expect(f.durable.payload.prs[intent.number].active.runId).toBe(`run-${intent.attempt}`);
	}
});

test("immutable dispatch action selects graph mode", async () => {
	let f = fixture(3);
	f.rows[1].action = "conflict";
	f.rows[2].action = "rebase";
	let result = await coordinate(f.options);
	expect(result.dispatches.map((intent: any) => [intent.action, intent.operation])).toEqual([
		["repair", "fix"],
		["conflict", "rebase"],
		["rebase", "rebase"],
	]);
});

test("published-head observations remain authoritative after completed application", async () => {
	for (let action of ["repair", "ready", "rebase", "opted-out"]) {
		let f = fixture();
		await coordinate(f.options);
		let attempt = f.sent[0].attempt;
		f.rows[0].head = "published";
		f.rows[0].action = action;
		f.runs.push({
			id: "run",
			attempt,
			status: "completed",
			conclusion: "success",
			outcome: { kind: "applied", head: "published" },
		});
		let result = await coordinate({ ...f.options, enabled: false });
		expect(result.payload.prs[1].action).toBe(action);
		expect(result.payload.prs[1].head).toBe("published");
		expect(result.dispatches.length).toBe(["repair", "rebase"].includes(action) ? 1 : 0);
	}
});

test("a scan predating application cannot dispatch the obsolete head", async () => {
	let f = fixture();
	await coordinate(f.options);
	f.runs.push({
		id: "run",
		attempt: f.sent[0].attempt,
		status: "completed",
		conclusion: "success",
		outcome: { kind: "applied", head: "published" },
	});
	let result = await coordinate({ ...f.options, enabled: false });
	expect(result.payload.prs[1].head).toBe("published");
	expect(result.payload.prs[1].action).toBe("waiting-ci");
	expect(result.dispatches).toHaveLength(0);
});

test("published-head reconciliation never applies the caller's episode reset twice", async () => {
	let f = fixture();
	await coordinate(f.options);
	f.rows[0].head = "published";
	f.rows[0].action = "ready";
	f.runs.push({
		id: "run",
		attempt: f.sent[0].attempt,
		status: "completed",
		conclusion: "success",
		outcome: { kind: "applied", head: "published" },
	});
	let result = await coordinate({ ...f.options, enabled: false, humanChanges: [1] });
	expect(result.payload.prs[1].episode).toBe(2);
	expect(result.payload.prs[1].repairCount).toBe(0);
	expect(result.payload.prs[1].action).toBe("ready");
	expect(result.payload.prs[1].active).toBeNull();
});

test("two published repairs with unchanged current-head CI block before third dispatch", async () => {
	let f = fixture();
	Object.assign(f.rows[0], { failureFingerprint: "ci:same" });
	await coordinate(f.options);
	for (let index = 1; index <= 2; index++) {
		let active = f.durable.payload.prs[1].active;
		active.proposalHead = `published${index}`;
		f.rows[0].head = active.proposalHead;
		f.runs.push({
			id: `run${index}`,
			attempt: active.id,
			status: "completed",
			outcome: { kind: "applied", head: active.proposalHead },
		});
		f.options.now++;
		await coordinate(f.options);
	}
	expect(f.sent).toHaveLength(2);
	expect(f.durable.payload.prs[1].failureCount).toBe(2);
	expect(f.durable.payload.prs[1].blocker.reason).toBe("Repeated failure without progress");
});

test("lost trusted result after observed publication charges and delays next repair", async () => {
	let f = fixture();
	Object.assign(f.rows[0], { failureFingerprint: "ci:same" });
	await coordinate(f.options);
	let active = f.durable.payload.prs[1].active;
	active.proposalHead = "published";
	f.rows[0].head = "published";
	f.runs.push({ id: "run1", attempt: active.id, status: "completed" });
	f.options.now = 2;
	await coordinate(f.options);
	expect(f.sent).toHaveLength(1);
	expect(f.durable.payload.prs[1].repairCount).toBe(1);
	expect(f.durable.payload.prs[1].nextRetryAt).toBe(2 + 5 * 60_000);
});

test("changed trusted CI fingerprint resets the no-progress streak", async () => {
	let f = fixture();
	Object.assign(f.rows[0], { failureFingerprint: "ci:A" });
	await coordinate(f.options);
	for (let index = 1; index <= 2; index++) {
		let active = f.durable.payload.prs[1].active;
		active.proposalHead = `published${index}`;
		f.rows[0].head = active.proposalHead;
		if (index === 2) Object.assign(f.rows[0], { failureFingerprint: "ci:B" });
		f.runs.push({
			id: `run${index}`,
			attempt: active.id,
			status: "completed",
			outcome: { kind: "applied", head: active.proposalHead },
		});
		f.options.now++;
		await coordinate(f.options);
	}
	expect(f.sent).toHaveLength(3);
	expect(f.durable.payload.prs[1].failureCount).toBe(0);
	expect(f.durable.payload.prs[1].failureRepairCount).toBe(2);
	expect(f.durable.payload.prs[1].blocker).toBeNull();
});
