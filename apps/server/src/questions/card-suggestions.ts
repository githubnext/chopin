import { isOpenStatus } from "./records";

import * as Store from "./store";

import type { Server } from "bun";

import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import type { SocketData } from "../wire";

import { announce } from "./card-notifications";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations; import/export wrappers only.
export async function suggest(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	id: string,
	suggestion?: { optionId: string; messageIds: string[] },
	locked = false,
): Promise<boolean> {
	let body = async () => {
		if (Service.implementationActive(plan)) return false;
		let record = plan.records.get(id);
		let originalQuestions = plan.questions;
		let live = Store.get(originalQuestions, id);
		if (
			!record || !isOpenStatus(record.status) || !live || !Store.reserveEdit(originalQuestions, id)
		) {
			return false;
		}
		try {
			let stagedQuestions: Store.Questions = {
				open: new Map(originalQuestions.open),
				closed: new Map(originalQuestions.closed),
			};
			stagedQuestions.open.set(id, {
				...live,
				claim: undefined,
				editors: new Set(live.editors),
			});
			let result = Store.suggest(stagedQuestions, id, suggestion);
			if (!result.ok) return false;
			if (result.revision === live.revision) return true;
			await Service.publishStaged(plan, server, roomId, {
				...plan,
				questions: stagedQuestions,
				records: new Map(plan.records),
			});
			announce(plan, server, roomId, id);
			return true;
		} finally {
			Store.releaseEdit(originalQuestions, id);
		}
	};
	return locked ? body() : Service.exclusive(plan, body);
}
