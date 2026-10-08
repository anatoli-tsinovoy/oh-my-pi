import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { createParentSubagentUsageRecorder } from "@oh-my-pi/pi-coding-agent/task/subagent-usage";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { ParentSubagentUsageRecorder } from "@oh-my-pi/pi-coding-agent/task/subagent-usage";

const MOCK_API_SOURCE = "test/seance-executor";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const SOURCE_SESSION_ID = "seance-source-history";
const ACTIVE_BRANCH_MARKER = "CURRENT_BRANCH_MARKER";
const INACTIVE_BRANCH_MARKER = "INACTIVE_BRANCH_MARKER";
const ALLOWED_TOOL_NAMES = ["glob", "grep", "read", "yield"];

interface CapturedRequest {
	modelId: string;
	toolNames: string[];
	messages: string;
	attemptedToolCall?: string;
}

let savedEnv: Record<string, string | undefined> = {};
let root: string;
const authStorages: AuthStorage[] = [];
const sessionManagers: SessionManager[] = [];
interface LocalHttpServer {
	readonly url: URL;
	stop(force?: boolean): void;
}
let localHttpServer: LocalHttpServer | undefined;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seance-executor-"));
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
	for (const storage of authStorages.splice(0)) storage.close();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	localHttpServer?.stop(true);
	localHttpServer = undefined;
	for (const manager of sessionManagers.splice(0)) await manager.close();
	await removeWithRetries(root);
});

interface HistoricalSpend {
	assistant: number;
	task: number;
	nestedTask: number;
	modelUsage: number;
}

async function createSourceSession(
	roleModel: string,
	defaultModel: string,
	historicalReferences?: string,
	historicalSpend?: HistoricalSpend,
): Promise<{ filePath: string; bytes: string }> {
	const cwd = path.join(root, "home", "work");
	const filePath = path.join(root, "sessions", "source.jsonl");
	await fs.mkdir(cwd, { recursive: true });
	const timestamp = new Date().toISOString();
	const entries: Array<Record<string, unknown>> = [
		{ type: "session", version: 3, id: SOURCE_SESSION_ID, timestamp, cwd },
		{
			type: "model_change",
			id: "saved-default-model",
			parentId: null,
			timestamp,
			model: defaultModel,
			role: "default",
		},
		{
			type: "model_change",
			id: "saved-reviewer-model",
			parentId: "saved-default-model",
			timestamp,
			model: roleModel,
			role: "reviewer",
		},
		{
			type: "message",
			id: "source-root",
			parentId: "saved-reviewer-model",
			timestamp,
			message: { role: "user", content: "ROOT_HISTORY_MARKER", timestamp: Date.now() },
		},
		{
			type: "message",
			id: "inactive-branch",
			parentId: "source-root",
			timestamp,
			message: { role: "user", content: INACTIVE_BRANCH_MARKER, timestamp: Date.now() },
		},
		{
			type: "message",
			id: "active-branch",
			parentId: "source-root",
			timestamp,
			message: {
				role: "user",
				content: [ACTIVE_BRANCH_MARKER, historicalReferences].filter(Boolean).join("\n"),
				timestamp: Date.now(),
			},
		},
	];
	if (historicalSpend) {
		const usage = (cost: number) => ({
			input: 20,
			output: 10,
			cacheRead: 5,
			cacheWrite: 2,
			totalTokens: 37,
			premiumRequests: 1,
			credits: { cost, committedCost: cost, acuCost: 1 },
			cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		});
		entries.push(
			{
				type: "message",
				id: "source-assistant-cost",
				parentId: "active-branch",
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "source-task-call", name: "task", arguments: {} }],
					api: "mock",
					provider: "mock",
					model: roleModel,
					stopReason: "toolUse",
					timestamp: Date.now(),
					usage: usage(historicalSpend.assistant),
				},
			},
			{
				type: "message",
				id: "source-task-result",
				parentId: "source-assistant-cost",
				timestamp,
				message: {
					role: "toolResult",
					toolCallId: "source-task-call",
					toolName: "task",
					content: [{ type: "text", text: "historical nested task output" }],
					details: {
						usage: usage(historicalSpend.task),
						results: [{ id: "nested-task", usage: usage(historicalSpend.nestedTask) }],
						progress: [{ id: "nested-task", tokens: 37, cost: historicalSpend.nestedTask }],
					},
					isError: false,
					timestamp: Date.now(),
				},
			},
			{
				type: "model_usage",
				id: "source-hidden-model-cost",
				parentId: "active-branch",
				timestamp,
				purpose: "source-history",
				role: "reviewer",
				api: "mock",
				provider: "mock",
				model: "historical-hidden-model",
				stopReason: "stop",
				usage: usage(historicalSpend.modelUsage),
			},
		);
	}
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const bytes = `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
	await Bun.write(filePath, bytes);
	return { filePath, bytes };
}

async function createSourceSessionWithoutSavedModel(): Promise<{ filePath: string; bytes: string }> {
	const cwd = path.join(root, "home", "work");
	const filePath = path.join(root, "sessions", "source.jsonl");
	await fs.mkdir(cwd, { recursive: true });
	const timestamp = new Date().toISOString();
	const entries: Array<Record<string, unknown>> = [
		{ type: "session", version: 3, id: SOURCE_SESSION_ID, timestamp, cwd },
		{
			type: "message",
			id: "source-root",
			parentId: null,
			timestamp,
			message: { role: "user", content: "ROOT_HISTORY_MARKER", timestamp: Date.now() },
		},
	];
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const bytes = `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
	await Bun.write(filePath, bytes);
	return { filePath, bytes };
}

