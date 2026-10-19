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

/** Who settled a decision and when: the display name without an @, and "19 Oct" when known. */
export function settledBy(
	meta: Pick<Question.CardMeta, "owner" | "resolver" | "decidedAt">,
	name: (handle: string) => string,
): { handle: string; text: string } | undefined {
	let handle = meta.resolver ?? meta.owner;
	if (!handle) return undefined;
	let by = `by ${name(handle).replace(/^@/, "")}`;
	return {
		handle,
		text: meta.decidedAt === undefined ? by : `${by}, ${dayMonth(meta.decidedAt)}`,
	};
}
