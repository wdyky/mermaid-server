import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Type } from "typebox";

// ── Locations ───────────────────────────────────────────────────────────────
// The extension dir ships the bundled server:
//   extensions/mermaid/server/server.cjs   (esbuild bundle, plain node)
//   extensions/mermaid/server/dist/        (SPA)
// Runtime state lives in extdata/mermaid/ (config.json, server.json, server.pid,
// server.log). The server writes server.pid itself (--pidfile); server.json is
// the extension's own record of the process it started.

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_CJS = join(EXT_DIR, "server", "server.cjs");

const EXT_DATA_DIR = join(getAgentDir(), "extdata", "mermaid");
const CONFIG_FILE = join(EXT_DATA_DIR, "config.json");
const META_FILE = join(EXT_DATA_DIR, "server.json");
const PID_FILE = join(EXT_DATA_DIR, "server.pid");
const LOG_FILE = join(EXT_DATA_DIR, "server.log");

const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;
const HEALTH_POLL_MS = 250;
const REQUEST_TIMEOUT_MS = 10_000;

// ── Config (extdata JSON, same pattern as llama_think) ─────────────────────

interface Config {
  host: string;
  port: number;
  rootDir: string;
  autoStart: boolean;
  /**
   * Persistent shared secret for the server's API + web UI. Generated once on
   * first use and reused for every (re)start, so the browser's auth cookie
   * survives server restarts; rotate with `/mermaid tokgen`.
   */
  token?: string;
}

function defaultConfig(): Config {
  return { host: "127.0.0.1", port: 8790, rootDir: homedir(), autoStart: true };
}

/** New shared secret (32 hex chars). */
function newToken(): string {
  return randomBytes(16).toString("hex");
}

function baseUrlOf(cfg: Config): string {
  return `http://${cfg.host}:${cfg.port}`;
}

/**
 * Load config, migrating the legacy { baseUrl } shape. Unknown/corrupt files
 * fall back to defaults.
 */
function loadConfig(): Config {
  const defaults = defaultConfig();
  let cfg: Config = defaults;
  if (existsSync(CONFIG_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
      cfg = { ...defaults };

      if (typeof parsed.host === "string" && parsed.host.trim()) cfg.host = parsed.host.trim();
      if (typeof parsed.port === "number" && Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port <= 65535) {
        cfg.port = parsed.port;
      }
      if (typeof parsed.rootDir === "string" && parsed.rootDir.trim()) {
        cfg.rootDir = resolve(parsed.rootDir.replace(/^~(?=$|\/)/, homedir()));
      }
      if (typeof parsed.autoStart === "boolean") cfg.autoStart = parsed.autoStart;
      if (typeof parsed.token === "string" && parsed.token.trim()) cfg.token = parsed.token.trim();

      // Legacy: only { baseUrl } was stored.
      if (typeof parsed.baseUrl === "string" && typeof parsed.host !== "string") {
        const url = new URL(parsed.baseUrl);
        cfg.host = url.hostname.replace(/^\[|\]$/g, "") || cfg.host;
        if (url.port) cfg.port = Number(url.port);
      }
    } catch {
      cfg = defaults;
    }
  }

  // First launch (or a legacy config): mint the persistent token once and
  // store it, so every restart keeps the same secret and the browser's cookie
  // keeps working. Rotate with /mermaid tokgen.
  if (!cfg.token) {
    cfg.token = newToken();
    saveConfig(cfg);
  }
  return cfg;
}

