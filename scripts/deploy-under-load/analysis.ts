/**
 * What a load run's measurements say, as plain functions of the measurements: the figures a
 * report is made of and the gates that decide whether the run passed. Nothing here talks to a
 * server, so every rule is held by a test (`analysis.test.ts`).
 */

import type { Sample } from "../overlap";

export type Summary = { count: number; min: number; p50: number; p95: number; max: number };

/** The least, median, 95th percentile and greatest of `values`, rounded to whole milliseconds. */
export function summarize(values: number[]): Summary {
	if (values.length === 0) return { count: 0, min: 0, p50: 0, p95: 0, max: 0 };
	let sorted = [...values].sort((left, right) => left - right);
	let at = (fraction: number) =>
		sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
	return {
		count: sorted.length,
		min: Math.round(sorted[0]!),
		p50: Math.round(at(0.5)),
		p95: Math.round(at(0.95)),
		max: Math.round(sorted.at(-1)!),
	};
}

export type CutLog = {
	/** The phases the old process reported for its cut, in milliseconds. */
	phases: Record<string, number>;
	/** Readiness checks it answered not ready in its unready window; undefined if it logged none. */
	refused?: number;
	/** Whether it warned that no proxy checked readiness. */
	noProxyCheck: boolean;
	/** Requests it closed without an answer because they outlasted the in-flight bound. */
	abandoned: string[];
};

/** What the old process logged about its cut (`apps/server/src/main.ts`, `handover/cut.ts`). */
export function parseCut(log: string): CutLog {
	let phases: Record<string, number> = {};
	let finished = /chopin: cut finished \(([^)]*)\)/.exec(log);
	for (let [, name, ms] of (finished?.[1] ?? "").matchAll(/(\w+) (\d+) ms/g)) {
		phases[name!] = Number(ms);
	}
	let refused = /chopin: (\d+) readiness check\(s\) answered not ready/.exec(log);
	return {
		phases,
		refused: refused ? Number(refused[1]) : undefined,
		noProxyCheck: /no readiness check was answered/.test(log),
		abandoned: [
			...log.matchAll(/chopin: closing (.+?), still running after \d+ ms, without an answer/g),
		]
			.map(match => match[1]!),
	};
}

/** What the new process logged when it became ready: how long after it took the lease. */
export function parseReady(
	log: string,
): { afterLeaseMs: number; phases: Record<string, number> } | undefined {
	let match = /chopin: ready (\d+) ms after taking the writer lease \(([^)]*)\)/.exec(log);
	if (!match) return undefined;
	let phases: Record<string, number> = {};
	for (let [, name, ms] of match[2]!.matchAll(/(\w+) (\d+) ms/g)) phases[name!] = Number(ms);
	return { afterLeaseMs: Number(match[1]), phases };
}

export type EditCheck = {
	marker: string;
	typed: number;
	/** Tokens the client typed that the stored document does not hold. */
	lost: string[];
	/** Tokens the stored document holds more than once. */
	duplicated: string[];
	/** Whether the tokens that are there are in the order they were typed. */
	ordered: boolean;
};

/**
 * Every client types tokens into a paragraph of its own, which starts with its marker. The stored
 * document must hold each token it typed exactly once and in order: an update the server
 * acknowledged, and one still in the client's outbox when the run ended, are both among them.
 */
export function checkEdits(source: string, typed: Record<string, string[]>): EditCheck[] {
	let paragraphs = new Map<string, string[]>();
	for (let block of source.split(/\n{2,}/)) {
		let [marker, ...words] = block.trim().split(/\s+/);
		if (marker) paragraphs.set(marker, words);
	}
	return Object.entries(typed).map(([marker, tokens]) => {
		let held = paragraphs.get(marker) ?? [];
		let counts = new Map<string, number>();
		for (let word of held) counts.set(word, (counts.get(word) ?? 0) + 1);
		let present = held.filter(word => tokens.includes(word));
		let expected = tokens.filter(token => counts.has(token));
		return {
			marker,
			typed: tokens.length,
			lost: tokens.filter(token => !counts.has(token)),
			duplicated: [...counts].filter(([word, count]) => tokens.includes(word) && count > 1).map((
				[word],
			) => word),
			ordered: present.length === expected.length
				&& present.every((word, index) => word === expected[index]),
		};
	});
}

export type RequestKind = "composer" | "invoke" | "system" | "comment" | "draft";

/** A Planner request the run made, and how it was answered. */
export type Request = {
	kind: RequestKind;
	document: string;
	/** What the request carries for the backend to quote back; a draft carries none. */
	tag?: string;
	/** Whether the server acknowledged it, and whether it said the turn is queued. */
	acknowledged: boolean;
	queued?: boolean;
	/** The acknowledgement named a refusal rather than a queue. */
	refusal?: string;
	retries: number;
	sentAt: number;
	ackedAt?: number;
};

