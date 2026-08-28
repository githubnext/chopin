import { useLayoutEffect, useMemo, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	addComposerChild$,
	markdownShortcutPlugin,
	MDXEditor,
	realmPlugin,
} from "@mdxeditor/editor";

import { importPlan, plugins as dialectPlugins } from "@chopin/dialect";

import { PLAN_LEXICAL_THEME } from "./plan-theme";
import { register } from "./widgets";
import { widgetsPlugin } from "./widgets-plugin";

import type { QuestionnaireStore } from "./questionnaires";
import type { ResearchStore } from "./widget-options";

register();

function StaticSource({ onError, source }: { onError: (error: Error) => void; source: string }) {
	let [editor] = useLexicalComposerContext();
	useLayoutEffect(() => {
		try {
			importPlan(editor, source);
		} catch (problem) {
			onError(problem instanceof Error ? problem : new Error("Could not import the document."));
		}
	}, [editor, onError, source]);
	return null;
}

let staticSourcePlugin = realmPlugin<{ onError: (error: Error) => void; source: string }>({
	init(realm, params) {
		if (!params) return;
		realm.pub(addComposerChild$, () => <StaticSource {...params} />);
	},
});

export function StaticPlanEditor(
	{ questions, research, source }: {
		questions?: QuestionnaireStore;
		research?: ResearchStore;
		source: string;
	},
) {
	let [error, setError] = useState<string>();
	let plugins = useMemo(
		() => [
			...dialectPlugins({ core: false }),
			markdownShortcutPlugin(),
			widgetsPlugin({ canEdit: false, questions, research }),
			staticSourcePlugin({ onError: problem => setError(problem.message), source }),
		],
		[questions, research, source],
	);

	return (
		<section
			aria-label="Authored content specimen"
			className="plan design-audit-static-plan"
			data-read-only="true"
			data-source-length={source.length}
			role="document"
		>
			{error && <p className="text-sm text-destructive-ink" role="alert">{error}</p>}
			<div className="plan-workspace">
				<div className="plan-document">
					<MDXEditor
						contentEditableClassName="plan-content focus-caret"
						lexicalTheme={PLAN_LEXICAL_THEME}
						markdown=""
						onError={problem => setError(problem.error)}
						plugins={plugins}
						readOnly
						spellCheck
						suppressHtmlProcessing
					/>
				</div>
			</div>
		</section>
	);
}