function saveConfig(config: Config): void {
  mkdirSync(EXT_DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ── Server process record ───────────────────────────────────────────────────

interface ServerMeta {
  pid: number;
  host: string;
  port: number;
  rootDir: string;
  startedAt: number;
  /**
   * Shared secret the extension passes to the server via --token and sends as
   * the Authorization header on every authenticated API call (everything
   * except the open /api/health). Persistent: generated once into config.json
   * and reused across restarts; rotated with /mermaid tokgen.
   */
  token?: string;
}

function loadMeta(): ServerMeta | null {
  try {
    const parsed = JSON.parse(readFileSync(META_FILE, "utf-8")) as ServerMeta;
    if (typeof parsed?.pid === "number") return parsed;
  } catch {
    // no record
  }
  return null;
}

function saveMeta(meta: ServerMeta): void {
  mkdirSync(EXT_DATA_DIR, { recursive: true });
  writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

function clearMeta(): void {
  try {
    unlinkSync(META_FILE);
  } catch {
    // already gone
  }
}

function removeIfExists(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}

function tailLog(lines = 12): string {
  try {
    return readFileSync(LOG_FILE, "utf-8")
      .trim()
      .split("\n")
      .slice(-lines)
      .join("\n");
  } catch {
    return "(no log)";
  }
}

// ── HTTP client (thin wrapper over the mermaid-server public API) ─────────

/** API failure carrying the server's machine-readable error code. */
class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Call a mermaid-server endpoint and unwrap the { result, error } envelope:
 *   success → { result: <payload>, error: null }
 *   failure → { result: null, error: { message, code } }
 * Throws ApiError (code: BAD_REQUEST / FILE_NOT_FOUND / TAB_NOT_FOUND /
 * INTERNAL) on failure. Tolerates the pre-envelope shapes (bare payload /
 * { error: string }) in case the base URL points at an older server.
 */
async function apiRequest<T>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
  token?: string,
): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  // /api/health is intentionally open (the liveness gate) — no token there.
  if (token && path !== "/api/health") headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  const body =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : undefined;
  const error = body?.error;
  if (error) {
    if (typeof error === "string") {
      throw new ApiError(error, "UNKNOWN", response.status); // legacy server
    }
    const e = error as { message?: unknown; code?: unknown };
    throw new ApiError(
      typeof e.message === "string" ? e.message : `mermaid-server error (HTTP ${response.status})`,
      typeof e.code === "string" ? e.code : "UNKNOWN",
      response.status,
    );
  }
  if (!response.ok) {
    throw new ApiError(`mermaid-server returned HTTP ${response.status}`, "HTTP_ERROR", response.status);
  }
  if (body && "result" in body) return body.result as T; // new envelope
  return payload as T; // legacy server: bare payload
}

interface HealthResult {
  ok: true;
  pid?: number;
  version?: string;
  uptime?: number;
  /** This instance runs the orphan watchdog (--parent-pid). */
  watched?: boolean;
  /** Pids still registered as live sessions (watchdog input). */
  sessions?: number;
}

/** Probe /api/health; null when the server is not reachable. */
async function getHealth(cfg: Config, signal?: AbortSignal): Promise<HealthResult | null> {
  try {
    return await apiRequest<HealthResult>(baseUrlOf(cfg), "/api/health", {}, signal);
  } catch {
    return null;
  }
}

/**
 * Does the instance listening on host:port accept our token? A 401 means it is
 * a different instance (different token) — anything else is treated as
 * "ours" so a transient error never causes a needless restart.
 */
async function instanceAcceptsToken(cfg: Config, token: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await apiRequest<unknown>(baseUrlOf(cfg), "/api/state", {}, signal, token);
    return true;
  } catch (error) {
    return !(error instanceof ApiError && error.code === "UNAUTHORIZED");
  }
}

/**
 * Best-effort keep-alive: tell the running server which pi pid still wants it,
 * so a server an older pi spawned can be adopted (the orphan watchdog exits
 * once every registered pid is gone). Ignored on servers without the endpoint.
 */
async function registerSession(cfg: Config, token: string): Promise<void> {
  try {
    await apiRequest(
      baseUrlOf(cfg),
      "/api/session",
      { method: "POST", body: JSON.stringify({ pid: process.pid }) },
      undefined,
      token,
    );
  } catch {
    // no /api/session (older server) or transient failure — --parent-pid covers it
  }
}

// ── Server lifecycle (spawn / stop / restart) ──────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let startingPromise: Promise<{ pid: number; started: boolean }> | null = null;

/**
 * Start the bundled server detached (it outlives this pi process) and wait
 * for /api/health. Resolves with the live pid. An instance already listening on
 * host:port is reused when it accepts our token and runs the orphan watchdog,
 * and replaced otherwise (older build / foreign server).
 */