export type Row = { document: string; kind: string; state: string };
export type Prompt = { document: string; tag?: string };

export type TurnCheck = {
	/** Requests acknowledged, by kind. */
	acknowledged: Record<string, number>;
	/** Requests refused or never acknowledged, with why. */
	unacknowledged: string[];
	/** Tagged requests whose prompt reached a backend not exactly once, with how many times. */
	misdelivered: Array<{ tag: string; times: number }>;
	/** Documents whose turns that began (saved rows that ended or were interrupted) differ from the prompts received. */
	turnsDiffer: Array<{ document: string; rows: number; prompts: number }>;
	/** Rows by kind and state. */
	rows: Record<string, Record<string, number>>;
	/** Rows left waiting or started when the run ended. */
	unsettled: number;
	cancelled: number;
	interrupted: number;
};

/**
 * Whether everything a person was told was queued was started exactly once, or is accounted for.
 * A row that began a turn (`ended` or `interrupted`) is one prompt at a backend; no request is
 * quoted twice, none that was acknowledged is missing, and nothing is left waiting.
 */
export function checkTurns(requests: Request[], rows: Row[], prompts: Prompt[]): TurnCheck {
	let acknowledged: Record<string, number> = {};
	let unacknowledged: string[] = [];
	for (let request of requests) {
		if (request.acknowledged) acknowledged[request.kind] = (acknowledged[request.kind] ?? 0) + 1;
		else {unacknowledged.push(
				`${request.kind} ${request.tag ?? ""} ${request.refusal ?? "no answer"}`.trim(),
			);}
	}
	let received = new Map<string, number>();
	for (let prompt of prompts) {
		if (prompt.tag) received.set(prompt.tag, (received.get(prompt.tag) ?? 0) + 1);
	}
	let misdelivered = requests
		.filter(request => request.acknowledged && request.tag)
		.flatMap(request => {
			let times = received.get(request.tag!) ?? 0;
			return times === 1 ? [] : [{ tag: request.tag!, times }];
		});
	let byKind: Record<string, Record<string, number>> = {};
	let began = new Map<string, number>();
	for (let row of rows) {
		byKind[row.kind] ??= {};
		byKind[row.kind]![row.state] = (byKind[row.kind]![row.state] ?? 0) + 1;
		if (row.state === "ended" || row.state === "interrupted") {
			began.set(row.document, (began.get(row.document) ?? 0) + 1);
		}
	}
	let delivered = new Map<string, number>();
	for (let prompt of prompts) {
		delivered.set(prompt.document, (delivered.get(prompt.document) ?? 0) + 1);
	}
	let turnsDiffer = [...new Set([...began.keys(), ...delivered.keys()])]
		.map(document => ({
			document,
			rows: began.get(document) ?? 0,
			prompts: delivered.get(document) ?? 0,
		}))
		.filter(entry => entry.rows !== entry.prompts);
	let count = (state: string) => rows.filter(row => row.state === state).length;
	return {
		acknowledged,
		unacknowledged,
		misdelivered,
		turnsDiffer,
		rows: byKind,
		unsettled: count("waiting") + count("started"),
		cancelled: count("cancelled"),
		interrupted: count("interrupted"),
	};
}

/** How far past the release a request the old process closed may still have been failing. */
const RELEASE_SLACK_MS = 500;

/**
 * Which of the requests the proxy did not answer 2xx are the one exception the cut allows: a
 * request still running at the in-flight bound, whose connection the old process closed without
 * an answer. A failure is that request only when it is the same method and path as one the old
 * process logged closing, it is not a GET (the proxy tries a GET again on the new process), the
 * proxy answered it 502 or not at all, and it ended while the old process was cutting, from the
 * moment it said it was stopping to just after the release. Each closed request explains at most
 * one failure, so a second failure of the same kind, or any other, is not excused by it.
 */
export function excuseFailures(
	failures: Sample[],
	abandoned: string[],
	window: { from: number; to: number },
): { excused: Sample[]; unexplained: Sample[] } {
	let open = [...abandoned];
	let excused: Sample[] = [];
	let unexplained: Sample[] = [];
	for (let failure of [...failures].sort((left, right) => left.endedAt - right.endedAt)) {
		let name = `${failure.method} ${failure.path.split("?")[0]}`;
		let match = failure.method !== "GET"
				&& (failure.status === undefined || failure.status === 502)
				&& failure.endedAt >= window.from
				&& failure.endedAt <= window.to + RELEASE_SLACK_MS
			? open.indexOf(name)
			: -1;
		if (match === -1) {
			unexplained.push(failure);
			continue;
		}
		open.splice(match, 1);
		excused.push(failure);
	}
	return { excused, unexplained };
}

