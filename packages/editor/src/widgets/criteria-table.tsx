import { InlineCode, plainInlineText, ReadOnlyMark } from "@chopin/question/react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@chopin/visuals";

import { markKey } from "@chopin/question";

import type { Question as Item } from "@chopin/dialect";
import type { Marks } from "@chopin/question";

/**
 * A settled decision's matrix, read only: every option against every criterion, with the chosen
 * rows tinted as a chosen option is.
 */
export function CriteriaTable({ marks, question }: { marks?: Marks; question: Item }) {
	let chosen = new Set(question.choices ?? []);
	return (
		<div className="crit-settled">
			<Table aria-label="Options by criterion" className="crit-table" variant="contained">
				<TableHeader>
					<TableRow>
						<TableHead>Option</TableHead>
						{question.criteria?.map(criterion => (
							<TableHead className="crit-table-mark" key={criterion.id}>
								{criterion.label}
							</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{question.options.map((option, index) => (
						<TableRow data-chosen={chosen.has(option.id) ? "" : undefined} key={option.id}>
							<TableCell>
								<span className="crit-table-option">
									<span aria-hidden="true" className="question-key">
										<span>{String.fromCharCode(65 + index)}</span>
									</span>
									<span className="question-label">
										{chosen.has(option.id) && <span className="sr-only">{"Selected: "}</span>}
										<InlineCode text={option.label} />
									</span>
								</span>
							</TableCell>
							{question.criteria?.map(criterion => (
								<TableCell className="crit-table-mark" key={criterion.id}>
									<ReadOnlyMark
										label={`${plainInlineText(option.label)}, ${criterion.label}`}
										mark={marks?.[markKey(option.id, criterion.id)]}
									/>
								</TableCell>
							))}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
