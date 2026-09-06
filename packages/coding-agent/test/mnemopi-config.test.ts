import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMnemopiConfig, type MnemopiBackendConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { getMemoriesDir, TempDir } from "@oh-my-pi/pi-utils";

// `mnemopi.embeddingVariant` selects the concrete local embedding model, while an
// explicit `mnemopi.embeddingModel` is an advanced override that wins. Scoping is
// pinned to "global" so the resolver stays pure (no legacy-bank disk probing).
function mnemopiConfigFor(
	overrides: Record<string, unknown>,
	agentDir = "/tmp/mnemopi-config-test",
): MnemopiBackendConfig {
	const settings = Settings.isolated({ "mnemopi.scoping": "global", ...overrides });
	return loadMnemopiConfig(settings, agentDir);
}

function runGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "Mnemopi Test",
			GIT_AUTHOR_EMAIL: "mnemopi@example.invalid",
			GIT_COMMITTER_NAME: "Mnemopi Test",
			GIT_COMMITTER_EMAIL: "mnemopi@example.invalid",
		},
	});
	if (result.exitCode !== 0) {
		const stderr = new TextDecoder().decode(result.stderr).trim();
		const stdout = new TextDecoder().decode(result.stdout).trim();
		throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout || `exit ${result.exitCode}`}`);
	}
	return new TextDecoder().decode(result.stdout).trim();
}

function createLegacyBank(dbPath: string, bank: string, cwd: string): void {
	const bankPath = path.join(path.dirname(dbPath), "banks", bank, "mnemopi.db");
	syncFs.mkdirSync(path.dirname(bankPath), { recursive: true });
	const db = new Database(bankPath, { create: true });
	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS working_memory (
				id TEXT PRIMARY KEY,
				content TEXT,
				metadata_json TEXT
			)
		`);
		db.prepare("INSERT INTO working_memory (id, content, metadata_json) VALUES (?, ?, ?)").run(
			`legacy-${bank}`,
			"legacy content",
			JSON.stringify({ cwd }),
		);
	} finally {
		db.close();
	}
}

async function mnemopiConfigForCwd(
	overrides: Record<string, unknown>,
	cwd: string,
	agentDir = "/tmp/mnemopi-config-test",
): Promise<MnemopiBackendConfig> {
	const settings = Settings.isolated({ "mnemopi.scoping": "global", ...overrides });
	return loadMnemopiConfig(await settings.cloneForCwd(cwd), agentDir);
}

function embeddingModelFor(overrides: Record<string, unknown>): string | undefined {
	return mnemopiConfigFor(overrides).providerOptions.embeddingModel;
}

describe("loadMnemopiConfig embedding variant resolution", () => {
	it("maps the en variant to BAAI/bge-base-en-v1.5", () => {
		expect(embeddingModelFor({ "mnemopi.embeddingVariant": "en" })).toBe("BAAI/bge-base-en-v1.5");
	});

	it("maps the multilingual variant to intfloat/multilingual-e5-large", () => {
		expect(embeddingModelFor({ "mnemopi.embeddingVariant": "multilingual" })).toBe("intfloat/multilingual-e5-large");
	});

	it("lets an explicit embeddingModel override win over the variant", () => {
		expect(
			embeddingModelFor({
				"mnemopi.embeddingVariant": "multilingual",
				"mnemopi.embeddingModel": "openai/text-embedding-3-small",
			}),
		).toBe("openai/text-embedding-3-small");
	});

	it("ignores a blank override and falls back to the variant", () => {
		expect(embeddingModelFor({ "mnemopi.embeddingVariant": "en", "mnemopi.embeddingModel": "   " })).toBe(
			"BAAI/bge-base-en-v1.5",
		);
	});

	it("honors MNEMOPI_EMBEDDING_MODEL when no explicit model setting is present", () => {
		const previous = Bun.env.MNEMOPI_EMBEDDING_MODEL;
		Bun.env.MNEMOPI_EMBEDDING_MODEL = "BAAI/bge-large-en-v1.5";
		try {
			// The documented env override must not be shadowed by the variant default.
			expect(embeddingModelFor({ "mnemopi.embeddingVariant": "en" })).toBe("BAAI/bge-large-en-v1.5");
		} finally {
			if (previous === undefined) delete Bun.env.MNEMOPI_EMBEDDING_MODEL;
			else Bun.env.MNEMOPI_EMBEDDING_MODEL = previous;
		}
	});

	it("lets an explicit embeddingModel setting win over the env var", () => {
		const previous = Bun.env.MNEMOPI_EMBEDDING_MODEL;
		Bun.env.MNEMOPI_EMBEDDING_MODEL = "BAAI/bge-large-en-v1.5";
		try {
			expect(embeddingModelFor({ "mnemopi.embeddingModel": "openai/text-embedding-3-small" })).toBe(
				"openai/text-embedding-3-small",
			);
		} finally {
			if (previous === undefined) delete Bun.env.MNEMOPI_EMBEDDING_MODEL;
			else Bun.env.MNEMOPI_EMBEDDING_MODEL = previous;
		}
	});
});

