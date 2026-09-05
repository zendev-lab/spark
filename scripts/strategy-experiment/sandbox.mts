import { spawn } from "node:child_process";
import { builtinModules } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { build } from "esbuild";

import { digest, readJson, repositoryRoot, within, type Task, type TestCase } from "./suite.mts";
import { workerSource } from "./worker-source.mts";

export interface CaseResult {
  id: string;
  passed: boolean;
  expected: unknown;
  actual?: unknown;
  error?: string;
  durationMs: number;
  process: { code: number | null; signal: string | null; stdout: string; stderr: string };
}

export interface Verification {
  bundleDigest?: string;
  buildError?: string;
  passed: boolean;
  cases: CaseResult[];
}

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));

/** Bundle production code without allowing imports of host secrets or evaluator sources. */
export async function bundleTask(snapshot: string, task: Task): Promise<string> {
  const npmRoot = await realpath(join(repositoryRoot, "node_modules/.pnpm"));
  const sourceRoot = await realpath(snapshot);
  const allowed = (path: string) => within(sourceRoot, path) || within(npmRoot, path);
  const result = await build({
    stdin: {
      contents: workerSource(task, join(sourceRoot, task.path)),
      resolveDir: sourceRoot,
      sourcefile: "observation-adapter.mjs",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    write: false,
    tsconfigRaw: {},
    logLevel: "silent",
    banner: {
      js: "import { createRequire as __sparkCreateRequire } from 'node:module'; const require = __sparkCreateRequire(import.meta.url);",
    },
    plugins: [
      {
        name: "experiment-import-fence",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, async (args) => {
            if (args.pluginData?.resolving) return undefined;
            if (builtins.has(args.path.replace(/^node:/u, "")))
              return { path: args.path, external: true };
            if (args.path.startsWith("@zendev-lab/")) {
              const parts = args.path.split("/");
              const packageName = parts[1]!;
              const packageRoot = join(sourceRoot, "packages", packageName);
              const manifest = await readJson<{
                exports: Record<string, string | Record<string, string>>;
              }>(join(packageRoot, "package.json"));
              const key = parts.length === 2 ? "." : `./${parts.slice(2).join("/")}`;
              const entry = manifest.exports[key];
              const target = typeof entry === "string" ? entry : (entry?.import ?? entry?.default);
              if (!target) throw new Error(`Unsupported workspace export: ${args.path}`);
              const path = await realpath(resolve(packageRoot, target));
              if (!within(sourceRoot, path)) throw new Error("Workspace import escapes snapshot");
              return { path };
            }
            if (isAbsolute(args.path) && !allowed(args.path))
              throw new Error("Absolute import escapes the source/dependency fence");
            let resolveDir = args.resolveDir;
            // Resolve third-party packages using the installed dependency graph of the same owner.
            // Workspace imports above always resolve to the task snapshot, never the fixed checkout.
            if (
              !args.path.startsWith(".") &&
              !isAbsolute(args.path) &&
              within(sourceRoot, args.resolveDir)
            )
              resolveDir = join(repositoryRoot, relative(sourceRoot, args.resolveDir));
            const resolved = await builder.resolve(args.path, {
              kind: args.kind,
              importer: args.importer,
              resolveDir,
              pluginData: { resolving: true },
            });
            if (resolved.errors.length) return { errors: resolved.errors };
            const path = await realpath(resolved.path);
            if (!allowed(path))
              throw new Error("Import resolves outside the source/dependency fence");
            return { path };
          });
        },
      },
    ],
  });
  return result.outputFiles[0]!.text;
}

function sandboxString(value: string): string {
  if (/[\n\r\0]/u.test(value)) throw new Error("Unsupported sandbox path");
  return JSON.stringify(value);
}

export async function sandboxProfile(bundle: string, scratch: string): Promise<string> {
  if (process.platform !== "darwin")
    throw new Error("This frozen experiment requires macOS sandbox-exec; no unsandboxed fallback");
  const executable = await realpath(process.execPath);
  // Homebrew Node links ICU and other dylibs from the Cellar. No user directory is readable.
  const runtimeRoots = [
    "/System",
    "/usr/lib",
    "/Library/Apple",
    "/opt/homebrew/Cellar",
    "/opt/homebrew/opt",
  ];
  return `(version 1)
(deny default)
(allow process-fork)
(allow process-exec (literal ${sandboxString(executable)}))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* ${runtimeRoots.map((path) => `(subpath ${sandboxString(path)})`).join(" ")}
  (literal "/")
  (literal ${sandboxString(executable)}) (literal ${sandboxString(bundle)}) (subpath ${sandboxString(scratch)})
  (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
(allow file-write* (subpath ${sandboxString(scratch)}) (literal "/dev/null"))
`;
}

