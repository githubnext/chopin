import { hasPendingWork } from "@chopin/protocol/pending-work";
import { entryOf } from "@chopin/protocol/restart";
import { describe, expect, it } from "bun:test";

import { ResearchDraftStore } from "../../../packages/editor/src/research-draft";
import { isNewerBuild, recoverFromPreloadError, RELOAD_GAP_MS } from "./preload-recovery";

import type { Reloading } from "./preload-recovery";

function page(
	options: {
		pending?: boolean | (() => boolean);
		newer?: boolean;
		storage?: "none" | "refusing";
	} = {},
) {
	let values = new Map<string, string>();
	let reloads = 0;
	let clock = 1_000_000;
	let state = { pending: options.pending ?? false, newer: options.newer ?? true };
	let pending = () => typeof state.pending === "function" ? state.pending() : state.pending;
	let storage: Reloading["storage"] = options.storage === "none" ? undefined : {
		getItem: key => {
			if (options.storage === "refusing") throw new Error("storage is blocked");
			return values.get(key) ?? null;
		},
		setItem: (key, value) => {
			if (options.storage === "refusing") throw new Error("storage is blocked");
			values.set(key, value);
		},
	};
	let reloading: Reloading = {
		pending,
		newer: async () => {
			await Promise.resolve();
			return state.newer;
		},
		reload: () => {
			reloads++;
		},
		now: () => clock,
		storage,
	};
	return {
		fail: () => recoverFromPreloadError(reloading),
		state,
		wait: (ms: number) => {
			clock += ms;
		},
		reloads: () => reloads,
	};
}

describe("recoverFromPreloadError", () => {
	it("reloads for a chunk that is gone when the server answers with a new build and the page holds nothing", async () => {
		let tab = page();
		expect(await tab.fail()).toBe(true);
		expect(tab.reloads()).toBe(1);
	});

	it("does not reload while the page holds unsaved work", async () => {
		let tab = page({ pending: true });
		expect(await tab.fail()).toBe(false);
		expect(tab.reloads()).toBe(0);
	});

	it("does not reload while a question typed into the document has not been started", async () => {
		let drafts = new ResearchDraftStore("investigation");
		drafts.open({ top: 1, right: 2, bottom: 3, left: 4, width: 5, height: 6 });
		let tab = page({ pending: hasPendingWork });
		drafts.change("Which index is faster?");
		expect(await tab.fail()).toBe(false);
		expect(tab.reloads()).toBe(0);

		// Nothing typed, or typed and put away, is nothing to lose.
		drafts.change("");
		expect(drafts.unsaved).toBe(false);
	});

	it("does not reload unless the server answers with a new build, which a chunk failing with the server away, or for no deploy at all, does not give", async () => {
		let tab = page({ newer: false });
		expect(await tab.fail()).toBe(false);
		expect(tab.reloads()).toBe(0);
	});

	it("does not reload for work begun while the server was being asked", async () => {
		let tab = page();
		let failing = tab.fail();
		tab.state.pending = true;
		expect(await failing).toBe(false);
		expect(tab.reloads()).toBe(0);
	});

	it("does not reload again for the next failure straight after one", async () => {
		let tab = page();
		expect(await tab.fail()).toBe(true);
		tab.wait(RELOAD_GAP_MS - 1);
		expect(await tab.fail()).toBe(false);
		expect(tab.reloads()).toBe(1);
	});

	it("reloads again once the gap has passed, as for a second deploy in one session", async () => {
		let tab = page();
		await tab.fail();
		tab.wait(RELOAD_GAP_MS);
		expect(await tab.fail()).toBe(true);
		expect(tab.reloads()).toBe(2);
	});

	it("reloads once for several chunks failing together", async () => {
		let tab = page();
		let results = await Promise.all([tab.fail(), tab.fail(), tab.fail()]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(tab.reloads()).toBe(1);
	});

	it("makes no reload it could not remember, so that it cannot loop", async () => {
		for (let storage of ["none", "refusing"] as const) {
			let tab = page({ storage });
			expect(await tab.fail()).toBe(false);
			expect(tab.reloads()).toBe(0);
		}
	});
});

describe("entryOf", () => {
	it("names the build by the entry script its page loads", () => {
		let html = `<!doctype html><html><head><script>window.theme = 1;</script>
			<script type="module" crossorigin src="/assets/index-CS81MqW4.js"></script>
			<link rel="modulepreload" crossorigin href="/assets/vendor-AbCd1234.js"></head></html>`;
		expect(entryOf(html)).toBe("/assets/index-CS81MqW4.js");
		expect(entryOf('<script src="/assets/index-CS81MqW4.js" type="module"></script>')).toBe(
			"/assets/index-CS81MqW4.js",
		);
	});

	it("is undefined for a page that loads none, such as an error page", () => {
		expect(entryOf("")).toBeUndefined();
		expect(entryOf("<html><body>Bad gateway</body></html>")).toBeUndefined();
		expect(entryOf('<script src="/a.js"></script><script type="module">run()</script>'))
			.toBeUndefined();
	});
});

describe("isNewerBuild", () => {
	it("is the server's page being of another build than the one running", () => {
		expect(isNewerBuild("/assets/index-AAAA.js", "/assets/index-BBBB.js")).toBe(true);
		expect(isNewerBuild("/assets/index-AAAA.js", "/assets/index-AAAA.js")).toBe(false);
	});

	it("is never so while either build is unknown", () => {
		expect(isNewerBuild(undefined, "/assets/index-BBBB.js")).toBe(false);
		expect(isNewerBuild("/assets/index-AAAA.js", undefined)).toBe(false);
	});
});
