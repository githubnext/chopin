const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

function ordinal(day: number): string {
	let teen = day % 100 >= 11 && day % 100 <= 13;
	let suffix = teen ? "th" : ["th", "st", "nd", "rd"][day % 10] ?? "th";
	return `${day}${suffix}`;
}

export function decidedOn(unixSeconds: number): string {
	let at = new Date(unixSeconds * 1_000);
	let hours = at.getHours();
	let minutes = String(at.getMinutes()).padStart(2, "0");
	let clock = `${hours % 12 || 12}:${minutes}${hours < 12 ? "am" : "pm"}`;
	return `Decided on ${MONTHS[at.getMonth()]} ${ordinal(at.getDate())}, ${clock}`;
}

export function discussionLine(owner: string, involved: string[]): string {
	let others = [...new Set(involved)].filter(handle => handle !== owner);
	if (others.length === 0) return `By ${owner}`;
	let list = others.length === 1
		? others[0]
		: `${others.slice(0, -1).join(", ")} and ${others.at(-1)}`;
	return `By ${owner}, in discussion with ${list}`;
}
