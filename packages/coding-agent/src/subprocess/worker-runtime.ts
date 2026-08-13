import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { ProgressInfo } from "@huggingface/transformers";
import { getTinyModelsCacheDir } from "@oh-my-pi/pi-utils/dirs";
import { isCompiledBinary } from "@oh-my-pi/pi-utils/env";
import {
	ensureRuntimeInstalled,
	installRuntimeModuleResolver,
	resolveRuntimeModule,
} from "@oh-my-pi/pi-utils/runtime-install";
import packageJson from "../../package.json" with { type: "json" };

/**
 * Child-side scaffolding shared by the ONNX inference worker bodies
 * (`stt/asr-worker`, `tiny/worker`, `tts/tts-worker`). These are the helpers
 * that run inside the spawned subprocess: error serialization, structured log
 * and progress reporting over the worker's typed transport, side-runtime
 * install (sharp stubbing + module-resolver patch), once-per-process runtime
 * memoization, and the Transformers.js runtime loader. The parent/client-side
 * complement lives in `worker-client.ts`.
 *
 * Each worker keeps its own strongly-typed transport / model-key / progress
 * event; the structural {@link WorkerLogTransport} / {@link WorkerProgressTransport}
 * interfaces below are the minimal shapes these helpers need, and every worker's
 * concrete transport satisfies them.
 */

export const TRANSFORMERS_PACKAGE = "@huggingface/transformers";
const COMPILED_TRANSFORMERS_VERSION = process.env.PI_TINY_TRANSFORMERS_VERSION;
const ONNX_RUNTIME_NODE_PACKAGE = "onnxruntime-node";
const ONNX_RUNTIME_CUDA_INSTALL = "cuda12";
const ONNX_RUNTIME_CUDA_PROVIDER_FILES = [
	"libonnxruntime_providers_cuda.so",
	"libonnxruntime_providers_shared.so",
	"libonnxruntime_providers_tensorrt.so",
] as const;
const LINUX_X64_ONNX_RUNTIME_CUDA_PROVIDER_DIR = path.join("bin", "napi-v6", "linux", "x64");

const sourceRequire = createRequire(import.meta.url);

// ── Error serialization ─────────────────────────────────────────────

