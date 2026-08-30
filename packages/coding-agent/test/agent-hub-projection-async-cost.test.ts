import { describe, expect, it } from "bun:test";
import { aggregateAsyncSubagentCost } from "../src/modes/components/agent-hub-projection";
import type { ObservableSession } from "../src/modes/session-observer-registry";
import type { AgentRef } from "../src/registry/agent-registry";
import type { AgentProgress } from "../src/task";

function ref(id: string, historicalCost?: number): AgentRef {
	return {
		id,
		displayName: id,
		kind: "sub",
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

function observed(id: string, cost: number, detached: boolean): ObservableSession {
	const progress: AgentProgress = {
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
	};
	return {
		id,
		kind: "subagent",
		label: id,
		status: "completed",
		detached,
		lastUpdate: 1,
		progress,
	};
}

describe("Agent Hub async subagent cost projection", () => {
	it("uses detached live rows and restored Hub history while excluding live synchronous rows", () => {
		const refs = [ref("AsyncAgent"), ref("SyncAgent"), ref("RestoredAgent", 0.18)];
		const sessions = [observed("AsyncAgent", 0.42, true), observed("SyncAgent", 0.25, false)];

		expect(aggregateAsyncSubagentCost(refs, sessions)).toBeCloseTo(0.6, 8);
	});
});
