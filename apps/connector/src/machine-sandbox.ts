import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { builtInRecipe, imageName, type ImageRecipe } from "./images";
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
	type Unsupported,
} from "./sandbox";
import type { SandboxSettings } from "./sandbox-policy";

/** A command chopin can't make an image of: nothing starts, and the words say what to add. */
export class NoRecipe extends Error {
	override name = "NoRecipe";
}

/**
 * The recipe of the image `command`'s program runs from: a built-in agent's, or the commands the
 * owner gave (`--install`, `--planner-install`), which read the folder `from` (`--install-from`).
 * One with neither is refused, naming the option.
 */
export function recipeFor(
	command: string[],
	install: string[] | undefined,
	option: string,
	from?: string,
): [string, ImageRecipe] {
	let program = guestProgram(command[programAt(command)] ?? "", process.platform);
	if (install?.length) {
		return [program, { name: program, install, programs: [program], ...from ? { from } : {} }];
	}
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
	/** `--install-from`: the folder the install commands read. */
	installFrom?: string;
}): Map<string, ImageRecipe> {
	let [agent, recipe] = recipeFor(
		options.command,
		options.install,
		"--install",
		options.installFrom,
	);
	let recipes = new Map<string, ImageRecipe>([[agent, { ...recipe, runs: ["agent"] }]]);
	if (options.plannerCommand?.length) {
		let [program, recipe] = recipeFor(
			options.plannerCommand,
			options.plannerInstall,
			"--planner-install",
			options.installFrom,
		);
		// A launch finds its image by its program, so a Planner command that starts the agent's
		// program runs from the one image the agent does.
		recipes.set(program, {
			...recipe,
			runs: program === agent ? ["agent", "planner"] : ["planner"],
		});
	}
	return recipes;
}

/**
 * What `chopin connect` says as it builds an image, which takes a minute or two once: whose it is,
 * and for the Planner's, that it is built now so the first document's Planner starts at once.
 */
export function buildingWords(recipes: ImageRecipe[]): string {
	let agents = [
		...new Set(
			recipes.filter(item => !item.runs || item.runs.includes("agent")).map(item => item.name),
		),
	];
	let planner = recipes.find(item => item.runs?.includes("planner"))?.name;
	if (!planner) return `Building ${imageName(recipes)} for its microVMs (a minute or two, once).`;
	let why = "(a minute or two, once, so the first document's Planner starts at once)";
	return agents.length
		? `Building one image for ${agents.join(" and ")} and the Planner (${planner}), whose installs `
			+ `are the same, for their microVMs ${why}.`
		: `Building the Planner's image (${planner}) for its microVMs ${why}.`;
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
 * The machine's microVMs, ready to start agents: NVX checked and installed, and every image a
 * launch here needs built, the agent's and the Planner command's, one for both where their installs
 * are the same. It says each build as it starts. A machine that can't run NVX throws
 * `MachineUnsupported` before anything is downloaded; a build that fails throws its own words.
 */
export async function openMachineSandbox(options: {
	directory: string;
	server: string;
	settings?: SandboxSettings;
	/** The images to build, by program (see `machineRecipes`). */
	recipes: Map<string, ImageRecipe>;
	output: Output;
	refused?: (host: string, port: number) => void;
	/** Hears that this machine can't run microVMs any more, and why (see `VmOptions`). */
	unsupported?: (problem: Unsupported) => void;
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
		building: recipes => output.say(output.style.dim(`… ${buildingWords(recipes)}`)),
		waiting: recipes =>
			output.say(
				output.style.dim(
					`… Waiting for another chopin on this machine to finish building ${imageName(recipes)}.`,
				),
			),
		...options.refused ? { refused: options.refused } : {},
		...options.unsupported ? { unsupported: options.unsupported } : {},
		...options.host ? { host: options.host } : {},
		...options.prune === false ? { prune: false } : {},
		wedged: detail => output.error(detail),
		retrying: detail => output.say(output.style.dim(`… ${detail}`)),
	});
}
