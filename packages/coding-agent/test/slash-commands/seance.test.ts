import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { cfgTaskAgentModelOverrides } from "@oh-my-pi/pi-coding-agent/task/settings";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TaskParams } from "@oh-my-pi/pi-coding-agent/task";
import type { Model } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

interface SelectOnlyModelOptions {
	onSelect(selector: string): void;
	onCancel?(): void;
}
interface HarnessTaskResult {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
	isError?: boolean;
}

function createHarness() {
	const settings = Settings.isolated({});
	cfgTaskAgentModelOverrides.override(settings, {
		...cfgTaskAgentModelOverrides.get(settings),
		task: "saved/task-default",
	});
	const taskOverrides = structuredClone(cfgTaskAgentModelOverrides.get(settings));
	const parentModel = { provider: "parent", id: "parent-model" } as Model;
	const progress = [{ agent: "seance", id: "seance-agent-42" }];
	const execute = vi.fn(async (_toolCallId: string, _params: unknown): Promise<HarnessTaskResult> => ({
		content: [{ type: "text", text: "started" }],
		details: { progress },
		isError: false,
	}));
	const state: {
		taskAvailable: boolean;
		hookChoice: string | undefined;
		selectedSession: ((session: SessionInfo) => void | Promise<void>) | undefined;
		modelSelection: SelectOnlyModelOptions | undefined;
	} = {
		taskAvailable: true,
		hookChoice: "Use saved model",
		selectedSession: undefined,
		modelSelection: undefined,
	};
	const getToolByName = vi.fn(() => (state.taskAvailable ? { execute } : undefined));
	const showSessionSelector = vi.fn((_source?: unknown, onSelect?: (session: SessionInfo) => void | Promise<void>) => {
		state.selectedSession = onSelect;
	});
	const showModelSelector = vi.fn((options?: { selectOnly?: SelectOnlyModelOptions }) => {
		state.modelSelection = options?.selectOnly;
	});
	const showHookSelector = vi.fn(async (_title: string, _options: readonly unknown[]) => state.hookChoice);
	const showError = vi.fn();
	const showStatus = vi.fn();
	const ctx = {
		editor: { setText: vi.fn() },
		settings,
		sessionManager: {
			getCwd: () => "/work",
			getSessionDir: () => "/sessions",
			getSessionFile: () => "/sessions/current.jsonl",
		},
		session: { model: parentModel, getToolByName },
		showSessionSelector,
		showModelSelector,
		showHookSelector,
		showError,
		showStatus,
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		execute,
		getToolByName,
		parentModel,
		settings,
		taskOverrides,
		state,
		showError,
		showHookSelector,
		showModelSelector,
		showSessionSelector,
		showStatus,
	};
}

const sourceSession: SessionInfo = {
	path: "/sessions/source.jsonl",
	id: "source-session-id",
	cwd: "/work",
	created: new Date("2026-01-01T00:00:00Z"),
	modified: new Date("2026-01-02T00:00:00Z"),
	messageCount: 1,
	size: 10,
	firstMessage: "Source",
	allMessagesText: "Source",
};

afterEach(() => vi.restoreAllMocks());

