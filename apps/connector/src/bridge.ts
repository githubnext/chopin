import { devNull } from "node:os";
import { resolve } from "node:path";

/**
 * How an agent starts this connector's stdio bridge. A compiled `chopin` binary is its own entry
 * point: its argv[1] is a virtual `/$bunfs/` path inside the binary that no other process can run.
 * A script run keeps Bun from loading the .env and bunfig.toml of the folder the agent starts it in.
 */
export function bridgeCommand(
	compiled = Bun.isStandaloneExecutable,
	execPath = process.execPath,
	script = process.argv[1]!,
) {
	return {
		command: execPath,
		args: compiled
			? ["bridge"]
			: ["--no-env-file", `--config=${devNull}`, resolve(script), "bridge"],
	};
}
