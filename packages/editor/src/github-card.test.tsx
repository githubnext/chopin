import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { cardTime, GitHubCard, labelTone, relativeTime } from "./github-card";

import type { GitHubReference, GitHubReferenceSummary } from "@chopin/protocol/github-reference";

const NOW = Date.parse("2026-09-10T12:00:00Z");

let base = {
	owner: "octo-org",
	repository: "score",
	url: "https://github.com/octo-org/score/pull/2",
	author: { login: "octocat", avatarUrl: "https://example.invalid/octocat.png" },
	labels: [{ name: "documents", color: "0e8a16" }],
	comments: 0,
	createdAt: "2026-09-01T12:00:00Z",
	updatedAt: "2026-09-09T12:00:00Z",
	closedAt: null,
};

let merged: GitHubReferenceSummary = {
	...base,
	kind: "pull",
	number: 2,
	title: "Render decision cards",
	state: "merged",
	draft: false,
	mergedAt: "2026-09-09T12:00:00Z",
	closedAt: "2026-09-09T12:00:00Z",
	headBranch: "topic-2",
	baseBranch: "main",
};

let issue: GitHubReferenceSummary = {
	...base,
	kind: "issue",
	number: 5,
	title: "Links lose their context",
	state: "open",
	stateReason: null,
};

let pull: GitHubReference = { owner: "octo-org", repository: "score", kind: "pull", number: 2 };

test("relative times read as people say them", () => {
	expect(relativeTime("2026-09-09T12:00:00Z", NOW)).toBe("yesterday");
	expect(relativeTime("2026-09-07T12:00:00Z", NOW)).toBe("3 days ago");
	expect(relativeTime("2026-09-10T09:00:00Z", NOW)).toBe("3 hours ago");
	expect(relativeTime("2026-09-10T11:59:40Z", NOW)).toBe("just now");
	expect(relativeTime("not a date", NOW)).toBe("");
});

test("the card shows the moment that matters for its state", () => {
	expect(cardTime(merged, NOW)).toBe("merged yesterday");
	expect(cardTime(issue, NOW)).toBe("updated yesterday");
	expect(cardTime({ ...issue, updatedAt: issue.createdAt }, NOW)).toBe("opened last week");
	expect(cardTime({ ...issue, state: "closed", closedAt: "2026-09-07T12:00:00Z" }, NOW))
		.toBe("closed 3 days ago");
});

test("label colours map onto the nearest shared tone", () => {
	expect(labelTone("d73a4a")).toBe("danger");
	expect(labelTone("#fbca04")).toBe("warning");
	expect(labelTone("0e8a16")).toBe("success");
	expect(labelTone("0075ca")).toBe("brand");
	expect(labelTone("a2eeef")).toBe("brand");
	expect(labelTone("7057ff")).toBe("merged");
	expect(labelTone("ededed")).toBe("neutral");
	expect(labelTone("cfd3d7")).toBe("neutral");
	expect(labelTone("nonsense")).toBe("neutral");
});

test("a pull request shows its head branch and never its labels", () => {
	let html = renderToStaticMarkup(
		<GitHubCard
			entry={{ status: "ok", summary: merged }}
			now={NOW}
			reference={pull}
			url={merged.url}
		/>,
	);
	expect(html).toContain('aria-label="Merged pull request"');
	expect(html).toContain("Render decision cards");
	expect(html).toContain("merged yesterday");
	expect(html).toContain("topic-2");
	expect(html).not.toContain("documents");
	expect(html).not.toContain("main<");
	expect(html.indexOf("octocat<")).toBeLessThan(html.indexOf("topic-2"));
});

test("an issue shows its labels last, after the author", () => {
	let html = renderToStaticMarkup(
		<GitHubCard
			entry={{ status: "ok", summary: issue }}
			now={NOW}
			reference={{ ...pull, kind: "issue", number: 5 }}
			url={issue.url}
		/>,
	);
	expect(html).toContain('aria-label="Open issue"');
	expect(html).toContain('data-tone="success"');
	expect(html.indexOf("octocat<")).toBeLessThan(html.indexOf("documents"));
});

test("loading and no access keep the card's layout", () => {
	expect(
		renderToStaticMarkup(
			<GitHubCard entry={{ status: "loading" }} reference={pull} url="https://github.com" />,
		),
	).toContain('aria-busy="true"');
	let html = renderToStaticMarkup(
		<GitHubCard
			entry={{ status: "unavailable" }}
			reference={{ ...pull, owner: "acme", repository: "private", number: 412 }}
			url="https://github.com/acme/private/pull/412"
		/>,
	);
	expect(html).toContain("private <span");
	expect(html).toContain("#412");
	expect(html).toContain("Chopin can’t read this repository.");
	expect(html).toContain('href="https://github.com/acme/private/pull/412"');
});
