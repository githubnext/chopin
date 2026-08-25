import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ComponentType, PropsWithChildren } from "react";

type DraftLayerModule = {
	attachmentBlock?: <Block>(
		resolved: Block,
		offset: number,
		previous: Block | undefined,
	) => Block;
	ResearchDraftRecovery?: ComponentType<{ unresolved: boolean }>;
	ResearchDraftShell?: ComponentType<PropsWithChildren>;
	retainDraftBlock?: <Block>(resolved: Block | undefined, previous: Block | undefined) =>
		| Block
		| undefined;
};

async function draftLayer(): Promise<DraftLayerModule> {
	return await import("./research").catch(() => ({}));
}

async function draftShell(): Promise<ComponentType<PropsWithChildren> | undefined> {
	let Shell = (await draftLayer()).ResearchDraftShell;
	expect(typeof Shell).toBe("function");
	return Shell;
}

describe("research draft layer", () => {
	it("renders the private draft as labelled inline editor chrome", async () => {
		let Shell = await draftShell();
		if (!Shell) return;
		let markup = renderToStaticMarkup(
			createElement(Shell, null, createElement("span", null, "Draft question")),
		);

		expect(markup).toContain('role="region"');
		expect(markup).toContain('aria-label="Research question"');
		expect(markup).not.toContain('role="dialog"');
		expect(markup).toContain("plan-research-draft");
		expect(markup).toContain("Draft question");
	});

	it("keeps the last block attachment while the saved position is unresolved", async () => {
		let retain = (await draftLayer()).retainDraftBlock;
		expect(typeof retain).toBe("function");
		if (!retain) return;
		let previous = { key: "previous" };

		expect(retain(undefined, previous)).toBe(previous);
	});

	it("attaches a zero-offset boundary after the preceding block", async () => {
		let attach = (await draftLayer()).attachmentBlock;
		expect(typeof attach).toBe("function");
		if (!attach) return;
		let previous = { key: "previous" };
		let resolved = { key: "resolved" };

		expect(attach(resolved, 0, previous)).toBe(previous);
		expect(attach(resolved, 1, previous)).toBe(resolved);
		expect(attach(resolved, 0, undefined)).toBe(resolved);
	});

	it("announces that an unresolved saved position cannot yet be placed", async () => {
		let Recovery = (await draftLayer()).ResearchDraftRecovery;
		expect(typeof Recovery).toBe("function");
		if (!Recovery) return;
		let markup = renderToStaticMarkup(createElement(Recovery, { unresolved: true }));

		expect(markup).toContain('role="alert"');
		expect(markup).toContain("cannot yet be placed");
	});
});
