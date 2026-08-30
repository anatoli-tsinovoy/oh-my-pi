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

type RefOptions = {
	status?: AgentRef["status"];
	sessionFile?: string | null;
	detached?: boolean;
};

function ref(id: string, historicalCost?: number, parentId?: string, options: RefOptions = {}): AgentRef {
	const { status = historicalCost === undefined ? "running" : "parked", sessionFile = null, detached } = options;
	const history =
		historicalCost === undefined && detached === undefined
			? undefined
			: {
					...(detached === undefined ? {} : { detached }),
					...(historicalCost === undefined
						? {}
						: {
								metrics: {
									tokens: 1000,
									requests: 2,
									tools: 3,
									cost: historicalCost,
									durationMs: 4000,
								},
							}),
				};
	return {
		id,
		displayName: id,
		kind: "sub",
		parentId,
		status,
		session: null,
		sessionFile,
		createdAt: 1,
		lastActivity: 1,
		history,
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

function observed(id: string, cost: number, detached: boolean, sessionFile?: string): ObservableSession {
	return {
		id,
		kind: "subagent",
		label: id,
		status: "completed",
		detached,
		sessionFile,
		lastUpdate: 1,
		progress: progress(id, cost),
	};
}

function childFile(rootSessionFile: string, id: string): string {
	return `${rootSessionFile.slice(0, -".jsonl".length)}/${id}.jsonl`;
}

describe("Agent Hub async subagent cost projection", () => {
	it("uses detached trees and restored Hub history while excluding unrelated synchronous rows", () => {
		const rootSessionFile = "/tmp/omp-current/main.jsonl";
		const refs = [
			ref("AsyncAgent", undefined, undefined, { sessionFile: childFile(rootSessionFile, "AsyncAgent") }),
			ref("SyncAgent", undefined, undefined, { sessionFile: childFile(rootSessionFile, "SyncAgent") }),
			ref("NestedSyncAgent", undefined, "AsyncAgent", {
				sessionFile: childFile(rootSessionFile, "NestedSyncAgent"),
			}),
			ref("RestoredAgent", 0.18, undefined, {
				sessionFile: childFile(rootSessionFile, "RestoredAgent"),
				detached: true,
			}),
		];
		const sessions = [
			observed("AsyncAgent", 0.42, true, childFile(rootSessionFile, "AsyncAgent")),
			observed("SyncAgent", 0.25, false, childFile(rootSessionFile, "SyncAgent")),
			observed("NestedSyncAgent", 0.12, false, childFile(rootSessionFile, "NestedSyncAgent")),
		];

		expect(aggregateAsyncSubagentCost(refs, sessions, rootSessionFile)).toBeCloseTo(0.72, 8);
	});

	it("excludes parked and idle refs from an old root after the observer resets", () => {
		const oldRootSessionFile = "/tmp/omp-previous/main.jsonl";
		const rootSessionFile = "/tmp/omp-current/main.jsonl";
		const refs = [
			ref("OldParked", 0.11, undefined, {
				status: "parked",
				sessionFile: childFile(oldRootSessionFile, "OldParked"),
				detached: true,
			}),
			ref("OldIdle", 0.13, undefined, {
				status: "idle",
				sessionFile: childFile(oldRootSessionFile, "OldIdle"),
				detached: true,
			}),
			ref("CurrentParked", 0.17, undefined, {
				status: "parked",
				sessionFile: childFile(rootSessionFile, "CurrentParked"),
				detached: true,
			}),
		];
		const bus = new EventBus();
		const observers = new SessionObserverRegistry();
		observers.subscribeToEventBus(bus, bus);
		for (const [id, cost] of [
			["OldParked", 0.11],
			["OldIdle", 0.13],
		] as const) {
			const sessionFile = childFile(oldRootSessionFile, id);
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id,
				agent: "scout",
				agentSource: "bundled",
				status: "completed",
				index: 0,
				detached: true,
				sessionFile,
			} satisfies SubagentLifecyclePayload);
			bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index: 0,
				agent: "scout",
				agentSource: "bundled",
				task: "research",
				detached: true,
				sessionFile,
				progress: progress(id, cost),
			} satisfies SubagentProgressPayload);
		}
		expect(observers.getSessions()).toHaveLength(2);

		observers.resetSessions();

		expect(observers.getSessions()).toEqual([]);
		expect(aggregateAsyncSubagentCost(refs, observers.getSessions(), rootSessionFile)).toBeCloseTo(0.17, 8);
		observers.dispose();
	});

	it("includes restored detached rows while excluding standalone blocking and unknown legacy rows", () => {
		const rootSessionFile = "/tmp/omp-current/main.jsonl";
		const refs = [
			ref("RestoredDetached", 0.31, undefined, {
				sessionFile: childFile(rootSessionFile, "RestoredDetached"),
				detached: true,
			}),
			ref("StandaloneBlocking", undefined, undefined, {
				sessionFile: childFile(rootSessionFile, "StandaloneBlocking"),
			}),
			ref("UnknownLegacy", 0.17, undefined, {
				sessionFile: childFile(rootSessionFile, "UnknownLegacy"),
			}),
		];
		const sessions = [observed("StandaloneBlocking", 0.23, false, childFile(rootSessionFile, "StandaloneBlocking"))];

		expect(aggregateAsyncSubagentCost(refs, sessions, rootSessionFile)).toBeCloseTo(0.31, 8);
	});

	it("includes a blocking child whose restored ancestor was detached", () => {
		const rootSessionFile = "/tmp/omp-current/main.jsonl";
		const refs = [
			ref("RestoredParent", undefined, undefined, {
				status: "parked",
				sessionFile: childFile(rootSessionFile, "RestoredParent"),
				detached: true,
			}),
			ref("BlockingChild", undefined, "RestoredParent", {
				sessionFile: childFile(rootSessionFile, "BlockingChild"),
			}),
		];
		const sessions = [observed("BlockingChild", 0.27, false, childFile(rootSessionFile, "BlockingChild"))];

		expect(aggregateAsyncSubagentCost(refs, sessions, rootSessionFile)).toBeCloseTo(0.27, 8);
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

	it("seeds cold restored spend while keeping warm repeated-turn accumulation isolated", () => {
		const bus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(bus, bus);
		const lifecycle = (
			id: string,
			status: SubagentLifecyclePayload["status"],
			restoredCost?: number,
		): SubagentLifecyclePayload => ({
			id,
			agent: "scout",
			agentSource: "bundled",
			status,
			index: 0,
			detached: true,
			...(restoredCost === undefined ? {} : { restoredCost }),
		});
		const report = (id: string, cost: number): SubagentProgressPayload => ({
			index: 0,
			agent: "scout",
			agentSource: "bundled",
			task: "research",
			progress: progress(id, cost),
			detached: true,
		});

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("ColdAgent", "started", 0.3));
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, report("ColdAgent", 0.2));
		expect(progressMetrics(registry.getSession("ColdAgent"))?.cost).toBeCloseTo(0.5, 8);

		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("WarmAgent", "started"));
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, report("WarmAgent", 0.4));
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("WarmAgent", "completed"));
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("WarmAgent", "started"));
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, report("WarmAgent", 0.1));
		expect(progressMetrics(registry.getSession("WarmAgent"))?.cost).toBeCloseTo(0.5, 8);
		registry.dispose();
	});
});
