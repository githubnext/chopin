// An explicit, reviewable subset; the full catalogue contains illustrative static markup too.
export let specimens = [
	{ id: "typography", covers: "Fluid scale and document title role" },
	{ id: "badge", covers: "Shared neutral, success, warning and danger semantics" },
	...[
		"primary",
		"secondary",
		"ghost",
		"destructive",
		"sizes",
	].map(sample => ({
		id: `buttons-${sample}`,
		item: "buttons",
		sample,
		covers: "Real button classes: hierarchy, focus, disabled and busy states",
	})),
	{ id: "fields", covers: "Labelled input, invalid, readonly, disabled and real Select" },
	{ id: "chat", covers: "Real transcript, tool activity, queued text and terminal error" },
	{ id: "callouts", covers: "Real static editor and five authored callout variants" },
	{ id: "code", covers: "Real plain and highlighted code previews" },
	{ id: "table", covers: "Real static editor table and deliberate internal overflow" },
] as const;

export let interactions = [
	"Production document action menu: keyboard open, arrow navigation, Escape, focus return",
	"Production navigation dialog: initial focus, focus trap, Escape, disabled save, save error",
	"Shared Select: keyboard open, selection and focus return",
	"200% root text size: control and prose reflow; normal-size table scroll lane and keyboard access to code previews",
	"Reduced motion: menu and modal transitions settle without active animations",
];
