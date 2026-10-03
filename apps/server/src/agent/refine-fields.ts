import { assertSourceShape } from "../conversation-plan/sources";
import type { ConversationPlan } from "@chopin/protocol";

export type Address = { index: number; digest: string };

export type Option = { label: string; rationale: string; source?: ConversationPlan.SourceRef };

export type Input = {
	revision: number;
	id: string;
	title?: string;
	add_options: Option[];
	place_after?: Address;
};

export function input(raw: unknown): Input {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("refine_decision arguments must be an object");
	}
	let value = raw as Record<string, unknown>;
	if (
		!Object.hasOwn(value, "revision") || !Object.hasOwn(value, "id")
		|| Object.keys(value).some(key =>
			!["revision", "id", "title", "add_options", "place_after"].includes(key)
		)
	) throw new Error("refine_decision arguments are invalid");
	if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
		throw new Error("revision must be a nonnegative integer");
	}
	if (typeof value.id !== "string" || !value.id) throw new Error("decision id is required");
	let title: string | undefined;
	if (Object.hasOwn(value, "title")) {
		title = typeof value.title === "string" ? value.title.trim() : "";
		if (!title || title.length > 80 || /[\r\n\u2028\u2029]/.test(value.title as string)) {
			throw new Error("title must be 1–80 characters on one line.");
		}
	}
	let add_options: Option[] = [];
	if (Object.hasOwn(value, "add_options")) {
		if (!Array.isArray(value.add_options) || value.add_options.length > 10) {
			throw new Error("add_options must contain at most ten options");
		}
		for (let rawOption of value.add_options) {
			if (
				!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)
				|| Object.keys(rawOption).some(key =>
					key !== "label" && key !== "rationale" && key !== "source"
				)
				|| !Object.hasOwn(rawOption, "label") || !Object.hasOwn(rawOption, "rationale")
			) throw new Error("each option needs a label and rationale");
			let option = rawOption as Record<string, unknown>;
			let label = typeof option.label === "string" ? option.label.trim() : "";
			let rationale = typeof option.rationale === "string" ? option.rationale.trim() : "";
			if (!label || label.length > 200) {
				throw new Error("option label must be 1–200 characters");
			}
			if (!rationale || rationale.length > 300) {
				throw new Error("option rationale must be 1–300 characters");
			}
			let source: ConversationPlan.SourceRef | undefined;
			if (Object.hasOwn(option, "source")) {
				try {
					assertSourceShape(option.source);
				} catch {
					throw new Error("source-shape");
				}
				source = option.source;
				if (source.role !== "option" && source.role !== "question") {
					throw new Error("option source must have option or question role");
				}
			}
			add_options.push({ label, rationale, ...(source ? { source } : {}) });
		}
	}
	let place_after: Address | undefined;
	if (Object.hasOwn(value, "place_after")) {
		let rawAddress = value.place_after;
		if (
			!rawAddress || typeof rawAddress !== "object" || Array.isArray(rawAddress)
			|| Object.keys(rawAddress).sort().join(",") !== "digest,index"
		) throw new Error("place_after must identify one block");
		let address = rawAddress as Record<string, unknown>;
		if (
			!Number.isSafeInteger(address.index) || (address.index as number) < 0
			|| typeof address.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(address.digest)
		) throw new Error("place_after must identify one block");
		place_after = { index: address.index as number, digest: address.digest };
	}
	return {
		revision: value.revision as number,
		id: value.id,
		...(title ? { title } : {}),
		add_options,
		...(place_after ? { place_after } : {}),
	};
}
