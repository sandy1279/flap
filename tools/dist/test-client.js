/**
 * test-client.ts
 * Spawns the MCP server as a child process and runs every tool through
 * the real MCP protocol over stdio. No mocks — genuine end-to-end.
 *
 * Run:  npx ts-node --esm test-client.ts
 *   or: node --loader ts-node/esm test-client.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, 'dist', 'index.js');
// ─── Colour helpers ───────────────────────────────────────────────────────────
const G = (s) => `\x1b[32m${s}\x1b[0m`; // green
const R = (s) => `\x1b[31m${s}\x1b[0m`; // red
const Y = (s) => `\x1b[33m${s}\x1b[0m`; // yellow
const B = (s) => `\x1b[34m${s}\x1b[0m`; // blue
const DIM = (s) => `\x1b[2m${s}\x1b[0m`; // dim
// ─── Result tracking ─────────────────────────────────────────────────────────
const results = [];
function pass(name, note = '') {
    results.push({ name, passed: true, note });
    console.log(`  ${G('✓')} ${name}${note ? DIM('  → ' + note) : ''}`);
}
function fail(name, reason) {
    results.push({ name, passed: false, note: reason });
    console.log(`  ${R('✗')} ${name}  ${R(reason)}`);
}
function section(title) {
    console.log(`\n${B('▸')} ${title}`);
}
// ─── Call helper ──────────────────────────────────────────────────────────────
async function call(client, tool, args = {}) {
    const res = await client.callTool({ name: tool, arguments: args });
    const block = res.content[0];
    if (!block || block.type !== 'text')
        throw new Error('Unexpected response shape');
    return block.text;
}
/**
 * Like call(), but never throws — MCP protocol errors (e.g. -32602 Zod
 * validation failures) are caught and returned as "ERROR: <message>" strings
 * so assertFails() can treat them uniformly with tool-level errors.
 */
async function tryCall(client, tool, args = {}) {
    try {
        return await call(client, tool, args);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `ERROR: ${msg}`;
    }
}
/** Assert the response does NOT start with "ERROR:" */
function assertOk(name, text, snippet) {
    if (text.startsWith('ERROR:')) {
        fail(name, text);
    }
    else if (snippet && !text.includes(snippet)) {
        fail(name, `Expected "${snippet}" in: ${text.slice(0, 120)}`);
    }
    else {
        pass(name, text.slice(0, 80).replace(/\n/g, ' '));
    }
}
/** Assert the response indicates a failure — accepts both tool-level "ERROR:"
 *  responses and MCP protocol errors like "-32602 Input validation error". */