function makeModel(
	id: string,
	requests: CapturedRequest[],
	options: {
		maliciousWritePath?: string;
		readReferences?: { url: string };
		readPaths?: string[];
		usage?: MockResponse["usage"];
		onProviderCall?: () => void;
	} = {},
): MockModel {
	let attemptedMaliciousWrite = false;
	const readCallsByPhase: Record<string, number> = {};
	const pricedUsage = options.usage === undefined ? {} : { usage: options.usage };
	return createMockModel({
		id,
		handler: context => {
			const toolNames = (context.tools ?? []).map(tool => tool.name).sort();
			const messages = JSON.stringify(context.messages);
			const captured: CapturedRequest = { modelId: id, toolNames, messages };
			requests.push(captured);
			options.onProviderCall?.();
			if (!toolNames.includes("yield")) return { content: ["Seance test"], ...pricedUsage };
			if (options.maliciousWritePath && !attemptedMaliciousWrite) {
				attemptedMaliciousWrite = true;
				captured.attemptedToolCall = "write";
				return {
					content: [
						{
							type: "toolCall",
							name: "write",
							arguments: { path: options.maliciousWritePath, content: "unauthorized" },
						},
					],
					...pricedUsage,
				};
			}

			const wakeMarker = ["SEANCE_COLD_WAKE_MARKER", "SEANCE_WARM_WAKE_MARKER", "SEANCE_WAKE_MARKER"].find(marker =>
				messages.includes(marker),
			);
			const phase = wakeMarker ?? "initial";
			const readPaths =
				options.readPaths ??
				(options.readReferences
					? ["artifact://777", "local://SEANCE_PLAN.txt", options.readReferences.url]
					: undefined);
			if (readPaths) {
				const readIndex = readCallsByPhase[phase] ?? 0;
				if (readIndex < readPaths.length) {
					readCallsByPhase[phase] = readIndex + 1;
					return {
						content: [
							{
								type: "toolCall",
								id: `read-${phase}-${readIndex}`,
								name: "read",
								arguments: { path: readPaths[readIndex] },
							},
						],
						...pricedUsage,
					};
				}
			}

			return {
				content: [
					{
						type: "toolCall",
						name: "yield",
						arguments: {
							type: "result",
							data: wakeMarker ? "Seance wake result" : "Initial seance result",
						},
					},
				],
				...pricedUsage,
			};
		},
	});
}

const HIDDEN_MODEL_USAGE = {
	input: 2,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0.02, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.05 },
} as const;

function appendHiddenUsageFromSource(id: string, childUsageIds?: string[]): void {
	const session = AgentRegistry.global().get(id)?.session;
	if (!session) throw new Error("expected live seance session for hidden usage");
	const manager = session.sessionManager;
	const entryId = manager.appendModelUsage(
		{
			purpose: "provider-hidden-test",
			role: "tiny",
			api: "mock",
			provider: "mock",
			model: "hidden-model",
			usage: HIDDEN_MODEL_USAGE,
			stopReason: "error",
			errorMessage: "hidden provider attempt failed after reporting usage",
		},
		{ sessionId: manager.getSessionId(), parentId: manager.getLeafId() },
	);
	if (entryId) childUsageIds?.push(entryId);
}

