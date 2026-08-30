import { describe, expect, it } from "bun:test";
import { aggregateAsyncSubagentCost, progressMetrics } from "../src/modes/components/agent-hub-projection";
import { type ObservableSession, SessionObserverRegistry } from "../src/modes/session-observer-registry";
import type { AgentRef } from "../src/registry/agent-registry";
import {
	type AgentProgress,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../src/task";
import { EventBus } from "../src/utils/event-bus";

function ref(id: string, historicalCost?: number, parentId?: string): AgentRef {
	return {
		id,
		displayName: id,
		kind: "sub",
		parentId,
		status: historicalCost === undefined ? "running" : "parked",
		session: null,
		sessionFile: null,
		createdAt: 1,
		lastActivity: 1,
		history:
			historicalCost === undefined
				? undefined
				: {
						metrics: {
							tokens: 1000,
							requests: 2,
							tools: 3,
							cost: historicalCost,
							durationMs: 4000,
						},
					},
	};
}

function progress(id: string, cost: number): AgentProgress {
	return {
		index: 0,
		id,
		agent: "scout",
		agentSource: "bundled",
		status: "completed",
		task: "research",
		recentTools: [],
		recentOutput: [],
		toolCount: 2,
		requests: 3,
		tokens: 1200,
		cost,
		durationMs: 4000,
	} satisfies AgentProgress;
}

function observed(id: string, cost: number, detached: boolean): ObservableSession {
	return {
		id,
		kind: "subagent",
		label: id,
		status: "completed",
		detached,
		lastUpdate: 1,
		progress: progress(id, cost),
	};
}

describe("Agent Hub async subagent cost projection", () => {
	it("uses detached trees and restored Hub history while excluding unrelated synchronous rows", () => {
		const refs = [
			ref("AsyncAgent"),
			ref("SyncAgent"),
			ref("NestedSyncAgent", undefined, "AsyncAgent"),
			ref("RestoredAgent", 0.18),
		];
		const sessions = [
			observed("AsyncAgent", 0.42, true),
			observed("SyncAgent", 0.25, false),
			observed("NestedSyncAgent", 0.12, false),
		];

		expect(aggregateAsyncSubagentCost(refs, sessions)).toBeCloseTo(0.72, 8);
	});

	it("preserves prior spend when a detached agent id starts a follow-up turn", () => {
		const bus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(bus, bus);
		const lifecycle = (status: SubagentLifecyclePayload["status"]): SubagentLifecyclePayload => ({
			id: "AsyncAgent",
			agent: "scout",
			agentSource: "bundled",
			status,
			index: 0,
			detached: true,
		});
		const report = (cost: number): SubagentProgressPayload => ({
			index: 0,
			agent: "scout",
			agentSource: "bundled",
			task: "research",
			progress: progress("AsyncAgent", cost),
			detached: true,
		});

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("started"));
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, report(0.4));
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("completed"));
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("started"));
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, report(0.1));

		expect(progressMetrics(registry.getSession("AsyncAgent"))?.cost).toBeCloseTo(0.5, 8);
		registry.dispose();
	});
});
