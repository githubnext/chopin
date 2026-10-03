/** Lifecycle replies may finish after a marker closes, but never override newer reader intent. */
import { useEffect, useRef, useState } from "react";
import { $nodesOfType } from "lexical";
import { QuestionnaireNode } from "@chopin/dialect";
import { currentDecision, decisionReplyCurrent } from "./decision-pin";
import { decisionHostVisible } from "./decision-placement";
import { scrollToKey } from "./scroll";
import type { LexicalEditor } from "lexical";
import type { Question } from "@chopin/protocol";
import type { QuestionnaireEntry } from "./questionnaires";
import type { Transport } from "./transport";

type Target = { key: string; widget: string };
type Request = Target & { kind: "discard" | "reopen"; intent: number };

export function useResolvedActions(
	{ canEdit, dismiss, editor, entries, host, intent, meta, owner, wire }: {
		canEdit: boolean;
		dismiss: () => void;
		editor: LexicalEditor;
		entries: QuestionnaireEntry[];
		host?: HTMLElement;
		intent: { current: number };
		meta: ReadonlyMap<string, Question.CardMeta>;
		owner: object;
		wire?: Transport;
	},
) {
	let [pending, setPending] = useState<Request>();
	let [error, setError] = useState<{ key: string; message: string; intent: number }>();
	let [awaiting, setAwaiting] = useState<Target & { intent: number }>();
	let busy = useRef(false);
	let alive = useRef(true);
	let generation = intent.current;
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	useEffect(() => {
		if (pending?.kind !== "discard" || meta.get(pending.widget)?.status !== "discarded") return;
		if (decisionReplyCurrent(owner, pending.key, pending.intent, intent.current)) dismiss();
		setPending(undefined);
	}, [dismiss, intent, meta, owner, pending]);
	useEffect(() => {
		if (!awaiting) return;
		if (!decisionReplyCurrent(owner, awaiting.key, awaiting.intent, intent.current)) {
			setAwaiting(undefined);
			return;
		}
		if (
			meta.get(awaiting.widget)?.status !== "reopened"
			|| entries.find(entry => entry.id === awaiting.widget)?.value.status !== "reopened"
		) return;
		let key = editor.getEditorState().read(() =>
			$nodesOfType(QuestionnaireNode)
				.find(node =>
					node.getId() === awaiting.widget
					&& node.getQuestionnaire().status === "reopened"
				)?.getKey()
		);
		if (!key) return;
		let frame = requestAnimationFrame(() => {
			if (
				decisionReplyCurrent(owner, awaiting.key, awaiting.intent, intent.current)
				&& host && decisionHostVisible(host)
			) scrollToKey(editor, key);
			setAwaiting(undefined);
		});
		return () => cancelAnimationFrame(frame);
	}, [awaiting, editor, entries, generation, host, intent, meta, owner]);

	let request = (kind: Request["kind"], target: Target) => {
		if (!canEdit || !wire || busy.current) return;
		let started = intent.current;
		let pin = currentDecision();
		if (pin?.owner !== owner || pin.id !== target.key) return;
		busy.current = true;
		setPending({ ...target, kind, intent: started });
		setError(undefined);
		let message = kind === "reopen"
			? "Could not reopen this decision. Try again."
			: "Could not discard this decision. Try again.";
		void wire.ask<Question.Reopen.Reply | Question.Discard.Reply>(
			kind === "reopen" ? "question:reopen" : "question:discard",
			{ id: target.widget },
		).then(reply => {
			if (!alive.current) return;
			let current = decisionReplyCurrent(owner, target.key, started, intent.current);
			if (!reply.ok) {
				if (current) setError({ key: target.key, message, intent: started });
				setPending(undefined);
				return;
			}
			if (kind === "reopen") {
				if (current) {
					setAwaiting({ ...target, intent: started });
					dismiss();
				}
				setPending(undefined);
			}
		}).catch(() => {
			if (!alive.current) return;
			if (decisionReplyCurrent(owner, target.key, started, intent.current)) {
				setError({ key: target.key, message, intent: started });
			}
			setPending(undefined);
		}).finally(() => {
			busy.current = false;
		});
	};
	return { error: error?.intent === generation ? error : undefined, pending, request };
}
