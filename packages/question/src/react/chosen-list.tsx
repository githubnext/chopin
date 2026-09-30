import { CheckIcon } from "@chopin/icons";

import type { Answer, Item } from "../schema";

export function ChosenList({ question, answer }: { question: Item; answer: Answer }) {
	if (answer.custom !== undefined && !answer.optionIds?.length) {
		return <p className="m-0 px-4 pt-2 text-base text-text-primary">{answer.custom}</p>;
	}

	let chosen = new Set(answer.optionIds ?? []);

	return (
		<ol className="m-0 list-none px-2 pt-2">
			{question.options.map((option, index) => {
				let picked = chosen.has(option.id)
					|| (!answer.optionIds && !!answer.choices?.includes(option.label));
				return (
					<li
						className={`flex items-baseline gap-2 rounded-md px-2 py-1.5 text-base ${
							picked ? "bg-selected" : ""
						}`}
						data-chosen={picked ? "true" : undefined}
						key={option.id}
					>
						<span aria-hidden="true" className="text-text-secondary tabular-nums">
							{index + 1}.
						</span>
						<span className="min-w-0 flex-1 text-text-primary">{option.label}</span>
						{picked && <CheckIcon aria-label="Chosen" size={14} />}
					</li>
				);
			})}
		</ol>
	);
}
