let actions = new Set([
	"opted-out",
	"waiting-parent",
	"conflict",
	"rebase",
	"verify",
	"waiting-ci",
	"repair",
	"ready",
]);

function fields(value, allowed) {
	if (
		!value || typeof value !== "object" || Array.isArray(value)
		|| Object.keys(value).some((key) => !allowed.includes(key))
	) {
		throw new Error("Invalid transition fields");
	}
}

function identity(value) {
	if (typeof value !== "string" || !value.trim()) throw new Error("Invalid identity");
}

function timestamp(now) {
	if (!Number.isFinite(now) || now < 0) throw new Error("Invalid timestamp");
}

function observation(value) {
	fields(value, ["number", "head", "baseHead", "action"]);
	if (!Number.isSafeInteger(value.number) || value.number < 1) throw new Error("Invalid PR number");
	identity(value.head);
	if (value.baseHead !== null || value.action !== "opted-out") identity(value.baseHead);
	if (!actions.has(value.action)) throw new Error("Invalid observation action");
}

function status(state) {
	return state.blocker ? "blocked" : state.active ? "working" : state.nextRetryAt !== null
		? "retrying"
		: state.action;
}

function exactFields(value, keys) {
	fields(value, keys);
	if (keys.some((key) => !Object.hasOwn(value, key))) throw new Error("Missing state field");
}

export function validateVerification(value) {
	exactFields(value, ["head", "operation", "paths", "checks", "hashReviews"]);
	let text = (value, maximum = 4096) =>
		typeof value === "string" && value.trim().length > 0
		&& Buffer.byteLength(value) <= maximum;
	let path = (value) =>
		text(value, 1024) && !["\\", "\r", "\n", "\0"].some((character) => value.includes(character))
		&& !/^[A-Za-z]:/.test(value)
		&& value.split("/").every((part) => part && part !== "." && part !== "..");
	if (
		!/^[a-f0-9]{40}$/.test(value.head) || !["fix", "rebase"].includes(value.operation)
		|| !Array.isArray(value.paths) || value.paths.length > 1000
		|| value.paths.some((entry) => !path(entry)) || new Set(value.paths).size !== value.paths.length
		|| !Array.isArray(value.checks) || !value.checks.length || value.checks.length > 100
		|| !Array.isArray(value.hashReviews) || value.hashReviews.length > 100
	) {
		throw new Error("Invalid verification evidence");
	}
	for (let check of value.checks) {
		exactFields(check, ["command", "result"]);
		if (!text(check.command) || !text(check.result)) throw new Error("Invalid verification check");
	}
	let reviewed = new Set();
	for (let review of value.hashReviews) {
		exactFields(review, ["file", "sourceHash", "rationale"]);
		if (
			!path(review.file) || !/^(apps|packages)\//.test(review.file)
			|| typeof review.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(review.sourceHash)
			|| !text(review.rationale)
			|| reviewed.has(review.file)
		) throw new Error("Invalid hash review evidence");
		reviewed.add(review.file);
	}
	if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024) {
		throw new Error("Verification evidence exceeds limit");
	}
}

export function validateState(state) {
	exactFields(state, [
		"number",
		"head",
		"baseHead",
		"action",
		"episode",
		"repairCount",
		"failureFingerprint",
		"failureCount",
		"failureRepairCount",
		"transientCount",
		"nextRetryAt",
		"active",
		"blocker",
		"status",
		"updatedAt",
		"lastAttemptAt",
		"verification",
	]);
	if (state.verification !== null) validateVerification(state.verification);
	observation({
		number: state.number,
		head: state.head,
		baseHead: state.baseHead,
		action: state.action,
	});
	for (
		let key of ["episode", "repairCount", "failureCount", "failureRepairCount", "transientCount"]
	) {
		if (!Number.isSafeInteger(state[key]) || state[key] < 0) {
			throw new Error("Invalid state counter");
		}
	}
	if (
		state.episode < 1 || state.repairCount > 3 || state.transientCount > 4
		|| state.failureRepairCount > state.repairCount
	) {
		throw new Error("Invalid state budget");
	}
	if (state.failureFingerprint !== null) identity(state.failureFingerprint);
	if (state.failureCount > 0 && state.failureFingerprint === null) {
		throw new Error("Missing failure identity");
	}
	timestamp(state.updatedAt);
	timestamp(state.lastAttemptAt);
	if (state.nextRetryAt !== null) timestamp(state.nextRetryAt);
	if (!actions.has(state.status) && !["working", "retrying", "blocked"].includes(state.status)) {
		throw new Error("Invalid state status");
	}
	if (state.active !== null) {
		exactFields(state.active, [
			"id",
			"head",
			"baseHead",
			"episode",
			"createdAt",
			"runId",
			"proposalHead",
			"operation",
			"action",
		]);
		identity(state.active.id);
		identity(state.active.head);
		identity(state.active.baseHead);
		if (state.active.runId !== null) identity(state.active.runId);
		if (state.active.proposalHead !== null) identity(state.active.proposalHead);
		timestamp(state.active.createdAt);
		if (
			!Number.isSafeInteger(state.active.episode) || state.active.episode < 1
			|| state.active.episode > state.episode
			|| !["repair", "conflict", "rebase"].includes(state.active.action)
			|| state.active.operation !== (state.active.action === "rebase" ? "rebase" : "repair")
		) {
			throw new Error("Invalid active attempt");
		}
	}
	if (state.blocker !== null) {
		exactFields(state.blocker, ["id", "kind", "reason"]);
		identity(state.blocker.id);
		identity(state.blocker.reason);
		if (!["human", "infrastructure"].includes(state.blocker.kind)) {
			throw new Error("Invalid blocker kind");
		}
	}
	if (state.status !== status(state)) throw new Error("Inconsistent state status");
}

