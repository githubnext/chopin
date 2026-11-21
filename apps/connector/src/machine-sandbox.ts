import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { builtInRecipe, type ImageRecipe } from "./images";
import {
	guestProgram,
	installNvx,
	NVX_RELEASE,
	nvxSupport,
	programAt,
	type SupportHost,
} from "./nvx";
import type { Output } from "./output";
import {
	createSandbox,
	installedArtifacts,
	MachineUnsupported,
	type Sandbox,
	systemSupportHost,
} from "./sandbox";
import type { SandboxSettings } from "./sandbox-policy";

/** A command chopin can't make an image of: nothing starts, and the words say what to add. */
export class NoRecipe extends Error {
	override name = "NoRecipe";
}

/**
 * The recipe of the image `command`'s program runs from: a built-in agent's, or the commands the
 * owner gave (`--install`, `--planner-install`). One with neither is refused, naming the option.
 */
export function recipeFor(
	command: string[],
	install: string[] | undefined,
	option: string,
): [string, ImageRecipe] {
	let program = guestProgram(command[programAt(command)] ?? "", process.platform);
	if (install?.length) return [program, { name: program, install, programs: [program] }];
	let recipe = builtInRecipe(program);
	if (recipe) return [program, recipe];
	throw new NoRecipe(
		`chopin runs ${program} in a microVM of its own and doesn't know how to install it there. Add ${option} '<the command that installs it>', such as ${option} 'npm install -g ${program}', then run this command again.`,
	);
}

/**
 * The images a machine's agents run from, by program: the agent's, and the Planner command's when
 * it has one. Refuses a command chopin can't make an image of before anything is paired.
 */
export function machineRecipes(options: {
	command: string[];
	plannerCommand?: string[];
	install?: string[];
	plannerInstall?: string[];
}): Map<string, ImageRecipe> {
	let recipes = new Map<string, ImageRecipe>([
		recipeFor(options.command, options.install, "--install"),
	]);
	if (options.plannerCommand?.length) {
		recipes.set(...recipeFor(options.plannerCommand, options.plannerInstall, "--planner-install"));
	}
	return recipes;
}

/** Fetches `url` into `path`, saying how much is in as it goes. */
async function download(url: string, path: string, progress?: (bytes: number) => void) {
	let response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`);
	let bytes = 0;
	let counted = Readable.fromWeb(response.body as never).on("data", (chunk: Buffer) => {
		bytes += chunk.length;
		progress?.(bytes);
	});
	await pipeline(counted, createWriteStream(path, { mode: 0o600 }));
}

/** Unpacks an NVX package with `tar`, which reads `.zip` too on Windows 10 and later. */
function unpack(archive: string, into: string) {
	return new Promise<void>((resolve, reject) => {
		let child = spawn("tar", [archive.endsWith(".zip") ? "-xf" : "-xzf", archive, "-C", into], {
			stdio: ["ignore", "ignore", "pipe"],
			windowsHide: true,
		});
		let errors = "";
		child.stderr.on("data", chunk => errors += chunk);
		child.once("error", reject);
		child.once(
			"close",
			code =>
				code === 0
					? resolve()
					: reject(new Error(`tar couldn't unpack ${archive}: ${errors.trim()}`)),
		);
	});
}

/**
 * The machine's microVMs, ready to start agents: NVX checked and installed, and the image of the
 * agent and of the Planner command built. A machine that can't run NVX throws `MachineUnsupported`
 * before anything is downloaded.
 */
export async function openMachineSandbox(options: {
	directory: string;
	server: string;
	settings?: SandboxSettings;
	/** The images to build, by program (see `machineRecipes`). */
	recipes: Map<string, ImageRecipe>;
	output: Output;
	refused?: (host: string, port: number) => void;
	host?: SupportHost;
	/** False to keep the images no recipe here names (see `SandboxOptions.prune`). */
	prune?: boolean;
}): Promise<Sandbox> {
	let support = nvxSupport(options.host ?? systemSupportHost());
	if (!support.supported) throw new MachineUnsupported(support);
	let { output, recipes } = options;
	let artifacts = installedArtifacts(options.directory);
	if (!artifacts) {
		output.say(
			output.style.dim(
				`… Installing NVX ${NVX_RELEASE.version}, the microVMs agents run in (about 275 MB, once).`,
			),
		);
		let shown = 0;
		artifacts = await installNvx(
			options.directory,
			support.package,
			process.platform,
			download,
			unpack,
			bytes => {
				let megabytes = Math.floor(bytes / 1024 / 1024 / 50) * 50;
				if (megabytes > shown) {
					shown = megabytes;
					output.say(output.style.dim(`  ${megabytes} MB`));
				}
			},
		);
	}
	return createSandbox({
		directory: options.directory,
		server: options.server,
		...options.settings ? { settings: options.settings } : {},
		setup: { artifacts, hypervisor: support.hypervisor },
		recipes,
		building: recipe =>
			output.say(
				output.style.dim(
					`… Building ${recipe.name}'s image for its microVMs (a minute or two, once).`,
				),
			),
		...options.refused ? { refused: options.refused } : {},
		...options.prune === false ? { prune: false } : {},
		wedged: detail => output.error(detail),
	});
}
