/**
 * The connector's human-facing terminal lines. Messages go to stdout so terminals don't paint them
 * as errors; failures go to stderr. ANSI styling only reaches a TTY and honours `NO_COLOR`.
 */
type Stream = { write(text: string): unknown; isTTY?: boolean };

const CODES = {
	bold: [1, 22],
	dim: [2, 22],
	underline: [4, 24],
	cyan: [36, 39],
	green: [32, 39],
	red: [31, 39],
} as const;

export type Style = Record<keyof typeof CODES, (text: string) => string>;

export function style(enabled: boolean): Style {
	return Object.fromEntries(
		Object.entries(CODES).map((
			[name, [open, close]],
		) => [name, (text: string) => enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text]),
	) as Style;
}

export function colorful(stream: Stream, env: Record<string, string | undefined> = process.env) {
	return !!stream.isTTY && !env.NO_COLOR;
}

export type JobKind = "build" | "investigation" | "spike";

const VERBS: Record<JobKind, string> = {
	build: "Building",
	investigation: "Investigating",
	spike: "Prototyping",
};

/** A brief can be paragraphs long; the terminal names it by its first line. */
function headline(text: string) {
	let line = text.trim().split("\n")[0]!.trim();
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export function createOutput(
	out: Stream = process.stdout,
	err: Stream = process.stderr,
	env: Record<string, string | undefined> = process.env,
) {
	let s = style(colorful(out, env));
	let e = style(colorful(err, env));
	let say = (...lines: string[]) => void out.write(lines.join("\n") + "\n");
	return {
		style: s,
		pairing(repository: string, url: string, code: string) {
			say(
				"",
				s.bold(`Chopin connector · ${repository}`),
				"",
				"1. Open this link and sign in:",
				`   ${s.underline(s.cyan(url))}`,
				"",
				"2. Check the page shows:",
				`   ${s.bold(code)}`,
				"",
			);
		},
		connected(repository: string) {
			say(
				`${s.green("✓ Connected.")}`,
				s.dim(`  Work you start in any ${repository} document runs here. Ctrl-C disconnects.`),
				"",
			);
		},
		/** `dropped` when a working connection failed, rather than the first attempt to connect. */
		unreachable(cause: string, dropped: boolean) {
			say(`${s.dim("…")} ${dropped ? "Lost the connection to" : "Can't reach"} Chopin (${cause}).`);
		},
		reconnecting(ms: number) {
			say(s.dim(ms ? `  Reconnecting in ${Math.ceil(ms / 1000)}s.` : "  Reconnecting now."));
		},
		stillReconnecting() {
			say(s.dim("  Still reconnecting, at most 5 minutes apart. Ctrl-C stops."));
		},
		reconnected() {
			say(s.green("✓ Reconnected."), "");
		},
		job(kind: JobKind, title: string, path: string) {
			say(`› ${VERBS[kind]} ${headline(title)}`, s.dim(`  ${path}`));
		},
		finished() {
			say(`  ${s.green("✓")} Finished`, "");
		},
		stopped() {
			say(`  ${s.dim("■ Stopped from this terminal")}`, "");
		},
		/** `agent` is the agent's last stderr lines, shown when debugging didn't already show them. */
		failed(message: string, agent: string[] = []) {
			let tail = env.CHOPIN_DEBUG === "1" ? [] : agent.map(line => e.dim(`  agent │ ${line}`));
			err.write([`  ${e.red(`✗ Failed: ${message}`)}`, ...tail, "", ""].join("\n"));
		},
		error(message: string) {
			err.write(`${e.red(message)}\n`);
		},
		/** The agent's own stderr is noise unless debugging; it never looks like a Chopin error. */
		agent(text: string) {
			if (env.CHOPIN_DEBUG !== "1") return;
			let lines = text.replace(/\n$/, "").split("\n");
			err.write(lines.map(line => e.dim(`  agent │ ${line}`)).join("\n") + "\n");
		},
		say,
	};
}

export type Output = ReturnType<typeof createOutput>;