function createRegistry(models: MockModel[]) {
	const authStorage = createInMemoryAuthStorage();
	authStorages.push(authStorage);
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => models);
	vi.spyOn(modelRegistry, "find").mockImplementation((provider, modelId) =>
		models.find(model => model.provider === provider && model.id === modelId),
	);
	return { authStorage, modelRegistry };
}

function settings(defaultModel: string): Settings {
	return Settings.isolated({
		"async.enabled": false,
		"advisor.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"task.agentIdleTtlMs": 0,
		"todo.enabled": false,
		"todo.reminders": false,
		modelRoles: { default: defaultModel, reviewer: "mock/role-model", tiny: defaultModel },
	});
}

async function runSeance(args: {
	id: string;
	roleModel: string;
	defaultModel: string;
	models: MockModel[];
	requests: CapturedRequest[];
	modelOverride?: string | string[];
	parentModelPattern?: string;
	enableIrc?: boolean;
	detached?: boolean;
	sourceHasModels?: boolean;
	historicalReferences?: string;
	historicalSpend?: HistoricalSpend;
	prepareSource?: (sourceFile: string) => Promise<void>;
	parentSessionManager?: SessionManager;
	parentUsageRecorder?: ParentSubagentUsageRecorder;
}): Promise<{
	result: SingleResult;
	sourceFile: string;
	sourceBytes: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	sessionSettings: Settings;
}> {
	const cwd = path.join(root, "home", "work");
	const artifactsDir = args.parentSessionManager?.getArtifactsDir() ?? path.join(root, "artifacts", args.id);
	await fs.mkdir(artifactsDir, { recursive: true });
	const source =
		args.sourceHasModels === false
			? await createSourceSessionWithoutSavedModel()
			: await createSourceSession(
					args.roleModel,
					args.defaultModel,
					args.historicalReferences,
					args.historicalSpend,
				);
	await args.prepareSource?.(source.filePath);
	const { authStorage, modelRegistry } = createRegistry(args.models);
	const sessionSettings = settings(args.defaultModel);
	const agent = {
		name: "seance",
		description: "Saved-session consultation",
		systemPrompt: "Consult the saved session without changing files.",
		// Deliberately hostile metadata proves that the executor does not trust
		// project or user definitions to enforce the seance capability boundary.
		tools: ["write", "bash", "task", "ast_edit", "read"],
		model: ["mock/agent-default"],
		source: "bundled" as const,
	};
	const main = AgentRegistry.global().get(MAIN_AGENT_ID);
	if (!main) {
		AgentRegistry.global().register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: null,
			status: "idle",
		});
	}
	const result = await runSubprocess({
		cwd,
		artifactsDir,
		agent,
		task: "Read the relevant source and report findings.",
		index: 0,
		id: args.id,
		parentAgentId: MAIN_AGENT_ID,
		sourceSession: source.filePath,
		...(args.modelOverride !== undefined ? { modelOverride: args.modelOverride } : {}),
		authStorage,
		modelRegistry,
		settings: sessionSettings,
		parentActiveModelPattern: args.parentModelPattern,
		enableLsp: true,
		enableMCP: true,
		enableIrc: args.enableIrc,
		detached: args.detached,
		parentUsageRecorder: args.parentUsageRecorder,
		...(args.parentSessionManager
			? {
					parentArtifactManager: args.parentSessionManager.getArtifactManager() ?? undefined,
					localProtocolOptions: {
						getArtifactsDir: () => args.parentSessionManager?.getArtifactsDir() ?? null,
						getSessionId: () => args.parentSessionManager?.getSessionId() ?? null,
					},
				}
			: {}),
		// This must remain false in the caller to prove seance itself forces it.
		restrictToolNames: false,
	});
	return {
		result,
		sourceFile: source.filePath,
		sourceBytes: source.bytes,
		authStorage,
		modelRegistry,
		sessionSettings,
	};
}

function expectSucceeded(result: SingleResult): void {
	if (result.exitCode !== 0) {
		throw new Error(`Seance exited ${result.exitCode}: ${result.error ?? result.stderr}`);
	}
}

