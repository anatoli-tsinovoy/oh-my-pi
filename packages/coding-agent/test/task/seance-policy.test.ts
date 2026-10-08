import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgTaskAgentModelOverrides } from "@oh-my-pi/pi-coding-agent/task/settings";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import {
	resolveEffectiveSubagentPolicy,
	StructuredSubagentError,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TempDir } from "@oh-my-pi/pi-utils";

const SEANCE_AGENT: AgentDefinition = {
	name: "seance",
	description: "Consult a saved session.",
	systemPrompt: "Read-only source session consultation.",
	tools: ["write", "bash", "task"],
	model: ["openai/agent-default"],
	source: "bundled",
};

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"task.maxRecursionDepth": 2,
			"task.isolation.enabled": false,
			modelRoles: { default: "openai/parent", reviewer: "openai/agent-default" },
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionAgents: () => [],
	} as unknown as ToolSession;
}

async function sourceFile(tempDir: string, cwd: string): Promise<string> {
	const filePath = path.join(tempDir, "source.jsonl");
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(
		filePath,
		`${JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "source-session",
			timestamp: new Date().toISOString(),
			cwd,
		})}\n`,
	);
	return filePath;
}

function taskRequest(
	session: ToolSession,
	sourceSession: string,
	model?: string | string[],
): StructuredSubagentRequest {
	return {
		session,
		invocationKind: "task",
		assignment: "Consult the prior transcript.",
		agent: "seance",
		sourceSession,
		...(model !== undefined ? { model } : {}),
	};
}

afterEach(() => vi.restoreAllMocks());

it("bypasses inherited task and agent models so the fork's saved role restores natively", async () => {
	using tempDir = TempDir.createSync("@omp-seance-policy-");
	const cwd = path.join(tempDir.path(), "project");
	const filePath = await sourceFile(path.join(tempDir.path(), "sessions"), cwd);
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [SEANCE_AGENT], projectAgentsDir: null });
	const session = createSession(cwd);
	cfgTaskAgentModelOverrides.override(session.settings, { seance: "openai/task-override" });

	const policy = await resolveEffectiveSubagentPolicy(taskRequest(session, filePath));

	expect(policy.modelOverride).toBeUndefined();
	expect(policy.modelRole).toBeUndefined();
	expect(policy.effectiveAgent.model).toBeUndefined();
	expect(policy.sourceSessionPath).toBe(filePath);
});

it("treats empty model selectors as saved-model restoration, not parent defaults", async () => {
	using tempDir = TempDir.createSync("@omp-seance-empty-model-");
	const cwd = path.join(tempDir.path(), "project");
	const filePath = await sourceFile(path.join(tempDir.path(), "sessions"), cwd);
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [SEANCE_AGENT], projectAgentsDir: null });
	const session = createSession(cwd);
	cfgTaskAgentModelOverrides.override(session.settings, { seance: "openai/task-override" });

	const emptySelectors: Array<string | string[]> = ["", ",", [], [""]];
	for (const model of emptySelectors) {
		const policy = await resolveEffectiveSubagentPolicy(taskRequest(session, filePath, model));
		expect(policy.modelOverride).toBeUndefined();
		expect(policy.effectiveAgent.model).toBeUndefined();
	}
});

it("keeps an explicit request model above seance defaults", async () => {
	using tempDir = TempDir.createSync("@omp-seance-explicit-policy-");
	const cwd = path.join(tempDir.path(), "project");
	const filePath = await sourceFile(path.join(tempDir.path(), "sessions"), cwd);
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [SEANCE_AGENT], projectAgentsDir: null });
	const session = createSession(cwd);
	cfgTaskAgentModelOverrides.override(session.settings, { seance: "openai/task-override" });

	const policy = await resolveEffectiveSubagentPolicy(taskRequest(session, filePath, "anthropic/explicit"));

	expect(policy.modelOverride).toEqual(["anthropic/explicit"]);
});

it("rejects sourceSession on other agents and missing sources for seance", async () => {
	using tempDir = TempDir.createSync("@omp-seance-contract-");
	const session = createSession(path.join(tempDir.path(), "project"));

	await expect(
		resolveEffectiveSubagentPolicy({
			...taskRequest(session, "unused"),
			agent: "task",
		}),
	).rejects.toBeInstanceOf(StructuredSubagentError);
	await expect(
		resolveEffectiveSubagentPolicy({ ...taskRequest(session, ""), sourceSession: undefined }),
	).rejects.toThrow("requires a `sourceSession`");
});
