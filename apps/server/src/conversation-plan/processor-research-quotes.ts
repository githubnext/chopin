import type { ConversationPlan } from "@chopin/protocol";
import { researchNamedOptionIds } from "./validation";
// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.ts; import/export and synchronous closure wrappers only.

function mentionsOptionLabel(quote: string, label: string): boolean {
	let names = [label, label.trim().split(/\s+/).at(-1) ?? ""];
	return names.some(name => {
		if (name.length < 2 || /^(?:app|service|server|storage|provider|option)$/i.test(name)) {
			return false;
		}
		let escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu")
			.test(quote);
	});
}

function exactOptionName(name: string, label: string): boolean {
	let normalized = name.trim().toLocaleLowerCase().replace(/\s+/g, " ");
	return [label, label.trim().split(/\s+/).at(-1) ?? ""].some(alias =>
		alias.length >= 2 && alias.toLocaleLowerCase() === normalized
	);
}

function exactNamedPair(
	quote: string,
	options: readonly Pick<ConversationPlan.Contribution, "text" | "displayLabel">[],
): boolean {
	let body = quote.trim().replace(/[.!?]$/, "");
	let match = body.match(
		/^compare\s+(.+?)\s+(?:and|or|vs\.?|versus)\s+(.+?)(?:\s+(?:costs?|prices?|pricing))?$/i,
	) ?? body.match(
		/^how do\s+(.+?)\s+and\s+(.+?)\s+(?:costs?|prices?|pricing)\s+compare$/i,
	) ?? body.match(
		/^(.+?)\s+(?:vs\.?|versus)\s+(.+?)(?:\s+(?:costs?|prices?|pricing))?$/i,
	);
	if (!match) return false;
	let first = options.find(option =>
		exactOptionName(match[1]!, option.displayLabel ?? option.text)
	);
	let second = options.find(option =>
		exactOptionName(match[2]!, option.displayLabel ?? option.text)
	);
	return !!first && !!second && first !== second;
}

export function researchQuoteSupportsPair(
	quote: string,
	options: readonly Pick<ConversationPlan.Contribution, "text" | "displayLabel">[],
): boolean {
	if (options.length !== 2) return false;
	if (
		options.some(option =>
			option.displayLabel && mentionsOptionLabel(quote, option.text)
			&& !mentionsOptionLabel(quote, option.displayLabel)
		)
	) return false;
	let named =
		options.filter(option => mentionsOptionLabel(quote, option.displayLabel ?? option.text)).length;
	if (named === 2) return exactNamedPair(quote, options);
	if (named === 0) {
		return /^(?:I|we) (?:don't|do not) know current provider (?:prices|pricing|costs)\.?$/i
			.test(quote);
	}
	let concern = quote.match(
		/^(.+?)['’]s\s+(?:egress|costs?|prices?|pricing|fees?)\s+(?:could|might|may)\s+matter(?:\s+for\s+([^.!?]+))?[.!?]?$/i,
	);
	return !!concern
		&& options.some(option => mentionsOptionLabel(concern[1]!, option.displayLabel ?? option.text))
		&& (!concern[2] || /^[a-z][a-z\s-]{0,80}$/.test(concern[2]));
}

export function researchQuoteFocus(
	quote: string,
	options: readonly ConversationPlan.Contribution[],
): { focusOptionId?: string } | undefined {
	if (![3, 4].includes(options.length)) return;
	let current = options.map(item => ({
		id: item.id,
		labelAtOffer: item.displayLabel ?? item.text,
	}));
	if (
		/^(?:I|we) (?:don't|do not) know current provider (?:prices|pricing|costs)\.?$/i.test(quote)
		|| /^We still need current provider (?:prices|pricing|costs)\.?$/i.test(quote)
	) {
		return {};
	}
	let concern = quote.match(
		/^(.+?)['’]s\s+(?:egress|costs?|prices?|pricing|fees?)\s+(?:could|might|may)\s+matter(?:\s+for\s+([^.!?]+))?[.!?]?$/i,
	);
	if (!concern || concern[2] && !/^[a-z][a-z\s-]{0,80}$/.test(concern[2])) return;
	let named = researchNamedOptionIds(quote, current);
	if (named.length !== 1) return;
	let operand = researchNamedOptionIds(concern[1]!, current);
	if (operand.length !== 1 || operand[0] !== named[0]) return;
	return { focusOptionId: named[0] };
}
