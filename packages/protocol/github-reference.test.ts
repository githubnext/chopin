import { describe, expect, it } from "bun:test";

import {
	gitHubReferenceKey,
	gitHubReferenceUrl,
	parseGitHubReference,
	parseGitHubReferenceKey,
} from "@chopin/protocol/github-reference";

describe("GitHub references", () => {
	it("parses pull request and issue URLs", () => {
		expect(parseGitHubReference("https://github.com/octo-org/score/pull/12")).toEqual({
			owner: "octo-org",
			repository: "score",
			kind: "pull",
			number: 12,
		});
		expect(parseGitHubReference("https://github.com/octo-org/score/issues/5")).toEqual({
			owner: "octo-org",
			repository: "score",
			kind: "issue",
			number: 5,
		});
	});

	it("tolerates common URL decorations", () => {
		for (
			let url of [
				"https://www.github.com/octo-org/score/pull/12",
				"http://github.com/octo-org/score/pull/12/",
				"https://github.com/octo-org/score/pull/12/files",
				"https://github.com/octo-org/score/pull/12/commits",
				"https://github.com/octo-org/score/pull/12#issuecomment-1",
				"https://github.com/octo-org/score/pull/12?diff=split",
				" https://github.com/octo-org/score/pull/12 ",
			]
		) {
			expect(parseGitHubReference(url)?.number).toBe(12);
		}
		expect(parseGitHubReference("https://github.com/octo-org/score/issues/5/")?.kind)
			.toBe("issue");
		expect(parseGitHubReference("https://github.com/octo-org/my.repo/issues/5")?.repository)
			.toBe("my.repo");
	});

	it("rejects anything that is not a github.com pull request or issue", () => {
		for (
			let url of [
				"",
				"not a url",
				"https://gitlab.com/octo-org/score/pull/12",
				"https://github.com.evil.test/octo-org/score/pull/12",
				"https://api.github.com/repos/octo-org/score/pulls/12",
				"https://gist.github.com/octo-org/score/pull/12",
				"https://user:pass@github.com/octo-org/score/pull/12",
				"https://github.com:8443/octo-org/score/pull/12",
				"ftp://github.com/octo-org/score/pull/12",
				"javascript:alert(1)",
				"https://github.com/octo-org/score",
				"https://github.com/octo-org/score/pulls",
				"https://github.com/octo-org/score/pulls/12",
				"https://github.com/octo-org/score/pull/0",
				"https://github.com/octo-org/score/pull/012",
				"https://github.com/octo-org/score/pull/-1",
				"https://github.com/octo-org/score/pull/12a",
				"https://github.com/octo-org/score/pull/99999999999",
				"https://github.com/octo-org/score/pull/12/unknown",
				"https://github.com/octo-org/score/issues/5/files",
				"https://github.com/-octo/score/pull/12",
				"https://github.com/octo-org/../pull/12",
				"https://github.com/octo-org/sc%20ore/pull/12",
			]
		) {
			expect(parseGitHubReference(url)).toBeUndefined();
		}
	});

	it("round-trips the compact request key", () => {
		let pull = parseGitHubReference("https://github.com/octo-org/score/pull/12")!;
		let issue = parseGitHubReference("https://github.com/octo-org/score/issues/5")!;
		expect(gitHubReferenceKey(pull)).toBe("octo-org/score/pull/12");
		expect(gitHubReferenceKey(issue)).toBe("octo-org/score/issues/5");
		expect(parseGitHubReferenceKey("octo-org/score/pull/12")).toEqual(pull);
		expect(parseGitHubReferenceKey("octo-org/score/issues/5")).toEqual(issue);
		expect(gitHubReferenceUrl(issue)).toBe("https://github.com/octo-org/score/issues/5");
		for (
			let key of [
				"octo-org/score/pulls/12",
				"octo-org/score/issue/5",
				"octo-org/score/pull/12/files",
				"/octo-org/score/pull/12",
				"octo-org/../pull/12",
				"__proto__/x/pull/1x",
			]
		) {
			expect(parseGitHubReferenceKey(key)).toBeUndefined();
		}
	});
});
