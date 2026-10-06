import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

let root = resolve(import.meta.dir, "..");
let supplied = process.env.LIVEAPP_SOURCE;
if (!supplied) throw new Error("Set LIVEAPP_SOURCE to the library checkout before preparing it");
let source = resolve(root, supplied);

async function run(command: string[], cwd: string) {
	let child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "inherit" });
	let output = await new Response(child.stdout).text();
	if (await child.exited) throw new Error(`${command.join(" ")} failed`);
	return output.trim();
}

console.log("Building the development library…");
await run(["npm", "run", "build"], source);
let directory = resolve(root, ".liveapp-package");
await mkdir(directory, { recursive: true });
let packed = JSON.parse(
	await run(["npm", "pack", "--json", "--pack-destination", directory], source),
);
let archive = resolve(directory, packed[0].filename);
let hash = createHash("sha256").update(await readFile(archive)).digest("hex");
let destination = resolve(directory, `liveapp-${hash.slice(0, 20)}.tgz`);
await rename(archive, destination);
let web = resolve(root, "apps/web");
let manifestPath = resolve(web, "package.json");
let manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.devDependencies.liveapp = relative(web, destination);
await writeFile(manifestPath, JSON.stringify(manifest, null, "\t") + "\n");
await run(["bun", "install", "--registry=https://registry.npmjs.org"], root);
await writeFile(
	resolve(root, "liveapp.package.json"),
	JSON.stringify(
		{
			commit: await run(["git", "rev-parse", "HEAD"], source),
			sha256: hash,
			archive: relative(root, destination),
		},
		null,
		2,
	) + "\n",
);
console.log(`Installed development library ${hash.slice(0, 20)}`);
