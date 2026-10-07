import { expect, test } from "bun:test";
import { routingLabels, selectIssues } from "./select.mjs";

let repository = "githubnext/chopin";
let external = {
	number: 149,
	title: "Add a contributing guide",
	body: "Clarify contribution expectations",
	state: "open",
	locked: false,
	created_at: "2026-09-05T00:00:00Z",
	author_association: "NONE",
	user: { login: "contributor", type: "User" },
	labels: [],
};

function fixture(issues = [external], comments: Record<number, unknown[]> = {}) {
	let reads: string[] = [];
	let gh = (path: string) => {
		reads.push(path);
		if (path.includes("/comments?")) {
			let number = Number(path.split("/issues/")[1]!.split("/")[0]);
			return [comments[number] ?? []];
		}
		if (path.includes("?state=open")) return issues.map((issue) => [issue]);
		let number = Number(path.split("/issues/")[1]);
		return [issues.find((issue) => issue.number === number)];
	};
	return { gh, reads };
}

test("prioritizes oldest external reports across pages and caps each run at five", () => {
	let internal = { ...external, number: 1, author_association: "MEMBER", created_at: "2020-01-01" };
	let issues = [
		internal,
		...Array.from({ length: 7 }, (_, index) => ({
			...external,
			number: index + 10,
			created_at: `2026-09-${String(10 - index).padStart(2, "0")}`,
		})),
	];
	let { gh } = fixture(issues);
	expect(selectIssues(repository, {}, gh).map((issue) => issue.number)).toEqual([
		16,
		15,
		14,
		13,
		12,
	]);
});

test("ignores closed, locked, bot, PR, spam, and opted-out issues", () => {
	let issues = [
		{ ...external, state: "closed" },
		{ ...external, locked: true },
		{ ...external, user: { login: "bot", type: "Bot" } },
		{ ...external, pull_request: {} },
		{ ...external, labels: [{ name: "spam" }] },
		{ ...external, labels: [{ name: "no-triage" }] },
	];
	let { gh, reads } = fixture(issues);
	expect(selectIssues(repository, {}, gh)).toEqual([]);
	expect(reads).toHaveLength(1);
});

test("existing ordinary labels do not hide untriaged external issues", () => {
	let { gh } = fixture([{ ...external, labels: [{ name: "bug" }] }]);
	expect(selectIssues(repository, {}, gh)).toHaveLength(1);
});

test("labels alone complete internal bookmark catch-up, but edits can retriage", () => {
	for (let label of routingLabels) {
		let issue = { ...external, author_association: "MEMBER", labels: [{ name: label }] };
		let { gh } = fixture([issue]);
		expect(selectIssues(repository, {}, gh)).toEqual([]);
		expect(selectIssues(repository, { issue }, gh)[0]?.internal).toBe(true);
	}
});

test("only a genuine github-actions bot receipt suppresses repeat triage", () => {
	let { gh } = fixture();
	let marker = selectIssues(repository, {}, gh)[0]!.marker;
	let receipt = { body: marker, user: { login: "github-actions[bot]", type: "Bot" } };
	let acknowledged = fixture([external], { 149: [receipt] });
	expect(selectIssues(repository, {}, acknowledged.gh)).toEqual([]);
	let forged = fixture([external], { 149: [{ ...receipt, user: external.user }] });
	expect(selectIssues(repository, {}, forged.gh)).toHaveLength(1);
});

test("bot activity and labels do not change a receipt; human replies and edits do", () => {
	let { gh } = fixture();
	let marker = selectIssues(repository, {}, gh)[0]!.marker;
	let receipt = { body: marker, user: { login: "github-actions[bot]", type: "Bot" } };
	let labeled = { ...external, labels: [{ name: "triage/human-response" }] };
	let unchanged = fixture([labeled], { 149: [receipt] });
	expect(selectIssues(repository, {}, unchanged.gh)).toEqual([]);
	let replied = fixture([labeled], {
		149: [receipt, {
			id: 2,
			body: "Here is a reproduction",
			updated_at: "2026-10-07",
			user: external.user,
		}],
	});
	expect(selectIssues(repository, {}, replied.gh)[0]?.marker).not.toBe(marker);
	let edited = fixture([{ ...labeled, body: "Updated details" }], { 149: [receipt] });
	expect(selectIssues(repository, {}, edited.gh)[0]?.marker).not.toBe(marker);
});

test("event runs select only their issue and never process PR comments or bots", () => {
	let { gh, reads } = fixture([external, { ...external, number: 150 }]);
	expect(selectIssues(repository, { issue: external }, gh).map((issue) => issue.number)).toEqual([
		149,
	]);
	expect(reads[0]).toBe(`repos/${repository}/issues/149`);
	let blocked = fixture();
	expect(selectIssues(repository, { issue: { pull_request: {} } }, blocked.gh)).toEqual([]);
	expect(selectIssues(repository, { comment: { user: { type: "Bot" } } }, blocked.gh)).toEqual([]);
	expect(blocked.reads).toEqual([]);
});