/** How a build that ran across the deploys ended, as Chopin reports it. */
export type BuildOutcome = {
	state: string;
	error?: string;
	/** What the build reported for each task: how it ended, and the pull request it opened. */
	tasks: Array<{ id: string; state: string; pullRequest?: string }>;
	/** The tasks the build was given, which every one of must have been reported. */
	expected: string[];
	/** The pull requests the finished build delivered, which is one for each task. */
	pullRequests: number;
};

type Progress = { tasks: Array<{ id: string; state: string; pullRequest?: { url: string } }> };

/** The part of the snapshot Chopin serves for a document's implementation that says how a build went. */
export type BuildSnapshot = {
	build?: { state: string; error?: string };
	/** What the build reported: while it runs, and once it has ended, the last run's. */
	lifecycle?: { activity?: Progress; history?: Array<{ progress: Progress }> };
};

/** How a build ended, from the snapshot, given the tasks it was meant to carry out. */
export function outcomeOf(snapshot: BuildSnapshot, expected: string[]): BuildOutcome {
	let progress = snapshot.lifecycle?.activity ?? snapshot.lifecycle?.history?.at(-1)?.progress;
	let tasks = (progress?.tasks ?? []).map(task => ({
		id: task.id,
		state: task.state,
		...(task.pullRequest ? { pullRequest: task.pullRequest.url } : {}),
	}));
	return {
		state: snapshot.build?.state ?? "missing",
		...(snapshot.build?.error ? { error: snapshot.build.error } : {}),
		tasks,
		expected,
		pullRequests: new Set(tasks.flatMap(task => task.pullRequest ? [task.pullRequest] : [])).size,
	};
}

/** What is wrong with how a build ended, if anything: it is Built only when all of this holds. */
export function buildProblems(build: BuildOutcome): string[] {
	let problems: string[] = [];
	if (build.state !== "stopped") problems.push(`it ended ${build.state}, not stopped`);
	if (build.error) problems.push(`it reported an error: ${build.error}`);
	for (let id of build.expected) {
		let task = build.tasks.find(item => item.id === id);
		if (!task) problems.push(`task ${id} was never reported`);
		else if (task.state !== "completed") problems.push(`task ${id} ended ${task.state}`);
		else if (!task.pullRequest) problems.push(`task ${id} has no pull request`);
	}
	if (build.pullRequests !== build.expected.length) {
		problems.push(
			`${build.pullRequests} pull request(s) delivered for ${build.expected.length} task(s)`,
		);
	}
	return problems;
}

export type Gate = { name: string; passed: boolean; detail: string };

export type Measures = {
	budgetMs: number;
	/** What the design allows a tab before it says anything, which is stricter than the tab's own. */
	graceMs: number;
	/** How long a tab says nothing about a restart it was told of: its own rule, which the gate holds to. */
	quietMs: number;
	maxGapMs: number;
	handOvers: Array<{
		exit: number | null;
		gapMs?: number;
		/** The requests through the proxy that were not answered 2xx. */
		failed: Sample[];
		/** The requests the old process logged closing without an answer, at its in-flight bound. */
		closedByCut: string[];
		/** From the old process saying it was stopping to its release, on the clock of the samples. */
		cutWindow: { from: number; to: number };
		readinessRefused?: number;
		noProxyCheck: boolean;
		/** The longest a client was without its document. */
		longestLossMs: number;
		/** Clients a tab would have shown a notice for: past the quiet of a restart, or the grace of a loss. */
		notices: number;
		/** Reconnects that took longer than the design's grace, whether or not a tab would say so. */
		pastGrace: number;
		resets: number;
		plannerMisses: number;
	}>;
	edits: EditCheck[];
	turns: TurnCheck;
	mcp: { calls: number; failures: number };
	connector: { withdrawn: number };
	build?: BuildOutcome;
	api: { calls: number; failures: number };
};

