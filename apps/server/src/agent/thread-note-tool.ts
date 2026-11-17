import { tool } from "ai";
import { z } from "zod";

import { MAX_DECIDERS, MAX_DECISION_LENGTH } from "../chat/thread-notes";

import type { TellChat } from "../chat/thread-notes";

export const threadNoteInput = z.object({
	decision: z.string().min(1).max(MAX_DECISION_LENGTH).describe(
		"What was decided, in one or two plain sentences that make sense without the thread.",
	),
	decidedBy: z.array(z.string().min(1).max(39)).max(MAX_DECIDERS).optional().describe(
		"Handles of the people who decided. Leave it out when it is whoever answered the Decision "
			+ "card, or else the person whose message you are answering.",
	),
	question: z.string().min(1).max(128).optional().describe(
		"The id of the Decision card the person answered, when the decision was an answer to one.",
	),
}).strict();

const DESCRIPTION = `You are answering in a thread: a side conversation forked from this document's
Chat. The Planner answering the Chat itself does not see what is said here, so tell it what a
person decides here, or its next turn can contradict it. The note goes only to this document's
Chat Planner, which reads it before its next turn; it is not posted in Chat and starts nothing.

Send one note for each Decision card a person answered in this thread, with its id in
\`question\`; a card is noted once. Also send one when a person settles something in words that
you act on: they choose an approach, agree to a proposal, or rule an option out. Send nothing when
nothing was decided, for your own suggestions, or for a choice you already noted.`;

/** `tell_chat_planner`, which sends through `tell`; without it the tool only refuses. */
export function threadNoteTool(tell?: TellChat) {
	return tool({
		description: DESCRIPTION,
		inputSchema: threadNoteInput,
		execute: async (input): Promise<string> => {
			if (!tell) throw new Error("Only a thread's Planner can tell the Chat's Planner anything.");
			return tell(input);
		},
	});
}
