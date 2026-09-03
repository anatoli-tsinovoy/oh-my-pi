import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import type { BunPlugin } from "bun";
import { Marked } from "@oh-my-pi/pi-utils/marked";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { getTemplate, resolveBundledHtmlAssetPath } from "../src/export/html/index";

interface HeapProbeResult {
	retainedAssetStrings: number;
	retainedAssets: Array<{ name: string; selfSize: number }>;
}

interface TemplateProbeResult {
	chars: number;
	bytes: number;
	sha256: string;
	stableCache: boolean;
	assetsRemoved: number;
}

const expectedTemplate: TemplateProbeResult = {
	chars: 385_409,
	bytes: 385_567,
	sha256: "963ab54ed4a811679ba1a21c2ceab17e54018039108b7999978276e11b42bac1",
	stableCache: true,
	assetsRemoved: 0,
};
const assetDir = new URL("../src/export/html/", import.meta.url);
const templateProbePath = path.resolve(import.meta.dir, "fixtures", "html-export-template-probe.ts");
const heapProbePath = path.resolve(import.meta.dir, "fixtures", "html-export-static-import-heap-probe.ts");
const packageDir = path.resolve(import.meta.dir, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-html-template-"));
const unrelatedCwd = path.join(tempRoot, "unrelated-cwd");
const bundleDir = path.join(tempRoot, "bundle");
const compiledPath = path.join(tempRoot, "compiled-template-probe");
let bundlePath: string;
const bundledDependencyStubs: Record<string, string> = {
	"@oh-my-pi/pi-utils": 'export const APP_NAME = "omp"; export const isEnoent = () => false;',
	"../../modes/theme/theme":
		"export const getResolvedThemeColors = async () => ({}); export const getThemeExportColors = async () => ({});",
	"../../session/session-loader": "export const loadEntriesFromFile = async () => [];",
	"../../session/session-manager":
		"export class SessionManager { static async open() { return new SessionManager(); } }",
	"./args": "export const parseExportArgs = () => undefined;",
	"./web-palette": 'export const webExportThemeVars = () => "";',
};
const focusedBundlePlugin: BunPlugin = {
	name: "html-template-focused-bundle",
	setup(build) {
		build.onResolve({ filter: /.*/ }, args =>
			bundledDependencyStubs[args.path] === undefined
				? undefined
				: { path: args.path, namespace: "html-template-test-stub" },
		);
		build.onLoad({ filter: /.*/, namespace: "html-template-test-stub" }, args => ({
			contents: bundledDependencyStubs[args.path]!,
			loader: "js",
		}));
	},
};

function composeExpectedTemplate(): string {
	const templateHtml = fs.readFileSync(new URL("template.html", assetDir), "utf8");
	const templateCss = fs.readFileSync(new URL("template.css", assetDir), "utf8");
	const templateJs = fs.readFileSync(new URL("template.js", assetDir), "utf8");
	const toolViewsJs = fs.readFileSync(new URL("tool-views.generated.js", assetDir), "utf8");
	const minifiedCss = templateCss
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\s+/g, " ")
		.replace(/\s*([{}:;,])\s*/g, "$1")
		.trim();
	return templateHtml
		.replace("<template-css/>", () => `<style>${minifiedCss}</style>`)
		.replace("<template-tool-views/>", () => `<script>${toolViewsJs}</script>`)
		.replace("<template-js/>", () => `<script>${templateJs}</script>`);
}

