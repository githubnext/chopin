import { type ConnectSettings, readConfig } from "./config";
import { machineLabel, machineToken, SELF } from "./machine";
import { CONNECTOR_HEADERS, refusal } from "./mcp";
import { logPath, type ServiceHost, type ServiceStatus, serviceStatus } from "./service";
import { appCannotPush } from "./github-token";
import { CONNECTOR_PROTOCOL, VERSION } from "./version";
import { join } from "node:path";
import { clones } from "./checkouts";
import {
	connectors,
	diskUsage,
	plannerWorktrees,
	processStart,
	runs,
	type StartFailure,
} from "./workspace";

/** Where the server origin came from: CHOPIN_URL, config.json, or Chopin's own default. */
export type ServerSource = "CHOPIN_URL" | "config" | "default";

/**
 * What Chopin said about the machine token: it accepts it, it revoked it or needs it paired
 * again, it needs a newer chopin, it could not be reached in time, or something else went wrong.
 */
export type MachineCheck =
	| "accepted"
	| "revoked"
	| "reauthorize"
	| "update-required"
	| "unreachable"
	| "error"
	| "not-paired";

/**
 * `chopin status --json`. The keys are stable: add new ones rather than renaming or removing
 * these. It never holds the machine token.
 */
export type StatusReport = {
	version: string;
	protocol: number;
	server: { origin: string; source: ServerSource };
	machine: {
		paired: boolean;
		/** The label this machine was paired under, or null when it is not paired. */
		label: string | null;
		check: MachineCheck;
		/** Whether Chopin accepts the token; null when unpaired or Chopin could not be asked. */
		accepted: boolean | null;
		/** The paired account's GitHub login, when Chopin accepts the token. */
		login?: string;
		/** Why the check did not succeed. */
		detail?: string;
	};
	/**
	 * Connectors holding the base dir, one at a time, or an older connector its checkout;
	 * `running: false` is a stale lock.
	 */
	connectors: Array<{
		pid: number;
		/** An older connector's one checkout. */
		checkout?: string;
		/** The checkouts a connector registered, by repository (`owner/name`) to their root. */
		checkouts?: Record<string, string>;
		running: boolean;
		service: boolean;
		version?: string;
		/** ISO 8601. */
		started?: string;
		/** The documents whose Planner backends it runs, as its lock records them. */
		planners?: string[];
		/** It has a Planner command, so it can run the Planner of a document that chooses this machine. */
		canRunPlanners?: true;
		/** The documents, by URL, whose Planners it runs because they chose this machine in Chopin. */
		chosenPlanners?: string[];
		/**
		 * The latest failure to start of its agent and of each Planner backend, while it runs:
		 * `kind` (`agent` or `planner`), `document` for a Planner, `how` it ended (`exit 127`,
		 * `signal SIGKILL`), the first line of its `stderr`, `at` and the Planner's `retryAt`; or
		 * for a Planner Chopin refused for good, `stopped` with the refusal as `how`.
		 */
		failures?: Array<
			Omit<StartFailure, "at" | "retryAt"> & { at: string; retryAt?: string }
		>;
		/**
		 * The repositories Chopin's GitHub App can't push to, so the machine's Planner commands and
		 * runs use its own GitHub login there.
		 */
		githubCannotPush?: string[];
	}>;
	service: ServiceStatus | { state: "unknown"; detail: string };
	log: string;
	baseDir: string;
	/** What the installed service runs, as `chopin service install` copied it. */
	serviceRuns: ConnectSettings | null;
	/** What the last `chopin connect` that connected ran, which the next install copies. */
	lastConnect: ConnectSettings | null;
	/**
	 * The runs in `<base>/runs`: how many finished runs' worktrees are `kept`, how many are
	 * `running` or queued, and the kept worktrees' size in `bytes`, absent where it can't be read.
	 */
	runs: { kept: number; running: number; bytes?: number };
	/** The worktrees Planner commands made in `<base>/planners`, with their repository and document. */
	plannerWorktrees: Array<{ path: string; repository: string; document: string }>;
	/**
	 * The checkouts work in their repositories runs from, by repository (`owner/name`) to their
	 * root: what the running connector registered, else what the next one runs with.
	 */
	checkouts: Record<string, string>;
	/** The clones made on demand in `<base>/repos/<owner>/<repo>` for every other repository. */
	clones: Array<{ repository: string; path: string }>;
};

const CHECK_MS = 3000;

