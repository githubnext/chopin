export let scenarios = [
	["team", "Chat · empty", "Quiet neutral border; the send button waits for a message."],
	[
		"chopin",
		"Chopin · empty",
		"Petrol glow and an automatic prefix make the destination explicit.",
	],
	["draft", "Chat · draft", "Enter sends to the conversation without starting Chopin."],
	[
		"chopin-draft",
		"Chopin · draft",
		"The prefix travels with the message; your draft stays intact when toggling.",
	],
	["focus", "Keyboard focus", "A focused boundary is distinct from the softer mode glow."],
	[
		"hover",
		"Hover / pressed",
		"Hover the controls; press them to feel the existing Chopin feedback.",
	],
	["multiline", "Growing draft", "Shift+Enter adds a line. Long drafts grow, then scroll."],
	[
		"sending",
		"Sending",
		"Wait for acknowledgement before clearing the draft; prevent duplicate sends.",
	],
	["working", "Chopin working", "Continue writing. Stop remains available beside Send."],
	[
		"queued",
		"Queued follow-up",
		"A new Chopin message queues while it works; collaborators can still chat.",
	],
	["paused", "Chopin paused", "Resume the previous turn or compose a new message."],
	[
		"error",
		"Send failed",
		"Keep the message, destination, and references; offer an explicit retry.",
	],
	["offline", "Connection lost", "Keep the draft visible. Reconnect before sending."],
	[
		"connecting",
		"Synchronizing",
		"The socket must receive fresh conversation state before sending.",
	],
	[
		"readonly",
		"Read-only access",
		"Explain the permission requirement without offering an active input.",
	],
	[
		"archived",
		"Archived document",
		"Explain why chat is unavailable; restoration belongs to the document.",
	],
	["agent-off", "Chopin unavailable", "Collaborator chat works; the agent mode is unavailable."],
	["mention", "Mention picker", "Type @. Arrows choose, Enter selects, Escape dismisses."],
	[
		"reference",
		"Document picker",
		"Type #. Retain Chopin’s existing identity-backed document references.",
	],
	[
		"reference-selected",
		"Selected reference",
		"The visible title retains its document identity when sent.",
	],
	[
		"ref-loading",
		"Reference search · loading",
		"Keep the composer visible while document search resolves.",
	],
	[
		"ref-empty",
		"Reference search · no results",
		"Explain the empty result without losing the draft.",
	],
	[
		"ref-error",
		"Reference search · failed",
		"Show the existing bounded error; typing searches again.",
	],
	["ref-limit", "Document mention limit", "A message already contains ten document mentions."],
	[
		"ref-truncated",
		"Reference search · partial",
		"Tell people when the available results are incomplete.",
	],
] as const;

export type Scenario = typeof scenarios[number][0];