function assertFails(name, text) {
    const isFailure = text.startsWith('ERROR:') ||
        text.includes('error') ||
        text.includes('Error') ||
        text.includes('-32602') ||
        text.includes('No ') && text.includes('found');
    if (isFailure) {
        pass(name, text.slice(0, 80).replace(/\n/g, ' '));
    }
    else {
        fail(name, `Expected an error but got: ${text.slice(0, 80)}`);
    }
}
// ─── Tests ────────────────────────────────────────────────────────────────────
async function runTests(client) {
    // ── List tools ──────────────────────────────────────────────────────────────
    section('MCP Metadata');
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    console.log(`  ${DIM('Registered tools: ')}${names.join(', ')}`);
    if (names.length >= 20)
        pass('tool count', `${names.length} tools registered`);
    else
        fail('tool count', `Only ${names.length} tools found — server may not have started correctly`);
    // ── System ──────────────────────────────────────────────────────────────────
    section('System tools');
    let text = await call(client, 'system_info');
    assertOk('system_info — returns JSON', text, os.hostname());
    text = await call(client, 'list_processes');
    assertOk('list_processes — returns process list', text);
    // lock_pc is deliberately skipped in automated tests to avoid locking the screen
    text = await call(client, 'open_app', { app: 'notepad.exe' });
    assertOk('open_app — launches notepad', text, 'Launched');
    // Give notepad a moment, then kill it
    await new Promise(r => setTimeout(r, 1500));
    text = await call(client, 'close_app', { process: 'notepad.exe' });
    assertOk('close_app — terminates notepad', text, 'terminated');
    // Reject bad process name (path separators / special chars)
    text = await tryCall(client, 'close_app', { process: 'bad/name$.exe' });
    assertFails('close_app — rejects invalid process name', text);
    // ── Spotify ───────────────────────────────────────────────────────────────
    section('Spotify — find, open, and play');
    // 1. find_app should locate Spotify.exe in AppData
    text = await call(client, 'find_app', { name: 'spotify' });
    const spotifyFound = !text.startsWith('ERROR:');
    if (spotifyFound) {
        pass('find_app — located Spotify', text.slice(0, 100));
    }
    else {
        console.log(`  ${Y('⚠')} find_app — Spotify not found in common locations (${text.slice(0, 60)})`);
        console.log(`  ${DIM('  Skipping Spotify open/play tests.')}`);
    }
    if (spotifyFound) {
        // 2. open_app with plain name — should auto-resolve and launch
        text = await call(client, 'open_app', { app: 'spotify' });
        assertOk('open_app — auto-resolves and launches Spotify', text, 'Launched');
        // Give Spotify time to start before sending a URI
        console.log(`  ${DIM('  Waiting 4s for Spotify to start...')}`);
        await new Promise(r => setTimeout(r, 4000));
        // 3. Play "The Real Slim Shady" via Spotify URI scheme.
        //    spotify:search:<query> opens Spotify's search — works without knowing the track ID.
        //    For a direct play, use the known track URI:
        //    spotify:track:3zi5cABRdRfS8Z8Wf8kvUy  (The Real Slim Shady — Eminem, The Marshall Mathers LP)
        text = await call(client, 'open_url', { url: 'spotify:track:3zi5cABRdRfS8Z8Wf8kvUy' });
        assertOk('open_url — sends Real Slim Shady track URI to Spotify', text, 'Opened');
        // 4. Verify Spotify is actually running after all this
        await new Promise(r => setTimeout(r, 1500));
        const procs = await call(client, 'list_processes');
        if (procs.toLowerCase().includes('spotify')) {
            pass('list_processes — confirms Spotify process is running');
        }
        else {
            fail('list_processes — Spotify process not detected', 'Spotify may have failed to start');
        }
        // 5. close Spotify when done
        text = await call(client, 'close_app', { process: 'Spotify.exe' });
        assertOk('close_app — closes Spotify after test', text, 'terminated');
    }
    // ── Web ─────────────────────────────────────────────────────────────────────
    section('Web / communication tools');
    text = await call(client, 'open_url', { url: 'https://example.com' });
    assertOk('open_url — valid URL', text, 'Opened');
    text = await call(client, 'browser_search', { query: 'MCP server test' });
    assertOk('browser_search — opens search', text, 'opened');
    text = await call(client, 'send_email', {
        to: 'test@example.com',
        subject: 'Hello',
        body: 'Test email from MCP client',
    });
    assertOk('send_email — opens mail client', text, 'Mail client');
    // ── Clipboard ────────────────────────────────────────────────────────────────
    section('Clipboard tools');
    const clipContent = `mcp-test-${Date.now()}`;
    text = await call(client, 'clipboard_set', { text: clipContent });
    assertOk('clipboard_set — writes to clipboard', text, 'updated');
    text = await call(client, 'clipboard_get');
    assertOk('clipboard_get — reads back correct value', text, clipContent);
    // ── File tools ───────────────────────────────────────────────────────────────
    section('File tools');
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `mcp-test-${Date.now()}.txt`);
    const content = 'Hello from MCP server test!\nLine two.';
    // write_file
    text = await call(client, 'write_file', { filepath: tmpFile, content });
    assertOk('write_file — creates file', text, 'Written');
    // write_file overwrite=false should fail on existing file
    text = await tryCall(client, 'write_file', { filepath: tmpFile, content: 'oops', overwrite: false });
    assertFails('write_file — rejects overwrite=false on existing file', text);
    // read_file
    text = await call(client, 'read_file', { filepath: tmpFile });
    assertOk('read_file — returns file content', text, 'Hello from MCP server test');
    // search_files
    text = await call(client, 'search_files', { dir: tmpDir, term: 'mcp-test-' });
    assertOk('search_files — finds written file', text, 'mcp-test-');
    // path traversal — must be blocked
    text = await call(client, 'read_file', { filepath: 'C:\\Windows\\System32\\drivers\\etc\\hosts' });
    // This passes if allowed roots include C:\Windows, but on a default install it should fail
    // We test a clearly outside path instead:
    text = await tryCall(client, 'read_file', { filepath: '\\\\server\\share\\secret.txt' });
    assertFails('read_file — blocks UNC path outside allowed roots', text);
    // delete_file
    text = await call(client, 'delete_file', { filepath: tmpFile });
    assertOk('delete_file — deletes the file', text, 'Deleted');
    // delete again → should fail
    text = await tryCall(client, 'delete_file', { filepath: tmpFile });
    assertFails('delete_file — fails on already-deleted file', text);
    // organize_folder: create a scratch dir, populate it, organize
    const scratchDir = path.join(tmpDir, `mcp-scratch-${Date.now()}`);
    // Create the dir and files via write_file
    await call(client, 'write_file', { filepath: path.join(scratchDir, 'a.txt'), content: 'a' });
    await call(client, 'write_file', { filepath: path.join(scratchDir, 'b.txt'), content: 'b' });
    await call(client, 'write_file', { filepath: path.join(scratchDir, 'c.png'), content: 'img' });
    text = await call(client, 'organize_folder', { dir: scratchDir });
    assertOk('organize_folder — moves files into extension sub-folders', text, 'Organized');
    // ── Tasks ────────────────────────────────────────────────────────────────────
    section('Task tools');
    text = await call(client, 'create_task', { title: 'Test task from MCP client' });
    assertOk('create_task — creates task', text, 'Task created');
    const taskId = text.match(/ID:\s+([0-9a-f-]{36})/i)?.[1] ?? '';
    if (!taskId)
        fail('create_task — could not parse task ID', text);
    else
        pass('create_task — ID parsed', taskId);
    text = await call(client, 'list_tasks', { status: 'todo' });
    assertOk('list_tasks todo — shows new task', text, 'Test task from MCP client');
    text = await call(client, 'complete_task', { id: taskId });
    assertOk('complete_task — marks task done', text, 'done');
    text = await call(client, 'list_tasks', { status: 'done' });
    assertOk('list_tasks done — shows completed task', text, 'Test task from MCP client');
    text = await call(client, 'delete_task', { id: taskId });
    assertOk('delete_task — removes task', text, 'deleted');
    text = await tryCall(client, 'delete_task', { id: taskId });
    assertFails('delete_task — fails on already-deleted task', text);
    // ── Notes ────────────────────────────────────────────────────────────────────
    section('Note tools');
    text = await call(client, 'create_note', { title: 'Test note', body: 'Body of the test note.' });
    assertOk('create_note — creates note', text, 'Note saved');
    const noteId = text.match(/ID:\s+([0-9a-f-]{36})/i)?.[1] ?? '';
    if (!noteId)
        fail('create_note — could not parse note ID', text);
    else
        pass('create_note — ID parsed', noteId);
    text = await call(client, 'list_notes');
    assertOk('list_notes — shows note', text, 'Test note');
    text = await call(client, 'read_note', { id: noteId });
    assertOk('read_note — returns body', text, 'Body of the test note');
    text = await tryCall(client, 'read_note', { id: '00000000-0000-0000-0000-000000000000' });
    assertFails('read_note — fails on unknown ID', text);
    text = await call(client, 'delete_note', { id: noteId });
    assertOk('delete_note — removes note', text, 'deleted');
    // ── Reminders ────────────────────────────────────────────────────────────────
    section('Reminder tools');
    const future = new Date(Date.now() + 86_400_000).toISOString(); // tomorrow
    text = await call(client, 'set_reminder', { title: 'Test reminder', remindAt: future });
    assertOk('set_reminder — creates reminder', text, 'Reminder saved');
    const remId = text.match(/ID:\s+([0-9a-f-]{36})/i)?.[1] ?? '';
    if (!remId)
        fail('set_reminder — could not parse ID', text);
    else
        pass('set_reminder — ID parsed', remId);
    text = await tryCall(client, 'set_reminder', { title: 'Bad date', remindAt: 'not-a-date' });
    assertFails('set_reminder — rejects invalid datetime', text);
    text = await call(client, 'list_reminders', { upcoming: true });
    assertOk('list_reminders upcoming — shows future reminder', text, 'Test reminder');
    text = await call(client, 'delete_reminder', { id: remId });
    assertOk('delete_reminder — removes reminder', text, 'deleted');
    text = await call(client, 'list_reminders', { upcoming: false });
    // may be empty now — just check it doesn't error
    assertOk('list_reminders — returns after deletion', text);
}
// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log(B('\n╔══════════════════════════════════════════╗'));
    console.log(B('║   local-pc-agent-pro  end-to-end tests   ║'));
    console.log(B('╚══════════════════════════════════════════╝\n'));
    const transport = new StdioClientTransport({
        command: 'node',
        args: [SERVER_PATH],
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    console.log(DIM(`Spawning server: node ${SERVER_PATH}\n`));
    try {
        await client.connect(transport);
        await runTests(client);
    }
    catch (e) {
        console.error(R(`\nUnhandled error: ${e}`));
    }
    finally {
        await client.close();
    }
    // ── Summary ────────────────────────────────────────────────────────────────
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const total = results.length;
    console.log('\n' + B('─'.repeat(50)));
    console.log(`  Total:  ${total}`);
    console.log(`  ${G('Passed')}: ${passed}`);
    if (failed > 0) {
        console.log(`  ${R('Failed')}: ${failed}`);
        console.log(R('\nFailed tests:'));
        results.filter(r => !r.passed).forEach(r => console.log(`  ${R('✗')} ${r.name}\n    ${DIM(r.note)}`));
    }
    console.log(B('─'.repeat(50)));
    console.log(failed === 0
        ? G('\n  All tests passed ✓\n')
        : Y(`\n  ${failed} test(s) failed — see above\n`));
    process.exit(failed > 0 ? 1 : 0);
}
main();
//# sourceMappingURL=test-client.js.map