export async function runSandboxed(
  bundle: string,
  input: unknown,
  timeoutMs = 10_000,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const root = await realpath(await mkdtemp(join(tmpdir(), "spark-strategy-check-")));
  const bundlePath = join(root, "worker.mjs");
  const scratch = join(root, "scratch");
  await mkdir(scratch);
  await writeFile(bundlePath, bundle);
  const profile = await sandboxProfile(bundlePath, scratch);
  const started = Date.now();
  const result = await new Promise<{
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }>((done, reject) => {
    const child = spawn(
      "/usr/bin/sandbox-exec",
      ["-p", profile, process.execPath, "--max-old-space-size=256", bundlePath],
      {
        cwd: scratch,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: scratch,
          TMPDIR: scratch,
          SPARK_HOME: join(scratch, "spark-home"),
          NODE_NO_WARNINGS: "1",
          OPENSSL_CONF: "/dev/null",
        },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    };
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > 128 * 1024) kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (Buffer.byteLength(stderr) > 128 * 1024) kill();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      kill();
      done({ code, signal: exitSignal, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
  await rm(root, { recursive: true });
  return { ...result, durationMs: Date.now() - started };
}

export function matches(actual: unknown, expected: unknown): boolean {
  if (
    expected &&
    typeof expected === "object" &&
    "assertion" in expected &&
    expected.assertion === "render"
  ) {
    if (!Array.isArray(actual) || actual.length !== 1 || typeof actual[0] !== "string")
      return false;
    const text = actual[0];
    const plain = text.replace(/\u001b\[[0-9;]*m/gu, "");
    if (!("plain" in expected) || !("ansi" in expected)) return false;
    return plain === expected.plain && (!expected.ansi || /\u001b\[/u.test(text));
  }
  return isDeepStrictEqual(actual, expected);
}

export async function verifyTask(
  snapshot: string,
  task: Task,
  cases: TestCase[],
  signal?: AbortSignal,
): Promise<Verification> {
  let bundle: string;
  try {
    bundle = await bundleTask(snapshot, task);
  } catch (error) {
    return { passed: false, buildError: String(error), cases: [] };
  }
  const results: CaseResult[] = [];
  for (const entry of cases) {
    signal?.throwIfAborted();
    const result = await runSandboxed(bundle, entry.input, 10_000, signal);
    let actual: unknown;
    let error: string | undefined;
    try {
      if (result.code !== 0 || result.signal)
        throw new Error(`Observation process failed (${result.code ?? result.signal})`);
      actual = JSON.parse(result.stdout);
    } catch (failure) {
      error = String(failure);
    }
    results.push({
      id: entry.id,
      passed: !error && matches(actual, entry.expected),
      expected: entry.expected,
      ...(actual !== undefined ? { actual } : {}),
      ...(error ? { error } : {}),
      durationMs: result.durationMs,
      process: {
        code: result.code,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    });
  }
  return {
    bundleDigest: digest(bundle),
    passed: results.every((entry) => entry.passed),
    cases: results,
  };
}

export async function probeSandbox(forbiddenPath: string): Promise<void> {
  const probe = `import fs from 'node:fs'; import net from 'node:net';
let readDenied=false, writeDenied=false;
try {fs.readFileSync(${JSON.stringify(forbiddenPath)});} catch(e) {readDenied=e.code==='EPERM'||e.code==='EACCES';}
try {fs.writeFileSync(${JSON.stringify(forbiddenPath)}, 'changed');} catch(e) {writeDenied=e.code==='EPERM'||e.code==='EACCES';}
const networkDenied=await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:9});socket.on('error',e=>resolve(e.code==='EPERM'||e.code==='EACCES'));socket.on('connect',()=>{socket.destroy();resolve(false)});});
process.stdout.write(JSON.stringify({readDenied,writeDenied,networkDenied}));`;
  const result = await runSandboxed(probe, {});
  if (
    result.code !== 0 ||
    !isDeepStrictEqual(JSON.parse(result.stdout || "null"), {
      readDenied: true,
      writeDenied: true,
      networkDenied: true,
    })
  )
    throw new Error(`Sandbox boundary probe failed: ${result.stderr || result.stdout}`);
  await readFile(forbiddenPath); // The trusted verifier retains access.
}