export function initialState(value, now) {
	observation(value);
	timestamp(now);
	return {
		...value,
		episode: 1,
		repairCount: 0,
		failureFingerprint: null,
		failureCount: 0,
		failureRepairCount: 0,
		transientCount: 0,
		nextRetryAt: null,
		active: null,
		blocker: null,
		status: value.action,
		updatedAt: now,
		lastAttemptAt: 0,
		verification: null,
	};
}

export function observe(state, value, options) {
	validateState(state);
	observation(value);
	fields(options, ["now", "humanChange", "authenticatedRetry", "resolved"]);
	timestamp(options.now);
	for (let flag of ["humanChange", "authenticatedRetry", "resolved"]) {
		if (options[flag] !== undefined && typeof options[flag] !== "boolean") {
			throw new Error("Invalid observation decision");
		}
	}
	if (state.number !== value.number) throw new Error("PR identity mismatch");
	let next = { ...state, ...value, updatedAt: options.now };
	if (options.humanChange || options.authenticatedRetry) {
		next = {
			...initialState(value, options.now),
			episode: state.episode + 1,
			active: state.active,
			lastAttemptAt: state.lastAttemptAt,
		};
	} else if (options.resolved) {
		next.blocker = null;
	}
	if (!next.blocker && next.repairCount >= 3 && ["repair", "conflict"].includes(next.action)) {
		next.blocker = {
			id: `budget:${next.episode}`,
			kind: "human",
			reason: "Repair budget exhausted",
		};
	}
	next.status = status(next);
	return next;
}

export function observeFailure(state, fingerprint, now) {
	validateState(state);
	identity(fingerprint);
	if (Buffer.byteLength(fingerprint) > 4096) throw new Error("Invalid failure fingerprint");
	timestamp(now);
	if (state.active || state.action !== "repair") return state;
	let same = state.failureFingerprint === fingerprint;
	let next = {
		...state,
		failureFingerprint: fingerprint,
		updatedAt: now,
		failureCount: same
			? state.failureCount + (state.repairCount > state.failureRepairCount ? 1 : 0)
			: 0,
		failureRepairCount: state.repairCount,
	};
	if (next.failureCount >= 2 && !next.blocker) {
		next.blocker = {
			id: `failure:${next.episode}:${next.repairCount}`,
			kind: "human",
			reason: "Repeated failure without progress",
		};
	}
	next.status = status(next);
	return next;
}

export function begin(state, attemptId, now) {
	validateState(state);
	identity(attemptId);
	timestamp(now);
	if (state.active || state.blocker || (state.nextRetryAt !== null && now < state.nextRetryAt)) {
		throw new Error("PR attempt unavailable");
	}
	if (!["repair", "conflict", "rebase"].includes(state.action)) {
		throw new Error("Observation does not authorize repair");
	}
	if (state.repairCount >= 3 && state.action !== "rebase") {
		throw new Error("Repair budget exhausted");
	}
	return {
		...state,
		active: {
			id: attemptId,
			head: state.head,
			baseHead: state.baseHead,
			episode: state.episode,
			createdAt: now,
			runId: null,
			proposalHead: null,
			operation: state.action === "rebase" ? "rebase" : "repair",
			action: state.action,
		},
		status: "working",
		nextRetryAt: null,
		updatedAt: now,
		lastAttemptAt: now,
	};
}

