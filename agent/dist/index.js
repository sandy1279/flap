/**
 * local-mcp-agent  —  Agent Orchestrator v5.0
 *
 * New in v5 over v4:
 *  - Multi-server MCP: connect to N servers via MCP_SERVERS env (JSON array)
 *    Falls back to single MCP_SERVER_PATH for backward compat.
 *  - Tool name collision namespacing ("server__tool") across multiple servers
 *  - Persistent HTTP sessions with TTL auto-cleanup (pass session_id in body)
 *  - Fixed CLI: maintains full conversation history across all turns
 *  - SSE streaming endpoint (/chat/stream): real-time tool-call events
 *  - Parallel tool execution when assistant calls multiple tools in one turn
 *  - Retry + exponential backoff for transient Ollama failures
 *  - Async write-queued logger — no blocking I/O on hot path
 *  - Graceful shutdown: drains in-flight HTTP requests, closes MCP connections
 *  - CORS headers for browser clients
 *  - /health → live server + tool status
 *  - /tools  → full tool list with source server
 *  - /sessions → active session list
 *  - Config validated at startup — fails fast with helpful messages
 */
import fs from "fs";
import os from "os";
import http from "http";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function parseServerConfigs() {
    if (process.env.MCP_SERVERS) {
        let parsed;
        try {
            parsed = JSON.parse(process.env.MCP_SERVERS);
        }
        catch {
            throw new Error("MCP_SERVERS must be valid JSON. Example:\n  '[{\"name\":\"local\",\"command\":\"node\",\"args\":[\"./tools/dist/index.js\"]}]'");
        }
        if (!Array.isArray(parsed) || parsed.length === 0)
            throw new Error("MCP_SERVERS must be a non-empty JSON array.");
        for (const s of parsed) {
            if (!s.name || !s.command || !Array.isArray(s.args))
                throw new Error(`Each MCP server entry needs name, command, args. Got: ${JSON.stringify(s)}`);
        }
        return parsed;
    }
    // Backward-compat: single server via MCP_SERVER_PATH
    const serverPath = process.env.MCP_SERVER_PATH
        ?? path.join(__dirname, "..", "..", "tools", "dist", "index.js");
    return [{ name: "local", command: "node", args: [serverPath] }];
}
const CONFIG = {
    MODEL: process.env.OLLAMA_MODEL ?? "llama3.1:latest",
    ENDPOINT: (process.env.OLLAMA_ENDPOINT ?? "http://127.0.0.1:11434").replace(/\/$/, ""),
    MAX_LOOPS: Number(process.env.MAX_TOOL_LOOPS ?? 10),
    TIMEOUT: Number(process.env.OLLAMA_TIMEOUT ?? 120_000),
    TOOL_TIMEOUT: Number(process.env.TOOL_TIMEOUT ?? 60_000),
    PORT: Number(process.env.AGENT_PORT ?? 8787),
    LOG_DIR: process.env.LOG_DIR ?? "./logs",
    SESSION_TTL: Number(process.env.SESSION_TTL_MS ?? 30 * 60 * 1000), // 30 min
    MAX_RETRIES: Number(process.env.OLLAMA_MAX_RETRIES ?? 3),
    SERVERS: parseServerConfigs(),
};
if (!fs.existsSync(CONFIG.LOG_DIR))
    fs.mkdirSync(CONFIG.LOG_DIR, { recursive: true });
