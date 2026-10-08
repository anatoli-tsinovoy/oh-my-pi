import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { resolveSeanceSession } from "@oh-my-pi/pi-coding-agent/task/seance";
import { TempDir } from "@oh-my-pi/pi-utils";

async function writeSession(filePath: string, id: string, cwd: string): Promise<void> {
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: new Date().toISOString(),
		cwd,
	};
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, `${JSON.stringify(header)}\n`);
}

describe("seance source resolution", () => {
	it("resolves a local ID prefix and validates a relative JSONL path", async () => {
		using tempDir = TempDir.createSync("@omp-seance-source-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const local = path.join(sessionDir, "2026-10-08T00-00-00_shared-session.jsonl");
		const direct = path.join(cwd, "source.jsonl");
		await writeSession(local, "shared-session-id", cwd);
		await writeSession(direct, "direct-session-id", cwd);

		expect(await resolveSeanceSession("shared-session", cwd, sessionDir)).toBe(local);
		expect(await resolveSeanceSession("./source.jsonl", cwd, sessionDir)).toBe(direct);
	});

	it("rejects an ambiguous ID prefix instead of selecting an arbitrary session", async () => {
		using tempDir = TempDir.createSync("@omp-seance-ambiguous-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await writeSession(path.join(sessionDir, "one.jsonl"), "shared-alpha", cwd);
		await writeSession(path.join(sessionDir, "two.jsonl"), "shared-beta", cwd);

		await expect(resolveSeanceSession("shared-", cwd, sessionDir)).rejects.toThrow("is ambiguous");
	});

	it("rejects missing IDs, missing files, and JSONL files without a valid header", async () => {
		using tempDir = TempDir.createSync("@omp-seance-invalid-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const malformed = path.join(cwd, "malformed.jsonl");
		await fs.mkdir(cwd, { recursive: true });
		const unknownSelector = `unknown-${path.basename(tempDir.path())}`;
		await Bun.write(malformed, `${JSON.stringify({ type: "message", id: "not-a-header" })}\n`);

		await expect(resolveSeanceSession(unknownSelector, cwd, sessionDir)).rejects.toThrow("was not found");
		await expect(resolveSeanceSession(malformed, cwd, sessionDir)).rejects.toThrow("valid session header");
	});
});
