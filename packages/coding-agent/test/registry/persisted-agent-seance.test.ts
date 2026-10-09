import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function persistedChild(id: string, cwd: string): string {
	const timestamp = "2026-10-01T00:00:00.000Z";
	return `${[
		{
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: `${id}-session`,
			timestamp,
			cwd,
		},
		{
			type: "session_init",
			id: `${id}-init`,
			parentId: null,
			timestamp,
			systemPrompt: ["unrestricted historical child"],
			task: "copied history only",
			tools: ["read", "write", "task"],
			agent: "task",
			spawns: "*",
		},
		{
			type: "message",
			id: `${id}-message`,
			parentId: null,
			timestamp,
			message: { role: "user", content: "historical child work", timestamp: 1 },
		},
	]
		.map(entry => JSON.stringify(entry))
		.join("\n")}\n`;
}

describe("persisted seance descendants", () => {
	it("keeps copied child and grandchild transcripts out of the runnable persisted roster", async () => {
		using tempDir = TempDir.createSync("@omp-persisted-seance-roster-");
		const cwd = path.join(tempDir.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		const sourceFile = path.join(tempDir.path(), "source", "source.jsonl");
		const sourceArtifacts = sourceFile.slice(0, -6);
		const childId = "Child";
		const grandchildId = `${childId}.Grandchild`;
		await fs.mkdir(path.join(sourceArtifacts, childId), { recursive: true });
		await Bun.write(
			sourceFile,
			`${JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "source-session",
				timestamp: "2026-10-01T00:00:00.000Z",
				cwd,
			})}\n`,
		);
		await Bun.write(path.join(sourceArtifacts, `${childId}.jsonl`), persistedChild(childId, cwd));
		await Bun.write(path.join(sourceArtifacts, childId, `${grandchildId}.jsonl`), persistedChild(grandchildId, cwd));

		const forkFile = path.join(tempDir.path(), "local", "Seance.jsonl");
		const forked = await SessionManager.forkFrom(sourceFile, cwd, path.dirname(forkFile), undefined, {
			sessionFile: forkFile,
			suppressBreadcrumb: true,
			neutralizeInheritedSessionInit: true,
		});
		await forked.close();

		const registry = new AgentRegistry();
		await registerPersistedSubagents(registry, forkFile);
		const peek = await SessionManager.peekSessionInit(forkFile);
		expect(peek).toMatchObject({ seanceFork: true, init: null });
		expect(registry.list()).toEqual([]);
	});
});
