/**
 * Checks the coding agents the Machines page offers against npm as it is today, each in a fresh
 * `node` container with no host mounts or credentials: the exact install command, that its
 * programs are on PATH and run, that its sign-in command exists, and that its ACP command answers
 * `initialize` (which needs no sign-in). With --below it also installs each at one Node major
 * under its minimum, where chopin connect should refuse it. Uses the network and Docker, so it is
 * not part of `bun test`; CI runs it weekly.
 *
 *   bun run verify:agents [--below] [agent id ...]
 */
import { AGENTS, nodeMajor } from "../packages/protocol/agents";

import type { CodingAgent } from "../packages/protocol/agents";

/** Run inside the container: start the ACP command, send initialize, report the first answer. */
const PROBE = `
const { spawn } = require("node:child_process");
const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
let out = "", err = "";
const done = (line) => { console.log(line); child.kill("SIGKILL"); process.exit(0); };
child.stdout.on("data", chunk => {
	out += chunk;
	for (const line of out.split("\\n")) {
		try {
			const message = JSON.parse(line);
			if (message.id === 1) {
				done(message.error
					? "error " + JSON.stringify(message.error.message).slice(0, 160)
					: "ok protocol " + message.result.protocolVersion);
			}
		} catch {}
	}
});
child.stderr.on("data", chunk => err += chunk);
child.on("exit", code => done("exit " + code + " " + JSON.stringify(err.trim().split("\\n")[0] ?? "").slice(0, 160)));
child.on("error", error => done("spawn " + error.message));
setTimeout(() => done("timeout " + JSON.stringify(err.trim().split("\\n")[0] ?? "").slice(0, 160)), 60000);
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
	params: { protocolVersion: 1, clientCapabilities: {} } }) + "\\n");
`;

function words(list: string[]) {
	return list.map(word => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

/** The shell script one container runs, printing `key=value` lines. */
function script(agent: CodingAgent) {
	let bins = [...new Set([agent.signIn.command[0]!, agent.acp[0]!])];
	return [
		"printf '%s' \"$PROBE\" > /tmp/probe.js",
		"echo node=$(node --version)",
		...agent.install.map(install =>
			`timeout 600 ${words(install)} > /tmp/install.log 2>&1; echo install=$?; `
			+ "grep -m1 -o 'EBADENGINE.*' /tmp/install.log | sed 's/^/engine=/'"
		),
		...bins.map(bin =>
			`command -v ${bin} > /dev/null && echo bin.${bin}=ok || echo bin.${bin}=missing`
		),
		`timeout 60 ${words([agent.signIn.command[0]!, "--version"])} < /dev/null > /tmp/v 2>&1; `
		+ "echo version=$? $(head -c 120 /tmp/v | head -n1)",
		`timeout 60 ${words([...agent.signIn.command, "--help"])} < /dev/null > /tmp/h 2>&1; `
		+ "echo signin=$? $(head -c 120 /tmp/h | head -n1)",
		`echo initialize=$(${agent.env.map(variable => `${variable} `).join("")}node /tmp/probe.js ${
			words(agent.acp)
		})`,
	].join("\n");
}

async function check(agent: CodingAgent, node: string) {
	let image = `node:${node}-slim`;
	let child = Bun.spawn([
		"docker",
		"run",
		"--rm",
		"-e",
		"PROBE",
		image,
		"sh",
		"-c",
		script(agent),
	], { env: { ...process.env, PROBE }, stdout: "pipe", stderr: "pipe" });
	let [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	let result: Record<string, string> = {};
	for (let line of stdout.split("\n")) {
		let at = line.indexOf("=");
		if (at > 0) result[line.slice(0, at)] = line.slice(at + 1);
	}
	if (code !== 0 && !stdout) result.docker = stderr.trim().split("\n").at(-1) ?? `exit ${code}`;
	return { agent: agent.id, image, ...result };
}

let args = process.argv.slice(2);
let below = args.includes("--below");
// --node <version> checks every chosen agent at that Node instead, to place a minimum.
let pinned = args.includes("--node") ? args[args.indexOf("--node") + 1] : undefined;
let chosen = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--node");
let agents = AGENTS.filter(agent => !chosen.length || chosen.includes(agent.id));
let runs = agents.flatMap(agent => [
	check(agent, pinned ?? agent.node),
	...(below && !pinned ? [check(agent, String(nodeMajor(agent.node) - 1))] : []),
]);
let results = await Promise.all(runs);
console.log(JSON.stringify(results, null, 2));
// At its minimum Node every agent installs, runs, has its sign-in command and answers initialize.
let failed = results.filter((result, index) => {
	let atMinimum = !below || index % 2 === 0;
	if (!atMinimum) return false;
	let value = result as Record<string, string>;
	return value.install !== "0"
		|| Object.entries(value).some(([key, state]) => key.startsWith("bin.") && state !== "ok")
		|| !value.version?.startsWith("0")
		|| !value.signin?.startsWith("0")
		|| !value.initialize?.startsWith("ok");
});
if (failed.length) {
	console.error(`Agents that failed at their minimum Node: ${failed.map(value => value.agent)}`);
	process.exitCode = 1;
}
