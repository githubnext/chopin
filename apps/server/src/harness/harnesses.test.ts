import { afterEach, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workflowJournal } from "./atomic/workspace";
import {
	harnesses,
	harnessFor,
	plannerCatalog,
	plannerCommands,
	plannerOfferKnown,
	plannerRanWithoutOffer,
	registerCredential,
	shutdownHarnesses,
} from "./harnesses";
import { attachLink } from "./remote/registry";

import type { AgentLink } from "./remote/link";

afterEach(shutdownHarnesses);

it("selects the tested Copilot SDK, Atomic, and remote harnesses", () => {
	expect(Object.keys(harnesses)).toEqual(["copilot-sdk", "atomic", "remote"]);
	expect(harnessFor({ harness: "copilot-sdk" }).harnessId).toBe("copilot-sdk");
	expect(() => harnessFor({ harness: "not-installed" })).toThrow("Unknown harness: not-installed");
});

it("refuses host-login fallback on public binds but accepts it on loopback", () => {
	for (let host of ["0.0.0.0", "::", "192.168.1.2", "localhost.example"]) {
		expect(() => harnessFor({ harness: "copilot-sdk", harnessAuth: "auto", host }))
			.toThrow("requires a loopback SERVER_HOST");
	}
	for (let host of ["127.0.0.1", "127.42.0.1", "localhost", "::1", "[::1]"]) {
		expect(harnessFor({ harness: "copilot-sdk", harnessAuth: "auto", host }).harnessId)
			.toBe("copilot-sdk");
	}
	expect(harnessFor({ harness: "copilot-sdk", harnessAuth: "direct", host: "0.0.0.0" }).harnessId)
		.toBe("copilot-sdk");
	expect(() => harnessFor({ harness: "unknown", harnessAuth: "auto", host: "127.0.0.1" }))
		.toThrow("Unknown harness: unknown");
});

it("refuses pi, which is no longer a harness", () => {
	expect(() => harnessFor({ harness: "pi", harnessAuth: "ai-gateway", host: "127.0.0.1" }))
		.toThrow("Unknown harness: pi");
});

it("requires an explicit, Atomic-supported auth mode and refuses direct or unknown modes", () => {
	expect(() => harnessFor({ harness: "atomic", host: "127.0.0.1" }))
		.toThrow("HARNESS_AUTH is required for harness atomic");
	for (let harnessAuth of ["direct", "openai", "custom", "bogus"]) {
		expect(() => harnessFor({ harness: "atomic", harnessAuth, host: "127.0.0.1" }))
			.toThrow(`HARNESS_AUTH ${harnessAuth} is not a supported atomic authentication mode`);
	}
	expect(harnessFor({ harness: "atomic", harnessAuth: "auto", host: "::1" }).harnessId)
		.toBe("atomic");
});

it("refuses Atomic's host-login auto mode on a non-loopback bind but accepts ai-gateway", () => {
	for (let host of ["0.0.0.0", "::", "192.168.1.2", "localhost.example"]) {
		expect(() => harnessFor({ harness: "atomic", harnessAuth: "auto", host }))
			.toThrow("HARNESS_AUTH for atomic on a non-loopback SERVER_HOST must be ai-gateway");
	}
	expect(harnessFor({ harness: "atomic", harnessAuth: "ai-gateway", host: "0.0.0.0" }).harnessId)
		.toBe("atomic");
});

it("journals Atomic workflow runs in Chopin's state directory unless the operator names a journal", async () => {
	let previous = {
		state: process.env.XDG_STATE_HOME,
		journal: process.env.ATOMIC_WORKFLOW_JOURNAL_PATH,
	};
	let state = join(tmpdir(), `chopin-state-${crypto.randomUUID()}`);
	let restore = (name: string, value: string | undefined) =>
		value === undefined ? delete process.env[name] : process.env[name] = value;
	try {
		process.env.XDG_STATE_HOME = state;
		delete process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;
		if (process.platform === "linux") {
			expect(workflowJournal()).toBe(join(state, "chopin", "atomic", "workflows.sqlite"));
		}
		// Each Planner session is given its journal; the process environment is left alone.
		harnessFor({ harness: "atomic", harnessAuth: "ai-gateway", host: "0.0.0.0" });
		expect(process.env.ATOMIC_WORKFLOW_JOURNAL_PATH).toBeUndefined();
		await shutdownHarnesses();

		process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = "/srv/atomic/runs.sqlite";
		expect(workflowJournal()).toBe("/srv/atomic/runs.sqlite");
		harnessFor({ harness: "atomic", harnessAuth: "ai-gateway", host: "0.0.0.0" });
		await shutdownHarnesses();
		expect(process.env.ATOMIC_WORKFLOW_JOURNAL_PATH).toBe("/srv/atomic/runs.sqlite");
	} finally {
		await shutdownHarnesses();
		restore("XDG_STATE_HOME", previous.state);
		restore("ATOMIC_WORKFLOW_JOURNAL_PATH", previous.journal);
	}
});