async function runProbe(command: string[]): Promise<TemplateProbeResult> {
	const proc = Bun.spawn(command, {
		cwd: unrelatedCwd,
		stdin: "ignore",
		stderr: "pipe",
		stdout: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as TemplateProbeResult;
}

function renderExportedSession(entries: unknown[], leafId: string) {
	const templateHtml = fs.readFileSync(new URL("template.html", assetDir), "utf8");
	const templateJs = fs.readFileSync(new URL("template.js", assetDir), "utf8");
	const { document, window } = parseHTML(templateHtml);
	const sessionData = document.getElementById("session-data");
	if (!sessionData) throw new Error("Export template is missing session data");
	sessionData.textContent = Buffer.from(
		JSON.stringify({
			header: {
				type: "session",
				version: 3,
				id: "html-media-test",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp",
			},
			entries,
			leafId,
		}),
	).toString("base64");
	Object.defineProperty(window, "location", {
		value: new URL("https://example.test/export.html"),
		configurable: true,
	});
	Object.defineProperty(window, "matchMedia", {
		value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		configurable: true,
	});
	const context = vm.createContext({
		window,
		document,
		marked: new Marked(),
		hljs: {
			getLanguage: () => false,
			highlight: () => ({ value: "" }),
			highlightAuto: () => ({ value: "" }),
		},
		URL,
		URLSearchParams,
		TextDecoder,
		Uint8Array,
		atob,
		navigator: { clipboard: null },
		localStorage: { getItem: () => null, setItem() {} },
		setTimeout: () => 0,
		clearTimeout() {},
	});
	vm.runInContext(templateJs, context);
	return document;
}

beforeAll(async () => {
	fs.mkdirSync(unrelatedCwd);
	const bundle = await Bun.build({
		entrypoints: [templateProbePath],
		outdir: bundleDir,
		target: "bun",
		plugins: [focusedBundlePlugin],
	});
	expect(bundle.success, bundle.logs.map(log => log.message).join("\n")).toBe(true);
	const entrypoint = bundle.outputs.find(output => output.kind === "entry-point");
	expect(entrypoint).toBeDefined();
	bundlePath = entrypoint!.path;

	const compiled = await Bun.build({
		entrypoints: [templateProbePath],
		target: "bun",
		plugins: [focusedBundlePlugin],
		compile: { outfile: compiledPath },
	});
	expect(compiled.success, compiled.logs.map(log => log.message).join("\n")).toBe(true);
}, 120_000);

afterAll(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("HTML export template", () => {
	test("keeps Windows drive-letter asset paths as filesystem paths", () => {
		const windowsAssetPath = "C:\\repo\\packages\\coding-agent\\src\\export\\html\\template.css";
		expect(resolveBundledHtmlAssetPath(windowsAssetPath, "C:\\repo\\packages\\coding-agent\\src\\export\\html")).toBe(
			windowsAssetPath,
		);
	});
	test("composes the exact source template once and returns the cached bytes", async () => {
		const expected = composeExpectedTemplate();
		const first = getTemplate();
		const repeated = getTemplate();

		expect(first).toBe(expected);
		expect(first).toContain("<style>");
		expect(first).toContain("// Auto-generated by packages/collab-web/scripts/build-tool-views.ts - DO NOT EDIT");
		expect(first).toContain("const THEME_STORAGE_KEY = 'omp-export-theme';");
		expect(first).not.toContain("<template-css/>");
		expect(first).not.toContain("<template-tool-views/>");
		expect(first).not.toContain("<template-js/>");
		expect(repeated).toBe(first);
		expect(await runProbe([process.execPath, templateProbePath])).toEqual(expectedTemplate);
	});

	test("preserves exact bytes in a normal bundle launched from an unrelated directory", async () => {
		expect(await runProbe([process.execPath, bundlePath])).toEqual(expectedTemplate);
	});

	test("production normal bundle packs every HTML export asset", async () => {
		const staleAssetPath = path.join(packageDir, "dist", "template-stale.css");
		fs.mkdirSync(path.dirname(staleAssetPath), { recursive: true });
		fs.writeFileSync(staleAssetPath, "stale");
		const build = Bun.spawn([process.execPath, "run", "gen:bundle"], {
			cwd: packageDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [buildStdout, buildStderr, buildExitCode] = await Promise.all([
			new Response(build.stdout).text(),
			new Response(build.stderr).text(),
			build.exited,
		]);
		expect(buildExitCode, `${buildStdout}\n${buildStderr}`).toBe(0);
		expect(fs.existsSync(staleAssetPath)).toBe(false);

		const proc = Bun.spawn([process.execPath, "pm", "pack", "--dry-run", "--ignore-scripts"], {
			cwd: packageDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const packedAssets = Array.from(
			stdout.matchAll(/^packed \S+ (dist\/(?:template-[^.]+\.(?:css|html|js)|tool-views\.generated-[^.]+\.js))$/gm),
			match => match[1],
		);
		expect(packedAssets).toHaveLength(4);
		expect(packedAssets.filter(filePath => /^dist\/template-[^.]+\.css$/.test(filePath))).toHaveLength(1);
		expect(packedAssets.filter(filePath => /^dist\/template-[^.]+\.html$/.test(filePath))).toHaveLength(1);
		expect(packedAssets.filter(filePath => /^dist\/template-[^.]+\.js$/.test(filePath))).toHaveLength(1);
		expect(packedAssets.filter(filePath => /^dist\/tool-views\.generated-[^.]+\.js$/.test(filePath))).toHaveLength(1);
	}, 30_000);

	test("serves the cached normal-bundle template after its asset files are removed", async () => {
		expect(await runProbe([process.execPath, bundlePath, "--remove-assets-after-first-use"])).toEqual({
			...expectedTemplate,
			assetsRemoved: 4,
		});
	});

	test("preserves exact bytes in a compiled bundle launched from an unrelated directory", async () => {
		expect(await runProbe([compiledPath])).toEqual(expectedTemplate);
	});

	test("does not retain source asset strings during a static import", async () => {
		const proc = Bun.spawn([process.execPath, heapProbePath], {
			stdin: "ignore",
			stderr: "pipe",
			stdout: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		const result = JSON.parse(stdout) as HeapProbeResult;
		expect(result, JSON.stringify(result)).toEqual({ retainedAssetStrings: 0, retainedAssets: [] });
	}, 30_000);

	test("renders audio/video-only and mixed messages", () => {
		const audio = { type: "audio", mimeType: "audio/wav", data: "UklGRg==" };
		const video = { type: "video", mimeType: "video/mp4", data: "AAAA" };
		const entries = [
			{
				type: "message",
				id: "user-audio-only",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: [audio], timestamp: 1 },
			},
			{
				type: "message",
				id: "user-video-only",
				parentId: "user-audio-only",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: { role: "user", content: [video], timestamp: 2 },
			},
			{
				type: "message",
				id: "assistant-mixed",
				parentId: "user-video-only",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "before media" }, audio, video, { type: "text", text: "after media" }],
					stopReason: "stop",
					timestamp: 3,
				},
			},
		];
		const document = renderExportedSession(entries, "assistant-mixed");

		const userAudio = document.querySelector("#entry-user-audio-only audio");
		const userVideo = document.querySelector("#entry-user-video-only video");
		const assistant = document.getElementById("entry-assistant-mixed");
		expect(userAudio?.getAttribute("src")).toBe("data:audio/wav;base64,UklGRg==");
		expect(userAudio?.hasAttribute("controls")).toBe(true);
		expect(userVideo?.getAttribute("src")).toBe("data:video/mp4;base64,AAAA");
		expect(userVideo?.hasAttribute("controls")).toBe(true);
		expect(assistant?.querySelector("audio")?.getAttribute("src")).toBe("data:audio/wav;base64,UklGRg==");
		expect(assistant?.querySelector("video")?.getAttribute("src")).toBe("data:video/mp4;base64,AAAA");
		expect(assistant?.textContent).toContain("before media");
		expect(assistant?.textContent).toContain("after media");
	});
});
