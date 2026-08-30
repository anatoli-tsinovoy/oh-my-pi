import { describe, expect, it } from "bun:test";
import { SessionObserverRegistry } from "../src/modes/session-observer-registry";
import { type AgentProgress, TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../src/task";
import { EventBus } from "../src/utils/event-bus";

function progress(id: string, cost: number): AgentProgress {
	return { id, cost } as AgentProgress;
}

describe("SessionObserverRegistry async subagent cost", () => {
	it("sums detached progress while excluding synchronous subagents", () => {
		const bus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(bus, bus);

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "AsyncAgent",
			agent: "scout",
			agentSource: "bundled",
			status: "started",
			index: 0,
			detached: true,
		});
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "scout",
			agentSource: "bundled",
			task: "background research",
			progress: progress("AsyncAgent", 0.42),
		});
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SyncAgent",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			index: 1,
		});
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 1,
			agent: "task",
			agentSource: "bundled",
			task: "blocking work",
			progress: progress("SyncAgent", 0.25),
		});

		expect(registry.getAsyncSubagentCost()).toBeCloseTo(0.42, 8);

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "AsyncAgent",
			agent: "scout",
			agentSource: "bundled",
			status: "completed",
			index: 0,
			detached: true,
		});
		expect(registry.getAsyncSubagentCost()).toBeCloseTo(0.42, 8);

		registry.resetSessions();
		expect(registry.getAsyncSubagentCost()).toBe(0);
		registry.dispose();
	});
});
