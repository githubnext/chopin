import { useEffect, useRef, useState } from "react";

export function decisionAttention(previous: number, current: number): boolean {
	return current > previous;
}

export function useDecisionAttention(unanswered: number): boolean {
	let previous = useRef(unanswered);
	let [attention, setAttention] = useState(false);
	useEffect(() => {
		let prior = previous.current;
		previous.current = unanswered;
		if (!decisionAttention(prior, unanswered)) return;
		setAttention(true);
		let timer = window.setTimeout(() => setAttention(false), 200);
		return () => window.clearTimeout(timer);
	}, [unanswered]);
	return attention;
}

export function unansweredDecisionsLabel(label: string, unanswered: number): string {
	if (unanswered <= 0) return label;
	return `${label}, ${unanswered} unanswered ${unanswered === 1 ? "decision" : "decisions"}`;
}
