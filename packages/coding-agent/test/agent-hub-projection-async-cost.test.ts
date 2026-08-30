import { describe, expect, it } from "bun:test";
import { aggregateAsyncSubagentCost } from "../src/modes/components/agent-hub-projection";
import type { ObservableSession } from "../src/modes/session-observer-registry";
import type { AgentProgress } from "../src/task";

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
	it("sums detached rows while excluding synchronous subagents", () => {
		const sessions = [observed("AsyncAgent", 0.42, true), observed("SyncAgent", 0.25, false)];

		expect(aggregateAsyncSubagentCost(sessions)).toBeCloseTo(0.42, 8);
	});
});
