import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BuildCard, elapsed } from "./run-card";

test("elapsed switches to days instead of printing hundreds of hours", () => {
	expect(elapsed(2)).toBe("2s");
	expect(elapsed(35 * 60)).toBe("35m");
	expect(elapsed(23 * 3600 + 59 * 60)).toBe("23h 59m");
	expect(elapsed(24 * 3600)).toBe("1d 0h");
	expect(elapsed(3 * 86_400 + 4 * 3600)).toBe("3d 4h");
	expect(elapsed(497_550 * 3600)).toBe("20731d 6h");
});

test("a running build's card is unfolded with its task, activity and pull requests, and a queued rebuild says it waits", () => {
	let build = {
		id: "b1",
		kind: "build" as const,
		state: "building" as const,
		done: 1,
		total: 2,
		task: "Prove the contract",
		activity: "Running a command",
		started: new Date(Date.now() - 90_000).toISOString(),
		pullRequests: ["https://github.com/o/r/pull/12"],
	};
	let markup = renderToStaticMarkup(createElement(BuildCard, { build, onShowBuild: () => {} }));
	expect(markup).toContain('aria-label="Running build"');
	let toggles = [...markup.matchAll(/aria-label="([^"]+)"[^>]*data-run-toggle/g)].map(match =>
		match[1]
	);
	expect(toggles).toHaveLength(1);
	expect(toggles[0]).toMatch(/^Build, 1 of 2 tasks, 1m$/);
	expect(markup).toContain("Prove the contract");
	expect(markup).toContain("Running a command");
	expect(markup).toContain('aria-label="Pull request #12"');
	expect(markup).toContain(">Open Build</button>");
	expect(markup.match(/aria-expanded="true"/g)).toHaveLength(1);

	let queued = renderToStaticMarkup(createElement(BuildCard, {
		build: { ...build, kind: "rebuild" as const, state: "queued" as const, task: undefined },
	}));
	expect(queued).toMatch(/aria-label="Building changes, queued, 1m"/);
	expect(queued).not.toContain("Open Build");
});