it("accepts the remote harness on any bind without HARNESS_AUTH, and refuses one", () => {
	for (let host of ["0.0.0.0", "::", "192.168.1.2", "127.0.0.1"]) {
		expect(harnessFor({ harness: "remote", host }).harnessId).toBe("remote");
		expect(() => harnessFor({ harness: "remote", harnessAuth: "ai-gateway", host }))
			.toThrow("HARNESS_AUTH does not apply to HARNESS=remote");
	}
	expect(() => harnessFor({ harness: "remote", harnessExtensions: [tmpdir()] }))
		.toThrow("HARNESS_EXTENSIONS requires HARNESS=atomic, not remote");
});

it("accepts only existing absolute extension paths, and only for the atomic harness", () => {
	let atomic = { harness: "atomic", harnessAuth: "auto", host: "127.0.0.1" };
	expect(() => harnessFor({ ...atomic, harnessExtensions: ["relative/package"] }))
		.toThrow("HARNESS_EXTENSIONS path relative/package must be absolute");
	let missing = join(tmpdir(), `chopin-missing-${crypto.randomUUID()}`);
	expect(() => harnessFor({ ...atomic, harnessExtensions: [missing] }))
		.toThrow(`HARNESS_EXTENSIONS path ${missing} does not exist`);
	expect(() => harnessFor({ harness: "copilot-sdk", harnessExtensions: [tmpdir()] }))
		.toThrow("HARNESS_EXTENSIONS requires HARNESS=atomic, not copilot-sdk");
	expect(harnessFor({ ...atomic, harnessExtensions: [tmpdir()] }).harnessId).toBe("atomic");
});

it("registers credentials per session without reuse or rewriting", () => {
	let token = "session-token";
	let release = registerCredential("session-id", () => token);
	expect(() => registerCredential("session-id", () => "other")).toThrow("already registered");
	try {
		token = "rotated-token";
	} finally {
		release();
	}
	let again = registerCredential("session-id", () => token);
	again();
});

it("offers no choice of model where the harness cannot honor one", async () => {
	// copilot-sdk takes a model per turn but reports no catalog and has no thinking level; no
	// harness chosen yet and an unknown one offer nothing either.
	harnessFor({ harness: "copilot-sdk" });
	expect(await plannerCatalog("copilot-sdk", "channel", "gpt-5")).toBeUndefined();
	expect(await plannerCatalog("not-installed", "channel", undefined)).toBeUndefined();
	await shutdownHarnesses();
	expect(await plannerCatalog("atomic", "channel", "stub/model")).toBeUndefined();
});

it("offers a remote Planner only what the client attached to the document reported", async () => {
	let reported: { models?: { available: Array<{ id: string; name: string }> } } | undefined;
	let link = {
		get catalog() {
			return reported;
		},
	} as unknown as AgentLink;
	// Nothing is attached, or a client from before the catalog is: no picker.
	expect(await plannerCatalog("remote", "doc-a", undefined)).toBeUndefined();
	let detach = attachLink("doc-a", link);
	expect(await plannerCatalog("remote", "doc-a", undefined)).toBeUndefined();
	reported = { models: { available: [{ id: "acme/large", name: "Large" }] } };
	expect(await plannerCatalog("remote", "doc-a", undefined)).toEqual({
		models: [{ id: "acme/large", name: "Large" }],
	});
	// Another document's client is not this document's.
	expect(await plannerCatalog("remote", "doc-b", undefined)).toBeUndefined();
	detach();
	expect(await plannerCatalog("remote", "doc-a", undefined)).toBeUndefined();
});