it("forks and restores only the source's current branch using its saved active role", async () => {
	const requests: CapturedRequest[] = [];
	const role = makeModel("role-model", requests);
	const fallback = makeModel("default-model", requests);
	const { result, sourceFile, sourceBytes } = await runSeance({
		id: "SeanceActiveRole",
		roleModel: "mock/role-model",
		defaultModel: "mock/default-model",
		models: [role, fallback],
		requests,
	});

	expectSucceeded(result);
	expect(result.resolvedModelIdentity).toBe("mock/role-model");
	expect(result.modelFallbackMessage).toBeUndefined();
	const request = requests.find(item => item.toolNames.includes("yield"));
	expect(request?.modelId).toBe("role-model");
	expect(request?.toolNames).toEqual(ALLOWED_TOOL_NAMES);
	expect(request?.messages).toContain(ACTIVE_BRANCH_MARKER);
	expect(request?.messages).not.toContain(INACTIVE_BRANCH_MARKER);
	expect(await Bun.file(sourceFile).text()).toBe(sourceBytes);

	const childFile = path.join(root, "artifacts", "SeanceActiveRole", "SeanceActiveRole.jsonl");
	const child = await loadSessionFile(childFile);
	const childHeader = child.entries[0];
	expect(childHeader?.type).toBe("session");
	if (childHeader?.type === "session") {
		expect(childHeader.id).not.toBe(SOURCE_SESSION_ID);
		expect(childHeader.parentSession).toBe(SOURCE_SESSION_ID);
	}
});

it("falls back from an unavailable saved role to the saved default and surfaces the notice", async () => {
	const requests: CapturedRequest[] = [];
	const fallback = makeModel("default-model", requests);
	const { result, sourceFile, sourceBytes } = await runSeance({
		id: "SeanceSavedDefault",
		roleModel: "mock/unavailable-role",
		defaultModel: "mock/default-model",
		models: [fallback],
		requests,
	});

	expectSucceeded(result);
	expect(result.resolvedModelIdentity).toBe("mock/default-model");
	expect(result.modelFallbackMessage).toContain("mock/unavailable-role");
	expect(result.modelFallbackMessage).toContain("mock/default-model");
	expect(requests.find(item => item.toolNames.includes("yield"))?.modelId).toBe("default-model");
	expect(await Bun.file(sourceFile).text()).toBe(sourceBytes);
});

it("uses an explicit model override instead of the source's saved model", async () => {
	const requests: CapturedRequest[] = [];
	const role = makeModel("role-model", requests);
	const fallback = makeModel("default-model", requests);
	const explicit = makeModel("explicit-model", requests);
	const { result, sourceFile, sourceBytes } = await runSeance({
		id: "SeanceExplicitModel",
		roleModel: "mock/role-model",
		defaultModel: "mock/default-model",
		models: [role, fallback, explicit],
		requests,
		modelOverride: "mock/explicit-model",
	});

	expectSucceeded(result);
	expect(result.resolvedModelIdentity).toBe("mock/explicit-model");
	expect(requests.find(item => item.toolNames.includes("yield"))?.modelId).toBe("explicit-model");
	expect(await Bun.file(sourceFile).text()).toBe(sourceBytes);
});

it("requires an override when the source contains no saved model instead of using a parent default", async () => {
	const requests: CapturedRequest[] = [];
	const parent = makeModel("parent-model", requests);
	const { result, sourceFile, sourceBytes } = await runSeance({
		id: "SeanceNoSavedModel",
		roleModel: "mock/unavailable-role",
		defaultModel: "mock/missing-default",
		models: [parent],
		requests,
		parentModelPattern: "mock/parent-model",
		sourceHasModels: false,
	});

	expect(result.exitCode).not.toBe(0);
	expect(result.error ?? result.stderr).toContain("no saved model");
	expect(result.error ?? result.stderr).toContain("explicit model override");
	expect(requests.some(item => item.toolNames.includes("yield"))).toBe(false);
	expect(requests.every(item => !item.messages.includes("ROOT_HISTORY_MARKER"))).toBe(true);
	expect(await Bun.file(sourceFile).text()).toBe(sourceBytes);
});

it("fails closed before transcript dispatch when no source-saved model can be restored", async () => {
	const requests: CapturedRequest[] = [];
	const parent = makeModel("parent-model", requests);
	const { result, sourceFile, sourceBytes } = await runSeance({
		id: "SeanceUnavailableModels",
		roleModel: "mock/missing-role",
		defaultModel: "mock/missing-default",
		models: [parent],
		requests,
		parentModelPattern: "mock/parent-model",
	});

	expect(result.exitCode).not.toBe(0);
	expect(result.error ?? result.stderr).toContain("explicit model override");
	expect(requests.some(item => item.toolNames.includes("yield"))).toBe(false);
	expect(requests.every(item => !item.messages.includes("ROOT_HISTORY_MARKER"))).toBe(true);
	expect(await Bun.file(sourceFile).text()).toBe(sourceBytes);
});

