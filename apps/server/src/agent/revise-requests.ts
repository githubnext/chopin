import type { Input } from "./revise-fields";

export type Target = { id: string; header: string; question: string };

export type RequestedAction = { kind: "title" | "option"; clause: string };

export function words(value: string): string[] {
	return value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function names(target: Target): string[] {
	return [target.id, target.header, target.question]
		.map(value => words(value).join(" "))
		.filter(Boolean);
}

function requestedAction(verb: string, clause: string): RequestedAction | undefined {
	if (/^(?:add|include|propose|suggest)$/.test(verb)) {
		if (
			/^\s*(?:(?:an?|some|new|the|these|those|my)\s+)?(?:option|options|choice|choices|alternative|alternatives)\b/
				.test(clause)
		) return { kind: "option", clause };
	} else if (/^\s*(?:the\s+)?(?:question|title|wording)\b/.test(clause)) {
		return { kind: "title", clause };
	}
	return undefined;
}

export function requestedActions(text: string): RequestedAction[] {
	let source = text.toLocaleLowerCase()
		.replace(/^\s*@chopin\b[\s,:-]*/, "").trim();
	let message = source.replace(/[\u2018\u2019]/g, "'");
	// Preserve offsets so quoted target names can still be read in an unquoted command.
	let unquoted = source
		.replace(
			/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`]*`|"[^"]*"|“[^”]*”|‘[^’]*’|(^|\s)'[^']*'/g,
			quote => " ".repeat(quote.length),
		)
		.replace(/^[\t ]*>.*$/gm, quote => " ".repeat(quote.length))
		.replace(/[\u2018\u2019]/g, "'");
	let verbs = "change|edit|rename|retitle|reword|revise|update|add|include|propose|suggest";
	let start = new RegExp(
		`^(?:(?:please|kindly)\\s+)?(?:(?:(?:can|could|would) you\\s+(?:please\\s+)?`
			+ `|i (?:want|would like) you to\\s+|i'd like you to\\s+))?(${verbs})\\b`,
	);
	let actions: RequestedAction[] = [];
	// A withdrawal or deferral anywhere in the same message cancels the proposed batch.
	if (
		/\b(?:don't|do not|not|never|no|cancel|withdraw|retract|stop)\b/.test(message)
		|| /\b(?:wait (?:until|for)|hold off|defer (?:this|that|the) (?:request|edit|change))\b/
			.test(message)
	) {
		return actions;
	}
	let scoped = false;
	for (let segment of unquoted.matchAll(/[^.!?;\r\n]+/g)) {
		let preceding = unquoted.slice(0, segment.index);
		let sentence = segment[0];
		let first = start.exec(sentence.trimStart());
		if (!first) {
			// A directive with unexplained trailing prose may be conditional or withdrawn.
			if (actions.length > 0 && sentence.trim()) return [];
			if (
				sentence.trimEnd().endsWith(":") || sentence.split(":").slice(1).some(part => {
					let command = part.trimStart();
					let directive = start.exec(command);
					return directive && requestedAction(directive[1]!, command.slice(directive[0].length));
				})
			) scoped = true;
			continue;
		}
		// A contextual colon scopes its paragraph. A block or embedded decision directive
		// retains that scope across paragraph breaks, whose meaning is ambiguous.
		let context = preceding.split(/\r?\n[\t ]*\r?\n/).at(-1)!;
		if (scoped || context.includes(":")) {
			if (actions.length > 0) return [];
			continue;
		}
		let offset = sentence.length - sentence.trimStart().length;
		let commands: Array<{ verb: string; objectStart: number; boundary: number }> = [{
			verb: first[1]!,
			objectStart: offset + first[0].length,
			boundary: 0,
		}];
		let continuation = new RegExp(`\\b(?:and|then)\\s+(?:please\\s+)?(${verbs})\\b`, "g");
		for (let match of sentence.slice(commands[0]!.objectStart).matchAll(continuation)) {
			let boundary = commands[0]!.objectStart + match.index!;
			commands.push({ verb: match[1]!, objectStart: boundary + match[0].length, boundary });
		}
		for (let [index, command] of commands.entries()) {
			let clause = message.slice(
				segment.index! + command.objectStart,
				segment.index! + (commands[index + 1]?.boundary ?? sentence.length),
			);
			let action = requestedAction(command.verb, clause);
			if (action) actions.push(action);
		}
	}
	return actions;
}

export function explicitRequest(
	text: string,
	target: Target,
	allTargets: Target[],
	args: Input,
	soleOptionTarget?: string,
): void {
	let actions = requestedActions(text);
	let supports = (kind: RequestedAction["kind"], refusal: string) => {
		let matches = actions.filter(action => action.kind === kind);
		if (matches.length === 0) throw new Error(refusal);
		let named = matches.some(action => {
			let clause = ` ${words(action.clause).join(" ")} `;
			if (/\b(?:instead of|rather than|except)\b/.test(clause)) return false;
			let mentioned = allTargets.filter(candidate =>
				names(candidate).some(name => clause.includes(` ${name} `))
			);
			if (mentioned.length === 0 && kind === "option" && soleOptionTarget === target.id) {
				return /\b(?:to|for) (?:the|this) decision $/.test(clause);
			}
			if (mentioned.length !== 1 || mentioned[0]?.id !== target.id) return false;
			return [...clause.matchAll(/\b(?:to|for)\s+(?:the\s+)?/g)].some(match => {
				let after = clause.slice(match.index! + match[0].length);
				return names(target).some(name => after.startsWith(`${name} `));
			});
		});
		if (!named) {
			throw new Error("the current member request must identify this decision in that action");
		}
	};
	if (args.title !== undefined) {
		supports("title", "the current member did not request a question edit");
	}
	if (args.add_options.length > 0) {
		supports("option", "the current member did not request new options");
	}
}
