import { ArrowRightIcon, DocumentIcon, PlusIcon } from "@chopin/icons";
import { UnfoldSection } from "@chopin/visuals/unfold";
import { useId } from "react";

import type { Agenda, Research } from "@chopin/protocol";
import type { DraftQuestion } from "./copy";

function QuestionEditor(
	{ question, index, onChange, onRemove }: {
		question: DraftQuestion;
		index: number;
		onChange: (next: DraftQuestion) => void;
		onRemove: () => void;
	},
) {
	let id = useId();
	return (
		<UnfoldSection defaultOpen={!question.question} label={question.question || "New question"}>
			<div className="agenda-fields">
				<label htmlFor={`${id}-question`}>Question {index + 1}</label>
				<textarea
					className="field agenda-field"
					id={`${id}-question`}
					maxLength={500}
					onChange={event =>
						onChange({ ...question, question: event.target.value })}
					rows={2}
					value={question.question}
				/>
				<label htmlFor={`${id}-reason`}>Why it matters</label>
				<input
					className="field agenda-field"
					id={`${id}-reason`}
					maxLength={300}
					onChange={event =>
						onChange({ ...question, reason: event.target.value })}
					value={question.reason}
				/>
				<label htmlFor={`${id}-evidence`}>Evidence needed</label>
				<textarea
					className="field agenda-field"
					id={`${id}-evidence`}
					maxLength={500}
					onChange={event => onChange({ ...question, evidenceNeed: event.target.value })}
					rows={2}
					value={question.evidenceNeed}
				/>
				<div className="agenda-question-actions">
					<label htmlFor={`${id}-priority`}>Priority</label>
					<select
						className="field agenda-field"
						id={`${id}-priority`}
						onChange={event => onChange({ ...question, priority: Number(event.target.value) })}
						value={question.priority}
					>
						<option value={1}>High</option>
						<option value={2}>Medium</option>
						<option value={3}>Low</option>
					</select>
					<button className="btn btn-sm btn-ghost" onClick={onRemove} type="button">Remove</button>
				</div>
			</div>
		</UnfoldSection>
	);
}

export function AgendaQuestions(
	{ questions, saved, editable, maxQuestions, onChange, onOpen }: {
		questions: DraftQuestion[];
		saved: Agenda.Question[];
		editable: boolean;
		maxQuestions: number;
		onChange: (questions: DraftQuestion[]) => void;
		onOpen: (child: Research.ReadyChild) => void;
	},
) {
	return (
		<div className="agenda-questions">
			{questions.map((question, index) => {
				let stored = saved.find(item => item.id === question.key);
				let report = stored?.request?.state === "completed" ? stored.request.child : undefined;
				return (
					<div className="agenda-question" key={question.key}>
						{editable
							? (
								<QuestionEditor
									question={question}
									index={index}
									onChange={next =>
										onChange(questions.map(item => item.key === next.key ? next : item))}
									onRemove={() => onChange(questions.filter(item => item.key !== question.key))}
								/>
							)
							: (
								<UnfoldSection label={question.question}>
									<p>{question.reason}</p>
									<p className="agenda-evidence">{question.evidenceNeed}</p>
									<p className="agenda-meta">
										{["High", "Medium", "Low"][question.priority - 1]} priority
									</p>
								</UnfoldSection>
							)}
						{report
							? (
								<button className="agenda-report" onClick={() => onOpen(report)} type="button">
									<DocumentIcon aria-hidden="true" />
									<span>{report.title}</span>
									<ArrowRightIcon aria-hidden="true" />
								</button>
							)
							: stored && (
								<p className="agenda-meta agenda-question-status" role="status">
									{stored.state === "running" ? "Investigating…" : stored.state === "failed"
										? "Investigation failed"
										: stored.state === "queued"
										? "Queued"
										: stored.state === "skipped"
										? "Skipped"
										: stored.state === "cancelled"
										? "Cancelled"
										: "Complete"}
								</p>
							)}
					</div>
				);
			})}
			{editable && questions.length < maxQuestions && (
				<button
					className="btn btn-sm btn-ghost"
					onClick={() =>
						onChange([...questions, {
							key: crypto.randomUUID(),
							question: "",
							reason: "",
							evidenceNeed: "",
							priority: 2,
						}])}
					type="button"
				>
					<PlusIcon aria-hidden="true" />Add question
				</button>
			)}
		</div>
	);
}