it("rejects a malicious write call without exposing the write tool", async () => {
	const requests: CapturedRequest[] = [];
	const target = path.join(root, "forbidden-write.txt");
	const model = makeModel("role-model", requests, { maliciousWritePath: target });
	const { sourceFile, sourceBytes } = await runSeance({
		id: "SeanceMaliciousWrite",
		roleModel: "mock/role-model",
		defaultModel: "mock/default-model",
		models: [model],
		requests,
	});

	const writeAttempt = requests.find(item => item.attemptedToolCall === "write");
	expect(writeAttempt?.toolNames).toEqual(ALLOWED_TOOL_NAMES);
	expect(requests.find(item => item.toolNames.includes("yield"))?.toolNames).toEqual(ALLOWED_TOOL_NAMES);
	expect(await Bun.file(target).exists()).toBe(false);
	expect(await Bun.file(sourceFile).text()).toBe(sourceBytes);
});

it("reads forked artifact and local references from its own namespace after fresh, warm, and cold revival", async () => {
	const id = "SeanceArtifactNamespace";
	const cwd = path.join(root, "home", "work");
	const parentSessionManager = await SessionManager.open(
		path.join(root, "artifacts", "main.jsonl"),
		undefined,
		undefined,
		{ initialCwd: cwd },
	);
	sessionManagers.push(parentSessionManager);
	const parentArtifactsDir = parentSessionManager.getArtifactsDir();
	if (!parentArtifactsDir) throw new Error("Expected the parent session to have an artifacts directory");
	await fs.mkdir(path.join(parentArtifactsDir, "local"), { recursive: true });
	await fs.writeFile(path.join(parentArtifactsDir, "777.read.log"), "PARENT_ARTIFACT_PAYLOAD");
	await fs.writeFile(path.join(parentArtifactsDir, "778.bash.log"), "PARENT_ARTIFACT_ID_778");
	await fs.writeFile(path.join(parentArtifactsDir, "local", "SEANCE_PLAN.txt"), "PARENT_LOCAL_PLAN");

	const sourceArtifactPayload = "SOURCE_ARTIFACT_PAYLOAD";
	const sourceLocalPlan = "SOURCE_LOCAL_PLAN";
	const sourceReferences = "Historical references: artifact://777 and local://SEANCE_PLAN.txt";
	const remotePayload = `URL_READ_START\n${"remote-content-line\n".repeat(5_000)}URL_READ_END\n`;
	localHttpServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () =>
			new Response(remotePayload, {
				headers: { "content-type": "text/plain; charset=utf-8" },
			}),
	});
	const readUrl = new URL("/large.txt", localHttpServer.url).toString();
	const requests: CapturedRequest[] = [];
	const model = makeModel("role-model", requests, { readReferences: { url: readUrl } });
	const { result, sourceFile, sourceBytes, authStorage, modelRegistry, sessionSettings } = await runSeance({
		id,
		roleModel: "mock/role-model",
		defaultModel: "mock/default-model",
		models: [model],
		requests,
		enableIrc: true,
		historicalReferences: sourceReferences,
		parentSessionManager,
		prepareSource: async sourceFile => {
			const artifactsDir = sourceFile.slice(0, -".jsonl".length);
			await fs.mkdir(path.join(artifactsDir, "local"), { recursive: true });
			await fs.writeFile(path.join(artifactsDir, "777.read.log"), sourceArtifactPayload);
			await fs.writeFile(path.join(artifactsDir, "local", "SEANCE_PLAN.txt"), sourceLocalPlan);
		},
	});
	expectSucceeded(result);
	const sourceArtifactsDir = sourceFile.slice(0, -".jsonl".length);

	const childArtifactsDir = path.join(parentArtifactsDir, id);
	const assertReadResults = (wakeMarker?: string) => {
		const request = requests.find(item => {
			const turnStart = wakeMarker ? item.messages.indexOf(wakeMarker) : 0;
			if (wakeMarker && turnStart < 0) return false;
			const turnMessages = item.messages.slice(turnStart);
			const hasWakeMarker =
				turnMessages.includes("SEANCE_WARM_WAKE_MARKER") || turnMessages.includes("SEANCE_COLD_WAKE_MARKER");
			return (
				turnMessages.includes(sourceArtifactPayload) &&
				turnMessages.includes(sourceLocalPlan) &&
				turnMessages.includes("URL_READ_START") &&
				(wakeMarker ? turnMessages.includes(wakeMarker) : !hasWakeMarker)
			);
		});
		expect(request).toBeDefined();
		if (!request) return;
		expect(request.toolNames).toEqual(ALLOWED_TOOL_NAMES);
		expect(request.messages).not.toContain("PARENT_ARTIFACT_PAYLOAD");
		expect(request.messages).not.toContain("PARENT_LOCAL_PLAN");
	};
	const assertReadArtifact = async (artifactId: number) => {
		const artifactPath = path.join(childArtifactsDir, `${artifactId}.read.log`);
		const artifact = await fs.readFile(artifactPath, "utf8");
		expect(artifact).toContain("URL_READ_START");
		expect(artifact).toContain("URL_READ_END");
	};

	assertReadResults();
	expect(await fs.readFile(path.join(childArtifactsDir, "777.read.log"), "utf8")).toBe(sourceArtifactPayload);
	expect(await fs.readFile(path.join(childArtifactsDir, "local", "SEANCE_PLAN.txt"), "utf8")).toBe(sourceLocalPlan);
	await assertReadArtifact(778);
	expect(await fs.readFile(path.join(parentArtifactsDir, "778.bash.log"), "utf8")).toBe("PARENT_ARTIFACT_ID_778");

	const wakeAndRead = async (marker: string) => {
		const replyPromise = IrcBus.global().wait(MAIN_AGENT_ID, { from: id }, 15_000);
		const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: id, body: marker });
		expect(receipt.outcome).toBe("revived");
		const reply = await replyPromise;
		expect(reply?.body).toContain("Seance wake result");
	};
	await AgentLifecycleManager.global().park(id);
	await wakeAndRead("SEANCE_WARM_WAKE_MARKER");
	assertReadResults("SEANCE_WARM_WAKE_MARKER");
	await assertReadArtifact(779);

	await AgentLifecycleManager.global().park(id);
	AgentLifecycleManager.resetGlobalForTests();
	AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
		createPersistedSubagentReviverFactory({
			session: { sessionManager: parentSessionManager } as unknown as AgentSession,
			authStorage,
			modelRegistry,
			settings: sessionSettings,
			enableLsp: true,
		}),
		() => 0,
	);
	await wakeAndRead("SEANCE_COLD_WAKE_MARKER");
	assertReadResults("SEANCE_COLD_WAKE_MARKER");
	await assertReadArtifact(780);

	expect(await Bun.file(sourceFile).text()).toBe(sourceBytes);
	expect(await fs.readFile(path.join(sourceArtifactsDir, "777.read.log"), "utf8")).toBe(sourceArtifactPayload);
	expect(await fs.readFile(path.join(sourceArtifactsDir, "local", "SEANCE_PLAN.txt"), "utf8")).toBe(sourceLocalPlan);
	expect(await fs.readFile(path.join(parentArtifactsDir, "777.read.log"), "utf8")).toBe("PARENT_ARTIFACT_PAYLOAD");
	expect(await fs.readFile(path.join(parentArtifactsDir, "local", "SEANCE_PLAN.txt"), "utf8")).toBe(
		"PARENT_LOCAL_PLAN",
	);
}, 60_000);

