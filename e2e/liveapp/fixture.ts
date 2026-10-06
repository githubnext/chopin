import { cp, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function copyApplication(source: string) {
	let parent = join(source, "e2e/.scratch");
	await mkdir(parent, { recursive: true });
	let root = await mkdtemp(join(parent, "frontend-pilot-"));
	let files = Bun.spawnSync(
		["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ cwd: source },
	);
	if (files.exitCode) throw new Error(files.stderr.toString());
	for (let path of files.stdout.toString().split("\0").filter(Boolean)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await cp(join(source, path), join(root, path));
	}
	let record = JSON.parse(await readFile(join(root, "liveapp.package.json"), "utf8"));
	await mkdir(dirname(join(root, record.archive)), { recursive: true });
	await cp(join(source, record.archive), join(root, record.archive));
	return root;
}
