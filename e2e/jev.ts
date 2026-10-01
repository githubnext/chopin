/** Fake only TypeSafe HTTP. The real adapter, policy, room and wire still run. */
import { join } from "node:path";

import type { JevQuestion, JevRequest } from "../apps/server/src/conversation-plan/jev";

let network = globalThis.fetch;
let failures = new Map<string, number>();

type Role =
	| "question"
	| "option"
	| "reason"
	| "constraint"
	| "support"
	| "objection"
	| "resolution"
	| "reopening"
	| "none";
type Scenario = {
	role: Role;
	optionText?: string;
	roles?: Role[];
	triageRoles?: Role[];
	owned?: boolean[];
	triageOnly?: boolean;
	directNewChoice?: boolean;
	significance?: number;
	target?: {
		preceding?: readonly string[];
		recent?: readonly string[];
	};
	delay?: boolean;
	failTimes?: number;
	material?: boolean;
	purpose?: boolean;
	agree?: boolean;
	spikeChoice?: boolean;
};

const SCENARIOS: Record<string, Scenario> = {
	"Which editor should we use?": { role: "question", purpose: true },
	"Lexical": { role: "option" },
	"Monaco": { role: "option" },
	"I'd pick Lexical for the spike;": {
		role: "support",
		triageRoles: ["support"],
		optionText: "Lexical",
		spikeChoice: true,
	},
	"yep, Lexical for the spike. not a final library call yet.": {
		role: "support",
		roles: ["support", "none"],
		triageRoles: ["support"],
		owned: [true, false],
		optionText: "Lexical",
		agree: true,
	},
	"yep, Lexical for the spike.": {
		role: "support",
		optionText: "Lexical",
		agree: true,
	},
	"not a final library call yet.": { role: "none" },
	"Should we ship a small pilot?": { role: "question", purpose: true },
	"Which service should send notification emails?": { role: "question", purpose: true },
	"Should our team use an AI coding agent?": { role: "question", purpose: true },
	"Should we store uploaded files in Amazon S3 or on a local disk?": {
		role: "question",
		purpose: true,
	},
	"Amazon S3": { role: "option" },
	"on a local disk": { role: "option" },
	"We should use Postmark for notification emails.": {
		role: "option",
		directNewChoice: true,
	},
	"Start with a small pilot.": { role: "option" },
	"Start with a small pilot. **Keep the pilot accessible to keyboard-only users.**": {
		role: "option",
		roles: ["option", "constraint"],
	},
	"A small pilot would catch setup problems early.": { role: "reason" },
	"Keep the pilot accessible to keyboard-only users.": { role: "constraint" },
	"**Keep the pilot accessible to keyboard-only users.**": { role: "constraint" },
	"SQS would reduce operations for us.": { role: "none", significance: 2 },
	"Copilot or bring-your-own API keys would simplify agent access for our team.": {
		role: "none",
		significance: 2,
	},
	"I support the small pilot.": { role: "support" },
	"Sounds good to me.": {
		role: "support",
		agree: true,
		target: { preceding: [""], recent: ["Let's just go with a small pilot."] },
	},
	"What about agent access?": {
		role: "question",
		target: {
			preceding: [
				"Sounds good to me. ",
				"Sounds good to me. I am concerned that a small pilot will exclude keyboard-only users. ",
			],
			recent: ["Let's just go with a small pilot."],
		},
	},
	"Copilot?": {
		role: "none",
		target: {
			preceding: ["Sounds good to me. What about agent access? "],
			recent: ["Let's just go with a small pilot."],
		},
	},
	"I am concerned that a small pilot will exclude keyboard-only users.": {
		role: "objection",
		material: true,
		target: {
			preceding: ["Sounds good to me. "],
			recent: ["Let's just go with a small pilot."],
		},
	},
	"Sounds good to me. What about agent access? Copilot? BYO API keys?": {
		role: "support",
		triageRoles: ["support", "question"],
		owned: [true, true, true],
		triageOnly: true,
	},
	"Sounds good to me. I am concerned that a small pilot will exclude keyboard-only users. What about agent access?":
		{
			role: "support",
			triageRoles: ["support", "objection", "question"],
			owned: [true, true, true],
			triageOnly: true,
		},
	"Let's do a small pilot.": { role: "resolution", optionText: "Start with a small pilot." },
	"Let's just go with a small pilot.": {
		role: "resolution",
		optionText: "Start with a small pilot.",
	},
	"Let's just go with Ship to everyone.": {
		role: "resolution",
		optionText: "Ship to everyone",
	},
	"I object: a small pilot will exclude keyboard-only users.": {
		role: "objection",
		material: true,
	},
	"Let's revisit the small pilot decision.": { role: "reopening" },
	"Maybe that?": { role: "none" },
	"Thanks, I'll review the draft.": { role: "none" },
	"Could we test with one team first?": { role: "question", failTimes: 1 },
	"Could we retry a flaky question twice?": { role: "question", failTimes: 2 },
	"Should we test with one team first?": { role: "question", delay: true },
};