/** The release gates of the design's deploy-under-load test, and the budget. */
export function gates(measures: Measures): Gate[] {
	let { handOvers, edits, turns } = measures;
	let list: Gate[] = [];
	let gate = (name: string, passed: boolean, detail: string) => list.push({ name, passed, detail });
	gate(
		"every hand-over ended with the old process exiting 0",
		handOvers.every(item => item.exit === 0),
		`exit codes ${handOvers.map(item => item.exit).join(", ")}`,
	);
	gate(
		`first request served within ${measures.maxGapMs} ms of the release (design budget ${measures.budgetMs} ms)`,
		handOvers.every(item => item.gapMs !== undefined && item.gapMs <= measures.maxGapMs),
		`gaps ${handOvers.map(item => item.gapMs ?? "never").join(", ")} ms, worst ${
			worst(handOvers.map(item => item.gapMs))
		} ms`,
	);
	let explained = handOvers.map(item =>
		excuseFailures(item.failed, item.closedByCut, item.cutWindow)
	);
	gate(
		"no request through the proxy was refused, apart from one still running at the in-flight bound",
		explained.every(item => item.unexplained.length === 0),
		`${sum(handOvers.map(item => item.failed.length))} not answered 2xx, ${
			sum(explained.map(item => item.excused.length))
		} of them a request the cut closed; ${
			sum(handOvers.map(item => item.closedByCut.length))
		} closed by a cut${
			explained.some(item => item.unexplained.length > 0)
				? `; unexplained: ${
					explained.flatMap(item => item.unexplained).slice(0, 5).map(failure =>
						`${failure.method} ${failure.path} ${failure.status ?? "no answer"}`
					).join(", ")
				}`
				: ""
		}`,
	);
	gate(
		`no client was without its document longer than a tab waits before saying so (${measures.quietMs} ms for a restart it was told of, ${measures.graceMs} ms otherwise)`,
		handOvers.every(item => item.notices === 0),
		`${sum(handOvers.map(item => item.notices))} notice(s), longest loss ${
			Math.max(0, ...handOvers.map(item => item.longestLossMs))
		} ms; ${
			sum(handOvers.map(item => item.pastGrace))
		} reconnect(s) past the design's ${measures.graceMs} ms grace, which is not gated`,
	);
	gate(
		"no client's document was replaced under it",
		handOvers.every(item => item.resets === 0),
		`${sum(handOvers.map(item => item.resets))} replaced`,
	);
	gate(
		"every word typed is in the stored document exactly once, in order",
		edits.every(item => item.lost.length === 0 && item.duplicated.length === 0 && item.ordered),
		`${sum(edits.map(item => item.typed))} typed by ${edits.length} clients, ${
			sum(edits.map(item => item.lost.length))
		} lost, ${sum(edits.map(item => item.duplicated.length))} duplicated, ${
			edits.filter(item => !item.ordered).length
		} out of order`,
	);
	gate(
		"every Planner request was acknowledged",
		turns.unacknowledged.length === 0,
		turns.unacknowledged.length === 0
			? `${sum(Object.values(turns.acknowledged))} acknowledged`
			: turns.unacknowledged.slice(0, 5).join("; "),
	);
	gate(
		"every acknowledged request reached the Planner exactly once",
		turns.misdelivered.length === 0 && turns.turnsDiffer.length === 0,
		turns.misdelivered.length === 0 && turns.turnsDiffer.length === 0
			? "each tagged request once; turns started equal prompts received for every document"
			: JSON.stringify({
				misdelivered: turns.misdelivered.slice(0, 5),
				turnsDiffer: turns.turnsDiffer.slice(0, 5),
			}),
	);
	gate(
		"no saved request was left waiting, cancelled or interrupted without a reason",
		turns.unsettled === 0 && turns.cancelled === 0,
		`${turns.unsettled} unsettled, ${turns.cancelled} cancelled, ${turns.interrupted} interrupted`,
	);
	gate(
		"every MCP call was answered, through the deploys",
		measures.mcp.failures === 0 && measures.mcp.calls > 0,
		`${measures.mcp.calls} calls, ${measures.mcp.failures} failed`,
	);
	gate(
		"every other API call was answered",
		measures.api.failures === 0,
		`${measures.api.calls} calls, ${measures.api.failures} failed`,
	);
	gate(
		"the machine's Planners were never withdrawn, and no remote Planner missed its window",
		measures.connector.withdrawn === 0 && handOvers.every(item => item.plannerMisses === 0),
		`${measures.connector.withdrawn} withdrawn, ${
			sum(handOvers.map(item => item.plannerMisses))
		} missed`,
	);
	if (measures.build) {
		let problems = buildProblems(measures.build);
		gate(
			"a build that ran across the deploys finished Built, with a pull request for every task",
			problems.length === 0,
			problems.length === 0
				? `stopped, ${measures.build.expected.length} tasks completed, ${measures.build.pullRequests} pull requests`
				: problems.join("; "),
		);
	}
	return list;
}

/** The greatest of `values`, which is infinite if any is missing. */
function worst(values: Array<number | undefined>): number {
	return Math.max(0, ...values.map(value => value ?? Infinity));
}

function sum(values: number[]): number {
	return values.reduce((total, value) => total + value, 0);
}
