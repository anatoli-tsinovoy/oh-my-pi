import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { executeSend } from "@oh-my-pi/pi-coding-agent/irc/messaging";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const MOCK_API_SOURCE = "test/seance-startup-safety";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const UNRESTRICTED_TOOLS = ["bash", "read", "write", "yield"];

interface Fixture {
	cwd: string;
	sourceFile: string;
	sourceBytes: string;
	sourceArtifactsDir: string;
	parentFile: string;
	parentArtifactsDir: string;
	parentOutputPath: string;
	attackPath: string;
	models: MockModel[];
	sourceModel: MockModel;
	dispatches: string[][];
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	parentManager: SessionManager;
}

let savedEnv: Record<string, string | undefined> = {};
let root = "";
const fixtures: Fixture[] = [];

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

function makeTrackedModel(id: string, dispatches: string[][], attackPath: string): MockModel {
	let attemptedWrite = false;
	return createMockModel({
		id,
		handler: context => {
			const toolNames = (context.tools ?? []).map(tool => tool.name);
			dispatches.push(toolNames);
			if (!attemptedWrite && toolNames.includes("write")) {
				attemptedWrite = true;
				return {
					content: [
						{
							type: "toolCall",
							id: `unsafe-write-${id}`,
							name: "write",
							arguments: { path: attackPath, content: "source tools were revived" },
						},
					],
				};
			}
			return {
				content: [
					{
						type: "toolCall",
						id: `yield-${id}`,
						name: "yield",
						arguments: { type: "result", data: "unexpected cold revival" },
					},
				],
			};
		},
	});
}