async function startServer(signal?: AbortSignal): Promise<{ pid: number; started: boolean }> {
  const cfg = loadConfig();
  const token = cfg.token ?? newToken();

  const existing = await getHealth(cfg, signal);
  // Reuse only a server that both accepts our token and runs the orphan
  // watchdog (reported as `watched`). An older build (per-start tokens, no
  // --parent-pid) is replaced so the upgrade actually takes effect.
  if (existing?.ok && existing.watched === true && (await instanceAcceptsToken(cfg, token, signal))) {
    await registerSession(cfg, token);
    if (existing.pid) saveMeta(loadMetaLike(existing.pid, cfg, token));
    return { pid: existing.pid ?? -1, started: false };
  }
  if (existing?.ok) {
    // Something listens on our host:port but is not our (current) server:
    // an instance from an older build, or a foreign/dev server. The extension
    // owns this port, so replace it.
    console.warn(
      `mermaid: replacing the server at ${baseUrlOf(cfg)} (not a watchdog-capable instance with our token)`,
    );
    await stopServer();
  }

  if (!existsSync(SERVER_CJS)) {
    throw new Error(
      `bundled server not found at ${SERVER_CJS} — in the mermaid-server project run: npm run build && npm run bundle && npm run ship`,
    );
  }

  mkdirSync(EXT_DATA_DIR, { recursive: true });
  const logFd = openSync(LOG_FILE, "w");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      process.execPath,
      [
        SERVER_CJS,
        "--host", cfg.host,
        "--port", String(cfg.port),
        "--root", cfg.rootDir,
        "--pidfile", PID_FILE,
        "--token", token,
        // Orphan watchdog: the server exits by itself if this pi process dies
        // without a clean shutdown (SIGKILL, crash) — no stale server left.
        "--parent-pid", String(process.pid),
      ],
      { detached: true, stdio: ["ignore", logFd, logFd], cwd: EXT_DIR },
    );
  } finally {
    closeSync(logFd);
  }
  const spawnedPid: number = child.pid ?? 0;
  child.on("error", (err) => {
    // spawn-level failure (e.g. missing node binary) — the health wait below
    // will time out and surface the log; keep the reason attached.
    (child as { spawnError?: Error }).spawnError = err;
  });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) throw new Error("aborted while starting mermaid server");
    const health = await getHealth(cfg);
    if (health?.ok) {
      const pid = health.pid ?? spawnedPid;
      saveMeta({
        pid,
        host: cfg.host,
        port: cfg.port,
        rootDir: cfg.rootDir,
        startedAt: Date.now(),
        token,
      });
      return { pid, started: true };
    }
    if (Date.now() > deadline) {
      const spawnError = (child as { spawnError?: Error }).spawnError;
      throw new Error(
        `mermaid server did not come up within ${START_TIMEOUT_MS / 1000} s` +
          (spawnError ? ` (spawn error: ${spawnError.message})` : "") +
          `\n${tailLog()}`,
      );
    }
    await sleep(HEALTH_POLL_MS);
  }
}

function loadMetaLike(pid: number, cfg: Config, token: string): ServerMeta {
  const prev = loadMeta();
  return {
    pid,
    host: cfg.host,
    port: cfg.port,
    rootDir: cfg.rootDir,
    startedAt: prev?.startedAt ?? Date.now(),
    // The token is stable config now; meta just mirrors it for reference.
    token,
  };
}

/** Ensure the server is running: returns immediately when up, starts it otherwise. */
function ensureServer(signal?: AbortSignal): Promise<{ pid: number; started: boolean }> {
  if (!startingPromise) {
    startingPromise = startServer(signal).finally(() => {
      startingPromise = null;
    });
  }
  return startingPromise;
}

/**
 * Stop the server currently answering on the configured host:port — the one
 * /api/health reports, whether or not the extension started it. SIGTERM first
 * (clean shutdown, server removes its pidfile), SIGKILL as backstop.
 */