it("relays an inbound message after yield and preserves the whitelist after park and revive", async () => {
	const requests: CapturedRequest[] = [];
	const model = makeModel("role-model", requests);
	const { result, sourceFile, sourceBytes } = await runSeance({
		id: "SeanceRestrictedRevive",
		roleModel: "mock/role-model",
		defaultModel: "mock/default-model",
		models: [model],
		requests,
		enableIrc: true,
	});

	expectSucceeded(result);
	expect(requests.find(item => item.toolNames.includes("yield"))?.toolNames).toEqual(ALLOWED_TOOL_NAMES);
	await AgentLifecycleManager.global().park("SeanceRestrictedRevive");
	expect(AgentRegistry.global().get("SeanceRestrictedRevive")).toMatchObject({ status: "parked", session: null });

	const replyPromise = IrcBus.global().wait(MAIN_AGENT_ID, { from: "SeanceRestrictedRevive" }, 10_000);
	const receipt = await IrcBus.global().send({
		from: MAIN_AGENT_ID,
		to: "SeanceRestrictedRevive",
		body: "SEANCE_WAKE_MARKER",
	});
	expect(receipt.outcome).toBe("revived");
	const reply = await replyPromise;
	expect(reply).toMatchObject({
		from: "SeanceRestrictedRevive",
		to: MAIN_AGENT_ID,
	});
	expect(reply?.body).toContain("Seance wake result");
	expect(reply?.replyTo).toBeTruthy();
	const wakeRequest = requests.find(
		item => item.toolNames.includes("yield") && item.messages.includes("SEANCE_WAKE_MARKER"),
	);
	expect(wakeRequest?.toolNames).toEqual(ALLOWED_TOOL_NAMES);
	expect(await Bun.file(sourceFile).text()).toBe(sourceBytes);
}, 20_000);