async function createFixture(): Promise<Fixture> {
	const cwd = path.join(root, "work");
	const sessionsDir = path.join(root, "sessions");
	const sourceDir = path.join(root, "sources");
	await Promise.all([
		fs.mkdir(cwd, { recursive: true }),
		fs.mkdir(sessionsDir, { recursive: true }),
		fs.mkdir(sourceDir, { recursive: true }),
	]);

	const parentManager = SessionManager.create(cwd, sessionsDir);
	const parentFile = parentManager.getSessionFile();
	if (!parentFile) throw new Error("Expected the parent session to have a persisted path");
	parentManager.appendMessage({ role: "user", content: "Parent session", timestamp: Date.now() });
	await parentManager.close();
	const parentArtifactsDir = parentManager.getArtifactsDir();
	if (!parentArtifactsDir) throw new Error("Expected the parent session to have an artifacts directory");
	await fs.mkdir(parentArtifactsDir, { recursive: true });
	const parentOutputPath = path.join(parentArtifactsDir, "parent-result.txt");
	await fs.writeFile(parentOutputPath, "parent result stays intact");

	const sourceFile = path.join(sourceDir, "source.jsonl");
	const sourceArtifactsDir = sourceFile.slice(0, -".jsonl".length);
	await fs.mkdir(sourceArtifactsDir, { recursive: true });
	await fs.writeFile(path.join(sourceArtifactsDir, "source-artifact.txt"), "source artifact remains intact");
	const timestamp = new Date().toISOString();
	const sourceEntries = [
		{ type: "session", version: 3, id: "source-session", timestamp, cwd },
		{
			type: "model_change",
			id: "source-model",
			parentId: null,
			timestamp,
			model: "mock/source",
			role: "default",
		},
		{
			type: "session_init",
			id: "unrestricted-source-init",
			parentId: "source-model",
			timestamp,
			systemPrompt: ["Unrestricted source-session prompt"],
			task: "Original source task",
			tools: UNRESTRICTED_TOOLS,
			agent: "legacy-unrestricted-agent",
			modelRole: "default",
			resolvedModel: "mock/source",
			spawns: "*",
		},
		{
			type: "message",
			id: "source-user-message",
			parentId: "unrestricted-source-init",
			timestamp,
			message: { role: "user", content: "Original source conversation", timestamp: Date.now() },
		},
	];
	const sourceBytes = `${sourceEntries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
	await fs.writeFile(sourceFile, sourceBytes);

	const dispatches: string[][] = [];
	const attackPath = path.join(root, "revived-source-tool-ran.txt");
	const sourceModel = makeTrackedModel("source", dispatches, attackPath);
	const fallbackModel = makeTrackedModel("fallback", dispatches, attackPath);
	const models: MockModel[] = [fallbackModel];
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => models);
	vi.spyOn(modelRegistry, "find").mockImplementation((provider, modelId) =>
		models.find(model => model.provider === provider && model.id === modelId),
	);
	const settings = Settings.isolated({
		"async.enabled": false,
		"advisor.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"task.agentIdleTtlMs": 0,
		"todo.enabled": false,
		modelRoles: { default: "mock/fallback" },
	});

	const fixture = {
		cwd,
		sourceFile,
		sourceBytes,
		sourceArtifactsDir,
		parentFile,
		parentArtifactsDir,
		parentOutputPath,
		attackPath,
		sourceModel,
		models,
		dispatches,
		authStorage,
		modelRegistry,
		settings,
		parentManager,
	};
	fixtures.push(fixture);

	const registry = AgentRegistry.global();
	registry.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: null, status: "idle" });
	const parentSession = {
		sessionManager: {
			getCwd: () => cwd,
			getArtifactManager: () => undefined,
		},
		effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
		preparedExtensions: [],
	} as unknown as AgentSession;
	AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
		createPersistedSubagentReviverFactory({
			session: parentSession,
			authStorage,
			modelRegistry,
			settings,
			enableLsp: false,
		}),
		() => 0,
	);
	return fixture;
}

async function startMissingModelSeance(fixture: Fixture, id: string) {
	const agent = {
		name: "seance",
		description: "Saved-session consultation",
		systemPrompt: "Consult the saved session without changing files.",
		tools: ["write", "bash", "task", "read"],
		model: ["mock/fallback"],
		source: "bundled" as const,
	};
	return runSubprocess({
		cwd: fixture.cwd,
		artifactsDir: fixture.parentArtifactsDir,
		sessionFile: fixture.parentFile,
		agent,
		task: "Consult the original source session.",
		index: 0,
		id,
		parentAgentId: MAIN_AGENT_ID,
		sourceSession: fixture.sourceFile,
		modelRegistry: fixture.modelRegistry,
		authStorage: fixture.authStorage,
		settings: fixture.settings,
		parentActiveModelPattern: "mock/fallback",
		restrictToolNames: false,
		enableIrc: true,
	});
}

async function expectExists(filePath: string): Promise<void> {
	await fs.access(filePath);
}

async function expectMissing(filePath: string): Promise<void> {
	try {
		await fs.access(filePath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return;
		throw error;
	}
	throw new Error(`Expected ${filePath} to be missing`);
}

function childFile(fixture: Fixture, id: string): string {
	return path.join(fixture.parentArtifactsDir, `${id}.jsonl`);
}

async function attemptIrcColdDelivery(fixture: Fixture, id: string) {
	const registry = AgentRegistry.global();
	await ensurePersistedRoster(registry, fixture.parentFile);
	return executeSend(
		{ registry, senderId: MAIN_AGENT_ID, sessionFileHint: fixture.parentFile },
		{ to: id, message: "Wake the persisted subagent." },
	);
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seance-startup-safety-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	for (const fixture of fixtures.splice(0)) {
		fixture.authStorage.close();
		await fixture.parentManager.close();
	}
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	closeModelCache();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	await removeWithRetries(root);
});

it("deletes a pre-contract fork without changing its source or parent artifacts", async () => {
	const fixture = await createFixture();
	const id = "seance-missing-model-cleanup";
	const result = await startMissingModelSeance(fixture, id);

	expect(result.exitCode).toBe(1);
	expect(result.error ?? result.stderr).toContain("No saved model from the source session is available");
	expect(fixture.dispatches).toEqual([]);
	expect(await fs.readFile(fixture.sourceFile, "utf8")).toBe(fixture.sourceBytes);
	await expectMissing(childFile(fixture, id));
	await expectMissing(path.join(fixture.parentArtifactsDir, id, "source-artifact.txt"));
	await expectExists(path.join(fixture.parentArtifactsDir, `${id}.md`));
	await expectExists(fixture.parentOutputPath);
	expect(await fs.readFile(fixture.parentOutputPath, "utf8")).toBe("parent result stays intact");
	expect(await fs.readFile(path.join(fixture.sourceArtifactsDir, "source-artifact.txt"), "utf8")).toBe(
		"source artifact remains intact",
	);

	const delivery = await attemptIrcColdDelivery(fixture, id);
	expect(delivery.isError).toBe(true);
	expect(fixture.dispatches).toEqual([]);
});

it("keeps inherited init historical and unavailable when owned-fork deletion fails", async () => {
	const fixture = await createFixture();
	const id = "seance-missing-model-delete-failure";
	const filePath = childFile(fixture, id);
	vi.spyOn(FileSessionStorage.prototype, "deleteSessionWithArtifacts").mockRejectedValueOnce(
		new Error("simulated child-fork deletion failure"),
	);

	const result = await startMissingModelSeance(fixture, id);
	expect(result.exitCode).toBe(1);
	expect(result.error ?? result.stderr).toContain("No saved model from the source session is available");
	expect(fixture.dispatches).toEqual([]);
	expect(await fs.readFile(fixture.sourceFile, "utf8")).toBe(fixture.sourceBytes);
	await expectExists(filePath);
	await expectExists(path.join(fixture.parentArtifactsDir, id, "source-artifact.txt"));
	await expectExists(fixture.parentOutputPath);
	expect(await fs.readFile(fixture.parentOutputPath, "utf8")).toBe("parent result stays intact");

	const childEntries = (await fs.readFile(filePath, "utf8"))
		.trimEnd()
		.split("\n")
		.map(line => JSON.parse(line) as Record<string, unknown>);
	const archivedInit = childEntries.find(
		entry => entry.type === "custom" && entry.customType === "source_session_init",
	);
	expect(archivedInit).toMatchObject({
		type: "custom",
		id: "unrestricted-source-init",
		parentId: "source-model",
		data: { type: "session_init", tools: UNRESTRICTED_TOOLS, agent: "legacy-unrestricted-agent" },
	});
	expect(childEntries.some(entry => entry.type === "session_init")).toBe(false);
	expect(childEntries.find(entry => entry.id === "source-user-message")?.parentId).toBe("unrestricted-source-init");
	expect(childEntries.find(entry => entry.id === "source-model")?.type).toBe("model_change");
	expect((await SessionManager.peekSessionInit(filePath))?.init).toBeNull();

	// The missing source model becomes available later, as it can in a new process.
	// An old inherited init would now cold-revive with its unrestricted tools.
	fixture.models.push(fixture.sourceModel);
	const registry = AgentRegistry.global();
	await ensurePersistedRoster(registry, fixture.parentFile);
	expect(registry.get(id)).toMatchObject({ id, status: "parked", session: null, sessionFile: filePath });
	const delivery = await executeSend(
		{ registry, senderId: MAIN_AGENT_ID, sessionFileHint: fixture.parentFile },
		{ to: id, message: "Wake the persisted subagent." },
	);
	const text = delivery.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
	expect(delivery.isError).toBe(true);
	expect(text).toContain("no reviver registered");
	expect(AgentRegistry.global().get(id)?.session).toBeNull();
	expect(fixture.dispatches).toEqual([]);
	await expectMissing(fixture.attackPath);
});