describe("loadMnemopiConfig database path resolution", () => {
	it("resolves a blank dbPath to persistent agent storage", () => {
		const agentDir = "/tmp/mnemopi-blank-db-path-test";
		const defaultPath = path.join(getMemoriesDir(agentDir), "mnemopi", "mnemopi.db");

		expect(mnemopiConfigFor({ "mnemopi.dbPath": "" }, agentDir).dbPath).toBe(defaultPath);
		expect(mnemopiConfigFor({ "mnemopi.dbPath": " \t " }, agentDir).dbPath).toBe(defaultPath);
	});
});

describe("loadMnemopiConfig worktree memory scope", () => {
	let fixtureDir: TempDir;
	let primaryRoot: string;
	let worktreeRoot: string;
	let worktreeSubdir: string;
	let sameNameRepoRoot: string;
	let nonRepoRoot: string;
	let bareRepoRoot: string;
	let bareWorktreeA: string;
	let bareWorktreeB: string;
	let bareWorktreeSubdir: string;
	let dbPath: string;

	beforeAll(async () => {
		fixtureDir = await TempDir.create("@mnemopi-config-worktree-");
		primaryRoot = fixtureDir.join("repo");
		worktreeRoot = fixtureDir.join("repo-feature");
		worktreeSubdir = path.join(worktreeRoot, "nested", "docs");
		sameNameRepoRoot = fixtureDir.join("other", "repo");
		nonRepoRoot = fixtureDir.join("plain");
		bareRepoRoot = fixtureDir.join("bare-repo.git");
		bareWorktreeA = fixtureDir.join("bare-a");
		bareWorktreeB = fixtureDir.join("bare-b");
		bareWorktreeSubdir = path.join(bareWorktreeA, "nested", "docs");
		dbPath = fixtureDir.join("memory", "mnemopi.db");

		await fs.mkdir(primaryRoot, { recursive: true });
		runGit(primaryRoot, ["-c", "init.defaultBranch=main", "init"]);
		runGit(primaryRoot, ["config", "user.email", "mnemopi@example.invalid"]);
		runGit(primaryRoot, ["config", "user.name", "Mnemopi Test"]);
		await fs.writeFile(path.join(primaryRoot, "README.txt"), "primary\n");
		runGit(primaryRoot, ["add", "-A"]);
		runGit(primaryRoot, ["commit", "-m", "base"]);
		runGit(primaryRoot, ["worktree", "add", worktreeRoot, "-b", "feature"]);
		await fs.mkdir(worktreeSubdir, { recursive: true });

		await fs.mkdir(sameNameRepoRoot, { recursive: true });
		runGit(sameNameRepoRoot, ["-c", "init.defaultBranch=main", "init"]);
		runGit(sameNameRepoRoot, ["config", "user.email", "mnemopi@example.invalid"]);
		runGit(sameNameRepoRoot, ["config", "user.name", "Mnemopi Test"]);
		await fs.writeFile(path.join(sameNameRepoRoot, "README.txt"), "other\n");
		runGit(sameNameRepoRoot, ["add", "-A"]);
		runGit(sameNameRepoRoot, ["commit", "-m", "base"]);
		await fs.mkdir(nonRepoRoot, { recursive: true });

		runGit(fixtureDir.path(), ["init", "--bare", bareRepoRoot]);
		runGit(primaryRoot, ["remote", "add", "bare", bareRepoRoot]);
		runGit(primaryRoot, ["push", "bare", "main"]);
		runGit(fixtureDir.path(), ["--git-dir", bareRepoRoot, "worktree", "add", bareWorktreeA, "-b", "bare-a", "main"]);
		runGit(fixtureDir.path(), ["--git-dir", bareRepoRoot, "worktree", "add", bareWorktreeB, "-b", "bare-b", "main"]);
		await fs.mkdir(bareWorktreeSubdir, { recursive: true });

		createLegacyBank(dbPath, "legacy-isolated", worktreeRoot);
	});

	afterAll(async () => {
		await fixtureDir.remove();
	});

	it("maps shared project read and write banks to the primary checkout", async () => {
		const shared = {
			"mnemopi.dbPath": dbPath,
			"mnemopi.scoping": "per-project",
			"mnemopi.shareAcrossWorktrees": true,
		};
		const fromPrimary = await mnemopiConfigForCwd(shared, primaryRoot, fixtureDir.path());
		const fromWorktree = await mnemopiConfigForCwd(shared, worktreeRoot, fixtureDir.path());
		const fromSubdir = await mnemopiConfigForCwd(shared, worktreeSubdir, fixtureDir.path());
		expect(fromWorktree.bank).toBe(fromPrimary.bank);
		expect(fromWorktree.retainBank).toBe(fromPrimary.retainBank);
		expect(fromWorktree.recallBanks).toEqual(fromPrimary.recallBanks);
		const fromBareA = await mnemopiConfigForCwd(shared, bareWorktreeA, fixtureDir.path());
		const fromBareB = await mnemopiConfigForCwd(shared, bareWorktreeB, fixtureDir.path());
		const fromBareSubdir = await mnemopiConfigForCwd(shared, bareWorktreeSubdir, fixtureDir.path());
		expect(fromBareB.bank).toBe(fromBareA.bank);
		expect(fromBareSubdir.bank).toBe(fromBareA.bank);
		expect(fromSubdir.bank).toBe(fromPrimary.bank);

		const isolatedWorktree = await mnemopiConfigForCwd(
			{ ...shared, "mnemopi.shareAcrossWorktrees": false },
			worktreeRoot,
			fixtureDir.path(),
		);
		expect(isolatedWorktree.bank).not.toBe(fromPrimary.bank);
		expect(isolatedWorktree.retainBank).not.toBe(fromPrimary.retainBank);

		const taggedPrimary = await mnemopiConfigForCwd(
			{ ...shared, "mnemopi.scoping": "per-project-tagged" },
			primaryRoot,
			fixtureDir.path(),
		);
		const taggedSubdir = await mnemopiConfigForCwd(
			{ ...shared, "mnemopi.scoping": "per-project-tagged" },
			worktreeSubdir,
			fixtureDir.path(),
		);
		expect(taggedSubdir.bank).toBe(taggedPrimary.bank);
		expect(taggedSubdir.retainBank).toBe(taggedPrimary.retainBank);
		expect(taggedSubdir.recallBanks).toEqual(taggedPrimary.recallBanks);
		expect(taggedPrimary.recallBanks).toContain(taggedPrimary.bank);
		expect(taggedPrimary.recallBanks).toContain(taggedPrimary.globalBank);

		const global = await mnemopiConfigForCwd(
			{ ...shared, "mnemopi.scoping": "global" },
			worktreeRoot,
			fixtureDir.path(),
		);
		expect(global.bank).toBe("default");
		expect(global.recallBanks).toEqual(["default"]);
	});

	it("keeps same-basename repositories isolated and falls back for nonrepositories", async () => {
		const shared = {
			"mnemopi.dbPath": dbPath,
			"mnemopi.scoping": "per-project",
			"mnemopi.shareAcrossWorktrees": true,
		};
		const fromPrimary = await mnemopiConfigForCwd(shared, primaryRoot, fixtureDir.path());
		const fromOtherRepo = await mnemopiConfigForCwd(shared, sameNameRepoRoot, fixtureDir.path());
		expect(path.basename(primaryRoot)).toBe(path.basename(sameNameRepoRoot));
		expect(fromOtherRepo.bank).not.toBe(fromPrimary.bank);

		const nonRepoShared = await mnemopiConfigForCwd(shared, nonRepoRoot, fixtureDir.path());
		const nonRepoIsolated = await mnemopiConfigForCwd(
			{ ...shared, "mnemopi.shareAcrossWorktrees": false },
			nonRepoRoot,
			fixtureDir.path(),
		);
		expect(nonRepoShared.bank).toBe(nonRepoIsolated.bank);
		expect(nonRepoShared.retainBank).toBe(nonRepoIsolated.retainBank);
		expect(nonRepoShared.recallBanks).toEqual(nonRepoIsolated.recallBanks);
	});

	it("does not scan isolated legacy banks when sharing is enabled", async () => {
		const shared = await mnemopiConfigForCwd(
			{
				"mnemopi.dbPath": dbPath,
				"mnemopi.scoping": "per-project",
				"mnemopi.shareAcrossWorktrees": true,
			},
			worktreeRoot,
			fixtureDir.path(),
		);
		expect(shared.recallBanks).toEqual([shared.bank]);
		expect(shared.recallBanks).not.toContain("legacy-isolated");

		const isolated = await mnemopiConfigForCwd(
			{
				"mnemopi.dbPath": dbPath,
				"mnemopi.scoping": "per-project",
				"mnemopi.shareAcrossWorktrees": false,
			},
			worktreeRoot,
			fixtureDir.path(),
		);
		expect(isolated.recallBanks).toContain("legacy-isolated");
	});
});