export function errorText(error: unknown): string {
	return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ── Structured logging ──────────────────────────────────────────────

export type WorkerLogLevel = "debug" | "warn" | "error";

/** Minimal transport surface a worker exposes for forwarding log lines. */
export interface WorkerLogTransport {
	send(message: { type: "log"; level: WorkerLogLevel; msg: string; meta?: Record<string, unknown> }): void;
}

export function sendLog(
	transport: WorkerLogTransport,
	level: WorkerLogLevel,
	msg: string,
	meta?: Record<string, unknown>,
): void {
	transport.send({ type: "log", level, msg, meta });
}

// ── Progress reporting ──────────────────────────────────────────────

/**
 * Generic worker progress event. Each worker's protocol declares an identical
 * shape with its own `modelKey` type; this is the parameterized version the
 * shared helpers emit, structurally assignable to each protocol's event.
 */
export interface WorkerProgressEvent<K> {
	modelKey: K;
	status: "initiate" | "download" | "progress" | "progress_total" | "done" | "ready" | "error";
	name?: string;
	file?: string;
	progress?: number;
	loaded?: number;
	total?: number;
	files?: Record<string, { loaded: number; total: number }>;
	task?: string;
	model?: string;
}

/** Minimal transport surface a worker exposes for emitting progress events. */
export interface WorkerProgressTransport<K> {
	send(message: { type: "progress"; id: string; event: WorkerProgressEvent<K> }): void;
}

/** Map a Transformers.js {@link ProgressInfo} onto the worker progress event. */
function toProgressEvent<K>(modelKey: K, info: ProgressInfo): WorkerProgressEvent<K> {
	if (info.status === "ready") {
		return { modelKey, status: info.status, task: info.task, model: info.model };
	}
	if (info.status === "progress_total") {
		return {
			modelKey,
			status: info.status,
			name: info.name,
			progress: info.progress,
			loaded: info.loaded,
			total: info.total,
			files: info.files,
		};
	}
	if (info.status === "progress") {
		return {
			modelKey,
			status: info.status,
			name: info.name,
			file: info.file,
			progress: info.progress,
			loaded: info.loaded,
			total: info.total,
		};
	}
	return { modelKey, status: info.status, name: info.name, file: info.file };
}

export function sendProgress<K>(
	transport: WorkerProgressTransport<K>,
	id: string,
	modelKey: K,
	info: ProgressInfo,
): void {
	transport.send({ type: "progress", id, event: toProgressEvent(modelKey, info) });
}

// ── Model cache ─────────────────────────────────────────────────────

/**
 * If a model is already warming/warm in `cache`, replay a `ready` progress
 * event for this request once it resolves and return the cached promise so the
 * caller can short-circuit; otherwise return `undefined`.
 */
export function replayCachedReady<K, M>(
	cache: Map<K, Promise<M>>,
	modelKey: K,
	transport: WorkerProgressTransport<K>,
	requestId: string,
	task: string,
	model: string,
): Promise<M> | undefined {
	const cached = cache.get(modelKey);
	if (!cached) return undefined;
	void cached
		.then(() => {
			transport.send({ type: "progress", id: requestId, event: { modelKey, status: "ready", task, model } });
		})
		.catch(() => undefined);
	return cached;
}

// ── Side-runtime install scaffolding ────────────────────────────────

/**
 * Stub `sharp` (the speech/text pipelines are not image codecs, so the native
 * image dependency is dead weight) and patch the module resolver so a side
 * runtime's bare requires resolve against its own `node_modules`. Returns the
 * runtime's `node_modules` directory.
 */
export async function installSharpStubResolver(
	runtimeDir: string,
	stubs: Record<string, string> = {},
): Promise<string> {
	const nodeModules = path.join(runtimeDir, "node_modules");
	const sharpStub = path.join(runtimeDir, "omp-sharp-stub.cjs");
	await Bun.write(sharpStub, "module.exports = {};\n");
	installRuntimeModuleResolver({ runtimeNodeModules: nodeModules, stubs: { sharp: sharpStub, ...stubs } });
	return nodeModules;
}

function shouldInstallOnnxRuntimeCudaProviders(device: string | undefined): boolean {
	const normalized = device?.trim().toLowerCase();
	return (
		process.platform === "linux" &&
		process.arch === "x64" &&
		(normalized === "cuda" || normalized === "gpu" || normalized === "auto")
	);
}

async function missingOnnxRuntimeCudaProviderFiles(binDir: string): Promise<string[]> {
	const missing: string[] = [];
	for (const file of ONNX_RUNTIME_CUDA_PROVIDER_FILES) {
		try {
			await fs.access(path.join(binDir, file));
		} catch {
			missing.push(file);
		}
	}
	return missing;
}

async function readPipe(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	return new Response(stream).text();
}

async function installOnnxRuntimeCudaProviders(packageDir: string, runtimeDir: string, binDir: string): Promise<void> {
	const script = path.join(packageDir, "script", "install.js");
	try {
		await fs.access(script);
	} catch {
		throw new Error(
			`ONNX Runtime CUDA provider binaries are missing from ${binDir}, and ${script} is unavailable. Remove the tiny-model side runtime cache at ${runtimeDir} and retry.`,
		);
	}

	const proc = Bun.spawn([process.execPath, script], {
		cwd: runtimeDir,
		env: { ...Bun.env, BUN_BE_BUN: "1", ONNXRUNTIME_NODE_INSTALL: ONNX_RUNTIME_CUDA_INSTALL },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		readPipe(proc.stdout as ReadableStream<Uint8Array> | null),
		readPipe(proc.stderr as ReadableStream<Uint8Array> | null),
		proc.exited,
	]);
	if (exitCode !== 0) {
		const output = `${stdout}\n${stderr}`.trim();
		throw new Error(
			`Failed to install ONNX Runtime CUDA provider binaries into ${binDir} with ${process.execPath} ${script} (exit ${exitCode}). Remove the tiny-model side runtime cache at ${runtimeDir} and retry with network access. ${output}`,
		);
	}
}

/**
 * Repairs the compiled Transformers side runtime when CUDA was requested and
 * Bun skipped `onnxruntime-node`'s NuGet sidecar install.
 */
export async function ensureOnnxRuntimeCudaProviders(
	runtimeDir: string,
	device = process.env.PI_TINY_DEVICE,
): Promise<void> {
	if (!shouldInstallOnnxRuntimeCudaProviders(device)) return;
	const nodeModules = path.join(runtimeDir, "node_modules");
	const manifest = resolveRuntimeModule(nodeModules, `${ONNX_RUNTIME_NODE_PACKAGE}/package.json`);
	if (!manifest)
		throw new Error(`Unable to resolve ${ONNX_RUNTIME_NODE_PACKAGE} in compiled runtime at ${nodeModules}`);
	const packageDir = path.dirname(manifest);
	const binDir = path.join(packageDir, LINUX_X64_ONNX_RUNTIME_CUDA_PROVIDER_DIR);
	const missing = await missingOnnxRuntimeCudaProviderFiles(binDir);
	if (missing.length === 0) return;

	await installOnnxRuntimeCudaProviders(packageDir, runtimeDir, binDir);
	const stillMissing = await missingOnnxRuntimeCudaProviderFiles(binDir);
	if (stillMissing.length === 0) return;
	throw new Error(
		`ONNX Runtime CUDA provider install completed but ${stillMissing.join(", ")} are still missing from ${binDir}. Remove the tiny-model side runtime cache at ${runtimeDir} and retry.`,
	);
}

/**
 * Prepare a freshly-installed compiled runtime for loading and return the
 * absolute entrypoint of `packageName` to `require`.
 */
async function prepareCompiledRuntime(runtimeDir: string, packageName: string): Promise<string> {
	const nodeModules = await installSharpStubResolver(runtimeDir);
	const entry = resolveRuntimeModule(nodeModules, packageName);
	if (!entry) throw new Error(`Unable to resolve ${packageName} in compiled runtime at ${nodeModules}`);
	return entry;
}

// ── Transformers version resolution ─────────────────────────────────

function resolveTransformersVersionSpec(): string {
	const manifest = packageJson as {
		optionalDependencies?: Record<string, string>;
		dependencies?: Record<string, string>;
	};
	const versionSpec =
		manifest.optionalDependencies?.[TRANSFORMERS_PACKAGE] ?? manifest.dependencies?.[TRANSFORMERS_PACKAGE];
	if (!versionSpec) throw new Error(`${TRANSFORMERS_PACKAGE} is missing from package.json optionalDependencies`);
	return COMPILED_TRANSFORMERS_VERSION ?? versionSpec;
}

let cachedTransformersVersionSpec: string | undefined;

/**
 * Lazily resolve and memoize the Transformers version spec. Compiled binaries
 * embed the exact build dependency version; source and published-package runs
 * use the concrete compatible range from this package's manifest.
 */
export function getTransformersVersionSpec(): string {
	cachedTransformersVersionSpec ??= resolveTransformersVersionSpec();
	return cachedTransformersVersionSpec;
}

// ── Transformers runtime loader ─────────────────────────────────────

interface TransformersCache {
	match(request: string): Promise<Response | undefined>;
	put(
		request: string,
		response: Response,
		progress?: (data: { progress: number; loaded: number; total: number }) => void,
	): Promise<void>;
}

interface TransformersWasmEnvironment {
	numThreads?: number;
	proxy?: boolean;
	wasmBinary?: Uint8Array;
	wasmPaths?: { mjs: string };
}

/** The subset of the Transformers.js module surface {@link configureTransformers} touches. */
interface ConfigurableTransformers {
	env: {
		cacheDir?: string;
		allowLocalModels?: boolean;
		logLevel?: unknown;
		backends?: { onnx?: { wasm?: TransformersWasmEnvironment } };
		useCustomCache?: boolean;
		customCache?: TransformersCache;
	};
	LogLevel?: { ERROR: unknown };
}

export interface TransformersRuntimePlan {
	useSideRuntime: boolean;
	entrySpecifier: string;
	overrides: Record<string, string> | undefined;
	trustedDependencies: string[] | undefined;
}

/** Select the native Node runtime on desktop and the WASM web runtime on Android. */
export function transformersRuntimePlan(
	platform: NodeJS.Platform | string = process.platform,
	compiled = isCompiledBinary(),
): TransformersRuntimePlan {
	const android = platform === "android";
	return {
		useSideRuntime: compiled || android,
		entrySpecifier: android ? `${TRANSFORMERS_PACKAGE}/dist/transformers.web.js` : TRANSFORMERS_PACKAGE,
		overrides: android
			? { "onnxruntime-node": "npm:onnxruntime-common@1.24.3", sharp: "npm:is-even@1.0.0" }
			: undefined,
		trustedDependencies: android ? undefined : ["onnxruntime-node"],
	};
}

export function withAndroidWebRuntime<T>(load: () => T): T {
	const release = process.release;
	const descriptor = Object.getOwnPropertyDescriptor(release, "name");
	Object.defineProperty(release, "name", {
		configurable: true,
		enumerable: descriptor?.enumerable ?? true,
		writable: true,
		value: "bun",
	});
	try {
		return load();
	} finally {
		if (descriptor) Object.defineProperty(release, "name", descriptor);
		else Reflect.deleteProperty(release, "name");
	}
}

function loadAndroidTransformers<T extends ConfigurableTransformers>(require_: NodeRequire, entry: string): T {
	const loaded = withAndroidWebRuntime(() => require_(entry) as T);
	return { ...loaded };
}

export interface TransformersRuntimeMetadata {
	__ompRuntimeNodeModules?: string;
	__ompTransformersEntry?: string;
	__ompCudaRepairError?: string;
}

function attachTransformersRuntimeMetadata<T extends ConfigurableTransformers>(
	transformers: T,
	metadata: TransformersRuntimeMetadata,
): T {
	const runtime = transformers as T & TransformersRuntimeMetadata;
	runtime.__ompRuntimeNodeModules = metadata.__ompRuntimeNodeModules;
	runtime.__ompTransformersEntry = metadata.__ompTransformersEntry;
	runtime.__ompCudaRepairError = metadata.__ompCudaRepairError;
	return runtime;
}

const TRANSITIVE_CUDA_LIBRARY_RE =
	/\b(lib(?:cu|nv)[A-Za-z0-9_.+-]*\.so(?:\.[0-9]+)*)\b[^:\n]*:\s*cannot open shared object file/iu;
const CUDA_DEVICE_UNAVAILABLE_RE = /\bCUDA failure 100\b|no CUDA-capable device is detected|cudaSetDevice|GPU=-1/iu;

function cudaDeviceUnavailable(error: unknown): boolean {
	return CUDA_DEVICE_UNAVAILABLE_RE.test(errorText(error));
}

function missingCudaLibrary(error: unknown): string | undefined {
	return TRANSITIVE_CUDA_LIBRARY_RE.exec(errorText(error))?.[1];
}

function cudaFailureCause(
	metadata: TransformersRuntimeMetadata,
	error: unknown,
	missingFiles: readonly string[],
): string {
	if (metadata.__ompCudaRepairError) {
		return `ONNX Runtime CUDA provider install failed: ${metadata.__ompCudaRepairError}`;
	}
	if (missingFiles.length > 0) return `missing ONNX Runtime CUDA provider file(s): ${missingFiles.join(", ")}`;
	const missingLibrary = missingCudaLibrary(error);
	if (missingLibrary) return `${missingLibrary}: cannot open shared object file`;
	if (cudaDeviceUnavailable(error)) {
		return "CUDA provider files are present; CUDA runtime reports no CUDA-capable device";
	}
	return "CUDA provider files are present; inspect the original ONNX Runtime CUDA error";
}

function cudaFailureHint(
	metadata: TransformersRuntimeMetadata,
	error: unknown,
	missingFiles: readonly string[],
): string {
	if (metadata.__ompCudaRepairError) {
		return "restore network access to nuget.org (or pre-populate the tiny side runtime) and rerun; CPU inference remained available";
	}
	if (missingFiles.length > 0) return "reinstall the tiny side runtime with ONNX Runtime postinstall enabled";
	if (missingCudaLibrary(error)) {
		return "install the matching CUDA/cuDNN shared libraries and expose them on the dynamic loader path";
	}
	if (cudaDeviceUnavailable(error)) {
		return "make the NVIDIA GPU visible to this process/session, or use providers.tinyModelDevice=default/cpu";
	}
	return "check the host CUDA driver, device visibility, and ONNX Runtime CUDA compatibility";
}

function resolveOnnxRuntimePackageDir(metadata: TransformersRuntimeMetadata): string | null {
	const entry = metadata.__ompTransformersEntry;
	if (entry) {
		try {
			return path.dirname(createRequire(entry).resolve(`${ONNX_RUNTIME_NODE_PACKAGE}/package.json`));
		} catch {
			// Fall through to the side-runtime resolver below.
		}
	}
	const nodeModules = metadata.__ompRuntimeNodeModules;
	if (!nodeModules) return null;
	const manifest = resolveRuntimeModule(nodeModules, `${ONNX_RUNTIME_NODE_PACKAGE}/package.json`);
	return manifest ? path.dirname(manifest) : null;
}

export async function formatOnnxRuntimeCudaDiagnostics(
	metadata: TransformersRuntimeMetadata,
	requestedDevice: string,
	error: unknown,
): Promise<string | null> {
	const device = requestedDevice.trim().toLowerCase();
	if (device !== "cuda" && device !== "gpu" && device !== "auto") return null;
	if (process.platform !== "linux" || process.arch !== "x64") return null;
	const packageDir = resolveOnnxRuntimePackageDir(metadata);
	if (!packageDir) {
		return [
			"ONNX Runtime CUDA diagnostics:",
			`  PI_TINY_DEVICE=${requestedDevice} requested CUDAExecutionProvider`,
			"  cause: unable to resolve onnxruntime-node in the tiny-model runtime",
		].join("\n");
	}
	const binDir = path.join(packageDir, LINUX_X64_ONNX_RUNTIME_CUDA_PROVIDER_DIR);
	const missingFiles = await missingOnnxRuntimeCudaProviderFiles(binDir);
	const sideRuntime = metadata.__ompRuntimeNodeModules;
	const lines = [
		"ONNX Runtime CUDA diagnostics:",
		`  PI_TINY_DEVICE=${requestedDevice} requested CUDAExecutionProvider`,
		sideRuntime ? `  side runtime: ${sideRuntime}` : `  onnxruntime-node: ${packageDir}`,
		`  cause: ${cudaFailureCause(metadata, error, missingFiles)}`,
	];
	lines.push(`  hint: ${cudaFailureHint(metadata, error, missingFiles)}`);
	return lines.join("\n");
}

function transformersCachePath(cacheDir: string, request: string): string | null {
	let relative = request;
	try {
		const url = new URL(request);
		const match = /^\/(.+?)\/resolve\/[^/]+\/(.+)$/.exec(url.pathname);
		if (!match) return null;
		relative = `${match[1]}/${match[2]}`;
	} catch {
		relative = relative.replace(/^\/models\//, "");
	}
	const normalized = path.posix.normalize(relative).replace(/^\/+/, "");
	if (!normalized || normalized === ".." || normalized.startsWith("../")) return null;
	return path.join(cacheDir, ...normalized.split("/"));
}

function createTransformersFileCache(cacheDir: string): TransformersCache {
	return {
		async match(request) {
			const file = transformersCachePath(cacheDir, request);
			if (!file || !(await Bun.file(file).exists())) return undefined;
			return new Response(Bun.file(file));
		},
		async put(request, response, progress) {
			const file = transformersCachePath(cacheDir, request);
			if (!file) throw new Error(`Unsupported Transformers cache key: ${request}`);
			const temporary = `${file}.part.${process.pid}.${crypto.randomUUID()}`;
			const total = Number(response.headers.get("content-length")) || 0;
			await fs.mkdir(path.dirname(temporary), { recursive: true });
			let loaded = 0;
			const reader = response.body?.getReader();
			if (!reader) throw new Error(`Transformers download returned no body for ${request}`);
			const sink = Bun.file(temporary).writer();
			let completed = false;
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					await sink.write(chunk.value);
					loaded += chunk.value.byteLength;
					progress?.({ progress: total > 0 ? (loaded / total) * 100 : 0, loaded, total });
				}
				await sink.end();
				await fs.rename(temporary, file);
				completed = true;
			} finally {
				if (!completed) {
					await reader.cancel().catch(() => undefined);
					await Promise.resolve(sink.end()).catch(() => undefined);
					await fs.rm(temporary, { force: true }).catch(() => undefined);
				}
			}
		},
	};
}

