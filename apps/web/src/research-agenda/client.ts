import type { Agenda } from "@chopin/protocol";

export class AgendaError extends Error {
	constructor(readonly status: number) {
		super(
			status === 409
				? "The agenda changed while you were editing. Review the latest version before saving."
				: status === 401 || status === 403
				? "Your access changed. Reopen the document to continue."
				: status === 400
				? "Check the scope and questions, then try again."
				: "Could not update the research agenda. Try again.",
		);
	}
}

export async function request(
	channelId: string,
	action: "load" | "save" | "activate" | "pause",
	input?: Agenda.Save | Agenda.Pause | { expectedRevision: number },
	signal?: AbortSignal,
): Promise<Agenda.Response> {
	let path = `/api/channels/${encodeURIComponent(channelId)}/research-agenda`;
	let response = await fetch(
		path + (action === "activate" || action === "pause" ? `/${action}` : ""),
		{
			method: action === "load" ? "GET" : action === "save" ? "PUT" : "POST",
			headers: input ? { "Content-Type": "application/json" } : undefined,
			body: input ? JSON.stringify(input) : undefined,
			signal,
		},
	);
	if (!response.ok) throw new AgendaError(response.status);
	return await response.json() as Agenda.Response;
}