export function attachRun(state, attemptId, runId) {
	validateState(state);
	identity(attemptId);
	identity(runId);
	if (state.active?.id !== attemptId) throw new Error("Attempt identity mismatch");
	if (state.active.runId !== null && state.active.runId !== runId) {
		throw new Error("Attempt already has a run");
	}
	return { ...state, active: { ...state.active, runId } };
}

export function finish(state, attemptId, outcome, now) {
	validateState(state);
	identity(attemptId);
	timestamp(now);
	let keys = {
		applied: ["kind", "head", "verification"],
		failed: ["kind", "fingerprint", "progress"],
		transient: ["kind", "reason"],
		blocked: ["kind", "reason"],
		superseded: ["kind"],
	};
	if (!outcome || !Object.hasOwn(keys, outcome.kind)) throw new Error("Invalid outcome");
	fields(outcome, keys[outcome.kind]);
	if (outcome.kind === "applied") {
		identity(outcome.head);
		if (outcome.verification !== undefined) {
			validateVerification(outcome.verification);
			if (outcome.verification.head !== outcome.head) throw new Error("Verification head mismatch");
		}
	}
	if (outcome.kind === "failed") {
		identity(outcome.fingerprint);
		if (typeof outcome.progress !== "boolean") throw new Error("Invalid progress decision");
	}
	if (["transient", "blocked"].includes(outcome.kind)) identity(outcome.reason);
	let active = state.active;
	if (active?.id !== attemptId) return state;
	let next = { ...state, active: null, updatedAt: now };
	if (
		outcome.kind === "applied" && active.proposalHead !== null
		&& active.proposalHead !== outcome.head
	) {
		throw new Error("Applied head does not match registered proposal");
	}
	let published = active.proposalHead !== null && active.proposalHead === state.head;
	let sameEpisode = active.episode === state.episode;
	if (sameEpisode && published && outcome.kind === "superseded") {
		outcome = { kind: "transient", reason: "Published proposal has no trusted completion result" };
	}
	let matchingHead = published || active.head === state.head
		|| (outcome.kind === "applied" && outcome.head === state.head);
	if (active.episode !== state.episode || !matchingHead || outcome.kind === "superseded") {
		next.status = status(next);
		return next;
	}
	if (active.baseHead !== state.baseHead && outcome.kind !== "applied" && !published) {
		if (outcome.kind === "failed" && active.operation === "repair") next.repairCount++;
		if (next.repairCount >= 3 && ["repair", "conflict"].includes(next.action)) {
			next.blocker = { id: attemptId, kind: "human", reason: "Repair budget exhausted" };
		}
		next.status = status(next);
		return next;
	}
	if (
		published && active.operation === "repair" && outcome.kind !== "applied"
		&& outcome.kind !== "failed"
	) next.repairCount++;
	if (outcome.kind === "transient") {
		next.transientCount++;
		let delay = [5, 15, 60][next.transientCount - 1];
		if (delay !== undefined) next.nextRetryAt = now + delay * 60_000;
		else next.blocker = { id: attemptId, kind: "infrastructure", reason: outcome.reason };
	} else if (outcome.kind === "blocked") {
		next.blocker = { id: attemptId, kind: "human", reason: outcome.reason };
	} else {
		next.transientCount = 0;
		if (active.operation === "repair") next.repairCount++;
		if (outcome.kind === "applied") {
			next.head = outcome.head;
			next.verification = outcome.verification ? structuredClone(outcome.verification) : null;
			next.action = "waiting-ci";
		} else {
			next.failureCount = outcome.progress
				? 0
				: next.failureFingerprint === outcome.fingerprint
				? next.failureCount + 1
				: 1;
			next.failureFingerprint = outcome.fingerprint;
			next.failureRepairCount = next.repairCount;
			if (next.failureCount >= 2 || next.repairCount >= 3) {
				next.blocker = {
					id: attemptId,
					kind: "human",
					reason: next.failureCount >= 2
						? "Repeated failure without progress"
						: "Repair budget exhausted",
				};
			}
		}
	}
	if (next.repairCount >= 3 && ["repair", "conflict"].includes(next.action) && !next.blocker) {
		next.blocker = { id: attemptId, kind: "human", reason: "Repair budget exhausted" };
	}
	next.status = status(next);
	return next;
}

export function registerProposal(state, attemptId, proposalHead) {
	validateState(state);
	identity(attemptId);
	identity(proposalHead);
	if (state.active?.id !== attemptId) throw new Error("Attempt identity mismatch");
	if (state.active.proposalHead !== null && state.active.proposalHead !== proposalHead) {
		throw new Error("Attempt already has a proposal");
	}
	return { ...state, active: { ...state.active, proposalHead } };
}
