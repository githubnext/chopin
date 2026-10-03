function concepts(label: string): string {
	let words: string[] = label.normalize("NFKC").toLocaleLowerCase().match(/[a-z0-9]+/g) ?? [];
	let action = ["use", "using", "choose"].includes(words[0] ?? "");
	if (action) words.shift();
	if (action && words.includes("for")) words = words.slice(0, words.indexOf("for"));
	let normalized = words.map(word =>
		word.length >= 4 && word.endsWith("s") && !word.endsWith("ss")
			? word.slice(0, -1)
			: word
	).filter(word => !["a", "an", "the", "and"].includes(word));
	// Browser-native can describe an API family; Native can also be part of a product name.
	if (
		normalized.includes("api")
		&& normalized.filter(word => word !== "browser" && word !== "native").length >= 3
	) {
		normalized = normalized.filter(word => word !== "browser" && word !== "native");
	}
	return normalized.join(" ");
}

export function grouped(label: string): boolean {
	let slashParts = label.split(/(?<=[a-z0-9])\s*\/\s*(?=[a-z0-9])/i);
	return /\b(?:or|versus|vs\.?)\b/i.test(label)
		|| /,[^,]+,/.test(label)
		|| /,[^,]+\band\b/i.test(label)
		|| slashParts.length >= 3
		|| (slashParts.length === 2 && /\s\/|\/\s/.test(label));
}

export function sameApproach(left: string, right: string): boolean {
	let a = concepts(left);
	let b = concepts(right);
	if (!a || !b) {
		return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
	}
	return a === b;
}

export function atomicOptionQuote(quote: string, label: string): boolean {
	if (grouped(quote)) return false;
	if (sameApproach(quote, label)) return true;
	let words = quote.normalize("NFKC").toLocaleLowerCase().match(/[a-z0-9]+/g) ?? [];
	return words[0] === "just" && words[1] === "native" && words.length >= 4
		&& sameApproach(words.slice(1).join(" "), label);
}
