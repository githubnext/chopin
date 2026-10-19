import type { Question } from "@chopin/protocol";

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

/** "19 Oct": day then month, in the reader's own time zone. */
export function dayMonth(at: number): string {
	let date = new Date(at * 1_000);
	return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** "Settled by Ada, 19 Oct", naming the person by display name rather than @handle. */
export function settledLine(
	meta: Pick<Question.CardMeta, "owner" | "resolver" | "decidedAt">,
	name: (handle: string) => string,
): string | undefined {
	let who = meta.resolver ?? meta.owner;
	if (!who) return undefined;
	let by = name(who).replace(/^@/, "");
	return meta.decidedAt === undefined
		? `Settled by ${by}`
		: `Settled by ${by}, ${dayMonth(meta.decidedAt)}`;
}
