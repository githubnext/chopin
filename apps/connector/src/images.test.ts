import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureImages,
	type ImageBuilder,
	imageKey,
	type ImageRecipe,
	installInputs,
	pruneImages,
} from "./images";

let scratch = await mkdtemp(join(tmpdir(), "chopin-images-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

let made = 0;
/** A folder of `files`, by path inside it, each with its content, and executable when it says. */
async function folder(files: Record<string, string | { content: string; executable: true }>) {
	let root = join(scratch, `folder-${made++}`);
	await mkdir(root, { mode: 0o700 });
	for (let [path, file] of Object.entries(files)) {
		await mkdir(join(root, path, ".."), { recursive: true, mode: 0o700 });
		let content = typeof file === "string" ? file : file.content;
		await writeFile(join(root, path), content, { mode: typeof file === "string" ? 0o600 : 0o700 });
	}
	return root;
}

const RECIPE: ImageRecipe = {
	name: "pdd",
	install: ["npm install -g /install-from/agent.tgz"],
	programs: ["agent"],
};
const USER = { uid: 1000, gid: 1000 };
const LAYER = "11111111-2222-4333-8444-555555555555";

/**
 * A builder that stands in for the build's microVM: its layer names the install it was made by,
 * and an image has the programs `installed` says that install puts in it. It records each build,
 * and holds each one until `release` is called when made `held`.
 */
function fakeBuilder(installed: Record<string, string[]>, { held = false } = {}) {
	let builds: string[][] = [];
	let checked: string[][] = [];
	let gate = Promise.withResolvers<void>();
	if (!held) gate.resolve();
	let started = Promise.withResolvers<void>();
	let builder: ImageBuilder = {
		async build(recipe, job) {
			builds.push(recipe.install);
			started.resolve();
			await gate.promise;
			await writeFile(job.layer, JSON.stringify({ install: recipe.install, uuid: job.uuid }));
		},
		async missing(image, programs) {
			checked.push(programs);
			let made = JSON.parse(await readFile(image.layer.path, "utf8")) as { install: string[] };
			let has = installed[made.install.join("\n")] ?? [];
			return programs.filter(program => !has.includes(program));
		},
	};
	return { builder, builds, checked, started: started.promise, release: gate.resolve };
}

let states = 0;
async function state() {
	let base = join(scratch, `state-${states++}`);
	await mkdir(base, { recursive: true, mode: 0o700 });
	return base;
}

function options(
	base: string,
	builder: ImageBuilder,
	heard: { building?: string[][]; waiting?: string[][] } = {},
) {
	return {
		base,
		layer: LAYER,
		user: USER,
		builder,
		building: (recipes: ImageRecipe[]) => heard.building?.push(recipes.map(item => item.name)),
		waiting: (recipes: ImageRecipe[]) => heard.waiting?.push(recipes.map(item => item.name)),
	};
}

const AGENT: ImageRecipe = {
	name: "agent",
	install: ["npm install -g agent"],
	programs: ["agent"],
};
const PLANNER: ImageRecipe = {
	name: "my-planner",
	install: ["npm install -g agent"],
	programs: ["my-planner"],
	planner: true,
};

describe("the folder --install-from names", () => {
	test("an image is built again when a file in it changes, is added or becomes executable", async () => {
		let key = async (files: Parameters<typeof folder>[0]) =>
			imageKey(RECIPE, LAYER, USER, await installInputs(await folder(files)));
		let first = await key({ "agent.tgz": "release 1", "deps/natives.tgz": "natives 1" });
		expect(await key({ "agent.tgz": "release 1", "deps/natives.tgz": "natives 1" })).toBe(first);
		expect(await key({ "agent.tgz": "release 2", "deps/natives.tgz": "natives 1" })).not.toBe(
			first,
		);
		expect(
			await key({ "agent.tgz": "release 1", "deps/natives.tgz": "natives 1", "extra.tgz": "x" }),
		).not.toBe(first);
		expect(
			await key({
				"agent.tgz": { content: "release 1", executable: true },
				"deps/natives.tgz": "natives 1",
			}),
		).not.toBe(first);
		// A file moved to another folder is another input.
		expect(await key({ "agent.tgz": "release 1", "natives.tgz": "natives 1" })).not.toBe(first);
	});

	test("the build gets a copy anyone may read, of exactly what the key was made of", async () => {
		let source = await folder({
			"agent.tgz": "release 1",
			"bin/setup": { content: "#!/bin/sh\n", executable: true },
		});
		let copy = join(scratch, "copy");
		await mkdir(copy);
		expect(await installInputs(source, copy)).toBe(await installInputs(source));
		expect(await Bun.file(join(copy, "agent.tgz")).text()).toBe("release 1");
		let mode = async (path: string) => (await stat(join(copy, path))).mode & 0o777;
		// The person's folder is theirs alone (0700); the build's nobody reads the copy.
		expect(await mode("agent.tgz")).toBe(0o644);
		expect(await mode("bin")).toBe(0o755);
		expect(await mode("bin/setup")).toBe(0o755);
	});

	test("a changed file builds the image again before the next launch is handed it", async () => {
		let inputs = await folder({ "agent.tgz": "release 1" });
		let recipes = new Map([["agent", { ...RECIPE, from: inputs }]]);
		let { builder, builds } = fakeBuilder({ "npm install -g /install-from/agent.tgz": ["agent"] });
		let base = await state();
		let first = await ensureImages(recipes, options(base, builder));
		await writeFile(join(inputs, "agent.tgz"), "release 2");
		let second = await ensureImages(recipes, options(base, builder));
		expect(builds).toHaveLength(2);
		expect(second.get("agent")!.layer.path).not.toBe(first.get("agent")!.layer.path);
	});

	test("a link in it is refused rather than followed to what it names on the host", async () => {
		let source = await folder({ "agent.tgz": "release 1" });
		await symlink("/etc/passwd", join(source, "passwd"));
		await chmod(source, 0o700);
		await expect(installInputs(source)).rejects.toThrow(
			`${
				join(source, "passwd")
			} isn't a file or a folder, and an image's build is given only those.`,
		);
	});
});

describe("the images a machine's launches run from", () => {
	test("an agent and a Planner with the same install share one image, built once and checked for both programs", async () => {
		let { builder, builds, checked } = fakeBuilder({
			"npm install -g agent": ["agent", "my-planner"],
		});
		let heard = { building: [] as string[][] };
		let images = await ensureImages(
			new Map([["agent", AGENT], ["my-planner", PLANNER]]),
			options(await state(), builder, heard),
		);
		expect(builds).toEqual([["npm install -g agent"]]);
		expect(checked).toEqual([["agent", "my-planner"]]);
		expect(heard.building).toEqual([["agent", "my-planner"]]);
		expect(images.get("my-planner")).toEqual(images.get("agent")!);
		// Which program a launch runs is no part of the key.
		expect(imageKey(PLANNER, LAYER, USER)).toBe(imageKey(AGENT, LAYER, USER));
	});

	test("a shared image without the Planner's program fails, saying so, and leaves no image", async () => {
		let { builder } = fakeBuilder({ "npm install -g agent": ["agent"] });
		let base = await state();
		let failed = await ensureImages(
			new Map([["agent", AGENT], ["my-planner", PLANNER]]),
			options(base, builder),
		).catch(error => error);
		expect(failed).toBeInstanceOf(Error);
		expect(failed.message).toBe(
			"The image agent and my-planner share was built, but has no my-planner: check its install "
				+ "commands.",
		);
		expect((await readdir(join(base, "images"))).filter(name => name.endsWith(".erofs")))
			.toEqual([]);
	});

	test("an image built for the agent alone is checked for the Planner's program when the Planner shares it, not built again", async () => {
		let base = await state();
		let { builder, builds, checked } = fakeBuilder({ "npm install -g agent": ["agent"] });
		let agent = await ensureImages(new Map([["agent", AGENT]]), options(base, builder));
		let heard = { building: [] as string[][] };
		let failed = await ensureImages(
			new Map([["agent", AGENT], ["my-planner", PLANNER]]),
			options(base, builder, heard),
		).catch(error => error);
		expect(failed.message).toBe(
			"The image agent and my-planner share has no my-planner: check its install commands.",
		);
		expect(builds).toHaveLength(1);
		expect(heard.building).toEqual([]);
		expect(checked).toEqual([["agent"], ["my-planner"]]);
		// The agent's image is kept, as good as it was.
		expect(await stat(agent.get("agent")!.layer.path).then(() => true)).toBe(true);

		let { builder: fixed, builds: rebuilt, checked: again } = fakeBuilder({
			"npm install -g agent": ["agent", "my-planner"],
		});
		let images = await ensureImages(
			new Map([["agent", AGENT], ["my-planner", PLANNER]]),
			options(base, fixed),
		);
		expect(rebuilt).toEqual([]);
		expect(again).toEqual([["my-planner"]]);
		expect(images.get("my-planner")).toEqual(agent.get("agent")!);
		// Once found there, it isn't checked again.
		await ensureImages(new Map([["my-planner", PLANNER]]), options(base, fixed));
		expect(again).toEqual([["my-planner"]]);
	});

	test("an agent and a Planner with different installs get an image each, one build and one line each", async () => {
		let planner = { ...PLANNER, install: ["npm install -g my-planner"] };
		let { builder, builds } = fakeBuilder({
			"npm install -g agent": ["agent"],
			"npm install -g my-planner": ["my-planner"],
		});
		let heard = { building: [] as string[][] };
		let images = await ensureImages(
			new Map([["agent", AGENT], ["my-planner", planner]]),
			options(await state(), builder, heard),
		);
		expect(builds).toEqual([["npm install -g agent"], ["npm install -g my-planner"]]);
		expect(heard.building).toEqual([["agent"], ["my-planner"]]);
		expect(images.get("my-planner")!.layer.path).not.toBe(images.get("agent")!.layer.path);
	});

	test("a Planner build that fails fails with the build's own words", async () => {
		let builder: ImageBuilder = {
			build: async () => {
				throw new Error("Couldn't build my-planner's image (exit 1):\nnpm error 404 my-planner");
			},
			missing: async () => [],
		};
		let failed = await ensureImages(
			new Map([["my-planner", { ...PLANNER, install: ["npm install -g my-planner"] }]]),
			options(await state(), builder),
		).catch(error => error);
		expect(failed.message).toBe(
			"Couldn't build my-planner's image (exit 1):\nnpm error 404 my-planner",
		);
	});

	test("a changed Planner install builds its own image before it is handed out, and the agent's stays", async () => {
		let base = await state();
		let changed = { ...PLANNER, install: ["npm install -g my-planner@2"] };
		let { builder, builds } = fakeBuilder({
			"npm install -g agent": ["agent", "my-planner"],
			"npm install -g my-planner@2": ["my-planner"],
		});
		let before = await ensureImages(
			new Map([["agent", AGENT], ["my-planner", PLANNER]]),
			options(base, builder),
		);
		let after = await ensureImages(
			new Map([["agent", AGENT], ["my-planner", changed]]),
			options(base, builder),
		);
		expect(builds).toEqual([["npm install -g agent"], ["npm install -g my-planner@2"]]);
		expect(after.get("agent")).toEqual(before.get("agent")!);
		let made = JSON.parse(await readFile(after.get("my-planner")!.layer.path, "utf8"));
		expect(made.install).toEqual(["npm install -g my-planner@2"]);
	});
});

describe("one build of an image at a time", () => {
	test("two chopins that need one image at once run one build, and the second waits for it", async () => {
		let base = await state();
		let { builder, builds, started, release } = fakeBuilder(
			{ "npm install -g agent": ["agent", "my-planner"] },
			{ held: true },
		);
		let heard = { building: [] as string[][], waiting: [] as string[][] };
		let recipes = new Map([["agent", AGENT], ["my-planner", PLANNER]]);
		let first = ensureImages(recipes, options(base, builder, heard));
		await started;
		let second = ensureImages(recipes, options(base, builder, heard));
		// The second finds the build under way and waits; nothing more starts.
		while (!heard.waiting.length) await Bun.sleep(10);
		expect(builds).toHaveLength(1);
		release();
		let [one, two] = await Promise.all([first, second]);
		expect(builds).toHaveLength(1);
		expect(heard.building).toEqual([["agent", "my-planner"]]);
		expect(heard.waiting).toEqual([["agent", "my-planner"]]);
		expect(two.get("my-planner")).toEqual(one.get("my-planner")!);
	});

	test.skipIf(process.platform === "win32")(
		"a build a chopin that died left under way is taken over",
		async () => {
			let base = await state();
			let key = imageKey(AGENT, LAYER, USER);
			await mkdir(join(base, "images"), { recursive: true });
			// A process that has exited, whose number no process has now.
			let dead = spawnSync("true").pid!;
			await writeFile(join(base, "images", `${key}.lock`), JSON.stringify({ pid: dead }));
			let { builder, builds } = fakeBuilder({ "npm install -g agent": ["agent"] });
			await ensureImages(new Map([["agent", AGENT]]), options(base, builder));
			expect(builds).toHaveLength(1);
			expect(await readdir(join(base, "images"))).toEqual([`${key}.erofs`, `${key}.json`]);
		},
	);

	test.skipIf(process.platform === "win32")(
		"pruning keeps an image another chopin is building, and removes what a chopin that died left",
		async () => {
			let base = await state();
			let images = join(base, "images");
			await mkdir(join(images, "cache"), { recursive: true });
			let names = {
				kept: ["a1.erofs", "a1.json"],
				building: ["b2.lock", "b2.building-1234"],
				unused: ["c3.erofs", "c3.json"],
				abandoned: ["d4.lock", "d4.building-5678"],
			};
			for (let name of Object.values(names).flat()) {
				if (name.includes(".building-")) await mkdir(join(images, name));
				else await writeFile(join(images, name), "");
			}
			await writeFile(join(images, "b2.lock"), JSON.stringify({ pid: process.pid }));
			await writeFile(join(images, "d4.lock"), JSON.stringify({ pid: spawnSync("true").pid }));
			await pruneImages(base, ["a1"]);
			expect((await readdir(images)).sort()).toEqual(
				["a1.erofs", "a1.json", "b2.building-1234", "b2.lock", "cache"],
			);
		},
	);
});
