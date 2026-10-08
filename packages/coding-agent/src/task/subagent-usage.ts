import { logger } from "@oh-my-pi/pi-utils";
import type { ModelUsageEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";

export type ParentSubagentUsage = Pick<
	ModelUsageEntry,
	"role" | "api" | "provider" | "model" | "usage" | "stopReason" | "errorMessage"
>;

export type ParentSubagentUsageRecorder = (usage: ParentSubagentUsage, purpose: string) => void;

type ParentUsageLedger = Pick<SessionManager, "appendModelUsage" | "getSessionId" | "getLeafId">;

/** Forward only newly appended source-child auxiliary calls into the parent usage ledger. */
export function subscribeToSeanceAuxiliaryUsage(
	sourceManager: Pick<SessionManager, "subscribeToAppendedEntries">,
	parentUsageRecorder: ParentSubagentUsageRecorder | undefined,
): (() => void) | undefined {
	if (!parentUsageRecorder) return undefined;
	return sourceManager.subscribeToAppendedEntries(entry => {
		if (entry.type !== "model_usage") return;
		parentUsageRecorder(
			{
				...(entry.role === undefined ? {} : { role: entry.role }),
				api: entry.api,
				provider: entry.provider,
				model: entry.model,
				usage: entry.usage,
				stopReason: entry.stopReason,
				...(entry.errorMessage === undefined ? {} : { errorMessage: entry.errorMessage }),
			},
			"seance-auxiliary",
		);
	});
}

/** Capture parent-session identity while following its active branch for each new report. */
export function createParentSubagentUsageRecorder(
	manager: Partial<ParentUsageLedger> | undefined,
): ParentSubagentUsageRecorder | undefined {
	const appendModelUsage = manager?.appendModelUsage?.bind(manager);
	const getSessionId = manager?.getSessionId?.bind(manager);
	const getLeafId = manager?.getLeafId?.bind(manager);
	if (!appendModelUsage || !getSessionId) return undefined;
	const sessionId = getSessionId();

	return (usage, purpose) => {
		try {
			appendModelUsage({ ...usage, purpose }, { sessionId, parentId: getLeafId?.() ?? null });
		} catch (error) {
			logger.debug("Failed to record subagent usage in its parent session", {
				purpose,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
}
