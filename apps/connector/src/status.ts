import { machineLabel, machineToken, SELF } from "./machine";
import { CONNECTOR_HEADERS, refusal } from "./mcp";
import { logPath, type ServiceHost, type ServiceStatus, serviceStatus } from "./service";
import { CONNECTOR_PROTOCOL, VERSION } from "./version";
import { connectors } from "./workspace";

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
	/** Connectors holding a checkout in the base dir; `running: false` is a stale lock. */
	connectors: Array<{
		pid: number;
		checkout: string;
		running: boolean;
		service: boolean;
		version?: string;
		/** ISO 8601. */
		started?: string;
	}>;
	service: ServiceStatus | { state: "unknown"; detail: string };
	log: string;
	baseDir: string;
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
	let machine: StatusReport["machine"] = token
		? {
			paired: true,
			label: await machineLabel(directory, server) ?? null,
			...await check(server, token, options.timeoutMs ?? CHECK_MS),
		}
		: { paired: false, label: null, check: "not-paired", accepted: null };
	let held = (await connectors(directory)).sort((a, b) =>
		Number(b.running) - Number(a.running) || a.root.localeCompare(b.root)
	);
	let service: StatusReport["service"];
	try {
		service = await serviceStatus(host, directory);
	} catch (error) {
		service = { state: "unknown", detail: error instanceof Error ? error.message : String(error) };
	}
	return {
		version: VERSION,
		protocol: CONNECTOR_PROTOCOL,
		server: { origin: server, source: options.source },
		machine,
		connectors: held.map(item => ({
			pid: item.pid,
			checkout: item.root,
			running: item.running,
			service: item.service,
			...(item.version ? { version: item.version } : {}),
			...(item.started ? { started: new Date(item.started).toISOString() } : {}),
		})),
		service,
		log: logPath(host.platform, directory),
		baseDir: directory,
	};
}

const SOURCES: Record<ServerSource, string> = {
	CHOPIN_URL: "from CHOPIN_URL",
	config: "stored by chopin service install",
	default: "the default; CHOPIN_URL changes it",
};

function row(name: string, value: string) {
	return `${`${name}:`.padEnd(12)}${value}`;
}

function more(value: string) {
	return `${" ".repeat(12)}${value}`;
}

/** The report as lines for a person. */
export function formatStatus(report: StatusReport) {
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
	let held = report.connectors.map(item =>
		item.running
			? `running for ${item.checkout} (pid ${item.pid}${
				item.version ? `, chopin ${item.version}` : ""
			}${item.service ? ", the service" : ""})`
			: `stale lock for ${item.checkout}: process ${item.pid} is gone; the next connect replaces it`
	);
	let serviceLine = service.state === "unknown"
		? `unknown (${service.detail})`
		: `${service.state} (${service.manager}${service.pid ? `, pid ${service.pid}` : ""})`;
	return [
		`chopin ${report.version} (connector protocol ${report.protocol})`,
		row("Server", `${report.server.origin} (${SOURCES[report.server.source]})`),
		row("Machine", pairing),
		row("Connector", held[0] ?? "not running"),
		...held.slice(1).map(more),
		row("Service", serviceLine),
		...(service.state === "unknown" || service.state === "not-installed"
			? []
			: [more(`definition: ${service.definition}`), ...service.notes.map(more)]),
		row("Log", report.log),
		row("Base dir", report.baseDir),
	];
}
