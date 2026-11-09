import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A process the sandbox test starts first and lets look around later: it says it is up, waits for
 * `go` in the folder it was given to write, and then tries to read what the test made after it
 * started, and what it was given, writing what happened beside them. Where its working directory
 * is the person's own checkout, which is read-only, it also tries to write that.
 */
let plan = JSON.parse(process.env.SANDBOX_WATCH!) as {
	/** Paths made after it started, none of which it may be able to read or list. */
	later: string[];
	/** A folder it was given, its files and what each must say now. */
	own: Record<string, string>;
	/** A folder whose entries it must not be able to name. */
	hiddenIn: string[];
	/** The folder it was given to write, where it says it is up and reports. */
	dir: string;
	/** Whether its working directory is the person's checkout, which it must not be able to write. */
	personsCheckout?: boolean;
};
let cwd = plan.dir;
writeFileSync(join(cwd, "up"), "");
while (!existsSync(join(cwd, "go"))) await Bun.sleep(50);

type Outcome = { ok: boolean; detail?: string };
let report: Record<string, Outcome> = {};
let tryRead = (path: string): Outcome => {
	try {
		return {
			ok: false,
			detail: `reads ${JSON.stringify(readFileSync(path, "utf8").slice(0, 40))}`,
		};
	} catch {
		/* Not a readable file; a directory may still list. */
	}
	try {
		let names = readdirSync(path);
		return names.length ? { ok: false, detail: `lists ${names.join(",")}` } : { ok: true };
	} catch {
		return { ok: true };
	}
};
for (let [index, path] of plan.later.entries()) report[`cannotRead${index}`] = tryRead(path);
for (let [index, folder] of plan.hiddenIn.entries()) {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		names = [];
	}
	report[`cannotName${index}`] = {
		ok: !names.some(name => /later|other/.test(name)),
		detail: names.join(","),
	};
}
for (let [path, expected] of Object.entries(plan.own)) {
	try {
		let text = readFileSync(path, "utf8");
		report[`reads ${path}`] = { ok: text === expected, detail: text };
	} catch (error) {
		report[`reads ${path}`] = { ok: false, detail: (error as NodeJS.ErrnoException).code };
	}
}
try {
	writeFileSync(join(cwd, "written"), "ok");
	report.writesWorktree = { ok: true };
} catch (error) {
	report.writesWorktree = { ok: false, detail: (error as NodeJS.ErrnoException).code };
}
if (plan.personsCheckout) {
	try {
		writeFileSync(join(process.cwd(), "written"), "ok");
		report.cannotWriteCheckout = { ok: false, detail: "written" };
	} catch (error) {
		report.cannotWriteCheckout = { ok: true, detail: (error as NodeJS.ErrnoException).code };
	}
}
writeFileSync(join(cwd, "report.json"), JSON.stringify(report));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
