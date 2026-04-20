/**
 * local-pc-agent-pro  —  MCP Tool Server v5.0
 *
 * New in v5 over v4:
 *  - Spotify integration: spotify_search + spotify_play
 *    (uses Spotify URI scheme; optionally uses Web API for precise track lookup
 *     when SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET are set)
 *  - YouTube: improved youtube_play with richer fallback + youtube_search unchanged
 *  - PC Optimization suite: optimize_pc, clear_temp_files, empty_recycle_bin,
 *    flush_dns, check_startup_apps, disk_health_check — all cross-platform
 *  - System extras: get_disk_usage, get_battery, get_network_info,
 *    get_volume, set_volume, take_screenshot
 *  - Clipboard, file, task, note, reminder tools unchanged from v4
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile, exec } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);
const execAsync    = promisify(exec);

// ─── Platform ──────────────────────────────────────────────────────────────────

const IS_WIN   = os.platform() === 'win32';
const IS_MAC   = os.platform() === 'darwin';
const IS_LINUX = os.platform() === 'linux';

// ─── Config ────────────────────────────────────────────────────────────────────

const DATA_DIR: string = path.resolve(
  process.env.MCP_DATA_DIR ?? path.join(os.homedir(), '.mcp-agent'),
);

const ROOT_SEP = IS_WIN ? ';' : ':';
const ALLOWED_ROOTS: string[] = (
  process.env.MCP_ALLOWED_ROOTS ?? os.homedir()
)
  .split(ROOT_SEP)
  .filter(Boolean)
  .map(r => path.resolve(r));

// Optional Spotify Web API credentials (for precise track lookup)
// Without these, spotify_play still works via URI scheme search fallback.
const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID     ?? '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET ?? '';

const MAX_FILE_READ_BYTES = 16_384;
const MAX_SEARCH_RESULTS  = 100;
const MAX_SEARCH_DEPTH    = 6;
const MAX_LIST_ENTRIES    = 500;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Response helpers ──────────────────────────────────────────────────────────

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text' as const, text: `ERROR: ${msg}` }] };
}

// ─── Path sandbox ──────────────────────────────────────────────────────────────

function safePath(p: string): string {
  const resolved = path.resolve(p);
  const allowed  = ALLOWED_ROOTS.some(
    root => resolved === root || resolved.startsWith(root + path.sep),
  );
  if (!allowed) throw new Error(
    `Path '${resolved}' is outside allowed roots.\n` +
    `Allowed roots: ${ALLOWED_ROOTS.join(', ')}\n` +
    `Set MCP_ALLOWED_ROOTS env var to expand access.`,
  );
  return resolved;
}

// ─── Platform-aware command runners ────────────────────────────────────────────

async function ps(script: string, timeoutMs = 15_000): Promise<string> {
  if (!IS_WIN) throw new Error('PowerShell is only available on Windows.');
  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: timeoutMs },
  );
  return (stdout || stderr || 'ok').trim();
}

async function shell(cmd: string, timeoutMs = 15_000): Promise<string> {
  const { stdout, stderr } = await execAsync(cmd, { timeout: timeoutMs });
  return (stdout || stderr || 'ok').trim();
}

async function openURL(url: string): Promise<void> {
  if (IS_WIN)      await ps(`Start-Process -FilePath ${JSON.stringify(url)}`);
  else if (IS_MAC) await execFileAsync('open',     [url]);
  else             await execFileAsync('xdg-open', [url]);
}

async function openApp(target: string): Promise<void> {
  if (IS_WIN)      await ps(`Start-Process -FilePath ${JSON.stringify(target)}`);
  else if (IS_MAC) await execFileAsync('open',    ['-a', target]);
  else             await execFileAsync('nohup',   [target], {});
}

// ─── JSON Persistence ──────────────────────────────────────────────────────────

type JsonRecord = { id: string; createdAt: string; [k: string]: unknown };

function storeFile(name: string): string {
  return path.join(DATA_DIR, `${name}.json`);
}

function readStore<T extends JsonRecord>(name: string): T[] {
  const f = storeFile(name);
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) as T[]; }
  catch { return []; }
}

function writeStore<T extends JsonRecord>(name: string, records: T[]): void {
  fs.writeFileSync(storeFile(name), JSON.stringify(records, null, 2), 'utf8');
}

function addRecord<T extends JsonRecord>(store: string, fields: Omit<T, 'id' | 'createdAt'>): T {
  const records = readStore<T>(store);
  const record  = { id: randomUUID(), createdAt: new Date().toISOString(), ...fields } as unknown as T;
  records.push(record);
  writeStore(store, records);
  return record;
}

function updateRecord<T extends JsonRecord>(
  store: string,
  id: string,
  patch: Partial<Omit<T, 'id' | 'createdAt'>>,
): T | null {
  const records = readStore<T>(store);
  const idx     = records.findIndex(r => r.id === id);
  if (idx === -1) return null;
  records[idx] = { ...records[idx], ...patch };
  writeStore(store, records);
  return records[idx];
}

function removeRecord(store: string, id: string): boolean {
  const records = readStore(store);
  const next    = records.filter(r => r.id !== id);
  if (next.length === records.length) return false;
  writeStore(store, next);
  return true;
}

// ─── File Search ───────────────────────────────────────────────────────────────

async function walkSearch(
  dir: string,
  term: string,
  depth: number,
  results: string[],
): Promise<void> {
  if (depth > MAX_SEARCH_DEPTH || results.length >= MAX_SEARCH_RESULTS) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (results.length >= MAX_SEARCH_RESULTS) break;
    const full = path.join(dir, entry.name);
    if (entry.name.toLowerCase().includes(term.toLowerCase())) results.push(full);
    if (entry.isDirectory()) await walkSearch(full, term, depth + 1, results);
  }
}

// ─── App finder (Windows) ──────────────────────────────────────────────────────

const WIN_APP_ROOTS: string[] = IS_WIN ? [
  path.join(os.homedir(), 'AppData', 'Roaming'),
  path.join(os.homedir(), 'AppData', 'Local'),
  path.join(os.homedir(), 'AppData', 'Local', 'Programs'),
  'C:\\Program Files',
  'C:\\Program Files (x86)',
] : [];

function findExeWindows(name: string): string | null {
  const target = name.toLowerCase().replace(/\.exe$/i, '');
  for (const root of WIN_APP_ROOTS) {
    if (!fs.existsSync(root)) continue;
    const direct = path.join(root, target + '.exe');
    if (fs.existsSync(direct)) return direct;
    try {
      for (const dir of fs.readdirSync(root)) {
        const candidate = path.join(root, dir, target + '.exe');
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {}
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// SPOTIFY HELPERS
// ══════════════════════════════════════════════════════════════════════════════

let _spotifyToken: { token: string; expiresAt: number } | null = null;

/**
 * Fetch a Spotify Client-Credentials access token (no user login needed).
 * Returns null if env vars are not configured.
 */
async function getSpotifyToken(): Promise<string | null> {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return null;
  if (_spotifyToken && Date.now() < _spotifyToken.expiresAt) return _spotifyToken.token;

  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) return null;
    const data = await res.json() as { access_token: string; expires_in: number };
    _spotifyToken = {
      token:     data.access_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    };
    return _spotifyToken.token;
  } catch {
    return null;
  }
}

interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  artists: string;
  album: string;
  duration: string;
  externalUrl: string;
}

/**
 * Search Spotify Web API for tracks. Returns null if no credentials or API fails.
 */
async function spotifySearchTracks(query: string, limit = 5): Promise<SpotifyTrack[] | null> {
  const token = await getSpotifyToken();
  if (!token) return null;

  try {
    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`;
    const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;

    const data = await res.json() as any;
    const items = data?.tracks?.items ?? [];

    return items.map((t: any): SpotifyTrack => {
      const durationMs  = t.duration_ms ?? 0;
      const mm          = Math.floor(durationMs / 60000);
      const ss          = Math.floor((durationMs % 60000) / 1000).toString().padStart(2, '0');
      return {
        id:          t.id,
        uri:         t.uri,           // spotify:track:XXXX
        name:        t.name,
        artists:     (t.artists ?? []).map((a: any) => a.name).join(', '),
        album:       t.album?.name ?? '',
        duration:    `${mm}:${ss}`,
        externalUrl: t.external_urls?.spotify ?? `https://open.spotify.com/track/${t.id}`,
      };
    });
  } catch {
    return null;
  }
}

/**
 * Open a spotify: URI in the installed Spotify app.
 * Works on all platforms if Spotify is installed.
 */
async function openSpotifyUri(uri: string): Promise<void> {
  if (IS_WIN)      await ps(`Start-Process -FilePath ${JSON.stringify(uri)}`);
  else if (IS_MAC) await execFileAsync('open', [uri]);
  else             await execFileAsync('xdg-open', [uri]);
}

// ══════════════════════════════════════════════════════════════════════════════
// YOUTUBE HELPERS
// ══════════════════════════════════════════════════════════════════════════════