async function stopServer(): Promise<"stopped" | "was-not-running"> {
  const cfg = loadConfig();
  const health = await getHealth(cfg);
  if (!health?.ok) {
    clearMeta();
    removeIfExists(PID_FILE);
    return "was-not-running";
  }
  if (!health.pid) {
    throw new Error(
      "server is running but /api/health reports no pid (old server build?) — stop it manually",
    );
  }
  const pid = health.pid;
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    clearMeta();
    removeIfExists(PID_FILE);
    throw new Error(`cannot signal pid ${pid}: ${(err as Error).message}`, { cause: err });
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  for (;;) {
    const still = await getHealth(cfg);
    if (!still?.ok) break;
    if (Date.now() > deadline) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
      await sleep(300);
      break;
    }
    await sleep(HEALTH_POLL_MS);
  }
  clearMeta();
  removeIfExists(PID_FILE);
  return "stopped";
}

async function restartServer(): Promise<{ pid: number; wasRunning: boolean }> {
  const cfg = loadConfig();
  const wasRunning = !!(await getHealth(cfg))?.ok;
  if (wasRunning) await stopServer();
  const { pid } = await startServer();
  return { pid, wasRunning };
}

// ── API shapes (see the mermaid-server AGENTS.md "Public HTTP API") ────────

interface Tab {
  name: string;
  path: string;
  mtime: number;
}

interface ParseResult {
  ok: boolean;
  /** jison-style message: line number, caret, expected tokens. */
  error?: string;
}

interface DisplayResult {
  name: string;
  path: string;
  mtime: number;
  parse: ParseResult;
}

interface ServerState {
  tabs: Tab[];
  lastDisplay: { name: string; at: number } | null;
}

// Append the server-side parse verdict to a tool result. Absent on legacy
// servers (no parse field) — nothing to report.
function parseNote(parse: ParseResult | undefined): string {
  if (!parse) return "";
  if (parse.ok) return "Diagram parses OK.";
  return `SYNTAX ERROR in the file (the tab still opens; the UI shows the same error):\n${parse.error}`;
}

// Derive a short tab name from a file path: basename without extension.
function deriveName(path: string): string {
  const base = path.split("/").pop() ?? "";
  const stem = base.replace(/\.[^.]+$/, "");
  return stem || "diagram";
}

// Pick a tab name: use the preferred name unless an existing tab holds it
// while pointing at a different file — in that case append -2, -3, ...
// (display with an existing name silently re-points that tab on the server).
function uniqueName(tabs: Tab[], preferred: string, path: string): string {
  const byName = new Map(tabs.map((t) => [t.name, t.path]));
  if (!byName.has(preferred) || byName.get(preferred) === path) return preferred;
  for (let i = 2; ; i++) {
    const candidate = `${preferred}-${i}`;
    if (!byName.has(candidate) || byName.get(candidate) === path) return candidate;
  }
}

/**
 * Tool preflight: make sure the server is up (starting it in the background
 * when needed) and return the base URL for requests.
 */
