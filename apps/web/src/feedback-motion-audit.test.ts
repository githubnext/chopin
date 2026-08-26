import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function app(path: string): string {
	return readFileSync(join(import.meta.dir, path), "utf8");
}

function workspace(path: string): string {
	return readFileSync(join(import.meta.dir, "../../..", path), "utf8");
}

function section(source: string, from: string, to: string): string {
	return source.slice(source.indexOf(from), source.indexOf(to));
}

describe("feedback motion audit", () => {
	it("marks completed action errors as terminal alert feedback", () => {
		for (
			let path of [
				"add-project-dialog.tsx",
				"chat/chat.tsx",
				"delete-document-dialog.tsx",
				"document-picker.tsx",
				"document-rename.tsx",
				"navigation-shell.tsx",
				"repository-picker.tsx",
				"research-actions.tsx",
				"research-workspace.tsx",
			]
		) {
			expect({ path, terminal: app(path).includes('data-motion-feedback="alert"') })
				.toEqual({ path, terminal: true });
		}
		expect(
			workspace("packages/question/src/react/question-view.tsx"),
		).toContain('data-motion-feedback="alert"');
	});

	it("keeps typing, selection, streaming, and live status feedback immediate", () => {
		let references = app("chat/reference-picker.tsx");
		expect(references).not.toContain("motion-feedback");
		expect(references).not.toMatch(/\btransition\b/);
		expect(app("document-search-dialog.tsx")).not.toContain("motion-feedback");
		let transcript = app("chat/transcript.tsx");
		expect(transcript).not.toContain("animate-enter");
		expect(transcript).not.toContain("animate-pulse");
		expect(transcript).not.toContain("chat-working");
		expect(workspace("packages/editor/src/status.tsx")).not.toContain("animate-enter");
		let theme = app("theme.css");
		expect(theme).not.toContain("@utility animate-enter");
		expect(theme).not.toContain("workspace-working-spin");
		expect(theme).not.toContain("chat-working-shimmer");

		for (
			let path of [
				"packages/editor/src/toolbar/bubble.tsx",
				"packages/editor/src/toolbar/slash.tsx",
			]
		) {
			let source = workspace(path);
			expect({ path, motion: /motion-|animate-|\btransition\b/.test(source) }).toEqual({
				path,
				motion: false,
			});
		}

		let research = section(
			app("research-workspace.tsx"),
			"function JobProgress(",
			"function SourceCitations(",
		);
		expect(research).not.toMatch(/motion-|animate-|\btransition\b/);
	});

	it("animates the Planner change count without animating repeated list disclosure", () => {
		let changes = workspace("packages/editor/src/changes-chip.tsx");
		expect(changes).toContain('data-motion-feedback="count"');
		expect(changes).not.toContain("animate-enter");
	});

	it("keys the completed tool disclosure icon by semantic state", () => {
		let transcript = app("chat/transcript.tsx");
		expect(transcript).toContain("toolChevronDown");
		expect(transcript).toContain("toolChevronRight");
		expect(transcript).toContain('data-motion-feedback="icon"');
		expect(transcript).toContain('data-feedback-icon={open ? "open" : "closed"}');
		expect(transcript).toContain('key={open ? "open" : "closed"}');
	});
});
