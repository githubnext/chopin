import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { designProblems } from "../check-design.mjs";
import {
	RECORDED_DIRECTORY,
	RECORDED_MANIFEST,
	sha256,
	verifyRecordedSources,
} from "./registry.mjs";
import { scan } from "./scan";

/** What `shadcn add` writes for a button: shadcn's utilities, a class spread and a prop spread. */
let copied = `import { cva } from "class-variance-authority";
import { cn } from "cn";
const buttonVariants = cva("rounded-xl bg-primary shadow-xs duration-100 ease-in text-[13px]");
export function Button({ className, ...props }) {
	return <button className={cn(buttonVariants({ className }))} {...props} />;
}
`;
let FILE = `${RECORDED_DIRECTORY}/ui/button.tsx`;
let version = "shadcn-ui/ui@0123456abcdef";

function entry(file = FILE, content = copied, over: Record<string, unknown> = {}) {
	return {
		file,
		registry: "@shadcn",
		item: "button",
		version,
		sha256: sha256(content),
		...over,
	};
}

function fixture(
	files: Record<string, string>,
	manifest: unknown,
	check: (root: string) => void,
) {
	let root = mkdtempSync(join(tmpdir(), "chopin-recorded-"));
	try {
		mkdirSync(join(root, "apps/web"), { recursive: true });
		mkdirSync(join(root, "packages/visuals"), { recursive: true });
		for (let [path, value] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), value);
		}
		if (manifest !== undefined) {
			mkdirSync(join(root, RECORDED_DIRECTORY), { recursive: true });
			writeFileSync(
				join(root, RECORDED_MANIFEST),
				typeof manifest === "string" ? manifest : JSON.stringify(manifest),
			);
		}
		check(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

let scanned = (findings: unknown[]) => ({ status: 2, stdout: JSON.stringify(findings) });
let record = (...files: ReturnType<typeof entry>[]) => ({ schemaVersion: 1, files });

describe("recorded third-party source", () => {
	test("a recorded copy is accepted whole, and the same source anywhere else is not", () => {
		fixture({ [FILE]: copied, "apps/web/src/button.tsx": copied }, record(entry()), root => {
			let result = scan(root);
			expect(result.recorded.errors).toEqual([]);
			expect([...result.recorded.files]).toEqual([FILE]);
			let findings = result.findings.map(finding => finding.file);
			expect(findings.length).toBeGreaterThan(0);
			expect(new Set(findings)).toEqual(new Set(["apps/web/src/button.tsx"]));
		});
	});

	test("without a record the copy is held to every rule", () => {
		fixture({ [FILE]: copied }, undefined, root => {
			let result = scan(root);
			expect(result.findings.some(finding => finding.file === FILE)).toBe(true);
			expect(result.recorded.errors.join("\n")).toContain("not in");
		});
	});

	test("editing a recorded file by one character loses the acceptance and says why", () => {
		fixture({ [FILE]: copied.replace("rounded-xl", "rounded-2xl") }, record(entry()), root => {
			let result = scan(root);
			expect(result.recorded.files.size).toBe(0);
			expect(result.recorded.errors.join("\n")).toContain("no longer matches its record");
			expect(result.recorded.errors.join("\n")).toContain("@shadcn/button");
			expect(result.findings.some(finding => finding.file === FILE)).toBe(true);
		});
	});

	test("hand-written code cannot hide in the recorded directory", () => {
		let handWritten = `${RECORDED_DIRECTORY}/mine.tsx`;
		fixture({ [FILE]: copied, [handWritten]: copied }, record(entry()), root => {
			let result = scan(root);
			expect(result.recorded.errors.join("\n")).toContain(`${handWritten} is in`);
			expect(result.findings.some(finding => finding.file === handWritten)).toBe(true);
		});
	});

	test("a recorded file that is gone, recorded twice or from an unknown place is an error", () => {
		fixture(
			{},
			record(entry()),
			root => expect(verifyRecordedSources(root).errors.join("\n")).toContain("recorded"),
		);
		fixture(
			{ [FILE]: copied },
			record(entry(), entry()),
			root => expect(verifyRecordedSources(root).errors.join("\n")).toContain("twice"),
		);
		fixture(
			{ [FILE]: copied },
			record(entry(FILE, copied, { registry: "@acme" })),
			root =>
				expect(verifyRecordedSources(root).errors.join("\n")).toContain("registry other than"),
		);
	});

	test("every record names its item, an upstream version and a hash", () => {
		for (
			let change of [
				{ item: "" },
				{ item: "Button" },
				{ version: "latest" },
				{ version: undefined },
				{ sha256: "abc" },
				{ file: "packages/ui/button.tsx" },
				{ file: "apps/web/src/../../secret.tsx" },
			]
		) {
			fixture({ [FILE]: copied }, record(entry(FILE, copied, change)), root => {
				let result = verifyRecordedSources(root);
				expect(result.files.size).toBe(0);
				expect(result.errors.length).toBeGreaterThan(0);
			});
		}
	});

	test("a malformed manifest fails closed", () => {
		fixture({ [FILE]: copied }, "{", root => {
			let result = scan(root);
			expect(result.recorded.errors.join("\n")).toContain("not valid JSON");
			expect(result.findings.some(finding => finding.file === FILE)).toBe(true);
		});
		fixture(
			{ [FILE]: copied },
			{ schemaVersion: 2, files: [] },
			root => expect(verifyRecordedSources(root).errors.join("\n")).toContain("schemaVersion"),
		);
	});

	test("a generated Tailwind layer must come from the Tailwind that is installed", () => {
		let layer = `${RECORDED_DIRECTORY}/geometry.css`;
		let tailwind = (value: string) =>
			entry(layer, ":root{}", {
				registry: "tailwindcss",
				item: "theme.css",
				version: `tailwindcss@${value}`,
			});
		let files = {
			[layer]: ":root{}",
			"apps/web/node_modules/tailwindcss/package.json": JSON.stringify({ version: "4.3.0" }),
		};
		fixture(
			files,
			record(tailwind("4.3.0")),
			root => expect(verifyRecordedSources(root).errors).toEqual([]),
		);
		fixture(
			files,
			record(tailwind("4.2.0")),
			root => expect(verifyRecordedSources(root).errors.join("\n")).toContain("generate it again"),
		);
	});

	test("a file outside the directory but inside src is recorded the same way", () => {
		let utils = "apps/web/src/lib/utils.ts";
		let content = 'export { cn } from "cn";\n';
		fixture(
			{ [utils]: content },
			record(entry(utils, content, { item: "utils" })),
			root => expect([...verifyRecordedSources(root).files]).toEqual([utils]),
		);
	});
});

describe("Impeccable accepts recorded files only", () => {
	let root = resolve(import.meta.dir, "../..");
	let finding = (file: string) => ({
		antipattern: "side-tab",
		file: join(root, file),
		snippet: "border-l-4",
	});
	let baseline = { schemaVersion: 1, findings: [] };

	test("a finding in a recorded file is not new, and the same finding elsewhere is", () => {
		let accepted = new Set([FILE]);
		let results = scanned([finding(FILE), finding("apps/web/src/chat/chat.tsx")]);
		expect(designProblems(results, baseline, root, accepted)).toEqual({
			changes: ["NEW side-tab in apps/web/src/chat/chat.tsx: border-l-4 (1)"],
			count: 1,
		});
		expect(designProblems(results, baseline, root).changes).toHaveLength(2);
	});

	test("a baseline entry for a file that is now recorded is stale", () => {
		let entry = {
			rule: "side-tab",
			file: FILE,
			snippet: "border-l-4",
			count: 1,
			reason: "Old.",
		};
		expect(
			designProblems(
				scanned([finding(FILE)]),
				{ schemaVersion: 1, findings: [entry] },
				root,
				new Set([
					FILE,
				]),
			).changes,
		).toEqual([`STALE baseline side-tab in ${FILE}: border-l-4`]);
	});
});
