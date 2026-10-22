import { CheckCircleFillIcon, CheckIcon, ClockIcon } from "@primer/octicons-react";
import { Button, FormControl, Label, Radio, RadioGroup } from "@primer/react";
import { Blankslate } from "@primer/react/experimental";
import { cue } from "./director";
import type { Decision } from "./plans";
import { displayName } from "./plans";
import styles from "./plans.module.css";
import { type PlanStore, usePlanState } from "./store";

function OpenDecision({ decision, store }: { decision: Decision; store: PlanStore }) {
	let select = (selected: string | null) =>
		store.set(state => ({
			decisions: state.decisions.map(
				item => (item.id === decision.id ? { ...item, selected } : item),
			),
		}));
	let submit = () => {
		if (cue("decide")) return;
		store.set(state => ({
			decisions: state.decisions.map(item =>
				item.id === decision.id ? { ...item, answer: item.selected, answeredBy: "monalisa" } : item
			),
		}));
	};

	return (
		<article className={styles.decision} data-open="true">
			<header className={styles.decisionHeader}>
				<Label variant="attention">Open</Label>
				<span className={styles.decisionMeta}>
					Raised by {displayName(decision.raisedBy)} {decision.raisedAt}
				</span>
			</header>
			<RadioGroup name={`decision-${decision.id}`} onChange={select}>
				<RadioGroup.Label className={styles.decisionQuestion}>{decision.question}</RadioGroup.Label>
				<RadioGroup.Caption>{decision.context}</RadioGroup.Caption>
				{decision.options.map(option => (
					<FormControl key={option.id}>
						<Radio value={option.id} checked={decision.selected === option.id} />
						<FormControl.Label>{option.label}</FormControl.Label>
						<FormControl.Caption>{option.description}</FormControl.Caption>
					</FormControl>
				))}
			</RadioGroup>
			<div className={styles.decisionActions}>
				<Button variant="primary" disabled={!decision.selected} onClick={submit}>
					Submit decision
				</Button>
			</div>
		</article>
	);
}

function DecidedDecision({ decision }: { decision: Decision }) {
	let chosen = decision.options.find(option => option.id === decision.answer);
	return (
		<article className={styles.decision}>
			<header className={styles.decisionHeader}>
				<Label variant="success">Decided</Label>
				<span className={styles.decisionMeta}>
					{decision.applied
						? (
							<>
								<CheckIcon size={14} /> Applied to the plan
							</>
						)
						: (
							<>
								<ClockIcon size={14} /> Copilot is updating the plan
							</>
						)}
				</span>
			</header>
			<h3 className={styles.decisionQuestion}>{decision.question}</h3>
			<p className={styles.decisionAnswer}>
				<CheckCircleFillIcon className={styles.successIcon} size={16} />
				<span>
					<strong>{chosen?.label}</strong>
					<span className={styles.muted}>, chosen by {decision.answeredBy}</span>
				</span>
			</p>
		</article>
	);
}

export function Decisions({ store }: { store: PlanStore }) {
	let state = usePlanState(store);
	let open = state.decisions.filter(decision => !decision.answer);
	let decided = state.decisions.filter(decision => decision.answer);

	return (
		<div className={styles.decisions}>
			{state.decisions.length === 0 && (
				<Blankslate border narrow>
					<Blankslate.Visual>
						<CheckCircleFillIcon size={24} />
					</Blankslate.Visual>
					<Blankslate.Heading>No open decisions</Blankslate.Heading>
					<Blankslate.Description>
						Copilot raises a decision here when the plan needs a call from the team.
					</Blankslate.Description>
				</Blankslate>
			)}
			{open.map(decision => <OpenDecision key={decision.id} decision={decision} store={store} />)}
			{decided.length > 0 && <h2 className={styles.sectionHeading}>Decided</h2>}
			{decided.toReversed().map(decision => (
				<DecidedDecision key={decision.id} decision={decision} />
			))}
		</div>
	);
}