async function check(url: string, token: string, timeoutMs: number) {
	let response;
	try {
		response = await fetch(`${url}/api/connector/machine`, {
			headers: { ...CONNECTOR_HEADERS, authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		return {
			check: "unreachable" as const,
			accepted: null,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	let refused = await refusal(response);
	if (refused) {
		return { check: "update-required" as const, accepted: false, detail: refused.message };
	}
	let body = await response.json().catch(() => ({})) as Record<string, unknown>;
	if (response.ok) {
		return {
			check: "accepted" as const,
			accepted: true,
			...(typeof body.login === "string" ? { login: body.login } : {}),
			...(typeof body.label === "string" ? { label: body.label } : {}),
		};
	}
	let code = typeof body.error === "string" ? body.error : `http-${response.status}`;
	if (code === "machine-revoked") {
		return { check: "revoked" as const, accepted: false, detail: code };
	}
	if (code === "machine-reauthorize") {
		return { check: "reauthorize" as const, accepted: false, detail: code };
	}
	return { check: "error" as const, accepted: null, detail: code };
}

/**
 * Everything `chopin status` reports for one base dir. Chopin is asked once, with a short
 * timeout, whether it still accepts the machine token; being offline is reported, not fatal.
 */
export async function collectStatus(options: {
	directory: string;
	server: string;
	source: ServerSource;
	host: ServiceHost;
	timeoutMs?: number;
}): Promise<StatusReport> {
	let { directory, server, host } = options;
	let token = await machineToken(directory, server);
	// The name Chopin has for the machine, which its owner may have changed there, else the stored one.
	let machine: StatusReport["machine"] = token
		? {
			paired: true,
			label: await machineLabel(directory, server) ?? null,
			...await check(server, token, options.timeoutMs ?? CHECK_MS),
		}
		: { paired: false, label: null, check: "not-paired", accepted: null };
	let held = (await connectors(directory, processStart(host.platform, host.run))).sort((a, b) =>
		Number(b.running) - Number(a.running) || (a.root ?? "").localeCompare(b.root ?? "")
	);
	let service: StatusReport["service"];
	try {
		service = await serviceStatus(host, directory);
	} catch (error) {
		service = { state: "unknown", detail: error instanceof Error ? error.message : String(error) };
	}
	let config = await readConfig(directory);
	let found = await runs(directory, processStart(host.platform, host.run));
	let kept = found.filter(run => !run.active && run.worktree);
	let bytes = await diskUsage(kept.map(run => join(directory, "runs", run.attempt)));
	return {
		version: VERSION,
		protocol: CONNECTOR_PROTOCOL,
		server: { origin: server, source: options.source },
		machine,
		connectors: held.map(item => ({
			pid: item.pid,
			...(item.root ? { checkout: item.root } : {}),
			...(item.checkouts ? { checkouts: item.checkouts } : {}),
			running: item.running,
			service: item.service,
			...(item.version ? { version: item.version } : {}),
			...(item.started ? { started: new Date(item.started).toISOString() } : {}),
			...(item.planners ? { planners: item.planners } : {}),
			...(item.plannerCommand ? { canRunPlanners: true as const } : {}),
			...(item.chosen ? { chosenPlanners: item.chosen } : {}),
			...(item.githubCannotPush ? { githubCannotPush: item.githubCannotPush } : {}),
			...(item.failures
				? {
					failures: item.failures.map(({ at, retryAt, ...failure }) => ({
						...failure,
						at: new Date(at).toISOString(),
						...(retryAt ? { retryAt: new Date(retryAt).toISOString() } : {}),
					})),
				}
				: {}),
		})),
		service,
		log: logPath(host.platform, directory),
		baseDir: directory,
		serviceRuns: config.service?.settings ?? null,
		lastConnect: config.connect ?? null,
		runs: {
			kept: kept.length,
			running: found.filter(run => run.active).length,
			...(bytes === undefined ? {} : { bytes }),
		},
		plannerWorktrees: await plannerWorktrees(directory),
		checkouts: held.find(item => item.running && item.checkouts)?.checkouts
			?? registered(config.service?.settings ?? config.connect),
		clones: await clones(directory),
	};
}

/** The checkouts settings register, an older chopin's one included, which has no repository. */
function registered(settings: ConnectSettings | undefined): Record<string, string> {
	if (!settings) return {};
	return settings.checkouts ?? (settings.checkout ? { "": settings.checkout } : {});
}

const SOURCES: Record<ServerSource, string> = {
	CHOPIN_URL: "from CHOPIN_URL",
	config: "saved by chopin connect",
	default: "the default; CHOPIN_URL changes it",
};

function row(name: string, value: string) {
	return `${`${name}:`.padEnd(12)}${value}`;
}

function more(value: string) {
	return `${" ".repeat(12)}${value}`;
}

function describe(settings: ConnectSettings) {
	let planners = settings.planners.length
		? ` and Planners for ${settings.planners.join(", ")}`
		: settings.plannerCommand?.length
		? " and the Planners of documents that choose this machine"
		: "";
	let command = settings.command.join(" ");
	let agent = settings.agent ? `--agent ${settings.agent} (${command})` : command;
	let checkouts = Object.values(registered(settings));
	let from = checkouts.length ? ` with checkouts ${checkouts.join(", ")}` : "";
	return `${agent}${planners}${from}, on ${settings.server}`;
}

type Failure = NonNullable<StatusReport["connectors"][number]["failures"]>[number];

function failing(failure: Failure, now: number) {
	if (failure.stopped) return `: stopped: ${failure.how}`;
	let wait = failure.retryAt ? Math.ceil((Date.parse(failure.retryAt) - now) / 1000) : undefined;
	return `: failing (${failure.how}${failure.stderr ? `: ${failure.stderr}` : ""})${
		wait === undefined ? "" : wait > 0 ? `, retrying in ${wait}s` : ", retrying now"
	}`;
}

/** `bytes` as a person reads a size. */
function size(bytes: number) {
	if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} kB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** The report as lines for a person; `now` says when a failing Planner is tried again. */
export function formatStatus(report: StatusReport, now = Date.now()) {
	let { machine, service } = report;
	let named = `paired as ${machine.label ?? "this machine"}${
		machine.login ? ` (${machine.login})` : ""
	}`;
	let pairing = {
		"not-paired": `not paired with ${report.server.origin}; run \`${SELF} pair\``,
		accepted: `${named}; Chopin accepts it`,
		revoked: `${named}; Chopin no longer accepts it (${machine.detail}). Run \`${SELF} pair\`.`,
		reauthorize: `${named}; GitHub no longer accepts its authorization. Run \`${SELF} pair\`.`,
		"update-required": `${named}; Chopin needs a newer chopin. ${machine.detail}`,
		unreachable: `${named}; can't reach Chopin to check it (${machine.detail})`,
		error: `${named}; Chopin's answer was ${machine.detail}`,
	}[machine.check];
	let held = report.connectors.flatMap(item => {
		let failures = item.failures ?? [];
		let agent = failures.find(failure => failure.kind === "agent");
		let planner = (document: string) =>
			failures.find(failure => failure.kind === "planner" && failure.document === document);
		return item.running
			? [
				`running${item.checkout ? ` for ${item.checkout}` : ""} (pid ${item.pid}${
					item.version ? `, chopin ${item.version}` : ""
				}${item.service ? ", the service" : ""})`,
				...(agent ? [`  Agent${failing(agent, now)}`] : []),
				...(item.githubCannotPush ?? []).map(repository => `  ${appCannotPush(repository)}`),
				...(item.canRunPlanners
					? ["  Can run Planners for documents that choose this machine"]
					: []),
				...(item.planners ?? []).map(document => {
					let failure = planner(document);
					return `  Planner for ${document}${failure ? failing(failure, now) : ""}`;
				}),
				...(item.chosenPlanners ?? []).map(document => {
					let failure = planner(document);
					return `  Planner for ${document} (chosen in Chopin)${
						failure ? failing(failure, now) : ""
					}`;
				}),
			]
			: [
				`stale lock${
					item.checkout ? ` for ${item.checkout}` : ""
				}: its connector (pid ${item.pid}) `
				+ "has exited; the next connect replaces it",
			];
	});
	let serviceLine = service.state === "unknown"
		? `unknown (${service.detail})`
		: `${service.state} (${service.manager}${service.pid ? `, pid ${service.pid}` : ""})`;
	let { serviceRuns: runs, lastConnect: last } = report;
	let kept = report.runs;
	let worktrees = report.plannerWorktrees.map(item =>
		`${item.path} (${item.repository}, document ${item.document})`
	);
	let checkouts = Object.entries(report.checkouts).map(([repository, path]) =>
		repository ? `${repository} at ${path}` : path
	);
	let cloned = report.clones.map(item => `${item.repository} at ${item.path}`);
	return [
		`chopin ${report.version} (connector protocol ${report.protocol})`,
		row("Server", `${report.server.origin} (${SOURCES[report.server.source]})`),
		row("Machine", pairing),
		row("Connector", held[0] ?? "not running"),
		...held.slice(1).map(more),
		row("Service", serviceLine),
		...(service.state === "unknown" || service.state === "not-installed"
			? []
			: [
				more(`definition: ${service.definition}`),
				...(runs ? [more(`runs ${describe(runs)}`)] : []),
				...(last && !Bun.deepEquals(last, runs)
					? [
						more(
							`chopin connect last ran ${describe(last)}; run chopin service install to use it`,
						),
					]
					: []),
				...service.notes.map(more),
			]),
		...(kept.kept || kept.running
			? [
				row(
					"Runs",
					`${kept.kept} finished run${kept.kept === 1 ? "" : "s"} kept${
						kept.bytes === undefined ? "" : ` (${size(kept.bytes)})`
					}${kept.running ? `, ${kept.running} running` : ""}`,
				),
			]
			: []),
		row("Checkouts", checkouts[0] ?? "none registered; chopin connect --checkout <path> adds one"),
		...checkouts.slice(1).map(more),
		row("Clones", cloned[0] ?? "none yet; other repositories are cloned when work needs them"),
		...cloned.slice(1).map(more),
		...(worktrees.length ? [row("Planners", worktrees[0]!), ...worktrees.slice(1).map(more)] : []),
		row("Log", report.log),
		row("Base dir", report.baseDir),
	];
}