it("offers a remote Planner's commands only from the client attached to that document, and none once it leaves", async () => {
	let repository = { owner: "acme", name: "plans" };
	let reportedByA: { commands?: Array<{ name: string; kind: string; description?: string }> } = {
		commands: [
			{ name: "skill:notes", kind: "skill", description: "Take notes" },
			{ name: "review", kind: "prompt" },
			{ name: "review", kind: "prompt" },
		],
	};
	let machineA = {
		get catalog() {
			return reportedByA;
		},
	} as unknown as AgentLink;
	let machineB = {
		get catalog() {
			return { models: { available: [] } };
		},
	} as unknown as AgentLink;
	expect(await plannerCommands("remote", "doc-a", repository)).toBeUndefined();
	let detachA = attachLink("doc-a", machineA);
	// Exactly as the client reported them, a repeated entry included.
	expect(await plannerCommands("remote", "doc-a", repository)).toEqual([
		{ name: "skill:notes", kind: "skill", description: "Take notes" },
		{ name: "review", kind: "prompt" },
		{ name: "review", kind: "prompt" },
	]);
	// Another document's machine is not this document's.
	expect(await plannerCommands("remote", "doc-b", repository)).toBeUndefined();
	detachA();
	expect(await plannerCommands("remote", "doc-a", repository)).toBeUndefined();
	// A different machine takes the document over: it never inherits the first one's commands.
	let detachB = attachLink("doc-a", machineB);
	expect(await plannerCommands("remote", "doc-a", repository)).toBeUndefined();
	detachB();
	// An older client reports no commands at all.
	let older = attachLink("doc-a", { catalog: undefined } as unknown as AgentLink);
	expect(await plannerCommands("remote", "doc-a", repository)).toBeUndefined();
	older();
	// A harness that reports none offers none.
	harnessFor({ harness: "copilot-sdk" });
	expect(await plannerCommands("copilot-sdk", "doc-a", repository)).toBeUndefined();
	await shutdownHarnesses();
});

it("knows what a remote Planner offers only from an attached client that has reported, or never will", () => {
	let pending = true;
	let link = {
		get catalogPending() {
			return pending;
		},
	} as unknown as AgentLink;
	// Nobody is attached, or the client has yet to say: nothing can be said of a saved choice.
	expect(plannerOfferKnown("remote", "doc-a")).toBe(false);
	let detach = attachLink("doc-a", link);
	expect(plannerOfferKnown("remote", "doc-a")).toBe(false);
	pending = false;
	expect(plannerOfferKnown("remote", "doc-a")).toBe(true);
	// Another document's client is not this document's.
	expect(plannerOfferKnown("remote", "doc-b")).toBe(false);
	detach();
	expect(plannerOfferKnown("remote", "doc-a")).toBe(false);
	// Every other harness knows what it offers, which may be nothing.
	for (let harness of ["copilot-sdk", "atomic", "not-installed"]) {
		expect(plannerOfferKnown(harness, "doc-a")).toBe(true);
	}
});

it("settles a remote Planner's wait for a catalog when a turn ran without it, for that document's client alone", () => {
	let pending = true;
	let link = {
		get catalogPending() {
			return pending;
		},
		settleWithoutCatalog() {
			pending = false;
		},
	} as unknown as AgentLink;
	// Nothing is attached: nothing to settle, and nothing becomes known.
	expect(plannerRanWithoutOffer("remote", "doc-a")).toBe(false);
	expect(plannerOfferKnown("remote", "doc-a")).toBe(false);
	let detach = attachLink("doc-a", link);
	expect(plannerRanWithoutOffer("remote", "doc-b")).toBe(false);
	expect(plannerOfferKnown("remote", "doc-a")).toBe(false);
	expect(plannerRanWithoutOffer("remote", "doc-a")).toBe(true);
	expect(plannerOfferKnown("remote", "doc-a")).toBe(true);
	// The client leaves: what it fell back on goes with it.
	detach();
	expect(plannerOfferKnown("remote", "doc-a")).toBe(false);
	// Every other harness knew what it offers all along, so there is nothing to settle.
	for (let harness of ["copilot-sdk", "atomic", "not-installed"]) {
		expect(plannerRanWithoutOffer(harness, "doc-a")).toBe(false);
	}
});

it("offers an Atomic Planner the models of its own runtime, once the harness is selected", async () => {
	harnessFor({ harness: "atomic", harnessAuth: "ai-gateway", host: "127.0.0.1" });
	let catalog = await plannerCatalog("atomic", "channel", undefined);
	expect(catalog).toBeDefined();
	// Gateway authentication offers only the gateway's models, and none has a default here.
	expect(catalog!.models.every(model => model.provider?.id === "vercel-ai-gateway")).toBe(true);
	expect(catalog!.default).toBeUndefined();
});
