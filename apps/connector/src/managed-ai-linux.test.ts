import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { checkouts } from "./checkouts";
import { createOutput } from "./output";
import { servePlanners } from "./planner";
import { plannerSpares } from "./planner-spare";
import { createSandbox, inspectSandbox } from "./sandbox";
import { answerTokens } from "./testing/github-grant";

/**
 * A Planner backend whose sessions run on people's AI accounts in Chopin, started on a real Linux
 * sandbox, cold and as a spare: it gets nothing of the owner's setup, in its environment or on
 * disk, wherever the owner's environment or `--env` keeps it. One started for a Chopin that says
 * nothing of AI accounts starts as before. These skip, saying why, where the machine has no
 * working sandbox. Everything lives under /var/tmp, because /tmp is private to each sandbox.
 */
let linux = process.platform === "linux";
let scratch = linux ? realpathSync(mkdtempSync("/var/tmp/chopin-managed-ai-")) : "";
let inspected = linux ? await inspectSandbox({ directory: join(scratch, "inspect") }) : undefined;
let usable = inspected?.report.engine === "bubblewrap";
if (!usable) {
	console.warn("Skipping the managed Planner tests: this machine has no working sandbox.");
}
afterAll(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const MACHINE = `chopin_m_${"M".repeat(43)}`;
/** A provider key in the connector's own environment that no list of known names covers. */
const UNRELATED_KEY = "sk-fake-unrelated-provider-0123456789";

function git(cwd: string, ...args: string[]) {
	let result = spawnSync("git", [
		"-c",
		"user.name=fixture",
		"-c",
		"user.email=fixture@example.test",
		...args,
	], { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

/**
 * A home, a checkout of octo-org/score, a connector state directory, and the owner's own agent
 * setup kept where their environment moved it: sessions where the connector's environment says,
 * the agent directory where an `--env` value says.
 */
function world(name: string) {
	let root = join(scratch, name);
	let home = join(root, "home");
	let checkout = join(root, "checkout");
	let state = join(root, "state");
	let sessions = join(root, "owner-sessions");
	let agent = join(root, "owner-agent");
	let remote = join(root, "github.com", "octo-org", "score.git");
	for (let directory of [home, checkout, state, sessions, agent, dirname(remote)]) {
		mkdirSync(directory, { recursive: true });
	}
	let markers = [join(sessions, "session.json"), join(agent, "auth.json")];
	writeFileSync(markers[0]!, "OWNER_SESSION_MARKER");
	writeFileSync(markers[1]!, "OWNER_AGENT_MARKER");
	git(root, "init", "--bare", remote);
	git(checkout, "init", "-b", "main");
	writeFileSync(join(checkout, "README.md"), "the repository\n");
	git(checkout, "add", ".");
	git(checkout, "commit", "-m", "initial");
	git(checkout, "remote", "add", "origin", remote);
	return { root, home, checkout, state, sessions, agent, markers };
}

/** Chopin as a machine meets it: a Planner credential, saying `ai` or not, and the tokens. */
function chopin(ai: boolean) {
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			let issued = await answerTokens(request);
			if (issued) return issued;
			if (new URL(request.url).pathname === "/api/connector/planner") {
				return Response.json({
					token: `chopin_p_${"P".repeat(43)}`,
					expiresAt: Date.now() + 15 * 60_000,
					document: {
						id: "D_1",
						repository: "octo-org/score",
						url: `${new URL(request.url).origin}/octo-org/score/plan`,
					},
					...(ai ? { ai: "chopin" } : {}),
				});
			}
			return new Response("chopin");
		},
	});
	return { origin: server.url.origin, stop: () => server.stop(true) };
}

/**
 * Starts the document's Planner backend, cold or on a spare, with the owner's setup in place, and
 * returns what it reported: its environment and what it could read of the owner's markers.
 */
async function started(name: string, options: { ai: boolean; spare: boolean }) {
	let made = world(name);
	let served = chopin(options.ai);
	let realHome = process.env.HOME;
	let saved = {
		key: process.env.MISTRAL_API_KEY,
		sessions: process.env.ATOMIC_CODING_AGENT_SESSION_DIR,
	};
	process.env.HOME = made.home;
	process.env.MISTRAL_API_KEY = UNRELATED_KEY;
	process.env.ATOMIC_CODING_AGENT_SESSION_DIR = made.sessions;
	let abort = new AbortController();
	let sandbox = await createSandbox({
		directory: made.state,
		home: made.home,
		server: served.origin,
	});
	let quiet = { write: () => true };
	let output = createOutput(quiet, quiet, {});
	let command = [process.execPath, join(import.meta.dir, "testing/ai-planner.ts")];
	let env = { ATOMIC_CODING_AGENT_DIR: made.agent, AI_AGENT_PEEK: made.markers.join(",") };
	let spares = options.spare
		? plannerSpares({
			url: served.origin,
			command,
			registered: { "octo-org/score": made.checkout },
			directory: made.state,
			output,
			signal: abort.signal,
			env,
			sandbox,
			managed: options.ai,
			replaceMs: 60_000,
		})
		: undefined;
	try {
		if (spares) {
			// The document's Planner starts on the spare once it is ready.
			for (let deadline = Date.now() + 60_000;; await Bun.sleep(100)) {
				if (Date.now() > deadline) throw new Error("The spare never became ready.");
				let found =
					spawnSync("sh", ["-c", `ls ${join(made.state, "planners", "octo-org", "score")}`], {
						encoding: "utf8",
					}).stdout;
				if (/spare-[0-9a-f]{12}\n/.test(found)) break;
			}
			await Bun.sleep(1_500);
		}
		let serving = servePlanners({
			url: served.origin,
			machine: MACHINE,
			documents: ["D_1"],
			command,
			checkouts: checkouts({
				directory: made.state,
				registered: { "octo-org/score": made.checkout },
			}),
			directory: made.state,
			output,
			signal: abort.signal,
			env,
			sandbox,
			...(spares ? { spares } : {}),
		});
		let folder = join(made.state, "planners", "octo-org", "score");
		let report: string | undefined;
		for (let deadline = Date.now() + 90_000; !report; await Bun.sleep(100)) {
			if (Date.now() > deadline) throw new Error("The Planner backend never reported.");
			let listed = spawnSync("sh", ["-c", `ls -d ${folder}/*/ai-report.json 2>/dev/null`], {
				encoding: "utf8",
			}).stdout.trim();
			if (listed && existsSync(listed.split("\n")[0]!)) report = listed.split("\n")[0]!;
		}
		let worktree = dirname(report);
		let { env: seen, peeked } = JSON.parse(readFileSync(report, "utf8")) as {
			env: Record<string, string | undefined>;
			peeked: Record<string, { text?: string; error?: string }>;
		};
		abort.abort();
		await spares?.stop();
		await serving;
		return { made, worktree, seen, peeked };
	} finally {
		abort.abort();
		await sandbox.close();
		served.stop();
		process.env.HOME = realHome;
		for (
			let [name, value] of [
				["MISTRAL_API_KEY", saved.key],
				["ATOMIC_CODING_AGENT_SESSION_DIR", saved.sessions],
			] as const
		) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

for (let spare of [false, true]) {
	test.skipIf(!usable)(
		`a Planner backend ${
			spare ? "started as a spare" : "started cold"
		} for a Chopin that runs its sessions on people's AI accounts gets none of the owner's keys or agent setup`,
		async () => {
			let { made, worktree, seen, peeked } = await started(spare ? "managed-spare" : "managed", {
				ai: true,
				spare,
			});
			expect(seen.MISTRAL_API_KEY).toBeUndefined();
			expect(JSON.stringify(seen)).not.toContain(UNRELATED_KEY);
			expect(seen.CHOPIN_AI).toBe("chopin");
			expect(seen.ATOMIC_CODING_AGENT_DIR).toBe(join(`${worktree}.agent`, "atomic"));
			expect(seen.ATOMIC_CODING_AGENT_SESSION_DIR).toBeUndefined();
			for (let marker of made.markers) {
				expect(peeked[marker], marker).toHaveProperty("error");
				expect(peeked[marker], marker).not.toHaveProperty("text");
			}
		},
		150_000,
	);
}

test.skipIf(!usable)(
	"a Planner backend for a Chopin that says nothing of AI accounts starts as before, on the owner's own setup",
	async () => {
		let { made, seen, peeked } = await started("legacy", { ai: false, spare: false });
		expect(seen.MISTRAL_API_KEY).toBe(UNRELATED_KEY);
		expect(seen.CHOPIN_AI).toBeUndefined();
		expect(seen.ATOMIC_CODING_AGENT_DIR).toBe(made.agent);
		expect(peeked[made.markers[1]!]).toEqual({ text: "OWNER_AGENT_MARKER" });
	},
	150_000,
);