export function configureTransformers<T extends ConfigurableTransformers>(
	transformers: T,
	androidWasm?: { binary: Uint8Array; module: string },
): T {
	const cacheDir = getTinyModelsCacheDir();
	transformers.env.cacheDir = cacheDir;
	transformers.env.allowLocalModels = false;
	transformers.env.logLevel = transformers.LogLevel?.ERROR ?? "error";
	if (androidWasm) {
		const onnx = (transformers.env.backends ??= {}).onnx ??= {};
		const wasm = (onnx.wasm ??= {});
		wasm.numThreads = 1;
		wasm.proxy = false;
		wasm.wasmBinary = androidWasm.binary;
		wasm.wasmPaths = { mjs: androidWasm.module };
		transformers.env.useCustomCache = true;
		transformers.env.customCache = createTransformersFileCache(cacheDir);
	}
	return transformers;
}

/**
 * Memoize an async runtime load so it runs at most once per process, clearing
 * the cache on failure so a later call can retry. Each worker holds one
 * instance per runtime it loads.
 */
export class MemoizedRuntime<T> {
	#promise: Promise<T> | null = null;

	load(build: () => Promise<T>): Promise<T> {
		if (this.#promise) return this.#promise;
		const promise = build().catch(error => {
			this.#promise = null;
			throw error;
		});
		this.#promise = promise;
		return promise;
	}
}

/**
 * Load `@huggingface/transformers` into `holder` (memoized). Desktop source
 * runs use the ambient native Node runtime; compiled binaries use a side
 * runtime. Android always uses a side runtime because npm skips the package's
 * unsupported `onnxruntime-node` dependency, then loads the web/WASM entry.
 */
export function loadTransformersRuntime<T extends ConfigurableTransformers, K>(
	holder: MemoizedRuntime<T>,
	transport: WorkerProgressTransport<K>,
	requestId: string,
	modelKey: K,
	runtimeDir: () => string,
): Promise<T> {
	const plan = transformersRuntimePlan();
	return holder.load(async () => {
		if (!plan.useSideRuntime) {
			const entry = sourceRequire.resolve(plan.entrySpecifier);
			return attachTransformersRuntimeMetadata(configureTransformers(sourceRequire(entry) as T), {
				__ompTransformersEntry: entry,
			});
		}
		const installedDir = await ensureRuntimeInstalled({
			runtimeDir: runtimeDir(),
			install: {
				dependencies: { [TRANSFORMERS_PACKAGE]: getTransformersVersionSpec() },
				overrides: plan.overrides,
				trustedDependencies: plan.trustedDependencies,
			},
			probePackage: TRANSFORMERS_PACKAGE,
			onPhase: phase =>
				transport.send({
					type: "progress",
					id: requestId,
					event: {
						modelKey,
						status: phase,
						name: `${TRANSFORMERS_PACKAGE}@${getTransformersVersionSpec()}`,
					},
				}),
		});
		let cudaRepairError: string | undefined;
		if (process.platform !== "android") {
			try {
				await ensureOnnxRuntimeCudaProviders(installedDir);
			} catch (repairError) {
				// Deferred failure: keep loading Transformers so `loadPipelineWithDeviceFallback`
				// still gets its CUDA→CPU retry. The error is surfaced through the CUDA
				// diagnostics attached to the runtime metadata.
				cudaRepairError = errorMessage(repairError);
			}
		}
		const nodeModules = await installSharpStubResolver(installedDir);
		const entry = resolveRuntimeModule(nodeModules, plan.entrySpecifier);
		if (!entry) throw new Error(`Unable to resolve ${plan.entrySpecifier} in runtime at ${nodeModules}`);
		const require_ = createRequire(entry);
		const android = process.platform === "android";
		const androidWasmPath = android
			? resolveRuntimeModule(nodeModules, "onnxruntime-web/ort-wasm-simd-threaded.wasm")
			: undefined;
		const androidWasmModule = android
			? resolveRuntimeModule(nodeModules, "onnxruntime-web/ort-wasm-simd-threaded.mjs")
			: undefined;
		if (android && (!androidWasmPath || !androidWasmModule)) {
			throw new Error(`Unable to resolve onnxruntime-web runtime at ${nodeModules}`);
		}
		const androidWasm =
			androidWasmPath && androidWasmModule
				? { binary: await Bun.file(androidWasmPath).bytes(), module: androidWasmModule }
				: undefined;
		const loaded = android ? loadAndroidTransformers<T>(require_, entry) : (require_(entry) as T);
		return attachTransformersRuntimeMetadata(configureTransformers(loaded, androidWasm ?? undefined), {
			__ompRuntimeNodeModules: nodeModules,
			__ompTransformersEntry: entry,
			__ompCudaRepairError: cudaRepairError,
		});
	});
}