async function toolPreflight(signal?: AbortSignal): Promise<string> {
  const cfg = loadConfig();
  try {
    await ensureServer(signal);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `mermaid server is not running at ${baseUrlOf(cfg)} and could not be started automatically. ` +
        `Start it with /mermaid start or manually (npm run dev / npm start in mermaid-server). ${detail}`,
      { cause: error },
    );
  }
  return baseUrlOf(cfg);
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function mermaidExtension(pi: ExtensionAPI): void {
  // Eager auto-start: on every user input, make sure the server is running.
  // The check is one localhost /api/health probe (~ms) — cheap enough to run
  // per message; the server is only spawned when it is actually down. After a
  // failed start, back off for a while so a broken setup cannot hammer a
  // 10 s spawn attempt (and an error toast) on every message.
  let lastAutoStartFailureAt = 0;

  // Kill the server when pi tears down the session: /reload (reason "reload"),
  // new/resume/fork switches, and process exit (Ctrl+C / Ctrl+D / SIGHUP /
  // SIGTERM) all emit session_shutdown — so the server dies with the runtime
  // instead of being orphaned. Idempotent: a no-op when nothing is running.
  // A hard SIGKILL of pi skips this, but the server's own --parent-pid
  // watchdog (see startServer) reclaims it a few seconds later.
  pi.on("session_shutdown", async (_event) => {
    try {
      await stopServer();
    } catch {
      // best effort on the way out
    }
  });

  pi.on("input", (_event, ctx) => {
    if (!loadConfig().autoStart) return;
    if (Date.now() < lastAutoStartFailureAt) return;
    ensureServer().then(
      (r) => {
        if (r.started) ctx.ui.notify(`mermaid server started (pid ${r.pid})`, "info");
      },
      (error) => {
        lastAutoStartFailureAt = Date.now() + 60_000;
        ctx.ui.notify(`mermaid auto-start failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      },
    );
  });

  pi.registerTool({
    name: "mermaid_display",
    label: "Mermaid: add tab",
    description: `Add (or re-point) a tab in the local mermaid-server diagram UI and make it the active tab.

POSTs {name, path} to the server's /api/display endpoint. The server reads the file, validates it with mermaid.parse, and the browser UI adopts/activates the tab on its next poll (~2 s). If a tab with the same name already exists it is silently re-pointed to the new path.

If the server is not running it is started in the background first (bundled with this extension); the result still reports the server-side parse verdict — on a syntax error it includes the full jison-style message (line, caret, expected tokens). Fix the file and call again instead of guessing.

Parameters:
- path: path to the file to display (required). Relative paths are resolved against the current working directory; the server itself only understands absolute paths, so the tool resolves them first.
- name: tab name (optional). If omitted, derived from the file name (basename without extension); if that name is already used by a tab pointing at a different file, a -2/-3 suffix is appended to avoid clobbering it. Pass an explicit name to intentionally re-point an existing tab.`,
    promptSnippet: "mermaid_display: open a file as a tab in the mermaid-server UI (reports parse errors)",
    promptGuidelines: [
      "Use mermaid_display to show a mermaid diagram (or any text file) in the mermaid-server UI; its result reports server-side parse errors — fix the file and re-display instead of guessing.",
      "Use mermaid_reload to pick up external edits to an open tab's file; mermaid_state to see what's open; mermaid_close to remove a tab from the server. /mermaid start|stop|restart manage the bundled server process.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to display (absolute, or relative to the current working directory)" }),
      name: Type.Optional(Type.String({ description: "Tab name; derived from the file name if omitted" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const baseUrl = await toolPreflight(signal);
      const token = loadConfig().token;

      // Models sometimes prefix paths with @; built-in tools strip it too.
      const rawPath = params.path.replace(/^@/, "");
      const path = resolve(ctx.cwd, rawPath);

      const state = await apiRequest<ServerState>(baseUrl, "/api/state", {}, signal, token);
      const name =
        params.name?.trim() || uniqueName(state.tabs ?? [], deriveName(path), path);

      const result = await apiRequest<DisplayResult>(
        baseUrl,
        "/api/display",
        { method: "POST", body: JSON.stringify({ name, path }) },
        signal,
        token,
      );

      const note = parseNote(result.parse);
      return {
        content: [
          {
            type: "text",
            text: `Tab "${result.name}" set to ${result.path} (mtime ${result.mtime}).${note ? `\n${note}` : ""} It appears/activates in the mermaid-server UI within ~2 s.`,
          },
        ],
        details: { name: result.name, path: result.path, mtime: result.mtime, parse: result.parse },
      };
    },
  });

  pi.registerTool({
    name: "mermaid_reload",
    label: "Mermaid: refresh tab",
    description: `Re-read a tab's file from disk in the mermaid-server diagram UI (picks up external edits).

POSTs {name} to the server's /api/reload endpoint. The server re-reads the tab's file, re-validates it with mermaid.parse, updates its stored mtime, and the browser UI refreshes the editor content on its next poll (~2 s). Does not change which tab is active.

The result reports the server-side parse verdict; on a syntax error it includes the full jison-style message. Fails with TAB_NOT_FOUND if the name is unknown, FILE_NOT_FOUND if the file is gone.`,
    promptSnippet: "mermaid_reload: refresh an open tab's content from disk in the mermaid-server UI",
    parameters: Type.Object({
      name: Type.String({ description: "Tab name to refresh" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const baseUrl = await toolPreflight(signal);
      const token = loadConfig().token;

      const name = params.name.trim();
      if (!name) throw new Error("name must not be empty");

      const result = await apiRequest<DisplayResult>(
        baseUrl,
        "/api/reload",
        { method: "POST", body: JSON.stringify({ name }) },
        signal,
        token,
      );

      const note = parseNote(result.parse);
      return {
        content: [
          {
            type: "text",
            text: `Tab "${result.name}" reloaded from ${result.path} (mtime ${result.mtime}).${note ? `\n${note}` : ""}`,
          },
        ],
        details: { name: result.name, path: result.path, mtime: result.mtime, parse: result.parse },
      };
    },
  });

  pi.registerTool({
    name: "mermaid_state",
    label: "Mermaid: list tabs",
    description: `List the tabs currently open in the mermaid-server diagram UI.

GETs /api/state. Returns every tab the server knows (name, path, mtime) and which tab was last asked to display (lastDisplay). Use it to check whether a tab exists before reload/close, or to see what the user has open.`,
    promptSnippet: "mermaid_state: list tabs open in the mermaid-server UI",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, _ctx) {
      const baseUrl = await toolPreflight(signal);
      const token = loadConfig().token;

      const state = await apiRequest<ServerState>(baseUrl, "/api/state", {}, signal, token);
      const tabs = state.tabs ?? [];
      const lines = tabs.length
        ? tabs.map((t) => `- ${t.name}: ${t.path} (mtime ${t.mtime})`)
        : ["(no tabs open)"];
      lines.push(
        state.lastDisplay ? `Last displayed: ${state.lastDisplay.name}` : "Last displayed: (none)",
      );
      return {
        content: [{ type: "text", text: `mermaid-server tabs (${tabs.length}):\n${lines.join("\n")}` }],
        details: { tabs, lastDisplay: state.lastDisplay ?? null },
      };
    },
  });

  pi.registerTool({
    name: "mermaid_close",
    label: "Mermaid: close tab",
    description: `Remove a tab from the mermaid-server's state (DELETE /api/tabs/:name).

After this the tab is gone from /api/state and mermaid_reload fails with TAB_NOT_FOUND. Note: an already-open browser keeps its local copy of the tab (the poll loop only adds tabs, and localStorage re-hydrates them) — close it there too if the UI is open.

Parameters:
- name: tab name to close (required).`,
    promptSnippet: "mermaid_close: remove a tab from the mermaid-server",
    parameters: Type.Object({
      name: Type.String({ description: "Tab name to close" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const baseUrl = await toolPreflight(signal);
      const token = loadConfig().token;

      const name = params.name.trim();
      if (!name) throw new Error("name must not be empty");

      await apiRequest<{ deleted: true }>(
        baseUrl,
        `/api/tabs/${encodeURIComponent(name)}`,
        { method: "DELETE" },
        signal,
        token,
      );
      return {
        content: [{ type: "text", text: `Tab "${name}" closed (removed from the mermaid-server's state).` }],
        details: { name },
      };
    },
  });

  // ── /mermaid command ─────────────────────────────────────────────────────

  const USAGE =
    "/mermaid — manage the bundled mermaid-server\n" +
    "  (no args)          status: config + server state + UI url\n" +
    "  start | stop | restart\n" +
    "  host <ip> | port <n> | root <dir>\n" +
    "  autos on|off       eager auto-start on user input (health probe per message)\n" +
    "  tokgen             regenerate the shared secret (restarts the server)\n" +
    "  base_url <url>     legacy: sets host+port";

  /**
   * How to open the (token-gated) UI without printing the secret: the URL
   * shape plus where the token is stored.
   */
  const uiHint = (cfg: Config): string =>
    `${baseUrlOf(cfg)}/?token=<token>  (token: ${CONFIG_FILE})`;

  pi.registerCommand("mermaid", {
    description:
      "bundled mermaid-server: /mermaid [start|stop|restart|host|port|root|autos|tokgen|base_url]",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const cfg = loadConfig();
      const notify = (text: string, kind: "info" | "error" = "info") =>
        ctx.ui.notify(text, kind);

      const describe = async (): Promise<string> => {
        const health = await getHealth(cfg);
        if (!health?.ok) return "not running";
        const meta = loadMeta();
        const managed = meta?.pid === health.pid ? ", started by extension" : ", not started by extension";
        const ver = health.version ? `, v${health.version}` : "";
        return `running (pid ${health.pid}${ver}${health.uptime ? `, up ${health.uptime}s` : ""}${managed})`;
      };

      if (parts.length === 0) {
        const status = await describe();
        notify(
          `mermaid server @ ${baseUrlOf(cfg)}: ${status}\n` +
            `config: root=${cfg.rootDir} autos=${cfg.autoStart ? "on" : "off"}\n` +
            `ui: ${uiHint(cfg)}\n` +
            `${USAGE}`,
        );
        return;
      }

      const [cmd, ...rest] = parts;
      const arg = rest.join(" ").trim();

      switch (cmd) {
        case "start": {
          const { pid, started } = await ensureServer(ctx.signal).catch((e) => {
            notify(`mermaid start failed: ${e instanceof Error ? e.message : String(e)}`, "error");
            throw e;
          });
          notify(`mermaid server ${started ? "started" : "already running"} (pid ${pid}) @ ${baseUrlOf(loadConfig())}`);
          return;
        }
        case "stop": {
          const r = await stopServer();
          notify(r === "stopped" ? "mermaid server stopped" : "mermaid server was not running");
          return;
        }
        case "restart": {
          const { pid, wasRunning } = await restartServer();
          notify(`mermaid server ${wasRunning ? "restarted" : "started"} (pid ${pid}) @ ${baseUrlOf(loadConfig())}`);
          return;
        }
        case "host": {
          if (!arg || /\s/.test(arg) || arg.includes(":")) {
            notify(`mermaid host: expected a single host (e.g. 127.0.0.1)`, "error");
            return;
          }
          const next = { ...loadConfig(), host: arg };
          saveConfig(next);
          notify(`mermaid host set: ${arg} (applies on next start/restart)`);
          return;
        }
        case "port": {
          const n = Number(arg);
          if (!arg || !Number.isInteger(n) || n < 1 || n > 65535) {
            notify("mermaid port: expected an integer 1-65535", "error");
            return;
          }
          const next = { ...loadConfig(), port: n };
          saveConfig(next);
          notify(`mermaid port set: ${n} (applies on next start/restart)`);
          return;
        }
        case "root": {
          if (!arg) {
            notify(`mermaid root (current): ${loadConfig().rootDir}`, "error");
            return;
          }
          const next = { ...loadConfig(), rootDir: resolve(arg.replace(/^~(?=$|\/)/, homedir())) };
          saveConfig(next);
          notify(`mermaid root set: ${next.rootDir} (applies on next start/restart)`);
          return;
        }
        case "autos": {
          if (arg !== "on" && arg !== "off") {
            notify(`mermaid autos: ${loadConfig().autoStart ? "on" : "off"} (set with /mermaid autos on|off)`, "error");
            return;
          }
          const next = { ...loadConfig(), autoStart: arg === "on" };
          saveConfig(next);
          notify(`mermaid auto-start: ${arg}`);
          return;
        }
        case "tokgen": {
          const next = { ...loadConfig(), token: newToken() };
          saveConfig(next);
          const wasRunning = !!(await getHealth(next))?.ok;
          if (wasRunning) await stopServer();
          const { pid } = await ensureServer(ctx.signal);
          notify(
            `mermaid token regenerated (server ${wasRunning ? "restarted" : "started"}, pid ${pid}).\n` +
              `Re-open the UI with the new token: ${uiHint(loadConfig())}`,
          );
          return;
        }
        case "base_url": {
          // Legacy shape — map onto host+port.
          if (!arg) {
            notify(`mermaid base_url: ${baseUrlOf(cfg)}`, "info");
            return;
          }
          let url: URL;
          try {
            url = new URL(arg);
          } catch {
            notify(`mermaid base_url: invalid URL: ${arg}`, "error");
            return;
          }
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            notify("mermaid base_url: must use http or https", "error");
            return;
          }
          const next = {
            ...loadConfig(),
            host: url.hostname.replace(/^\[|\]$/g, "") || "127.0.0.1",
            port: url.port ? Number(url.port) : 8790,
          };
          saveConfig(next);
          notify(`mermaid base_url set: http://${next.host}:${next.port} (applies on next start/restart)`);
          return;
        }
        default:
          notify(`mermaid: unknown subcommand "${cmd}"\n${USAGE}`, "error");
      }
    },
  });
}
