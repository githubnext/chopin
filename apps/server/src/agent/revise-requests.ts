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

export function requestedActions(text: string): RequestedAction[] {
	let message = text.toLocaleLowerCase().replace(/[\u2018\u2019]/g, "'")
		.replace(/^\s*@chopin\b[\s,:-]*/, "").trim();
	let verbs = "change|edit|rename|retitle|reword|revise|update|add|include|propose|suggest";
	let start = new RegExp(
		`^(?:(?:please|kindly)\\s+)?(?:(?:(?:can|could|would) you\\s+(?:please\\s+)?`
			+ `|i (?:want|would like) you to\\s+|i'd like you to\\s+))?(${verbs})\\b`,
	);
	let first = start.exec(message);
	let actions: RequestedAction[] = [];
	if (!first) return actions;
	// A withdrawal anywhere in the same message cancels the whole proposed batch.
	if (/\b(?:don't|do not|not|never|no|cancel|withdraw|retract|stop)\b/.test(message)) {
		return actions;
	}
	let commands: Array<{ verb: string; objectStart: number; boundary: number }> = [{
		verb: first[1]!,
		objectStart: first[0].length,
		boundary: 0,
	}];
	let continuation = new RegExp(`\\b(?:and|then)\\s+(?:please\\s+)?(${verbs})\\b`, "g");
	for (let match of message.slice(first[0].length).matchAll(continuation)) {
		let boundary = first[0].length + match.index!;
		commands.push({ verb: match[1]!, objectStart: boundary + match[0].length, boundary });
	}
	for (let [index, command] of commands.entries()) {
		let clause = message.slice(command.objectStart, commands[index + 1]?.boundary);
		if (/^(?:add|include|propose|suggest)$/.test(command.verb)) {
			if (
				/^\s*(?:(?:an?|some|new|the)\s+)?(?:option|options|choice|choices|alternative|alternatives)\b/
					.test(clause)
			) {
				actions.push({ kind: "option", clause });
			}
		} else if (/^\s*(?:the\s+)?(?:question|title|wording)\b/.test(clause)) {
			actions.push({ kind: "title", clause });
		}
	}
	return actions;
}

export function explicitRequest(
	text: string,
	target: Target,
	allTargets: Target[],
	args: Input,
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