it("counts only new fork usage in the parent session across async, warm, and cold seance turns", async () => {
	const id = "SeanceCostAccounting";
	const parentFile = path.join(root, "artifacts", "main.jsonl");
	const parentSessionManager = await SessionManager.open(parentFile, undefined, undefined, {
		suppressBreadcrumb: true,
	});
	sessionManagers.push(parentSessionManager);
	parentSessionManager.appendMessage({
		role: "user",
		content: "Parent ledger root branch",
		timestamp: Date.now(),
	});
	const existingRootUsage = {
		input: 4,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 4,
		cost: { input: 0.4, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.4 },
	} as const;
	parentSessionManager.appendModelUsage(
		{
			purpose: "seance-command",
			role: "default",
			api: "mock",
			provider: "mock",
			model: "existing-root-cost",
			usage: existingRootUsage,
			stopReason: "stop",
		},
		{ sessionId: parentSessionManager.getSessionId(), parentId: parentSessionManager.getLeafId() },
	);
	expect(parentSessionManager.getUsageStatistics().cost).toBeCloseTo(0.4);

	const usage = {
		input: 7,
		output: 3,
		cacheRead: 2,
		cacheWrite: 1,
		totalTokens: 13,
		cost: { input: 0.07, output: 0.15, cacheRead: 0.03, cacheWrite: 0, total: 0.25 },
	} as const;
	const requests: CapturedRequest[] = [];
	const sourceFile = path.join(root, "sessions", "source.jsonl");
	const childUsageIds: string[] = [];
	const model = makeModel("role-model", requests, {
		usage,
		readPaths: [sourceFile],
		onProviderCall: () => appendHiddenUsageFromSource(id, childUsageIds),
	});
	let parentSession: AgentSession | undefined;
	try {
		const { result, sourceFile, sourceBytes, authStorage, modelRegistry, sessionSettings } = await runSeance({
			id,
			roleModel: "mock/role-model",
			defaultModel: "mock/default-model",
			models: [model],
			requests,
			enableIrc: true,
			detached: true,
			historicalSpend: { assistant: 500, task: 200, nestedTask: 100, modelUsage: 700 },
			parentSessionManager,
			parentUsageRecorder: createParentSubagentUsageRecorder(parentSessionManager),
		});
		expectSucceeded(result);
		expect(result.usage?.cost.total).toBeCloseTo(0.5);

		const parentModel = modelRegistry.find("mock", "role-model");
		if (!parentModel) throw new Error("expected priced parent test model");
		parentSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: parentModel,
					systemPrompt: ["Parent cost accounting test"],
					tools: [],
					messages: parentSessionManager.buildSessionContext().messages,
				},
				streamFn: model.stream,
			}),
			sessionManager: parentSessionManager,
			modelRegistry,
			settings: sessionSettings,
		});

		const childCost = (): number => {
			const session = AgentRegistry.global().get(id)?.session;
			if (!session) throw new Error("expected live seance session");
			return session.sessionManager.getUsageStatistics().cost;
		};
		const assertTotals = (parentExpected: number, childExpected: number): void => {
			expect(parentSession?.getSessionStats().cost).toBeCloseTo(parentExpected);
			expect(parentSessionManager.getUsageStatistics().cost).toBeCloseTo(parentExpected);
			expect(childCost()).toBeCloseTo(childExpected);
		};
		const auxiliaryEntries = () =>
			parentSessionManager
				.getEntries()
				.filter(entry => entry.type === "model_usage" && entry.purpose === "seance-auxiliary");
		const wake = async (marker: string): Promise<void> => {
			const replyPromise = IrcBus.global().wait(MAIN_AGENT_ID, { from: id }, 10_000);
			const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: id, body: marker });
			expect(receipt.outcome).toBe("revived");
			expect((await replyPromise)?.body).toContain("Seance wake result");
		};

		expect(requests).toHaveLength(2);
		assertTotals(1, 0.6);
		expect(auxiliaryEntries()).toHaveLength(2);
		// A retained source may finish a hidden usage append after yield.
		// Keep its observer attached while the child session is idle.
		appendHiddenUsageFromSource(id, childUsageIds);
		assertTotals(1.05, 0.65);
		expect(auxiliaryEntries()).toHaveLength(3);

		await AgentLifecycleManager.global().park(id);
		await wake("SEANCE_WARM_WAKE_MARKER");
		expect(requests).toHaveLength(4);
		assertTotals(1.65, 1.25);
		expect(auxiliaryEntries()).toHaveLength(5);

		await AgentLifecycleManager.global().park(id);
		AgentLifecycleManager.resetGlobalForTests();
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			createPersistedSubagentReviverFactory({
				session: parentSession,
				authStorage,
				modelRegistry,
				settings: sessionSettings,
				enableLsp: true,
			}),
			() => 0,
		);
		await wake("SEANCE_COLD_WAKE_MARKER");
		expect(requests).toHaveLength(6);
		assertTotals(2.25, 1.85);
		const rootEntryIds = new Set(parentSessionManager.getEntries().map(entry => entry.id));
		for (const entry of auxiliaryEntries()) {
			expect(childUsageIds).not.toContain(entry.id);
			expect(entry.parentId === null || rootEntryIds.has(entry.parentId)).toBe(true);
		}
		expect(auxiliaryEntries()).toHaveLength(7);
		expect(await Bun.file(sourceFile).text()).toBe(sourceBytes);
	} finally {
		await parentSession?.dispose();
	}
}, 30_000);
it("records synchronous initial source auxiliary usage without duplicating chat usage", async () => {
	const id = "SeanceSyncAuxiliary";
	const parentFile = path.join(root, "artifacts", "main.jsonl");
	const parentSessionManager = await SessionManager.open(parentFile, undefined, undefined, {
		suppressBreadcrumb: true,
	});
	sessionManagers.push(parentSessionManager);
	const requests: CapturedRequest[] = [];
	const sourceFile = path.join(root, "sessions", "source.jsonl");
	const model = makeModel("role-model", requests, {
		usage: {
			input: 7,
			output: 3,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 13,
			cost: { input: 0.07, output: 0.15, cacheRead: 0.03, cacheWrite: 0, total: 0.25 },
		},
		readPaths: [sourceFile],
		onProviderCall: () => appendHiddenUsageFromSource(id),
	});

	const {
		result,
		sourceFile: actualSourceFile,
		sourceBytes,
	} = await runSeance({
		id,
		roleModel: "mock/role-model",
		defaultModel: "mock/default-model",
		models: [model],
		requests,
		historicalSpend: { assistant: 500, task: 200, nestedTask: 100, modelUsage: 700 },
		parentSessionManager,
		parentUsageRecorder: createParentSubagentUsageRecorder(parentSessionManager),
	});
	expectSucceeded(result);
	expect(result.usage?.cost.total).toBeCloseTo(0.5);
	expect(parentSessionManager.getUsageStatistics().cost).toBeCloseTo(0.1);
	const auxiliaryEntries = parentSessionManager
		.getEntries()
		.filter(entry => entry.type === "model_usage" && entry.purpose === "seance-auxiliary");
	expect(auxiliaryEntries).toHaveLength(2);
	expect(auxiliaryEntries[0]).toMatchObject({
		role: "tiny",
		api: "mock",
		provider: "mock",
		model: "hidden-model",
		usage: HIDDEN_MODEL_USAGE,
		stopReason: "error",
		errorMessage: "hidden provider attempt failed after reporting usage",
	});
	const child = AgentRegistry.global().get(id)?.session;
	if (!child) throw new Error("expected retained seance session");
	expect(child.sessionManager.getUsageStatistics().cost).toBeCloseTo(0.6);
	expect(await Bun.file(actualSourceFile).text()).toBe(sourceBytes);
});