function choice(question: Extract<JevQuestion, { type: "choice" }>, wanted: string) {
	let keys = Object.keys(question.criteria);
	if (!keys.includes(wanted)) throw new Error(`Jev fixture missing choice ${wanted}`);
	let probabilities = Object.fromEntries(keys.map(key => [
		key,
		key === wanted ? 0.96 : 0.04 / (keys.length - 1),
	]));
	return { type: "choice", choice: wanted, confidence: 0.96, probabilities };
}

function score(question: Extract<JevQuestion, { type: "score" }>, level: number) {
	let probabilities = Object.fromEntries(question.criteria.map((_, index) => [
		String(index),
		index === level ? 1 : 0,
	]));
	return {
		type: "score",
		score: level,
		confidence: 0.96,
		legend: Object.fromEntries(question.criteria.map((label, index) => [String(index), label])),
		probabilities,
	};
}

function answers(request: JevRequest, scenario: Scenario) {
	let state = request.state as {
		threads: Array<{ id: string; options: Array<{ id: string; text: string }> }>;
	};
	let thread = state.threads[0];
	let option = scenario.optionText
		? thread?.options.find(item => item.text === scenario.optionText)
		: thread?.options[0];
	let answer: Record<string, unknown> = {};
	let triage = "new_question" in request.questions;
	for (let [id, question] of Object.entries(request.questions)) {
		let candidate = /^c(\d+)_/.exec(id);
		let role = candidate
			? scenario.directNewChoice
				? "resolution"
				: scenario.roles?.[Number(candidate[1])] ?? scenario.role
			: scenario.role;
		let triageRoles = scenario.triageRoles ?? [scenario.role];
		let hasRole = (wanted: Role) => triage ? triageRoles.includes(wanted) : role === wanted;
		let relevant = role !== "none";
		let flags: Record<string, boolean> = {
			enough_purpose: !!scenario.purpose,
			new_question: hasRole("question"),
			new_option: hasRole("option") || (!!scenario.directNewChoice && !triage),
			reason: hasRole("reason"),
			constraint: hasRole("constraint"),
			evidence: false,
			assumption: false,
			support: hasRole("support") || (!!scenario.directNewChoice && !triage),
			objection: hasRole("objection"),
			correction: false,
			explicit_resolution: hasRole("resolution"),
			reopening: hasRole("reopening"),
			raises_again: false,
			agrees_with_settle: !!scenario.agree,
			planner_request: false,
			planning_substance: hasRole("reason") || hasRole("constraint") || hasRole("objection")
				|| (!!scenario.directNewChoice && !triage),
			duplicate: false,
			material_objection: !!scenario.material,
			owned_unretracted: candidate ? scenario.owned?.[Number(candidate[1])] ?? true : false,
		};
		let selectedThread = role === "question" ? "new" : thread?.id ?? "none";
		let selectedOption = scenario.directNewChoice && !triage
			? "new"
			: ["reason", "support", "objection", "resolution"].includes(role)
			? option?.id ?? "none"
			: role === "option"
			? "new"
			: "none";
		let selectedRelation = role === "objection"
			? "challenges"
			: role === "constraint"
			? "qualifies"
			: relevant
			? "supports"
			: "unrelated";
		let key = id.replace(/^c\d+_/, "");
		if (question.type === "noul") {
			answer[id] = { type: "noul", noul: flags[key] ? 0.97 : 0.03 };
		} else if (question.type === "score") {
			let level = key === "significance"
				? scenario.significance ?? (relevant ? 2 : 0)
				: key === "commitment"
				? role === "resolution" ? 3 : 0
				: key === "novelty"
				? relevant ? 2 : 0
				: 0;
			answer[id] = score(question, level);
		} else {
			let selected = key === "act"
				? scenario.spikeChoice
					? "proposal"
					: role === "question"
					? "question"
					: role === "option"
					? "proposal"
					: role === "resolution"
					? "commitment"
					: role === "none"
					? "other"
					: "evaluation"
				: key === "role"
				? role
				: key === "thread" || key === "thread_target"
				? selectedThread
				: key === "option"
				? selectedOption
				: key === "chosen_option"
				? role === "resolution" || scenario.spikeChoice || scenario.agree
					? selectedOption
					: "none"
				: key === "relation"
				? selectedRelation
				: "none";
			answer[id] = choice(question, selected);
		}
	}
	return answer;
}