describe("/seance", () => {
	it("invokes Task with a direct source and one-off model without mutating parent defaults", async () => {
		const harness = createHarness();

		const handled = await executeBuiltinSlashCommand("/seance /sessions/source.jsonl --model fixture/override", {
			ctx: harness.ctx,
		});

		expect(handled).toBe(true);
		expect(harness.execute).toHaveBeenCalledTimes(1);
		expect(harness.execute.mock.calls[0]?.[1]).toMatchObject({
			agent: "seance",
			sourceSession: "/sessions/source.jsonl",
			model: "fixture/override",
		} satisfies Partial<TaskParams>);
		expect(harness.showHookSelector).not.toHaveBeenCalled();
		expect(harness.showModelSelector).not.toHaveBeenCalled();
		expect(harness.ctx.session.model).toBe(harness.parentModel);
		expect(cfgTaskAgentModelOverrides.get(harness.settings)).toEqual(harness.taskOverrides);
		expect(harness.showStatus).toHaveBeenCalledWith("Seance agent agent://seance-agent-42 started.");
	});
	it("gets the seance ID from synchronous Task results when progress is absent", async () => {
		const harness = createHarness();
		harness.execute.mockResolvedValueOnce({
			content: [{ type: "text", text: "Seance ready." }],
			details: {
				projectAgentsDir: null,
				results: [{ id: "seance-sync-17", agent: "seance" }],
				totalDurationMs: 0,
			},
		});

		await executeBuiltinSlashCommand("/seance source-id", { ctx: harness.ctx });

		expect(harness.showStatus).toHaveBeenCalledWith("Seance agent agent://seance-sync-17 started.");
		expect(harness.showError).not.toHaveBeenCalled();
	});
	it("journals direct synchronous seance usage because no task result enters the parent transcript", async () => {
		const harness = createHarness();
		const parentSessionManager = SessionManager.inMemory();
		const pricedModel = { api: "mock", provider: "mock", id: "role-model" } as Model;
		Object.assign(harness.ctx.session, {
			sessionManager: parentSessionManager,
			modelRegistry: { find: () => pricedModel },
		});
		const usage = {
			input: 7,
			output: 3,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 13,
			cost: { input: 0.07, output: 0.15, cacheRead: 0.03, cacheWrite: 0, total: 0.25 },
		};
		harness.execute.mockResolvedValueOnce({
			content: [{ type: "text", text: "Seance complete." }],
			details: {
				projectAgentsDir: null,
				results: [
					{
						id: "seance-cost-sync",
						agent: "seance",
						exitCode: 0,
						resolvedModelIdentity: "mock/role-model",
						usage,
					},
				],
				usage,
				totalDurationMs: 10,
			},
		});

		await executeBuiltinSlashCommand("/seance source-id", { ctx: harness.ctx });

		expect(parentSessionManager.getUsageStatistics().cost).toBeCloseTo(0.25);
		const entries = parentSessionManager.getEntries().filter(entry => entry.type === "model_usage");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			type: "model_usage",
			purpose: "seance-command",
			usage: { cost: { total: 0.25 } },
		});
		expect(parentSessionManager.getEntries().some(entry => entry.type === "message")).toBe(false);
		await parentSessionManager.close();
	});

	it("surfaces Task result content when a preflight error has no isError flag or agent ID", async () => {
		const harness = createHarness();
		harness.execute.mockResolvedValueOnce({
			content: [{ type: "text", text: "Task execution failed: invalid source header" }],
			details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
		});

		await executeBuiltinSlashCommand("/seance source-id", { ctx: harness.ctx });

		expect(harness.showError).toHaveBeenCalledWith("Task execution failed: invalid source header");
		expect(harness.showStatus).not.toHaveBeenCalled();
	});
	it("uses the saved source model for direct selection unless an override is supplied", async () => {
		const harness = createHarness();

		await executeBuiltinSlashCommand("/seance source-id", { ctx: harness.ctx });

		expect(harness.execute.mock.calls[0]?.[1]).toMatchObject({ agent: "seance", sourceSession: "source-id" });
		expect(harness.execute.mock.calls[0]?.[1]).not.toHaveProperty("model");
		expect(harness.showHookSelector).not.toHaveBeenCalled();
		expect(harness.showModelSelector).not.toHaveBeenCalled();
	});
	it("preserves unquoted Windows session paths", async () => {
		const harness = createHarness();
		const source = String.raw`C:\Users\Ada\session.jsonl`;

		await executeBuiltinSlashCommand(`/seance ${source}`, { ctx: harness.ctx });

		expect(harness.execute.mock.calls[0]?.[1]).toMatchObject({ sourceSession: source });
	});

	it("opens the existing session picker and uses the saved source model by default", async () => {
		const harness = createHarness();
		await executeBuiltinSlashCommand("/seance", { ctx: harness.ctx });
		const selected = harness.state.selectedSession;
		expect(selected).toBeDefined();

		await selected!(sourceSession);

		expect(harness.execute).toHaveBeenCalledTimes(1);
		expect(harness.execute.mock.calls[0]?.[1]).toMatchObject({
			agent: "seance",
			sourceSession: sourceSession.path,
		});
		expect(harness.execute.mock.calls[0]?.[1]).not.toHaveProperty("model");
		expect(harness.showHookSelector).toHaveBeenCalledWith("Choose the seance agent model", [
			"Use saved model",
			"Choose another model",
		]);
		expect(harness.showModelSelector).not.toHaveBeenCalled();
		expect(harness.ctx.session.model).toBe(harness.parentModel);
		expect(cfgTaskAgentModelOverrides.get(harness.settings)).toEqual(harness.taskOverrides);
	});

	it("uses the selection-only model picker for an alternative without changing parent settings", async () => {
		const harness = createHarness();
		harness.state.hookChoice = "Choose another model";
		await executeBuiltinSlashCommand("/seance", { ctx: harness.ctx });
		const selected = harness.state.selectedSession;
		expect(selected).toBeDefined();

		const launching = selected!(sourceSession);
		await Promise.resolve();
		const selection = harness.state.modelSelection;
		expect(selection).toBeDefined();
		selection!.onSelect("fixture/alternative");
		await launching;

		expect(harness.execute.mock.calls[0]?.[1]).toMatchObject({ model: "fixture/alternative" });
		expect(harness.ctx.session.model).toBe(harness.parentModel);
		expect(cfgTaskAgentModelOverrides.get(harness.settings)).toEqual(harness.taskOverrides);
	});

	it("does not launch when either interactive choice is cancelled", async () => {
		const cancelledChoice = createHarness();
		cancelledChoice.state.hookChoice = undefined;
		await executeBuiltinSlashCommand("/seance", { ctx: cancelledChoice.ctx });
		await cancelledChoice.state.selectedSession!(sourceSession);
		expect(cancelledChoice.execute).not.toHaveBeenCalled();

		const cancelledModelPicker = createHarness();
		cancelledModelPicker.state.hookChoice = "Choose another model";
		await executeBuiltinSlashCommand("/seance", { ctx: cancelledModelPicker.ctx });
		const launching = cancelledModelPicker.state.selectedSession!(sourceSession);
		await Promise.resolve();
		cancelledModelPicker.state.modelSelection?.onCancel?.();
		await launching;
		expect(cancelledModelPicker.execute).not.toHaveBeenCalled();
	});

	it("rejects malformed arguments and reports unavailable or failed Task launches", async () => {
		for (const input of [
			"/seance --model",
			"/seance first second",
			"/seance --unknown",
			'/seance ""',
			'/seance --model ""',
		]) {
			const harness = createHarness();
			await executeBuiltinSlashCommand(input, { ctx: harness.ctx });
			expect(harness.showError).toHaveBeenCalledWith(expect.stringContaining("Usage: /seance"));
			expect(harness.execute).not.toHaveBeenCalled();
			expect(harness.showSessionSelector).not.toHaveBeenCalled();
		}

		const unavailable = createHarness();
		unavailable.state.taskAvailable = false;
		await executeBuiltinSlashCommand("/seance source-id", { ctx: unavailable.ctx });
		expect(unavailable.showError).toHaveBeenCalledWith(
			"Task tool is unavailable. Enable the task tool to start a seance.",
		);

		const failed = createHarness();
		failed.execute.mockRejectedValueOnce(new Error("launch failed"));
		await executeBuiltinSlashCommand("/seance source-id", { ctx: failed.ctx });
		expect(failed.showError).toHaveBeenCalledWith("launch failed");
	});
});
