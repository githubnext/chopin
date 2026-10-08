import { createRoot } from "react-dom/client";
import { QuestionView } from "@chopin/question/react";
import "@fontsource-variable/inter/opsz.css";
import "../theme.css";
import "./frame.css";
import "./bridge";

// This public specimen contains no authored document or repository data.
let definition = {
	questions: [{
		id: "sign-in",
		header: "Sign-in",
		question: "How should people sign in to this prototype?",
		multiple: false,
		options: [
			{ id: "github", label: "GitHub App", description: "Use existing repository permissions." },
			{ id: "oauth", label: "OAuth", description: "Ask each person to authorise access." },
			{ id: "local", label: "Local accounts", description: "Keep identities within this prototype." },
		],
	}],
};
createRoot(document.getElementById("preview-root")!).render(
	<QuestionView
		definition={definition}
		drafts={{
			"sign-in": {
				mode: "choices",
				choice: "github",
				options: { github: true, oauth: false, local: false },
				custom: "",
			},
		}}
		showActions={false}
		disabled
	/>,
);