/* ══════════════════════════════════════════════════════════════════════════ */
/* ASYNC LOGGER                                                               */
/* ══════════════════════════════════════════════════════════════════════════ */
class AsyncLogger {
    queue = [];
    busy = false;
    fd;
    constructor(logFile) {
        this.fd = fs.openSync(logFile, "a");
    }
    schedule() {
        if (this.busy || this.queue.length === 0)
            return;
        this.busy = true;
        const chunk = Buffer.from(this.queue.splice(0).join(os.EOL) + os.EOL);
        fs.write(this.fd, chunk, () => {
            this.busy = false;
            this.schedule();
        });
    }
    write(level, message, meta) {
        this.queue.push(JSON.stringify({
            ts: new Date().toISOString(), level, message, meta: meta ?? null,
        }));
        this.schedule();
        const icon = level === "ERROR" ? "❌" :
            level === "WARN" ? "⚠️" :
                level === "TOOL" ? "⚙️" : "ℹ️";
        process.stdout.write(`${icon} [${level}] ${message}\n`);
    }
    info = (m, meta) => this.write("INFO", m, meta);
    warn = (m, meta) => this.write("WARN", m, meta);
    error = (m, meta) => this.write("ERROR", m, meta);
    tool = (m, meta) => this.write("TOOL", m, meta);
    flush() {
        if (this.queue.length > 0) {
            fs.writeSync(this.fd, this.queue.splice(0).join(os.EOL) + os.EOL);
        }
        fs.closeSync(this.fd);
    }
}
const LOG_FILE = path.join(CONFIG.LOG_DIR, `agent-${new Date().toISOString().slice(0, 10)}.log`);
const logger = new AsyncLogger(LOG_FILE);
/* ══════════════════════════════════════════════════════════════════════════ */
/* SYSTEM PROMPT                                                              */
/* ══════════════════════════════════════════════════════════════════════════ */
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ??
    `You are a local desktop AI assistant with access to tools.

RULES:
- Always use the most appropriate tool when the user asks to perform an action.
- Never guess missing parameters — ask for only what is missing.
- After calling tools, give a concise, natural-language summary of what was done.
- Be fast, direct, and genuinely useful.`;
/* ══════════════════════════════════════════════════════════════════════════ */
/* HELPERS                                                                    */
/* ══════════════════════════════════════════════════════════════════════════ */
function uid() { return crypto.randomUUID(); }
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
function withTimeout(p, ms, label) {
    return Promise.race([
        p,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label} (${ms}ms)`)), ms)),
    ]);
}
function mcpToOllamaTool(t, ollamaName) {
    const schema = (t.inputSchema ?? { type: "object", properties: {} });
    return {
        type: "function",
        function: {
            name: ollamaName,
            description: t.description ?? ollamaName,
            parameters: {
                type: schema.type ?? "object",
                properties: schema.properties ?? {},
                required: schema.required ?? [],
            },
        },
    };
}
/* ══════════════════════════════════════════════════════════════════════════ */
/* OLLAMA CLIENT  (with retry + backoff)                                      */
/* ══════════════════════════════════════════════════════════════════════════ */
async function ollamaChat(messages, tools) {
    let lastErr;
    for (let attempt = 0; attempt < CONFIG.MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            const backoff = 500 * 2 ** (attempt - 1); // 500 ms, 1 s, 2 s …
            logger.warn(`Ollama retry ${attempt}/${CONFIG.MAX_RETRIES - 1} in ${backoff}ms`);
            await sleep(backoff);
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CONFIG.TIMEOUT);
        try {
            const res = await fetch(`${CONFIG.ENDPOINT}/api/chat`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                signal: controller.signal,
                body: JSON.stringify({
                    model: CONFIG.MODEL,
                    messages,
                    tools,
                    stream: false,
                    options: { temperature: 0.1 },
                }),
            });
            clearTimeout(timer);
            if (!res.ok)
                throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
            const data = await res.json();
            return data.message;
        }
        catch (err) {
            clearTimeout(timer);
            lastErr = err;
            // Don't retry on abort (our own timeout)
            if (err?.name === "AbortError")
                break;
        }
    }
    throw lastErr;
}
function buildToolRegistry(conns) {
    // Count collisions first — both instances get prefixed, not just the second
    const counts = new Map();
    for (const c of conns)
        for (const t of c.tools)
            counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    const registry = new Map();
    for (const conn of conns) {
        for (const tool of conn.tools) {
            const collides = (counts.get(tool.name) ?? 0) > 1;
            const ollamaName = collides ? `${conn.config.name}__${tool.name}` : tool.name;
            registry.set(ollamaName, {
                ollamaName,
                mcpName: tool.name,
                serverName: conn.config.name,
                client: conn.client,
                schema: mcpToOllamaTool(tool, ollamaName),
            });
        }
    }
    if (registry.size === 0)
        logger.warn("No tools were loaded from any MCP server.");
    return registry;
}
class SessionStore {
    ttlMs;
    store = new Map();
    timer;
    constructor(ttlMs) {
        this.ttlMs = ttlMs;
        this.timer = setInterval(() => this.evict(), 5 * 60_000).unref();
    }
    getOrCreate(id) {
        let s = this.store.get(id);
        if (!s) {
            s = { id, history: [], createdAt: Date.now(), lastActive: Date.now() };
            this.store.set(id, s);
        }
        else {
            s.lastActive = Date.now();
        }
        return s;
    }
    get(id) {
        const s = this.store.get(id);
        if (s)
            s.lastActive = Date.now();
        return s;
    }
    delete(id) { return this.store.delete(id); }
    list() {
        return [...this.store.values()].map(s => ({
            id: s.id,
            createdAt: new Date(s.createdAt).toISOString(),
            lastActive: new Date(s.lastActive).toISOString(),
            turns: s.history.filter(m => m.role === "user").length,
        }));
    }
    evict() {
        const cutoff = Date.now() - this.ttlMs;
        for (const [id, s] of this.store)
            if (s.lastActive < cutoff) {
                this.store.delete(id);
                logger.info(`Session evicted: ${id}`);
            }
    }
    destroy() { clearInterval(this.timer); }
}
const sessions = new SessionStore(CONFIG.SESSION_TTL);
/* ══════════════════════════════════════════════════════════════════════════ */
/* AGENT LOOP                                                                 */
/* ══════════════════════════════════════════════════════════════════════════ */
/**
 * Run one user turn through the agent loop.
 *
 * @param registry   The global tool registry
 * @param history    Mutable conversation history (MODIFIED IN PLACE — includes system prompt)
 * @param input      The user's message for this turn
 * @param onEvent    Optional callback for real-time events (SSE / CLI progress)
 */
async function runTurn(registry, history, input, onEvent) {
    const ollamaTools = [...registry.values()].map(r => r.schema);
    const trace = [];
    history.push({ role: "user", content: input });
    for (let loop = 0; loop < CONFIG.MAX_LOOPS; loop++) {
        let assistant;
        try {
            assistant = await ollamaChat(history, ollamaTools);
        }
        catch (err) {
            const msg = `Ollama error: ${err instanceof Error ? err.message : String(err)}`;
            onEvent?.({ type: "error", message: msg });
            return { reply: msg, trace };
        }
        history.push(assistant);
        // ── No tool calls → final reply ───────────────────────────────────────
        if (!assistant.tool_calls?.length) {
            const reply = assistant.content?.trim() ?? "";
            onEvent?.({ type: "reply", content: reply });
            onEvent?.({ type: "done", trace });
            return { reply, trace };
        }
        // ── Execute all tool calls in parallel ────────────────────────────────
        const toolCalls = assistant.tool_calls;
        const results = await Promise.allSettled(toolCalls.map(async (tc) => {
            const toolName = tc.function.name;
            const args = tc.function.arguments ?? {};
            const reg = registry.get(toolName);
            trace.push(`${toolName} ${JSON.stringify(args)}`);
            logger.tool(toolName, args);
            onEvent?.({ type: "tool_start", tool: toolName, args });
            const t0 = Date.now();
            if (!reg) {
                const err = `Tool '${toolName}' not found in registry.`;
                onEvent?.({ type: "tool_done", tool: toolName, result: err, elapsedMs: 0 });
                return { toolName, result: err };
            }
            let resultText;
            try {
                const raw = await withTimeout(reg.client.callTool({ name: reg.mcpName, arguments: args }), CONFIG.TOOL_TIMEOUT, toolName);
                const block = raw.content[0];
                resultText = block?.text ?? JSON.stringify(raw.content);
            }
            catch (err) {
                resultText = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
            }
            const elapsed = Date.now() - t0;
            onEvent?.({ type: "tool_done", tool: toolName, result: resultText, elapsedMs: elapsed });
            return { toolName, result: resultText };
        }));
        // Push each tool result into history
        for (const r of results) {
            const text = r.status === "fulfilled"
                ? r.value.result
                : `ERROR: ${r.reason?.message ?? r.reason}`;
            history.push({ role: "tool", content: text });
        }
    }
    const reply = "Max tool iterations reached. Please try rephrasing your request.";
    onEvent?.({ type: "reply", content: reply });
    onEvent?.({ type: "done", trace });
    return { reply, trace };
}
/* ══════════════════════════════════════════════════════════════════════════ */
/* HTTP SERVER                                                                */
/* ══════════════════════════════════════════════════════════════════════════ */
function buildHttpServer(registry, connections) {
    let inFlight = 0;
    // ── CORS / common headers ────────────────────────────────────────────────
    function setCors(res) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    function json(res, code, body) {
        setCors(res);
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body, null, 2));
    }
    // ── Body reader ───────────────────────────────────────────────────────────
    async function readBody(req) {
        let raw = "";
        for await (const chunk of req)
            raw += chunk;
        return JSON.parse(raw);
    }
    // ── Request router ────────────────────────────────────────────────────────
    const server = http.createServer(async (req, res) => {
        const rid = uid();
        setCors(res);
        // Pre-flight
        if (req.method === "OPTIONS") {
            res.writeHead(204).end();
            return;
        }
        inFlight++;
        try {
            await route(req, res, rid);
        }
        catch (err) {
            logger.error(`Unhandled error in request ${rid}`, err);
            if (!res.headersSent)
                json(res, 500, { error: "Internal server error", requestId: rid });
        }
        finally {
            inFlight--;
        }
    });
    async function route(req, res, rid) {
        const url = req.url ?? "/";
        const method = req.method ?? "GET";
        // ── GET /health ──────────────────────────────────────────────────────
        if (method === "GET" && url === "/health") {
            return json(res, 200, {
                status: "ok",
                model: CONFIG.MODEL,
                endpoint: CONFIG.ENDPOINT,
                servers: connections.map(c => ({ name: c.config.name, tools: c.tools.length })),
                totalTools: registry.size,
                sessions: sessions.list().length,
                uptime: `${Math.floor(process.uptime())}s`,
            });
        }
        // ── GET /tools ───────────────────────────────────────────────────────
        if (method === "GET" && url === "/tools") {
            return json(res, 200, {
                count: registry.size,
                tools: [...registry.values()].map(t => ({
                    name: t.ollamaName,
                    mcpName: t.mcpName,
                    server: t.serverName,
                    description: t.schema.function.description,
                })),
            });
        }
        // ── GET /sessions ────────────────────────────────────────────────────
        if (method === "GET" && url === "/sessions") {
            return json(res, 200, { sessions: sessions.list() });
        }
        // ── DELETE /sessions/:id ─────────────────────────────────────────────
        const deleteMatch = url.match(/^\/sessions\/([^/]+)$/);
        if (method === "DELETE" && deleteMatch) {
            const id = deleteMatch[1];
            return sessions.delete(id)
                ? json(res, 200, { deleted: id })
                : json(res, 404, { error: `Session '${id}' not found` });
        }
        // ── POST /chat  (blocking) ────────────────────────────────────────────
        if (method === "POST" && url === "/chat") {
            let body;
            try {
                body = await readBody(req);
            }
            catch {
                return json(res, 400, { error: "Invalid JSON body" });
            }
            const input = String(body.message ?? "").trim();
            if (!input)
                return json(res, 400, { error: "Missing 'message' field" });
            const sessionId = String(body.session_id ?? uid());
            const session = sessions.getOrCreate(sessionId);
            // Inject system prompt on first turn
            if (session.history.length === 0)
                session.history.push({ role: "system", content: SYSTEM_PROMPT });
            logger.info(`[${rid}] POST /chat session=${sessionId}`);
            const result = await runTurn(registry, session.history, input);
            return json(res, 200, {
                requestId: rid,
                sessionId,
                model: CONFIG.MODEL,
                reply: result.reply,
                trace: result.trace,
            });
        }
        // ── POST /chat/stream  (SSE) ──────────────────────────────────────────
        if (method === "POST" && url === "/chat/stream") {
            let body;
            try {
                body = await readBody(req);
            }
            catch {
                return json(res, 400, { error: "Invalid JSON body" });
            }
            const input = String(body.message ?? "").trim();
            if (!input)
                return json(res, 400, { error: "Missing 'message' field" });
            const sessionId = String(body.session_id ?? uid());
            const session = sessions.getOrCreate(sessionId);
            if (session.history.length === 0)
                session.history.push({ role: "system", content: SYSTEM_PROMPT });
            logger.info(`[${rid}] POST /chat/stream session=${sessionId}`);
            // Set SSE headers before any await so the client knows it's streaming
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                "connection": "keep-alive",
                "access-control-allow-origin": "*",
            });
            function emit(event) {
                if (res.destroyed)
                    return;
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
            emit({ type: "tool_start", tool: "__start__", args: { requestId: rid, sessionId } });
            await runTurn(registry, session.history, input, emit);
            if (!res.destroyed)
                res.end();
            return;
        }
        // ── 404 ───────────────────────────────────────────────────────────────
        json(res, 404, { error: `No route for ${method} ${url}` });
    }
    // ── Graceful shutdown ─────────────────────────────────────────────────────
    async function shutdown() {
        logger.info("Shutdown signal received — draining in-flight requests...");
        server.close();
        const deadline = Date.now() + 10_000;
        while (inFlight > 0 && Date.now() < deadline)
            await sleep(100);
        if (inFlight > 0)
            logger.warn(`Force-closing with ${inFlight} request(s) still active`);
        sessions.destroy();
        for (const c of connections) {
            try {
                await c.client.close();
            }
            catch { /* ignore */ }
        }
        logger.info("Shutdown complete.");
        logger.flush();
        process.exit(0);
    }
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    return server;
}
/* ══════════════════════════════════════════════════════════════════════════ */
/* CLI MODE                                                                   */
/* ══════════════════════════════════════════════════════════════════════════ */
async function runCLI(registry) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Persistent history across all CLI turns
    const history = [{ role: "system", content: SYSTEM_PROMPT }];
    console.log(`\n🤖  local-mcp-agent v5 — ${registry.size} tools loaded`);
    console.log(`    Model: ${CONFIG.MODEL}   Type "exit" to quit.\n`);
    for (;;) {
        const input = await new Promise(r => rl.question("You: ", r));
        if (input.trim().toLowerCase() === "exit")
            break;
        if (!input.trim())
            continue;
        // Print tool events inline so the user sees live progress
        const result = await runTurn(registry, history, input, event => {
            if (event.type === "tool_start" && event.tool !== "__start__")
                process.stdout.write(`  ⚙️  Calling: ${event.tool}\n`);
            if (event.type === "tool_done")
                process.stdout.write(`  ✓  ${event.tool} (${event.elapsedMs}ms)\n`);
        });
        console.log(`\nAgent: ${result.reply}\n`);
    }
    rl.close();
}
/* ══════════════════════════════════════════════════════════════════════════ */
/* MAIN                                                                       */
/* ══════════════════════════════════════════════════════════════════════════ */
async function main() {
    logger.info("local-mcp-agent v5 starting");
    logger.info(`Model: ${CONFIG.MODEL}  Endpoint: ${CONFIG.ENDPOINT}`);
    logger.info(`Connecting to ${CONFIG.SERVERS.length} MCP server(s)...`);
    // ── Connect to all MCP servers in parallel ────────────────────────────────
    const connections = await Promise.all(CONFIG.SERVERS.map(async (cfg) => {
        const transport = new StdioClientTransport({
            command: cfg.command,
            args: cfg.args,
            env: cfg.env,
        });
        const client = new Client({ name: "local-mcp-agent", version: "5.0.0" }, { capabilities: {} });
        try {
            await withTimeout(client.connect(transport), 15_000, `Connect to MCP server '${cfg.name}'`);
        }
        catch (err) {
            throw new Error(`Failed to connect to MCP server '${cfg.name}': ${err instanceof Error ? err.message : err}`);
        }
        let rawTools = [];
        try {
            const res = await withTimeout(client.listTools(), 10_000, `listTools on '${cfg.name}'`);
            rawTools = res.tools;
        }
        catch (err) {
            logger.warn(`Could not list tools for server '${cfg.name}': ${err instanceof Error ? err.message : err}`);
        }
        logger.info(`Connected to '${cfg.name}' — ${rawTools.length} tool(s)`);
        return { config: cfg, client, tools: rawTools };
    }));
    // ── Build unified tool registry ───────────────────────────────────────────
    const registry = buildToolRegistry(connections);
    logger.info(`Tool registry ready — ${registry.size} tool(s) total`);
    // ── Start HTTP server ─────────────────────────────────────────────────────
    const httpServer = buildHttpServer(registry, connections);
    httpServer.listen(CONFIG.PORT, () => {
        logger.info(`HTTP API listening on :${CONFIG.PORT}`);
        logger.info(`  GET  /health          → status check`);
        logger.info(`  GET  /tools           → list all tools`);
        logger.info(`  GET  /sessions        → list active sessions`);
        logger.info(`  POST /chat            → blocking chat`);
        logger.info(`  POST /chat/stream     → SSE streaming chat`);
        logger.info(`  DELETE /sessions/:id  → clear a session`);
    });
    // ── CLI (runs alongside HTTP — only active when stdin is a TTY) ───────────
    if (process.stdin.isTTY) {
        await runCLI(registry);
        // CLI exited cleanly — trigger graceful shutdown
        process.kill(process.pid, "SIGTERM");
    }
}
/* ══════════════════════════════════════════════════════════════════════════ */
/* BOOT                                                                       */
/* ══════════════════════════════════════════════════════════════════════════ */
main().catch(err => {
    logger.error("Fatal startup failure", err instanceof Error ? err.message : err);
    logger.flush();
    process.exit(1);
});