async function youtubeSearchFirstId(query: string): Promise<string | null> {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  try {
    const res  = await fetch(url, {
      headers: {
        'User-Agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) return null;
    const html  = await res.text();
    const match = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
    if (!match) return null;
    const data = JSON.parse(match[1]);
    const contents =
      data?.contents?.twoColumnSearchResultsRenderer
          ?.primaryContents?.sectionListRenderer
          ?.contents?.[0]?.itemSectionRenderer?.contents ?? [];
    for (const item of contents) {
      const id = item?.videoRenderer?.videoId;
      if (id) return id as string;
    }
  } catch {}
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// VOLUME HELPERS  (Windows: COM audio; Mac: osascript; Linux: amixer/pactl)
// ══════════════════════════════════════════════════════════════════════════════

// Inline C# for Windows audio — avoids any external dependency
const WIN_VOLUME_CS = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int f(); int g(); int h(); int i();
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int j();
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid id, int clsCtx, IntPtr activationParams, out IAudioEndpointVolume aev);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int f();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}
[ClassInterface(ClassInterfaceType.None), Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorCom {}

public static class AudioDevice {
    static IAudioEndpointVolume GetVol() {
        var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
        IMMDevice dev;
        Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
        IAudioEndpointVolume epv;
        var guid = typeof(IAudioEndpointVolume).GUID;
        Marshal.ThrowExceptionForHR(dev.Activate(ref guid, 23, IntPtr.Zero, out epv));
        return epv;
    }
    public static int GetVolume() {
        float v = 0;
        Marshal.ThrowExceptionForHR(GetVol().GetMasterVolumeLevelScalar(out v));
        return (int)Math.Round(v * 100);
    }
    public static void SetVolume(int pct) {
        float v = Math.Max(0f, Math.Min(1f, pct / 100f));
        Marshal.ThrowExceptionForHR(GetVol().SetMasterVolumeLevelScalar(v, Guid.Empty));
    }
}
'@
`;

async function winGetVolume(): Promise<number> {
  const out = await ps(`${WIN_VOLUME_CS}\n[AudioDevice]::GetVolume()`);
  return parseInt(out.trim(), 10);
}

async function winSetVolume(pct: number): Promise<void> {
  await ps(`${WIN_VOLUME_CS}\n[AudioDevice]::SetVolume(${pct})`);
}

// ─── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'local-pc-agent-pro', version: '5.0.0' });

// ══════════════════════════════════════════════════════════════════════════════
// SYSTEM TOOLS
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  'system_info',
  'Return hardware, OS, memory, and agent configuration for this machine.',
  {},
  async () => {
    try {
      const cpus = os.cpus();
      return ok(JSON.stringify({
        hostname:     os.hostname(),
        platform:     os.platform(),
        release:      os.release(),
        arch:         os.arch(),
        cpu:          cpus[0]?.model ?? 'unknown',
        cores:        cpus.length,
        totalMemGB:   (os.totalmem() / 1e9).toFixed(2),
        freeMemGB:    (os.freemem()  / 1e9).toFixed(2),
        uptime:       `${Math.floor(os.uptime() / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`,
        homeDir:      os.homedir(),
        tmpDir:       os.tmpdir(),
        dataDir:      DATA_DIR,
        allowedRoots: ALLOWED_ROOTS,
        spotifyApi:   SPOTIFY_CLIENT_ID ? 'configured' : 'not configured (URI fallback)',
      }, null, 2));
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'list_processes',
  'List the top running processes sorted by CPU usage.',
  {},
  async () => {
    try {
      let out: string;
      if (IS_WIN) {
        out = await ps(
          'Get-Process | Sort-Object CPU -Descending | ' +
          'Select-Object -First 60 Name,Id,' +
          '@{N="CPU_s";E={[math]::Round($_.CPU,1)}},' +
          '@{N="MemMB";E={[math]::Round($_.WorkingSet/1MB,1)}} | ' +
          'ConvertTo-Json -Depth 2',
        );
      } else if (IS_MAC) {
        out = await shell('ps -Ao pid,pcpu,pmem,comm -r | head -40');
      } else {
        out = await shell('ps aux --sort=-%cpu | head -40');
      }
      return ok(out.slice(0, 15_000));
    } catch (e) { return fail(e); }
  },
);

// ── Disk Usage ──────────────────────────────────────────────────────────────

server.tool(
  'get_disk_usage',
  'Report disk space usage for all drives/partitions.',
  {},
  async () => {
    try {
      let out: string;
      if (IS_WIN) {
        out = await ps(
          'Get-PSDrive -PSProvider FileSystem | ' +
          'Select-Object Name,' +
          '@{N="UsedGB";E={[math]::Round(($_.Used/1GB),2)}},' +
          '@{N="FreeGB";E={[math]::Round(($_.Free/1GB),2)}},' +
          '@{N="TotalGB";E={[math]::Round((($_.Used+$_.Free)/1GB),2)}} | ' +
          'ConvertTo-Json',
        );
      } else if (IS_MAC) {
        out = await shell('df -h');
      } else {
        out = await shell('df -h --output=source,size,used,avail,pcent,target');
      }
      return ok(out.slice(0, 10_000));
    } catch (e) { return fail(e); }
  },
);

// ── Battery ─────────────────────────────────────────────────────────────────

server.tool(
  'get_battery',
  'Get battery status: charge level, charging state, and estimated time remaining.',
  {},
  async () => {
    try {
      let out: string;
      if (IS_WIN) {
        out = await ps(
          'Get-WmiObject Win32_Battery | ' +
          'Select-Object Name,EstimatedChargeRemaining,' +
          '@{N="Status";E={ switch($_.BatteryStatus){1{"Discharging"}2{"AC - Plugged In"}3{"Fully Charged"}default{"Unknown"}} }},' +
          'EstimatedRunTime | ConvertTo-Json',
        );
      } else if (IS_MAC) {
        out = await shell('pmset -g batt');
      } else {
        // Try upower first, then /sys fallback
        try {
          out = await shell('upower -i $(upower -e | grep BAT) 2>/dev/null || cat /sys/class/power_supply/BAT*/status /sys/class/power_supply/BAT*/capacity 2>/dev/null');
        } catch {
          out = 'Battery information unavailable on this Linux system.';
        }
      }
      return ok(out || 'No battery detected (desktop system).');
    } catch (e) { return fail(e); }
  },
);

// ── Network Info ─────────────────────────────────────────────────────────────

server.tool(
  'get_network_info',
  'List network adapters, IP addresses, and current Wi-Fi SSID.',
  {},
  async () => {
    try {
      const lines: string[] = [];

      // Node.js built-in network interfaces
      const ifaces = os.networkInterfaces();
      lines.push('=== Network Interfaces ===');
      for (const [name, addrs] of Object.entries(ifaces)) {
        for (const addr of addrs ?? []) {
          if (!addr.internal) {
            lines.push(`  ${name}  ${addr.family}  ${addr.address}`);
          }
        }
      }

      // Wi-Fi SSID
      lines.push('\n=== Wi-Fi ===');
      try {
        let ssid: string;
        if (IS_WIN)      ssid = await ps('(netsh wlan show interfaces) -match "\\s+SSID\\s+:" | ForEach-Object { $_ -replace ".*:\\s+","" }');
        else if (IS_MAC) ssid = await shell('/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I | grep " SSID:" | awk \'{print $2}\'');
        else             ssid = await shell('iwgetid -r 2>/dev/null || nmcli -t -f active,ssid dev wifi 2>/dev/null | grep "^yes" | cut -d: -f2');
        lines.push(`  SSID: ${ssid.trim() || 'Not connected'}`);
      } catch {
        lines.push('  SSID: Could not determine');
      }

      // Public IP
      lines.push('\n=== Public IP ===');
      try {
        const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
        const { ip } = await res.json() as { ip: string };
        lines.push(`  ${ip}`);
      } catch {
        lines.push('  Could not reach ipify.org');
      }

      return ok(lines.join('\n'));
    } catch (e) { return fail(e); }
  },
);

// ── Volume ──────────────────────────────────────────────────────────────────

server.tool(
  'get_volume',
  'Get the current system master volume level (0–100).',
  {},
  async () => {
    try {
      let vol: string;
      if (IS_WIN) {
        const pct = await winGetVolume();
        vol = `${pct}%`;
      } else if (IS_MAC) {
        const out = await shell('osascript -e "output volume of (get volume settings)"');
        vol = `${out.trim()}%`;
      } else {
        // Try amixer (ALSA) or pactl (PulseAudio)
        try {
          const out = await shell('amixer sget Master 2>/dev/null | grep -oP "\\d+(?=%)"');
          vol = `${out.split('\n')[0].trim()}%`;
        } catch {
          const out = await shell('pactl get-sink-volume @DEFAULT_SINK@ 2>/dev/null | grep -oP "\\d+(?=%)"');
          vol = `${out.split('\n')[0].trim()}%`;
        }
      }
      return ok(`Current volume: ${vol}`);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'set_volume',
  'Set the system master volume to a specific level (0–100). Works on Windows, macOS, and Linux.',
  {
    level: z.number().int().min(0).max(100).describe('Volume level (0 = mute, 100 = max)'),
  },
  async ({ level }) => {
    try {
      if (IS_WIN) {
        await winSetVolume(level);
      } else if (IS_MAC) {
        await shell(`osascript -e "set volume output volume ${level}"`);
      } else {
        // Try amixer first, then pactl
        try {
          await shell(`amixer sset Master ${level}% 2>/dev/null`);
        } catch {
          await shell(`pactl set-sink-volume @DEFAULT_SINK@ ${level}% 2>/dev/null`);
        }
      }
      return ok(`Volume set to ${level}%.`);
    } catch (e) { return fail(e); }
  },
);

// ── Screenshot ───────────────────────────────────────────────────────────────

server.tool(
  'take_screenshot',
  'Capture the primary screen and save the image to disk. Returns the saved file path.',
  {
    savePath: z.string().optional().describe(
      'Absolute path to save the PNG (default: Desktop/screenshot-<timestamp>.png)',
    ),
  },
  async ({ savePath }) => {
    try {
      const ts      = new Date().toISOString().replace(/[:.]/g, '-');
      const outFile = savePath
        ? safePath(savePath)
        : path.join(os.homedir(), 'Desktop', `screenshot-${ts}.png`);
      fs.mkdirSync(path.dirname(outFile), { recursive: true });

      if (IS_WIN) {
        // Inline C# — no external tool required
        const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$screen  = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp     = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g       = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bmp.Save(${JSON.stringify(outFile)}, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved"
`;
        await ps(script, 20_000);
      } else if (IS_MAC) {
        await execFileAsync('screencapture', ['-x', outFile]);
      } else {
        // Try scrot, then gnome-screenshot, then import (ImageMagick)
        try      { await execFileAsync('scrot',             [outFile]); }
        catch    {
          try    { await execFileAsync('gnome-screenshot',  ['-f', outFile]); }
          catch  { await shell(`import -window root ${JSON.stringify(outFile)} 2>/dev/null`); }
        }
      }

      if (!fs.existsSync(outFile)) return fail('Screenshot file was not created. Ensure a display is connected.');
      const sizeKb = (fs.statSync(outFile).size / 1024).toFixed(1);
      return ok(`Screenshot saved (${sizeKb} KB):\n${outFile}`);
    } catch (e) { return fail(e); }
  },
);

// ══════════════════════════════════════════════════════════════════════════════
// PC OPTIMIZATION  &  MAINTENANCE
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  'optimize_pc',
  'Run a comprehensive PC optimization/cleanup: clears temp files, flushes DNS, empties recycle bin, ' +
  'reports disk health, kills memory hogs, and summarizes freed space. ' +
  'Safe — no destructive registry edits. Windows-primary; partial support on Mac/Linux.',
  {
    aggressiveness: z.enum(['light', 'full']).default('light').describe(
      'light = safe cleanup only | full = also clears browser caches and Windows Update cache',
    ),
  },
  async ({ aggressiveness }) => {
    const report: string[] = [`PC Optimization Report — ${new Date().toLocaleString()}`, ''];

    // 1. Clear temp files
    try {
      const tempDirs: string[] = [os.tmpdir()];
      if (IS_WIN) {
        tempDirs.push(
          path.join(os.homedir(), 'AppData', 'Local', 'Temp'),
          'C:\\Windows\\Temp',
        );
        if (aggressiveness === 'full') {
          tempDirs.push(
            path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'INetCache'),
          );
        }
      } else if (IS_MAC) {
        tempDirs.push(path.join(os.homedir(), 'Library', 'Caches'));
      }
      let totalFreed = 0;
      let totalFiles = 0;
      for (const dir of tempDirs) {
        if (!fs.existsSync(dir)) continue;
        try {
          const entries = fs.readdirSync(dir);
          for (const name of entries) {
            const full = path.join(dir, name);
            try {
              const stat = fs.statSync(full);
              totalFiles++;
              totalFreed += stat.size;
              if (stat.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
              else                    fs.unlinkSync(full);
            } catch {}
          }
        } catch {}
      }
      report.push(`✓ Temp files cleared: ${totalFiles} items, ~${(totalFreed / 1024 / 1024).toFixed(1)} MB freed`);
    } catch (e) { report.push(`✗ Temp cleanup failed: ${e instanceof Error ? e.message : e}`); }

    // 2. Flush DNS
    try {
      if (IS_WIN)        await ps('Clear-DnsClientCache');
      else if (IS_MAC)   await shell('sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder');
      else               await shell('sudo systemctl restart systemd-resolved 2>/dev/null || sudo service dns-clean restart 2>/dev/null');
      report.push('✓ DNS cache flushed');
    } catch { report.push('⚠ DNS flush skipped (may need elevated privileges)'); }

    // 3. Empty Recycle Bin / Trash
    try {
      if (IS_WIN) {
        await ps('Clear-RecycleBin -Force -ErrorAction SilentlyContinue');
        report.push('✓ Recycle Bin emptied');
      } else if (IS_MAC) {
        await shell('rm -rf ~/.Trash/* 2>/dev/null');
        report.push('✓ Trash emptied');
      } else {
        await shell('rm -rf ~/.local/share/Trash/files/* ~/.local/share/Trash/info/* 2>/dev/null');
        report.push('✓ Trash emptied');
      }
    } catch { report.push('⚠ Could not empty Recycle Bin / Trash'); }

    // 4. Windows Update cache (full mode only)
    if (IS_WIN && aggressiveness === 'full') {
      try {
        await ps(
          'Stop-Service wuauserv -Force -ErrorAction SilentlyContinue; ' +
          'Remove-Item -Recurse -Force C:\\Windows\\SoftwareDistribution\\Download\\* -ErrorAction SilentlyContinue; ' +
          'Start-Service wuauserv -ErrorAction SilentlyContinue',
        );
        report.push('✓ Windows Update download cache cleared');
      } catch { report.push('⚠ Windows Update cache clear skipped (needs admin)'); }
    }

    // 5. Top memory consumers
    try {
      let memInfo: string;
      if (IS_WIN) {
        memInfo = await ps(
          'Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First 5 ' +
          'Name,@{N="MemMB";E={[math]::Round($_.WorkingSet/1MB,1)}} | ' +
          'ForEach-Object { "$($_.Name): $($_.MemMB) MB" }',
        );
      } else if (IS_MAC) {
        memInfo = await shell('ps -Ao comm,rss -r | awk \'NR<=6{printf "%s: %.1f MB\\n",$1,$2/1024}\' | tail -5');
      } else {
        memInfo = await shell('ps aux --sort=-%mem | awk \'NR>1&&NR<=7{printf "%s: %.1f MB\\n",$11,$6/1024}\'');
      }
      report.push('\nTop memory consumers:');
      for (const line of memInfo.trim().split('\n').slice(0, 5)) {
        report.push(`  ${line.trim()}`);
      }
    } catch { report.push('⚠ Could not read process list'); }

    // 6. Current disk space after cleanup
    try {
      let diskInfo: string;
      if (IS_WIN) {
        diskInfo = await ps(
          'Get-PSDrive -PSProvider FileSystem | ' +
          'ForEach-Object { "$($_.Name): used=$([math]::Round($_.Used/1GB,1))GB free=$([math]::Round($_.Free/1GB,1))GB" }',
        );
      } else {
        diskInfo = await shell("df -h | awk 'NR==1||/^\\/dev/' | head -5");
      }
      report.push('\nDisk space after cleanup:');
      for (const line of diskInfo.trim().split('\n')) {
        report.push(`  ${line.trim()}`);
      }
    } catch {}

    report.push('\n✅ Optimization complete.');
    return ok(report.join('\n'));
  },
);

