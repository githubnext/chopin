import { defineFeature } from "@github-ui/playground/config";

export default defineFeature({
	id: "chopin",
	label: "Chopin plans",
	description: "Collaborative repository plans with Copilot as a co-author.",
	toolbar: "./src/director.toolbar.tsx",
	data: { packs: ["./data/chopin"] },
	repositoryShell: {
		pages: [
			{
				id: "plans",
				label: "Plans",
				component: "./src/plans-page.tsx",
				icon: "./src/plans-icon.tsx",
			},
		],
		order: ["code", "plans"],
	},
	bookmarks: [
		{ name: "Plans", path: "/monalisa/notes/plans" },
		{ name: "Offline sync", path: "/monalisa/notes/plans?plan=offline-sync" },
	],
});