function validateIsolatedTarget(request: JevRequest, scenario: Scenario): void {
	if ("new_question" in request.questions) return;
	if (
		scenario.triageOnly
		&& Object.keys(request.questions).some(key => /^c\d+_(?!owned_unretracted$)/.test(key))
	) {
		throw new Error("mixed fixture targeting must issue one request per candidate");
	}
	if (!scenario.target) return;
	let state = request.state as {
		current?: { text?: string };
		preceding?: string;
		recent?: Array<{ text?: string }>;
		candidates?: Array<{ quote?: string }>;
	};
	let indexes = [
		...new Set(
			Object.keys(request.questions).flatMap(key => {
				let match = /^c(\d+)_/.exec(key);
				return match ? [Number(match[1])] : [];
			}),
		),
	];
	if (indexes.length !== 1) throw new Error("mixed fixture targeting must isolate one candidate");
	let index = indexes[0]!;
	if (!Object.keys(request.questions).every(key => key.startsWith(`c${index}_`))) {
		throw new Error("mixed fixture targeting leaked another candidate");
	}
	if (
		state.current?.text !== state.candidates?.at(-1)?.quote
		|| state.candidates?.length !== index + 1
	) {
		throw new Error("mixed fixture targeting did not preserve the exact candidate span");
	}
	if (scenario.target.preceding && !scenario.target.preceding.includes(state.preceding ?? "")) {
		throw new Error("mixed fixture targeting did not retain bounded preceding context");
	}
	for (let text of scenario.target.recent ?? []) {
		if (!state.recent?.some(entry => entry.text === text)) {
			throw new Error("mixed fixture targeting lost conversation history");
		}
	}
}

async function waitForRelease(signal?: AbortSignal): Promise<void> {
	let directory = process.env.E2E_JEV_CONTROL_DIR;
	if (!directory) throw new Error("Jev fixture control directory is missing");
	while (!(await Bun.file(join(directory, "delayed-question")).exists())) {
		if (signal?.aborted) throw signal.reason;
		await Bun.sleep(15);
	}
}

let fake = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
	let url = new URL(input instanceof Request ? input.url : input);
	if (url.hostname !== "api.typesafe.ai") return network(input, init);
	if (url.href !== "https://api.typesafe.ai/v1/systemone" || init?.method !== "POST") {
		return Response.json({ error: "unexpected TypeSafe request" }, { status: 501 });
	}
	let headers = new Headers(init.headers);
	if (headers.get("authorization") !== "Bearer e2e-jev-only") {
		return Response.json({ error: "unexpected TypeSafe credentials" }, { status: 401 });
	}
	let request = JSON.parse(String(init.body)) as JevRequest & { model: string };
	let current = (request.state as { current?: { id?: string; text?: string } }).current;
	let scenario = current?.text && SCENARIOS[current.text];
	if (!current?.id || !scenario) {
		return Response.json({ error: "unknown Jev fixture scenario" }, { status: 501 });
	}
	if (scenario.delay) await waitForRelease(init.signal ?? undefined);
	try {
		validateIsolatedTarget(request, scenario);
	} catch (error) {
		return Response.json({
			error: error instanceof Error ? error.message : "invalid fixture request",
		}, {
			status: 422,
		});
	}
	let failureCount = failures.get(current.id) ?? 0;
	if (failureCount < (scenario.failTimes ?? 0)) {
		failures.set(current.id, failureCount + 1);
		return Response.json({ error: "injected failure" }, { status: 503 });
	}
	return Response.json({
		model: "jev-e2e-fixture",
		answers: answers(request, scenario),
		usage: { input_tokens: 10, output_tokens: 5 },
	});
};

globalThis.fetch = Object.assign(fake, { preconnect: network.preconnect });