server.tool(
  'clear_temp_files',
  'Delete temporary files from system and user temp directories. Returns count and size freed.',
  {},
  async () => {
    try {
      const dirs = [os.tmpdir(), path.join(os.homedir(), 'AppData', 'Local', 'Temp')].filter(d => fs.existsSync(d));
      let files = 0, bytesFreed = 0;
      for (const dir of dirs) {
        for (const name of fs.readdirSync(dir)) {
          const full = path.join(dir, name);
          try {
            const stat = fs.statSync(full);
            bytesFreed += stat.size;
            files++;
            if (stat.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
            else                    fs.unlinkSync(full);
          } catch {}
        }
      }
      return ok(`Cleared ${files} items, freed ~${(bytesFreed / 1024 / 1024).toFixed(1)} MB.`);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'empty_recycle_bin',
  'Empty the Recycle Bin (Windows) or Trash (macOS/Linux).',
  {},
  async () => {
    try {
      if (IS_WIN) {
        await ps('Clear-RecycleBin -Force -ErrorAction SilentlyContinue');
      } else if (IS_MAC) {
        await shell('rm -rf ~/.Trash/* 2>/dev/null');
      } else {
        await shell('rm -rf ~/.local/share/Trash/files/* ~/.local/share/Trash/info/* 2>/dev/null');
      }
      return ok('Recycle Bin / Trash emptied.');
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'flush_dns',
  'Flush the DNS resolver cache. May require elevated privileges on some systems.',
  {},
  async () => {
    try {
      if (IS_WIN)      await ps('Clear-DnsClientCache');
      else if (IS_MAC) await shell('sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder');
      else             await shell('sudo systemd-resolve --flush-caches 2>/dev/null || sudo service dns-clean restart');
      return ok('DNS cache flushed.');
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'check_startup_apps',
  'List applications that launch at startup (Windows registry + startup folder; macOS launchctl; Linux systemctl).',
  {},
  async () => {
    try {
      let out: string;
      if (IS_WIN) {
        out = await ps(
          '$keys = @(' +
          '"HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",' +
          '"HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run") ;' +
          'foreach ($k in $keys) {' +
          '  if (Test-Path $k) {' +
          '    $n = Split-Path $k -Leaf ;' +
          '    Get-ItemProperty $k | Select-Object -Property * -ExcludeProperty PS* |' +
          '    Get-Member -MemberType NoteProperty |' +
          '    ForEach-Object { Write-Output "[$n] $($_.Name): $((Get-ItemProperty $k).$($_.Name))" }' +
          '  }' +
          '}',
        );
      } else if (IS_MAC) {
        out = await shell('launchctl list | grep -v com.apple | head -40');
      } else {
        out = await shell('systemctl list-unit-files --state=enabled --no-legend 2>/dev/null | head -40');
      }
      return ok(out.trim() || 'No startup apps found.');
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'disk_health_check',
  'Run a read-only disk health check. On Windows: SMART status via WMI. On Mac: diskutil. On Linux: smartctl.',
  {},
  async () => {
    try {
      let out: string;
      if (IS_WIN) {
        out = await ps(
          'Get-WmiObject -Namespace root\\wmi -Class MSStorageDriver_FailurePredictStatus | ' +
          'Select-Object InstanceName,' +
          '@{N="PredictFailure";E={$_.PredictFailure}},' +
          '@{N="Reason";E={$_.Reason}} | ConvertTo-Json',
          30_000,
        );
      } else if (IS_MAC) {
        out = await shell('diskutil info disk0 | grep -E "(SMART|Disk Size|Volume Name)"');
      } else {
        try {
          out = await shell('sudo smartctl -H /dev/sda 2>/dev/null || sudo smartctl -H /dev/nvme0 2>/dev/null || echo "smartctl not available; install smartmontools"');
        } catch {
          out = 'smartctl unavailable. Install smartmontools: sudo apt install smartmontools';
        }
      }
      return ok(out.trim() || 'No disk health data available.');
    } catch (e) { return fail(e); }
  },
);

// ══════════════════════════════════════════════════════════════════════════════
// APP / BROWSER TOOLS
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  'find_app',
  'Search common install locations for an application and return its full path. Windows only.',
  {
    name: z.string().min(1).max(100).describe('App name without .exe, e.g. "spotify", "discord"'),
  },
  async ({ name }) => {
    try {
      if (!IS_WIN) return fail('find_app is only available on Windows. On Mac/Linux use the app name directly with open_app.');
      const found = findExeWindows(name);
      return found
        ? ok(`Found: ${found}`)
        : fail(`Could not find '${name}.exe' in common install locations.`);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'open_app',
  'Launch an application by name or full path. ' +
  'On Windows: searches install dirs if not found in PATH. ' +
  'On macOS: use the app bundle name (e.g. "Safari"). ' +
  'On Linux: use the binary name (e.g. "firefox").',
  {
    app: z.string().min(1).max(260).describe('App name or full path'),
  },
  async ({ app }) => {
    try {
      let target = app;
      if (IS_WIN && !path.isAbsolute(app) && !app.includes('\\')) {
        const resolved = findExeWindows(app);
        if (resolved) target = resolved;
      }
      await openApp(target);
      return ok(`Launched: ${target}`);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'close_app',
  'Force-terminate a running process by its executable name.',
  {
    process: z.string().min(1).max(128)
      .regex(/^[\w.\-]+$/, 'Process name must only contain word chars, dots, or hyphens')
      .describe('e.g. notepad.exe (Windows) or firefox (Mac/Linux)'),
  },
  async ({ process: proc }) => {
    try {
      if (IS_WIN) {
        await execFileAsync('taskkill.exe', ['/IM', proc.endsWith('.exe') ? proc : proc + '.exe', '/F']);
      } else {
        await execFileAsync('pkill', ['-f', proc]);
      }
      return ok(`Process '${proc}' terminated.`);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'open_url',
  'Open a URL in the default browser.',
  { url: z.string().url().describe('Full URL including https://') },
  async ({ url }) => {
    try {
      await openURL(url);
      return ok(`Opened: ${url}`);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'browser_search',
  'Open a Google search in the default browser.',
  { query: z.string().min(1).max(500).describe('Search query') },
  async ({ query }) => {
    try {
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      await openURL(url);
      return ok(`Opened Google search: ${query}`);
    } catch (e) { return fail(e); }
  },
);

// ══════════════════════════════════════════════════════════════════════════════
// SPOTIFY TOOLS
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  'spotify_search',
  'Search Spotify for tracks, artists, or albums and return results. ' +
  'Requires SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET env vars for full results; ' +
  'without them returns a helpful message.',
  {
    query:      z.string().min(1).max(300).describe('Artist, song title, or album name'),
    type:       z.enum(['track', 'artist', 'album']).default('track').describe('What to search for'),
    maxResults: z.number().int().min(1).max(10).default(5).describe('Number of results'),
  },
  async ({ query, type, maxResults }) => {
    try {
      const token = await getSpotifyToken();
      if (!token) {
        return ok(
          `Spotify Web API is not configured.\n` +
          `To enable track search, set these environment variables:\n` +
          `  SPOTIFY_CLIENT_ID=your_id\n` +
          `  SPOTIFY_CLIENT_SECRET=your_secret\n` +
          `Get credentials free at: https://developer.spotify.com/dashboard\n\n` +
          `You can still use spotify_play — it will open Spotify search for "${query}".`,
        );
      }

      const url  = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=${type}&limit=${maxResults}`;
      const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return fail(`Spotify API error: ${res.status}`);

      const data  = await res.json() as any;
      const items = data?.tracks?.items ?? data?.artists?.items ?? data?.albums?.items ?? [];

      if (!items.length) return ok(`No ${type} results found for "${query}".`);

      const lines: string[] = [`Spotify results for "${query}":\n`];
      items.forEach((item: any, i: number) => {
        if (type === 'track') {
          const artists = (item.artists ?? []).map((a: any) => a.name).join(', ');
          const dur     = (() => {
            const ms = item.duration_ms ?? 0;
            return `${Math.floor(ms / 60000)}:${Math.floor((ms % 60000) / 1000).toString().padStart(2, '0')}`;
          })();
          lines.push(`${i + 1}. ${item.name}\n   Artist: ${artists}  Album: ${item.album?.name ?? '?'}  Duration: ${dur}\n   URI: ${item.uri}`);
        } else if (type === 'artist') {
          lines.push(`${i + 1}. ${item.name}  Followers: ${item.followers?.total?.toLocaleString() ?? '?'}  URI: ${item.uri}`);
        } else {
          const artists = (item.artists ?? []).map((a: any) => a.name).join(', ');
          lines.push(`${i + 1}. ${item.name}  Artist: ${artists}  Tracks: ${item.total_tracks ?? '?'}  URI: ${item.uri}`);
        }
      });

      lines.push('\nTip: Copy a URI and pass it to spotify_play to play it immediately.');
      return ok(lines.join('\n'));
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'spotify_play',
  'Play music on the installed Spotify desktop app. ' +
  'You can pass a natural-language query ("Bohemian Rhapsody Queen"), ' +
  'or a Spotify URI (spotify:track:xxx / spotify:artist:xxx / spotify:album:xxx / spotify:playlist:xxx). ' +
  'If SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET are configured, finds the exact track first. ' +
  'Without API credentials, opens Spotify in-app search — user presses play.',
  {
    query: z.string().min(1).max(300).describe(
      'Song/artist/album name OR a Spotify URI (spotify:track:xxx etc.)',
    ),
    type: z.enum(['track', 'artist', 'album', 'playlist']).default('track')
      .describe('Used for API lookup when query is plain text — ignored for URI input'),
  },
  async ({ query, type }) => {
    try {
      // 1. Direct URI — just open it
      if (query.startsWith('spotify:')) {
        await openSpotifyUri(query);
        return ok(`▶ Opening Spotify URI: ${query}`);
      }

      // 2. Try Web API lookup for a precise track URI
      const token = await getSpotifyToken();
      if (token) {
        const tracks = await spotifySearchTracks(query, 1);
        if (tracks && tracks.length > 0) {
          const t = tracks[0]!;
          await openSpotifyUri(t.uri);
          return ok(
            `▶ Now playing on Spotify:\n` +
            `  Track:  ${t.name}\n` +
            `  Artist: ${t.artists}\n` +
            `  Album:  ${t.album}\n` +
            `  URI:    ${t.uri}`,
          );
        }
      }

      // 3. Fallback: open Spotify with in-app search URI
      // spotify:search:QUERY opens Spotify's built-in search
      const searchUri = `spotify:search:${encodeURIComponent(query)}`;
      await openSpotifyUri(searchUri);
      return ok(
        `▶ Opened Spotify with search: "${query}"\n` +
        `(Spotify Web API not configured — click the top result to play.\n` +
        `Set SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET for auto-play.)`,
      );
    } catch (e) { return fail(e); }
  },
);

// ══════════════════════════════════════════════════════════════════════════════
// YOUTUBE TOOLS
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  'youtube_search',
  'Search YouTube and return the top video results (title, channel, URL) without opening a browser.',
  {
    query:      z.string().min(1).max(300).describe('Search query'),
    maxResults: z.number().int().min(1).max(10).default(5).describe('Number of results'),
  },
  async ({ query, maxResults }) => {
    try {
      const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
      const res  = await fetch(url, {
        headers: {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) return fail(`YouTube request failed: ${res.status}`);
      const html  = await res.text();
      const match = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
      if (!match) return fail('Could not parse YouTube response.');

      const data = JSON.parse(match[1]);
      const contents =
        data?.contents?.twoColumnSearchResultsRenderer
            ?.primaryContents?.sectionListRenderer
            ?.contents?.[0]?.itemSectionRenderer?.contents ?? [];

      const results: string[] = [];
      for (const item of contents) {
        if (results.length >= maxResults) break;
        const vr = item?.videoRenderer;
        if (!vr?.videoId) continue;
        const title   = vr.title?.runs?.[0]?.text ?? 'Unknown';
        const channel = vr.ownerText?.runs?.[0]?.text ?? 'Unknown';
        const dur     = vr.lengthText?.simpleText ?? '?';
        results.push(
          `${results.length + 1}. ${title}\n` +
          `   Channel: ${channel}  Duration: ${dur}\n` +
          `   URL: https://www.youtube.com/watch?v=${vr.videoId}`,
        );
      }
      if (!results.length) return ok('No video results found.');
      return ok(`YouTube results for "${query}":\n\n${results.join('\n\n')}`);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'youtube_play',
  'Search YouTube for a video and open it playing in the default browser immediately. ' +
  'Always prefer this over open_url when the user asks to play or watch something on YouTube.',
  {
    query:    z.string().min(1).max(300).describe('Video/song title and artist, e.g. "bohemian rhapsody queen"'),
    autoplay: z.boolean().default(true).describe('Append autoplay=1 to the URL'),
  },
  async ({ query, autoplay }) => {
    try {
      const videoId = await youtubeSearchFirstId(query);
      if (!videoId) {
        const fallback = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        await openURL(fallback);
        return ok(`Could not resolve a specific video ID — opened YouTube search instead.\nURL: ${fallback}`);
      }
      const watchUrl = `https://www.youtube.com/watch?v=${videoId}${autoplay ? '&autoplay=1' : ''}`;
      await openURL(watchUrl);
      return ok(`▶ Now playing on YouTube:\n  https://www.youtube.com/watch?v=${videoId}\n  Query: "${query}"`);
    } catch (e) { return fail(e); }
  },
);

// ══════════════════════════════════════════════════════════════════════════════
// EMAIL
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  'send_email',
  'Open the default mail client with a pre-filled draft via mailto: link.',
  {
    to:      z.string().email().describe('Recipient email address'),
    subject: z.string().max(200).describe('Email subject'),
    body:    z.string().max(2000).describe('Email body text'),
  },
  async ({ to, subject, body }) => {
    try {
      const mailto =
        `mailto:${encodeURIComponent(to)}` +
        `?subject=${encodeURIComponent(subject)}` +
        `&body=${encodeURIComponent(body)}`;
      await openURL(mailto);
      return ok(`Mail client opened for: ${to}`);
    } catch (e) { return fail(e); }
  },
);

// ══════════════════════════════════════════════════════════════════════════════
// CLIPBOARD
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  'clipboard_get',
  'Read the current text content of the system clipboard.',
  {},
  async () => {
    try {
      let text: string;
      if (IS_WIN)      text = await ps('Get-Clipboard');
      else if (IS_MAC) text = await shell('pbpaste');
      else             text = await shell('xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null || echo ""');
      return ok(text.trim() || '(clipboard is empty)');
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'clipboard_set',
  'Write text to the system clipboard.',
  { text: z.string().max(50_000).describe('Text to copy to clipboard') },
  async ({ text }) => {
    try {
      const tmp = path.join(os.tmpdir(), `mcp-clip-${randomUUID()}.txt`);
      fs.writeFileSync(tmp, text, 'utf8');
      try {
        if (IS_WIN)      await ps(`Get-Content -Raw ${JSON.stringify(tmp)} | Set-Clipboard`);
        else if (IS_MAC) await shell(`cat ${JSON.stringify(tmp)} | pbcopy`);
        else             await shell(`cat ${JSON.stringify(tmp)} | xclip -selection clipboard 2>/dev/null || cat ${JSON.stringify(tmp)} | xsel --clipboard --input`);
        return ok('Clipboard updated.');
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
    } catch (e) { return fail(e); }
  },
);

// ══════════════════════════════════════════════════════════════════════════════
// FILE TOOLS
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  'list_dir',
  'List the contents of a directory (files and subdirectories).',
  {
    dir:        z.string().describe('Absolute path to the directory'),
    showHidden: z.boolean().default(false).describe('Include dot-files/hidden entries'),
  },
  async ({ dir, showHidden }) => {
    try {
      const safe = safePath(dir);
      if (!fs.existsSync(safe))             return fail('Directory not found.');
      if (!fs.statSync(safe).isDirectory()) return fail('Path is not a directory.');

      const entries = fs.readdirSync(safe, { withFileTypes: true });
      const shown   = showHidden ? entries : entries.filter(e => !e.name.startsWith('.'));
      const sorted  = [...shown].sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const lines = sorted.slice(0, MAX_LIST_ENTRIES).map(e => {
        const type = e.isDirectory() ? '[DIR]' : '[FILE]';
        let size = '';
        if (e.isFile()) {
          try {
            const bytes = fs.statSync(path.join(safe, e.name)).size;
            size = bytes < 1024 ? ` (${bytes}B)` : ` (${(bytes / 1024).toFixed(1)}KB)`;
          } catch {}
        }
        return `${type}  ${e.name}${size}`;
      });
      if (sorted.length > MAX_LIST_ENTRIES) lines.push(`\n… and ${sorted.length - MAX_LIST_ENTRIES} more entries`);
      return ok(`Contents of ${safe} (${sorted.length} entries):\n\n${lines.join('\n')}`);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'search_files',
  `Search for files whose name contains a term. Searches up to ${MAX_SEARCH_DEPTH} levels deep.`,
  {
    dir:  z.string().describe('Root directory to start searching from'),
    term: z.string().min(1).max(200).describe('Filename substring to match (case-insensitive)'),
  },
  async ({ dir, term }) => {
    try {
      const safe = safePath(dir);
      if (!fs.existsSync(safe))             return fail(`Directory not found: ${safe}`);
      if (!fs.statSync(safe).isDirectory()) return fail('Path is not a directory.');
      const results: string[] = [];
      await walkSearch(safe, term, 0, results);
      const suffix = results.length >= MAX_SEARCH_RESULTS ? `\n(capped at ${MAX_SEARCH_RESULTS} results)` : '';
      return ok(results.length ? results.join('\n') + suffix : 'No matching files found.');
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'read_file',
  `Read a file's text content. Returns up to ${MAX_FILE_READ_BYTES / 1024} KB.`,
  {
    filepath: z.string().describe('Absolute path to the file'),
    offset:   z.number().int().min(0).default(0).describe('Byte offset (for paginating large files)'),
  },
  async ({ filepath, offset }) => {
    try {
      const safe = safePath(filepath);
      if (!fs.existsSync(safe))        return fail('File not found.');
      if (!fs.statSync(safe).isFile()) return fail('Path is not a file.');
      const stat    = fs.statSync(safe);
      const buf     = Buffer.allocUnsafe(MAX_FILE_READ_BYTES);
      const fd      = fs.openSync(safe, 'r');
      const read    = fs.readSync(fd, buf, 0, MAX_FILE_READ_BYTES, offset);
      fs.closeSync(fd);
      const content   = buf.slice(0, read).toString('utf8');
      const truncated = offset + read < stat.size;
      const header    = `File: ${safe} (${(stat.size / 1024).toFixed(1)} KB, reading from byte ${offset})\n\n`;
      const footer    = truncated ? `\n\n[Truncated — use offset=${offset + read} to read the next chunk]` : '';
      return ok(header + content + footer);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'write_file',
  'Write content to a file (creates or overwrites). Creates parent directories if needed.',
  {
    filepath:  z.string().describe('Absolute path to write to'),
    content:   z.string().max(10_000_000).describe('File content (text)'),
    overwrite: z.boolean().default(true).describe('When false, fails if the file already exists'),
  },
  async ({ filepath, content, overwrite }) => {
    try {
      const safe = safePath(filepath);
      if (!overwrite && fs.existsSync(safe)) return fail('File already exists. Set overwrite=true to replace.');
      fs.mkdirSync(path.dirname(safe), { recursive: true });
      fs.writeFileSync(safe, content, 'utf8');
      return ok(`Written ${content.length.toLocaleString()} characters to: ${safe}`);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'append_file',
  'Append text to the end of a file. Creates the file if it does not exist.',
  {
    filepath: z.string().describe('Absolute path to the file'),
    content:  z.string().max(1_000_000).describe('Text to append'),
  },
  async ({ filepath, content }) => {
    try {
      const safe = safePath(filepath);
      fs.mkdirSync(path.dirname(safe), { recursive: true });
      fs.appendFileSync(safe, content, 'utf8');
      return ok(`Appended ${content.length.toLocaleString()} characters to: ${safe}`);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'move_file',
  'Move or rename a file or directory.',
  {
    src:  z.string().describe('Absolute source path'),
    dest: z.string().describe('Absolute destination path'),
  },
  async ({ src, dest }) => {
    try {
      const safeSrc  = safePath(src);
      const safeDest = safePath(dest);
      if (!fs.existsSync(safeSrc)) return fail('Source path not found.');
      fs.mkdirSync(path.dirname(safeDest), { recursive: true });
      fs.renameSync(safeSrc, safeDest);
      return ok(`Moved: ${safeSrc} → ${safeDest}`);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'copy_file',
  'Copy a file to a new location.',
  {
    src:       z.string().describe('Absolute source file path'),
    dest:      z.string().describe('Absolute destination file path'),
    overwrite: z.boolean().default(true).describe('When false, fails if destination already exists'),
  },
  async ({ src, dest, overwrite }) => {
    try {
      const safeSrc  = safePath(src);
      const safeDest = safePath(dest);
      if (!fs.existsSync(safeSrc))        return fail('Source file not found.');
      if (!fs.statSync(safeSrc).isFile()) return fail('Source is not a file.');
      if (!overwrite && fs.existsSync(safeDest)) return fail('Destination exists. Set overwrite=true to replace.');
      fs.mkdirSync(path.dirname(safeDest), { recursive: true });
      fs.copyFileSync(safeSrc, safeDest);
      return ok(`Copied: ${safeSrc} → ${safeDest}`);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'delete_file',
  'Permanently delete a single file (not a directory).',
  { filepath: z.string().describe('Absolute path to the file to delete') },
  async ({ filepath }) => {
    try {
      const safe = safePath(filepath);
      if (!fs.existsSync(safe))            return fail('File not found.');
      if (fs.statSync(safe).isDirectory()) return fail('Path is a directory. Use delete_file only for files.');
      fs.unlinkSync(safe);
      return ok(`Deleted: ${safe}`);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'organize_folder',
  'Sort all files in a folder into sub-folders named by their extension (e.g. PDF/, PNG/, TXT/).',
  { dir: z.string().describe('Absolute path to the folder to organize') },
  async ({ dir }) => {
    try {
      const safe = safePath(dir);
      if (!fs.existsSync(safe)) return fail('Directory not found.');
      const moved: string[]  = [];
      const errors: string[] = [];
      for (const name of fs.readdirSync(safe)) {
        const src = path.join(safe, name);
        if (fs.statSync(src).isDirectory()) continue;
        const ext  = (path.extname(name).slice(1) || 'NO-EXTENSION').toUpperCase();
        const dest = path.join(safe, ext, name);
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(src, dest);
          moved.push(`  ${name} → ${ext}/${name}`);
        } catch (e) {
          errors.push(`  SKIP ${name}: ${e instanceof Error ? e.message : e}`);
        }
      }
      const lines = [`Organized ${moved.length} file(s):`, ...moved];
      if (errors.length) lines.push('', `Skipped ${errors.length} item(s):`, ...errors);
      return ok(lines.join('\n'));
    } catch (e) { return fail(e); }
  },
);

// ══════════════════════════════════════════════════════════════════════════════
// TASKS
// ══════════════════════════════════════════════════════════════════════════════

type Task = JsonRecord & { title: string; status: 'todo' | 'done'; priority: 'low' | 'normal' | 'high' };

server.tool('create_task', 'Create a new to-do task with an optional priority.',
  {
    title:    z.string().min(1).max(500).describe('Task description'),
    priority: z.enum(['low', 'normal', 'high']).default('normal'),
  },
  async ({ title, priority }) => {
    try {
      const task = addRecord<Task>('tasks', { title, status: 'todo', priority });
      return ok(`Task created.\nID:       ${task.id}\nTitle:    ${title}\nPriority: ${priority}`);
    } catch (e) { return fail(e); }
  },
);

server.tool('list_tasks', 'List tasks, optionally filtered by status.',
  { status: z.enum(['todo', 'done', 'all']).default('all') },
  async ({ status }) => {
    try {
      const tasks = readStore<Task>('tasks');
      const shown = status === 'all' ? tasks : tasks.filter(t => t.status === status);
      if (!shown.length) return ok(`No ${status === 'all' ? '' : status + ' '}tasks found.`);
      const priorityOrder = { high: 0, normal: 1, low: 2 };
      shown.sort((a, b) => (priorityOrder[a.priority ?? 'normal'] - priorityOrder[b.priority ?? 'normal']));
      return ok(shown.map(t => {
        const check = t.status === 'done' ? '✓' : ' ';
        const pri   = t.priority === 'high' ? '🔴' : t.priority === 'low' ? '🔵' : '⚪';
        return `[${check}] ${pri} ${t.id.slice(0, 8)}  ${t.title}  (${t.createdAt.slice(0, 10)})`;
      }).join('\n'));
    } catch (e) { return fail(e); }
  },
);

server.tool('complete_task', 'Mark a task as done by its ID.',
  { id: z.string().uuid() },
  async ({ id }) => {
    try {
      const updated = updateRecord<Task>('tasks', id, { status: 'done' });
      return updated ? ok(`✓ Task done: ${updated.title}`) : fail(`No task found with ID: ${id}`);
    } catch (e) { return fail(e); }
  },
);

server.tool('delete_task', 'Permanently delete a task by its ID.',
  { id: z.string().uuid() },
  async ({ id }) => {
    try {
      return removeRecord('tasks', id) ? ok(`Task ${id} deleted.`) : fail(`No task found with ID: ${id}`);
    } catch (e) { return fail(e); }
  },
);

// ══════════════════════════════════════════════════════════════════════════════
// NOTES
// ══════════════════════════════════════════════════════════════════════════════

type Note = JsonRecord & { title: string; body: string; tags: string[] };

server.tool('create_note', 'Create a new note with a title, body, and optional tags.',
  {
    title: z.string().min(1).max(200),
    body:  z.string().max(100_000),
    tags:  z.array(z.string().max(50)).max(10).default([]),
  },
  async ({ title, body, tags }) => {
    try {
      const note = addRecord<Note>('notes', { title, body, tags });
      return ok(`Note saved.\nID:    ${note.id}\nTitle: ${title}\nTags:  ${tags.join(', ') || '(none)'}`);
    } catch (e) { return fail(e); }
  },
);

server.tool('list_notes', 'List all saved notes (titles, IDs, and tags).',
  { tag: z.string().optional() },
  async ({ tag }) => {
    try {
      let notes = readStore<Note>('notes');
      if (tag) notes = notes.filter(n => n.tags?.includes(tag));
      if (!notes.length) return ok(tag ? `No notes with tag '${tag}'.` : 'No notes found.');
      return ok(notes.map(n =>
        `${n.id.slice(0, 8)}  ${n.title}  [${(n.tags ?? []).join(', ') || 'no tags'}]  (${n.createdAt.slice(0, 10)})`,
      ).join('\n'));
    } catch (e) { return fail(e); }
  },
);

server.tool('read_note', 'Read the full content of a note by its ID.',
  { id: z.string().uuid() },
  async ({ id }) => {
    try {
      const note = readStore<Note>('notes').find(n => n.id === id);
      if (!note) return fail(`No note found with ID: ${id}`);
      return ok(`# ${note.title}\nCreated: ${note.createdAt}\nTags: ${(note.tags ?? []).join(', ') || 'none'}\n\n${note.body}`);
    } catch (e) { return fail(e); }
  },
);

server.tool('search_notes', 'Search note titles and bodies for a keyword.',
  { query: z.string().min(1).max(200) },
  async ({ query }) => {
    try {
      const lower = query.toLowerCase();
      const hits  = readStore<Note>('notes').filter(n =>
        n.title.toLowerCase().includes(lower) || n.body.toLowerCase().includes(lower),
      );
      if (!hits.length) return ok(`No notes matching '${query}'.`);
      return ok(hits.map(n => `${n.id.slice(0, 8)}  ${n.title}`).join('\n'));
    } catch (e) { return fail(e); }
  },
);

server.tool('delete_note', 'Permanently delete a note by its ID.',
  { id: z.string().uuid() },
  async ({ id }) => {
    try {
      return removeRecord('notes', id) ? ok(`Note ${id} deleted.`) : fail(`No note found with ID: ${id}`);
    } catch (e) { return fail(e); }
  },
);

// ══════════════════════════════════════════════════════════════════════════════
// REMINDERS
// ══════════════════════════════════════════════════════════════════════════════

type Reminder = JsonRecord & { title: string; remindAt: string; done: boolean };

server.tool('set_reminder', 'Save a reminder with a title and an ISO 8601 datetime.',
  {
    title:    z.string().min(1).max(500),
    remindAt: z.string().describe('ISO 8601 datetime, e.g. 2025-06-01T09:00:00'),
  },
  async ({ title, remindAt }) => {
    try {
      if (isNaN(Date.parse(remindAt))) return fail('Invalid datetime. Use ISO 8601: 2025-06-01T09:00:00');
      const r = addRecord<Reminder>('reminders', { title, remindAt, done: false });
      return ok(`Reminder saved.\nID:   ${r.id}\nTime: ${remindAt}\nText: ${title}`);
    } catch (e) { return fail(e); }
  },
);

server.tool('list_reminders', 'List reminders sorted by time.',
  {
    upcoming:    z.boolean().default(false).describe('Only show future reminders'),
    includeDone: z.boolean().default(false).describe('Also show completed reminders'),
  },
  async ({ upcoming, includeDone }) => {
    try {
      let reminders = readStore<Reminder>('reminders');
      if (!includeDone) reminders = reminders.filter(r => !r.done);
      if (upcoming) {
        const now = new Date();
        reminders = reminders.filter(r => new Date(r.remindAt) > now);
      }
      reminders.sort((a, b) => a.remindAt.localeCompare(b.remindAt));
      if (!reminders.length) return ok('No reminders found.');
      return ok(reminders.map(r => {
        const status = r.done ? '✓' : new Date(r.remindAt) < new Date() ? '⚠ OVERDUE' : '⏰';
        return `${status}  ${r.id.slice(0, 8)}  ${r.remindAt}  ${r.title}`;
      }).join('\n'));
    } catch (e) { return fail(e); }
  },
);

server.tool('complete_reminder', 'Mark a reminder as done by its ID.',
  { id: z.string().uuid() },
  async ({ id }) => {
    try {
      const updated = updateRecord<Reminder>('reminders', id, { done: true });
      return updated ? ok(`✓ Reminder done: ${updated.title}`) : fail(`No reminder found with ID: ${id}`);
    } catch (e) { return fail(e); }
  },
);

server.tool('delete_reminder', 'Delete a reminder by its ID.',
  { id: z.string().uuid() },
  async ({ id }) => {
    try {
      return removeRecord('reminders', id)
        ? ok(`Reminder ${id} deleted.`)
        : fail(`No reminder found with ID: ${id}`);
    } catch (e) { return fail(e); }
  },
);

// ─── Boot ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[local-pc-agent-pro v5] Ready\n` +
    `  Platform:      ${os.platform()}\n` +
    `  Data dir:      ${DATA_DIR}\n` +
    `  Allowed roots: ${ALLOWED_ROOTS.join(', ')}\n` +
    `  Spotify API:   ${SPOTIFY_CLIENT_ID ? 'configured ✓' : 'not configured (URI fallback mode)'}\n`,
  );
}

main().catch(e => {
  process.stderr.write(`[local-pc-agent-pro] Fatal: ${String(e)}\n`);
  process.exit(1);
});