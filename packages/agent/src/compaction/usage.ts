import type { AssistantMessage, Model, StopReason, Usage } from "@oh-my-pi/pi-ai";
import { parseChunkUsage } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { applyProviderReportedCost, populateResponsesUsageFromResponse } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { isRecord, logger } from "@oh-my-pi/pi-utils";

/** Normalized, priced provider usage for one compaction generation. */
export interface CompactionUsageReport {
	api: Model["api"];
	provider: string;
	model: string;
	usage: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}

/** Receives one actual provider completion that reported usage. */
export type CompactionUsageCallback = (report: CompactionUsageReport) => void;

export function reportCompactionUsage(
	callback: CompactionUsageCallback | undefined,
	report: CompactionUsageReport | undefined,
): void {
	if (!callback || !report) return;
	try {
		callback(report);
	} catch (error) {
		logger.debug("Compaction usage callback failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Emit normalized usage from a completeSimple result; its default empty usage is not a report. */
export function reportAssistantCompactionUsage(
	callback: CompactionUsageCallback | undefined,
	message: AssistantMessage,
): void {
	if (!hasReportedUsage(message.usage)) return;
	reportCompactionUsage(callback, {
		api: message.api,
		provider: message.provider,
		model: message.upstreamModel ?? message.model,
		usage: message.usage,
		stopReason: message.stopReason,
		errorMessage: message.errorMessage,
	});
}

/** Convert official Responses usage to priced canonical usage without estimating absent fields. */
export function normalizeResponsesCompactionUsage(model: Model, rawUsage: unknown): Usage | undefined {
	if (!isRecord(rawUsage)) return undefined;
	if (typeof rawUsage.input_tokens !== "number" && typeof rawUsage.output_tokens !== "number") return undefined;

	const output = { usage: emptyUsage() } as unknown as AssistantMessage;
	populateResponsesUsageFromResponse(output, rawUsage as Parameters<typeof populateResponsesUsageFromResponse>[1]);
	calculateCost(model, output.usage);
	applyProviderReportedCost(model, output.usage, rawUsage);
	return output.usage;
}

/** Convert official Chat Completions usage or canonical custom-endpoint usage to priced canonical usage. */
export function normalizeRemoteCompactionUsage(model: Model, rawUsage: unknown): Usage | undefined {
	if (!isRecord(rawUsage)) return undefined;

	if (typeof rawUsage.prompt_tokens === "number" || typeof rawUsage.completion_tokens === "number") {
		const usage = parseChunkUsage(rawUsage, model as Model<"openai-completions">, undefined);
		return usage;
	}

	if (typeof rawUsage.input_tokens === "number" || typeof rawUsage.output_tokens === "number") {
		return normalizeResponsesCompactionUsage(model, rawUsage);
	}

	// Omp-compatible custom summary endpoints may already return canonical Usage.
	if (typeof rawUsage.input !== "number" && typeof rawUsage.output !== "number") return undefined;
	const empty = emptyUsage();
	const usage = {
		...empty,
		...rawUsage,
		cost: { ...empty.cost },
	} as Usage;
	if (typeof rawUsage.totalTokens !== "number") {
		usage.totalTokens =
			usage.input +
			usage.output +
			usage.cacheRead +
			usage.cacheWrite +
			(usage.orchestration?.input ?? 0) +
			(usage.orchestration?.cacheRead ?? 0) +
			(usage.orchestration?.output ?? 0);
	}
	calculateCost(model, usage);
	return usage;
}

export function createCompactionUsageReport(
	model: Model,
	usage: Usage,
	actualModel?: string,
	stopReason?: StopReason,
	errorMessage?: string,
): CompactionUsageReport {
	return {
		api: model.remoteCompaction?.api ?? model.api,
		provider: model.provider,
		model: actualModel ?? model.remoteCompaction?.model ?? model.requestModelId ?? model.id,
		usage,
		...(stopReason !== undefined ? { stopReason } : {}),
		...(errorMessage !== undefined ? { errorMessage } : {}),
	};
}

function hasReportedUsage(usage: Usage): boolean {
	return (
		usage.input > 0 ||
		usage.output > 0 ||
		usage.cacheRead > 0 ||
		usage.cacheWrite > 0 ||
		usage.totalTokens > 0 ||
		(usage.orchestration?.input ?? 0) > 0 ||
		(usage.orchestration?.cacheRead ?? 0) > 0 ||
		(usage.orchestration?.output ?? 0) > 0 ||
		(usage.premiumRequests ?? 0) > 0 ||
		(usage.credits?.cost ?? 0) > 0 ||
		(usage.credits?.committedCost ?? 0) > 0 ||
		(usage.credits?.acuCost ?? 0) > 0 ||
		usage.cost.total > 0
	);
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
