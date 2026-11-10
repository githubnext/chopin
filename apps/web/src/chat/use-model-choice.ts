import { useCallback, useEffect, useRef, useState } from "react";

import { WireRefusal } from "../wire";
import { sameChoice } from "./model-picker-state";

import type { Chat as Wire } from "@chopin/protocol";
import type { Wire as Socket } from "../wire";

export type ModelControl = {
	catalog: Wire.ModelCatalog;
	/** What the room holds, or what this browser has asked for until the server has answered. */
	choice: Wire.ModelChoice | undefined;
	/** Why the server refused the last choice, until the next one. */
	refusal: string | undefined;
	choose: (next: Wire.ModelChoice) => void;
};

type Held = { room: string; wire: Socket; catalog?: Wire.ModelCatalog; choice?: Wire.ModelChoice };
type Asked = { sequence: number; choice: Wire.ModelChoice };

/**
 * The document's model choice, shared by the room: the catalog the harness offers and the choice
 * everyone sees. A pick shows at once and is sent when the connection allows; the server's answer
 * (or its refusal, which puts the shared choice back) decides. Nothing is returned where the
 * harness offers no choice or the person cannot make one.
 */
export function useModelChoice(
	{ wire, room, connected, enabled }: {
		wire: Socket | undefined;
		room: string;
		connected: boolean;
		enabled: boolean;
	},
): ModelControl | undefined {
	let [held, setHeld] = useState<Held>();
	let [asked, setAsked] = useState<Asked>();
	let [refusal, setRefusal] = useState<string>();
	let sequence = useRef(0);
	let sent = useRef(0);

	useEffect(() => {
		if (!wire) return;
		setHeld(undefined);
		setAsked(undefined);
		setRefusal(undefined);
		return wire.on<Wire.ModelState>("chat:model", frame => {
			setHeld({ room, wire, catalog: frame.catalog, choice: frame.choice });
		});
	}, [wire, room]);

	// Sent once connected, newest only: the server keeps the order it hears them in.
	useEffect(() => {
		if (!wire || !asked || !connected || !wire.connected || sent.current === asked.sequence) return;
		sent.current = asked.sequence;
		let current = asked;
		wire.ask<Wire.ModelState>("chat:model", current.choice).then(() => {
			setAsked(latest => latest?.sequence === current.sequence ? undefined : latest);
		}, error => {
			if (error instanceof WireRefusal) {
				setAsked(latest => latest?.sequence === current.sequence ? undefined : latest);
				setRefusal(error.message);
			} else if (sent.current === current.sequence) {
				// The connection went before the answer: asked again once it is back.
				sent.current = 0;
			}
		});
	}, [wire, asked, connected]);

	let choose = useCallback((next: Wire.ModelChoice) => {
		setRefusal(undefined);
		setAsked({ sequence: ++sequence.current, choice: next });
	}, []);

	if (!enabled || !wire || held?.wire !== wire || held.room !== room || !held.catalog) {
		return undefined;
	}
	let choice = asked && !sameChoice(asked.choice, held.choice) ? asked.choice : held.choice;
	return { catalog: held.catalog, choice, refusal, choose };
}
