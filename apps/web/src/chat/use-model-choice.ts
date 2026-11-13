import { useCallback, useEffect, useRef, useState } from "react";

import { WireRefusal } from "../wire";
import { pendingTrigger, sameChoice } from "./model-picker-state";

import type { Chat as Wire } from "@chopin/protocol";
import type { Wire as Socket } from "../wire";

export type ModelControl = {
	catalog: Wire.ModelCatalog;
	/** What the room holds, or what this browser has asked for until the server has answered. */
	choice: Wire.ModelChoice | undefined;
	/** Catalog name saved with this choice, if known. */
	modelName?: string;
	/** Why the server refused the last choice, until the next one. */
	refusal: string | undefined;
	choose: (next: Wire.ModelChoice) => void;
};

/**
 * The pill drawn while the document's machine is starting its Planner, before it has said which
 * models it can run: the saved choice's words, or none, and nothing to open.
 */
export type PendingModel = { pending: true; name: string; level?: string };

/** What the composer's model pill draws: the real control, or the pill waiting for it. */
export type ComposerModel = ModelControl | PendingModel;

type Held = {
	room: string;
	wire: Socket;
	catalog?: Wire.ModelCatalog;
	choice?: Wire.ModelChoice;
	modelName?: string;
	/** The offer is not known yet: the stored choice to show while the models are on their way. */
	waiting?: Wire.ModelState["waiting"];
	/** What the document's agent offers `/` beyond Chat's own commands. */
	commands?: Wire.CommandOption[];
	/** The server ran the harness's default because a turn could not read the choice. */
	unreadable?: boolean;
};
type Asked = { sequence: number; choice: Wire.ModelChoice };

/**
 * The document's model choice, shared by the room: the catalog the harness offers and the choice
 * everyone sees. A pick shows at once and is sent when the connection allows; the server's answer
 * (or its refusal, which puts the shared choice back) decides. No `control` is returned where the
 * harness offers no choice or the person cannot make one, and then `saved` is still the choice the
 * room holds (the server tells it where it knows the harness offers nothing, such as a client that
 * withdrew its models, and not while no client is attached), so the composer can say it fell back
 * to the default. `unreadable` is the server's word that its last turn could not read the choice
 * and ran the harness's default. Only the server ends it: its word that a turn could read it
 * again, or a new transcript (a join, a reconnect, a restarted server), after which it is said
 * again if it still holds.
 */
export function useModelChoice(
	{ wire, room, connected, enabled }: {
		wire: Socket | undefined;
		room: string;
		connected: boolean;
		enabled: boolean;
	},
): {
	control: ModelControl | undefined;
	saved: Wire.ModelChoice | undefined;
	savedName: string | undefined;
	unreadable: boolean;
	/** The commands the document's agent offers now, none where it reports none. */
	commands: Wire.CommandOption[] | undefined;
	/** The server's word that the offer is not known yet, with the stored choice to wait with. */
	waiting: Wire.ModelState["waiting"];
} {
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
		let stops = [
			wire.on<Wire.ModelState>("chat:model", frame => {
				setHeld(current => ({
					...(current?.unreadable ? { unreadable: true } : {}),
					room,
					wire,
					catalog: frame.catalog,
					choice: frame.choice,
					modelName: frame.modelName,
					waiting: frame.waiting,
					commands: frame.commands,
				}));
			}),
			wire.on<Wire.ModelUnreadable>("chat:model-unreadable", frame => {
				setHeld(current => ({ ...current, room, wire, unreadable: frame.unreadable }));
			}),
			wire.on<Wire.History>("chat:history", () => {
				setHeld(current => current && { ...current, unreadable: false });
			}),
		];
		return () => {
			for (let stop of stops) stop();
		};
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

	let current = held && held.wire === wire && held.room === room ? held : undefined;
	let unreadable = enabled && current?.unreadable === true;
	let saved = enabled ? current?.choice : undefined;
	let savedName = enabled ? current?.modelName : undefined;
	let commands = enabled ? current?.commands : undefined;
	let waiting = enabled ? current?.waiting : undefined;
	if (!enabled || !wire || !current?.catalog) {
		return { control: undefined, saved, savedName, unreadable, commands, waiting };
	}
	let choice = asked && !sameChoice(asked.choice, current.choice) ? asked.choice : current.choice;
	let modelName = choice?.model === current.choice?.model ? savedName : undefined;
	return {
		control: { catalog: current.catalog, choice, modelName, refusal, choose },
		saved,
		savedName,
		unreadable,
		commands,
		waiting,
	};
}

/**
 * The pill the composer draws before the real one: while the document's machine is `coming`
 * (starting its Planner, or attached and yet to report) and the server says the offer is not known
 * yet (`waiting`), a pill that waits for the models in the real one's place, with the stored
 * choice's words. A Planner that cannot start, a machine that went away or none chosen, and a
 * client that reported nothing, end the wait: the composer is then as it was without a pill.
 */
export function pendingModel(
	waiting: Wire.ModelState["waiting"],
	coming: "starting" | "attached" | undefined,
): PendingModel | undefined {
	return coming && waiting ? pendingTrigger(waiting.choice, waiting.modelName) : undefined;
}
