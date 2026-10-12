import { resolve } from "node:path";
import { buildBinaries, hostTarget } from "../../scripts/build-binaries";

/**
 * The compiled `chopin` binary, as people install it. CI passes the release build through
 * CHOPIN_BINARY; otherwise this compiles one for the host into `directory`. Undefined where
 * `bun build --compile` is unavailable.
 */
export async function compiledChopin(directory: string) {
	if (process.env.CHOPIN_BINARY) return resolve(process.env.CHOPIN_BINARY);
	try {
		return (await buildBinaries([hostTarget()], directory))[0];
	} catch (error) {
		console.warn(
			"Skipping the compiled chopin binary tests: `bun build --compile` is unavailable here.\n"
				+ (error instanceof Error ? error.message : String(error)),
		);
	}
}
