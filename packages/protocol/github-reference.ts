export type GitHubReferenceKind = "pull" | "issue";

export type GitHubReference = {
	owner: string;
	repository: string;
	kind: GitHubReferenceKind;
	number: number;
};

export type GitHubReferenceAuthor = {
	login: string;
	avatarUrl: string;
};

export type GitHubReferenceLabel = {
	name: string;
	color: string;
};

type GitHubReferenceSummaryBase = {
	owner: string;
	repository: string;
	number: number;
	url: string;
	title: string;
	author: GitHubReferenceAuthor | null;
	labels: GitHubReferenceLabel[];
	comments: number;
	createdAt: string;
	updatedAt: string;
	closedAt: string | null;
};

export type GitHubPullRequestSummary = GitHubReferenceSummaryBase & {
	kind: "pull";
	state: "open" | "closed" | "merged";
	draft: boolean;
	mergedAt: string | null;
	headBranch: string;
	baseBranch: string;
};

export type GitHubIssueSummary = GitHubReferenceSummaryBase & {
	kind: "issue";
	state: "open" | "closed";
	/** Present only for a closed issue. */
	stateReason: "completed" | "not_planned" | null;
};

export type GitHubReferenceSummary = GitHubPullRequestSummary | GitHubIssueSummary;

export type GitHubReferenceResult =
	| { status: "ok"; summary: GitHubReferenceSummary }
	| { status: "unavailable" }
	| { status: "rate-limited" };

export type GitHubReferencesResponse = {
	references: Record<string, GitHubReferenceResult>;
};

export const MAX_GITHUB_REFERENCES = 20;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPOSITORY = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const NUMBER = /^[1-9]\d{0,9}$/;
const PULL_SUFFIX = /^(?:\/(?:files|commits|checks|changes))?\/?$/;
const KEY = /^([^/]+)\/([^/]+)\/(pull|issues)\/([^/]+)$/;

function reference(
	owner: string,
	repository: string,
	segment: string,
	number: string,
): GitHubReference | undefined {
	if (!OWNER.test(owner) || !REPOSITORY.test(repository) || !NUMBER.test(number)) {
		return undefined;
	}
	let value = Number(number);
	if (value > 2_147_483_647) return undefined;
	return { owner, repository, kind: segment === "pull" ? "pull" : "issue", number: value };
}

/** Recognizes a github.com pull request or issue URL; anything else is not a reference. */
export function parseGitHubReference(value: string): GitHubReference | undefined {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
	if (url.username || url.password || url.port) return undefined;
	if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return undefined;
	let match = /^\/([^/]+)\/([^/]+)\/(pull|issues)\/([^/]+)(\/.*)?$/.exec(url.pathname);
	if (!match) return undefined;
	let suffix = match[5] ?? "";
	if (match[3] === "pull" ? !PULL_SUFFIX.test(suffix) : suffix !== "" && suffix !== "/") {
		return undefined;
	}
	return reference(match[1]!, match[2]!, match[3]!, match[4]!);
}

/** The compact `owner/repository/pull/12` form used to request summaries. */
export function gitHubReferenceKey(value: GitHubReference): string {
	let segment = value.kind === "pull" ? "pull" : "issues";
	return `${value.owner}/${value.repository}/${segment}/${value.number}`;
}

export function parseGitHubReferenceKey(value: string): GitHubReference | undefined {
	let match = KEY.exec(value);
	return match ? reference(match[1]!, match[2]!, match[3]!, match[4]!) : undefined;
}

export function gitHubReferenceUrl(value: GitHubReference): string {
	return `https://github.com/${gitHubReferenceKey(value)}`;
}
