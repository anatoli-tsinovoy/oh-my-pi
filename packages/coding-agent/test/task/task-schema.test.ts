import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

// Contract: the single-spawn schema (`task.batch: false`; the exported
// `taskSchema` instance) carries no batch fields while accepting a caller
// `model`, `outputSchema`, and its validation mode. The batch shape (`tasks[]` + shared
// `context`) is gated by the `task.batch` setting (default on, covered by
// test/task/task-batch.test.ts).

describe("task schema (single-spawn)", () => {
	it("requires task", () => {
		const parsed = taskSchema({ agent: "scout", solutionSpace: "c" });
		expect(parsed instanceof type.errors).toBe(true);
	});
	it("accepts sourceSession and string-or-array model selectors for seance calls", () => {
		const parsed = taskSchema({
			agent: "seance",
			task: "Consult the saved session.",
			solutionSpace: "bounded",
			sourceSession: "session-prefix",
			model: ["openai/gpt-4o", "anthropic/claude-sonnet"],
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.sourceSession).toBe("session-prefix");
			expect(parsed.model).toEqual(["openai/gpt-4o", "anthropic/claude-sonnet"]);
		}
	});

	it("advertises sourceSession and model on every dynamic flat and batch schema", () => {
		for (const isolationEnabled of [false, true]) {
			const flatSchema = getTaskSchema({ isolationEnabled, batchEnabled: false });
			const flat = flatSchema({
				agent: "seance",
				task: "Consult.",
				solutionSpace: "bounded",
				sourceSession: "session-prefix",
				model: "openai/gpt-4o",
			});
			expect(flat instanceof type.errors).toBe(false);

			const batchSchema = getTaskSchema({ isolationEnabled, batchEnabled: true });
			const batch = batchSchema({
				context: "shared",
				tasks: [
					{
						agent: "seance",
						task: "Consult.",
						solutionSpace: "bounded",
						sourceSession: "session-prefix",
						model: ["openai/gpt-4o"],
					},
				],
			});
			expect(batch instanceof type.errors).toBe(false);
		}
	});

	it("removes eval tool names from the wire shape when eval.tools.enabled is off", () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: false,
			evalToolsEnabled: false,
		});
		const parsed = schema({
			agent: "scout",
			task: "Map the auth module.",
			solutionSpace: "c",
			tools: ["word_count"],
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (parsed && typeof parsed === "object" && !(parsed instanceof type.errors)) {
			expect("tools" in parsed).toBe(false);
		}
	});

	it("retains caller outputSchema, schemaMode, and eval tool names while stripping stale keys", () => {
		const outputSchema = { type: "object", properties: { answer: { type: "string" } } };
		const parsed = taskSchema({
			agent: "scout",
			task: "Map the auth module.",
			solutionSpace: "c",
			outputSchema,
			schemaMode: "strict",
			tools: ["word_count"],
			context: "shared background",
			tasks: [{ name: "A", task: "..." }],
			schema: '{"properties":{}}',
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.outputSchema).toEqual(outputSchema);
			expect(parsed.schemaMode).toBe("strict");
			expect(parsed.tools).toEqual(["word_count"]);
			expect("tasks" in parsed).toBe(false);
			expect("context" in parsed).toBe(false);
			expect("schema" in parsed).toBe(false);
		}
	});
});

describe("task spawn validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createSession(): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "task.isolation.enabled": false, "task.batch": false }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionAgents: () => [
				{
					name: "seance",
					description: "Read-only saved-session consultation.",
					systemPrompt: "Consult only the saved transcript.",
					tools: ["read", "grep", "glob"],
					source: "bundled",
				},
			],
		} as unknown as ToolSession;
	}

	async function executeText(params: unknown): Promise<string> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tool-call", params);
		return result.content.find(part => part.type === "text")?.text ?? "";
	}

	it("defaults a missing agent to `task`", async () => {
		// With no `agent`, execute() normalizes to the `task` default, so the
		// failure is unknown-agent (none discovered), not missing-agent.
		const text = await executeText({ task: "..." });
		expect(text).toContain('Unknown agent "task"');
	});

	it("rejects a missing task", async () => {
		const text = await executeText({ agent: "scout" });
		expect(text).toContain("Missing `task`");
	});
	it("requires seance/sourceSession pairing before resolving the agent", async () => {
		const wrongAgent = await executeText({
			agent: "task",
			task: "Consult.",
			solutionSpace: "bounded",
			sourceSession: "session-prefix",
		});
		expect(wrongAgent).toContain('`sourceSession` is only valid with `agent: "seance"`');

		const missingSource = await executeText({ agent: "seance", task: "Consult.", solutionSpace: "bounded" });
		expect(missingSource).toContain("requires a `sourceSession`");
	});
	it("returns source resolution failures as visible task-result text", async () => {
		const missingSource = await executeText({
			agent: "seance",
			task: "Consult.",
			solutionSpace: "bounded",
			sourceSession: `/tmp/missing-seance-${Bun.nanoseconds()}.jsonl`,
		});
		expect(missingSource).toContain("Task execution failed:");
		expect(missingSource).toContain("Could not read seance source session");
	});
});
