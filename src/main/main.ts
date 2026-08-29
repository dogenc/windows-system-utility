/**
 * SystemUtilitybyDGKN@Labs – Main-Prozess
 *
 * Der Main-Prozess ist der EINZIGE Ort, an dem `fs`, `path`, `shell` und
 * `child_process` laufen. Der Renderer bekommt niemals ein Node-Modul,
 * sondern ausschliesslich die schmale, getypte API aus `preload.ts`.
 *
 * Sicherheitsmodell:
 *  1. Der Renderer sendet nur IDs (`user-temp`), nie rohe Pfade.
 *  2. Jeder Loeschpfad muss innerhalb eines registrierten Ziels liegen (Allowlist).
 *  3. Eine Blockliste schuetzt System- und Nutzerordner zusaetzlich.
 *  4. Das Zielverzeichnis selbst wird nie geloescht, nur sein Inhalt.
 */

import { app, BrowserWindow, ipcMain, shell, dialog, clipboard, Menu, nativeTheme } from 'electron';
import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { IPC } from '../shared/channels';

const execFileAsync = promisify(execFile);
const IS_DEV = process.argv.includes('--dev');
const IS_WINDOWS = process.platform === 'win32';

/* ------------------------------------------------------------------ *
 * 1. Pfad-Aufloesung
 * ------------------------------------------------------------------ */

/** Liest eine Umgebungsvariable und faellt auf einen Standardwert zurueck. */
function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : fallback;
}

const HOME = os.homedir();
const SYSTEM_ROOT = env('SystemRoot', env('windir', 'C:\\Windows'));
const LOCAL_APPDATA = env('LOCALAPPDATA', path.join(HOME, 'AppData', 'Local'));
const ROAMING_APPDATA = env('APPDATA', path.join(HOME, 'AppData', 'Roaming'));
const USER_TEMP = env('TEMP', env('TMP', path.join(LOCAL_APPDATA, 'Temp')));

/* ------------------------------------------------------------------ *
 * 2. Bereinigungsziele (Allowlist)
 * ------------------------------------------------------------------ */

type TargetDefinition = Omit<CleanTargetInfo, 'exists'>;

const CLEAN_TARGETS: readonly TargetDefinition[] = [
  {
    id: 'user-temp',
    label: 'Benutzer-Temp (%TEMP%)',
    path: USER_TEMP,
    info:
      'Temporaere Dateien von Anwendungen. Das Loeschen ist unbedenklich, ' +
      'aktive Dateien werden automatisch uebersprungen.',
    recommended: true,
    requiresAdmin: false,
  },
  {
    id: 'windows-temp',
    label: 'System-Temp (C:\\Windows\\Temp)',
    path: path.join(SYSTEM_ROOT, 'Temp'),
    info:
      'Ablage fuer temporaere Dateien von Systemdiensten und Installern. ' +
      'Ohne Administratorrechte bleiben viele Eintraege gesperrt – die App ' +
      'ueberspringt sie dann einfach.',
    recommended: true,
    requiresAdmin: true,
  },
  {
    id: 'inet-cache',
    label: 'Windows INetCache',
    path: path.join(LOCAL_APPDATA, 'Microsoft', 'Windows', 'INetCache'),
    info:
      'Zwischenspeicher fuer Downloads und Web-Inhalte von Windows-Komponenten. ' +
      'Wird bei Bedarf neu aufgebaut.',
    recommended: true,
    requiresAdmin: false,
  },
  {
    id: 'crash-dumps',
    label: 'Absturzberichte (CrashDumps)',
    path: path.join(LOCAL_APPDATA, 'CrashDumps'),
    info:
      'Speicherabbilder abgestuerzter Programme. Nur loeschen, wenn du gerade ' +
      'keinen Absturz analysierst – die Dateien werden schnell sehr gross.',
    recommended: true,
    requiresAdmin: false,
  },
  {
    id: 'npm-cache',
    label: 'npm-Cache (_cacache)',
    path: path.join(LOCAL_APPDATA, 'npm-cache', '_cacache'),
    info:
      'Paket-Cache von npm. Loeschen ist gefahrlos, der naechste `npm install` ' +
      'laedt die Pakete allerdings erneut aus dem Netz.',
    recommended: false,
    requiresAdmin: false,
  },
  {
    id: 'windows-update-download',
    label: 'Windows-Update-Downloads',
    path: path.join(SYSTEM_ROOT, 'SoftwareDistribution', 'Download'),
    info:
      'Bereits installierte Update-Pakete. Nur bereinigen, wenn kein Update ' +
      'laeuft oder ein Neustart aussteht. Benoetigt Administratorrechte.',
    recommended: false,
    requiresAdmin: true,
  },
];

/** Pfade, die niemals als Loeschziel akzeptiert werden. */
const FORBIDDEN_PATHS: readonly string[] = [
  path.parse(HOME).root,
  SYSTEM_ROOT,
  path.join(SYSTEM_ROOT, 'System32'),
  path.join(SYSTEM_ROOT, 'SysWOW64'),
  HOME,
  LOCAL_APPDATA,
  ROAMING_APPDATA,
  path.join(HOME, 'Desktop'),
  path.join(HOME, 'Documents'),
  path.join(HOME, 'Downloads'),
  path.join(HOME, 'Pictures'),
  'C:\\Program Files',
  'C:\\Program Files (x86)',
].map((p) => path.resolve(p).toLowerCase());

/** Normalisiert einen Pfad fuer Vergleiche (Windows ist case-insensitiv). */
function normalize(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * Kernstueck des Schutzes: Ein Pfad darf nur angefasst werden, wenn er
 * innerhalb eines registrierten Ziels liegt und selbst nicht auf der
 * Blockliste steht.
 */
function isDeletable(candidate: string): boolean {
  const target = normalize(candidate);

  if (FORBIDDEN_PATHS.includes(target)) return false;

  return CLEAN_TARGETS.some((definition) => {
    const root = normalize(definition.path);
    // Nur echte Kinder – das Zielverzeichnis selbst bleibt bestehen.
    return target.startsWith(root + path.sep) && target.length > root.length + 1;
  });
}

function findTarget(id: string): TargetDefinition | undefined {
  return CLEAN_TARGETS.find((t) => t.id === id);
}

/* ------------------------------------------------------------------ *
 * 3. Path-Locator (wichtige Ordner)
 * ------------------------------------------------------------------ */

type LocatorDefinition = Omit<LocatorPath, 'exists'>;

const LOCATOR_PATHS: readonly LocatorDefinition[] = [
  {
    id: 'ssh',
    label: 'SSH-Keys',
    path: path.join(HOME, '.ssh'),
    kind: 'folder',
    sensitive: true,
    info:
      'Hier liegen deine privaten und oeffentlichen Schluessel. Teile niemals ' +
      'eine Datei ohne die Endung .pub! Die Datei `config` steuert Host-Aliase, ' +
      '`known_hosts` merkt sich bekannte Server.',
  },
  {
    id: 'hosts-dir',
    label: 'Hosts-Datei (Ordner)',
    path: path.join(SYSTEM_ROOT, 'System32', 'drivers', 'etc'),
    kind: 'folder',
    sensitive: true,
    info:
      'Enthaelt die Datei `hosts`, mit der Domains lokal auf IP-Adressen ' +
      'gemappt werden. Zum Bearbeiten brauchst du einen Editor mit ' +
      'Administratorrechten.',
  },
  {
    id: 'hosts-file',
    label: 'Hosts-Datei (direkt)',
    path: path.join(SYSTEM_ROOT, 'System32', 'drivers', 'etc', 'hosts'),
    kind: 'file',
    sensitive: true,
    info:
      'Die Datei selbst – "Im Explorer zeigen" markiert sie direkt. Ein Eintrag ' +
      'wie `127.0.0.1 meine-app.local` leitet Anfragen auf deinen Rechner um.',
  },
  {
    id: 'local-appdata',
    label: 'AppData\\Local',
    path: LOCAL_APPDATA,
    kind: 'folder',
    sensitive: false,
    info:
      'Maschinenspezifische Anwendungsdaten und Caches. Wandert NICHT mit einem ' +
      'Roaming-Profil mit. Typischer Ort fuer Logs und lokale Datenbanken.',
  },
  {
    id: 'roaming-appdata',
    label: 'AppData\\Roaming',
    path: ROAMING_APPDATA,
    kind: 'folder',
    sensitive: false,
    info:
      'Konfiguration, die dem Benutzerprofil folgt. Hier liegen z. B. ' +
      'Editor-Einstellungen und npm-Globals.',
  },
  {
    id: 'startup',
    label: 'Autostart-Ordner',
    path: path.join(ROAMING_APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    kind: 'folder',
    sensitive: false,
    info:
      'Alles hier startet beim Anmelden mit. Ein guter erster Blick, wenn der ' +
      'Rechner langsam hochfaehrt.',
  },
  {
    id: 'gitconfig',
    label: 'Globale .gitconfig',
    path: path.join(HOME, '.gitconfig'),
    kind: 'file',
    sensitive: false,
    info:
      'Deine globale Git-Konfiguration: Name, E-Mail, Aliase und ' +
      'Zeilenende-Handhabung (core.autocrlf).',
  },
  {
    id: 'npmrc',
    label: '.npmrc (Benutzer)',
    path: path.join(HOME, '.npmrc'),
    kind: 'file',
    sensitive: true,
    info:
      'npm-Konfiguration. Achtung: Hier koennen Registry-Auth-Tokens im ' +
      'Klartext stehen – niemals in ein Repository committen.',
  },
  {
    id: 'npm-global',
    label: 'npm Global-Pakete',
    path: path.join(ROAMING_APPDATA, 'npm'),
    kind: 'folder',
    sensitive: false,
    info: 'Ablage der global installierten npm-Pakete und ihrer .cmd-Shims.',
  },
  {
    id: 'vscode-user',
    label: 'VS Code Benutzerdaten',
    path: path.join(ROAMING_APPDATA, 'Code', 'User'),
    kind: 'folder',
    sensitive: false,
    info: 'settings.json, keybindings.json und Snippets deiner VS-Code-Installation.',
  },
  {
    id: 'powershell-profile',
    label: 'PowerShell-Profil',
    path: path.join(HOME, 'Documents', 'WindowsPowerShell'),
    kind: 'folder',
    sensitive: false,
    info:
      'Enthaelt `Microsoft.PowerShell_profile.ps1` – das Skript, das bei jedem ' +
      'Start der Shell ausgefuehrt wird.',
  },
  {
    id: 'temp-folder',
    label: 'Temp-Ordner (%TEMP%)',
    path: USER_TEMP,
    kind: 'folder',
    sensitive: false,
    info: 'Derselbe Ordner, den der Cache-Cleaner oben bereinigt.',
  },
];

function findLocator(id: string): LocatorDefinition | undefined {
  return LOCATOR_PATHS.find((p) => p.id === id);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 4. Fehlerbehandlung
 * ------------------------------------------------------------------ */

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as NodeJS.ErrnoException).code ?? 'UNKNOWN');
  }
  return 'UNKNOWN';
}

/** Uebersetzt Node-Fehlercodes in verstaendliche Hinweise. */
function describeError(error: unknown): string {
  switch (errorCode(error)) {
    case 'EBUSY':
      return 'Datei ist gesperrt (wird gerade von einem Prozess benutzt)';
    case 'EPERM':
    case 'EACCES':
      return 'Keine Berechtigung (evtl. Administratorrechte noetig)';
    case 'ENOENT':
      return 'Existiert nicht mehr';
    case 'ENOTEMPTY':
      return 'Ordner nicht leer (enthaelt gesperrte Dateien)';
    case 'EMFILE':
      return 'Zu viele offene Dateien';
    default:
      return error instanceof Error ? error.message : 'Unbekannter Fehler';
  }
}

/* ------------------------------------------------------------------ *
 * 5. Groessenberechnung (Scan)
 * ------------------------------------------------------------------ */

interface Emitter {
  (event: ProgressEvent): void;
}

/**
 * Laeuft iterativ (kein Rekursionslimit) durch den Baum und summiert Groessen.
 * Symlinks/Junctions werden NICHT verfolgt, damit der Scan nicht aus dem
 * Zielordner ausbricht.
 */
async function measure(id: string, root: string, emit: Emitter): Promise<ScanResult> {
  const result: ScanResult = {
    id,
    path: root,
    exists: true,
    bytes: 0,
    files: 0,
    folders: 0,
    unreadable: 0,
  };

  if (!(await exists(root))) {
    result.exists = false;
    return result;
  }

  const stack: string[] = [root];
  let lastEmit = 0;

  while (stack.length > 0) {
    const dir = stack.pop() as string;

    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      result.unreadable++;
      if (dir === root) result.error = describeError(error);
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        result.files++;
        continue;
      }

      if (entry.isDirectory()) {
        result.folders++;
        stack.push(full);
        continue;
      }

      try {
        const stats = await fsp.lstat(full);
        result.bytes += stats.size;
        result.files++;
      } catch {
        result.unreadable++;
      }
    }

    const now = Date.now();
    if (now - lastEmit > 120) {
      lastEmit = now;
      emit({ id, phase: 'scan', currentPath: dir, files: result.files, bytes: result.bytes });
    }
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * 6. Bereinigung (Clean)
 * ------------------------------------------------------------------ */

const MAX_REPORTED_SKIPS = 200;

interface PurgeContext {
  id: string;
  cutoff: number | null;
  result: CleanResult;
  emit: Emitter;
  lastEmit: number;
}

function noteSkip(ctx: PurgeContext, target: string, error: unknown): void {
  ctx.result.skippedTotal++;
  if (ctx.result.skipped.length < MAX_REPORTED_SKIPS) {
    ctx.result.skipped.push({
      path: target,
      reason: describeError(error),
      code: errorCode(error),
    });
  }
}

function tick(ctx: PurgeContext, currentPath: string): void {
  const now = Date.now();
  if (now - ctx.lastEmit > 120) {
    ctx.lastEmit = now;
    ctx.emit({
      id: ctx.id,
      phase: 'clean',
      currentPath,
      files: ctx.result.deletedFiles,
      bytes: ctx.result.freedBytes,
    });
  }
}

/**
 * Loescht den Inhalt eines Verzeichnisses in Post-Order.
 * Rueckgabe: true, wenn das Verzeichnis danach leer ist (dann darf der
 * Aufrufer es selbst entfernen – ausser es ist die Zielwurzel).
 */
async function purgeDirectory(dir: string, ctx: PurgeContext): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    noteSkip(ctx, dir, error);
    return false;
  }

  let emptied = true;

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    // Zweite Verteidigungslinie: jeder einzelne Pfad wird geprueft.
    if (!isDeletable(full)) {
      noteSkip(ctx, full, { code: 'EGUARD', message: 'Ausserhalb der erlaubten Pfade' });
      emptied = false;
      continue;
    }

    if (entry.isSymbolicLink()) {
      try {
        await fsp.unlink(full);
        ctx.result.deletedFiles++;
      } catch {
        // Directory-Junctions lassen sich nur per rmdir entfernen.
        try {
          await fsp.rmdir(full);
          ctx.result.deletedFolders++;
        } catch (error) {
          noteSkip(ctx, full, error);
          emptied = false;
        }
      }
      continue;
    }

    if (entry.isDirectory()) {
      const childEmptied = await purgeDirectory(full, ctx);
      if (!childEmptied) {
        emptied = false;
        continue;
      }
      try {
        await fsp.rmdir(full);
        ctx.result.deletedFolders++;
      } catch (error) {
        noteSkip(ctx, full, error);
        emptied = false;
      }
      continue;
    }

    try {
      const stats = await fsp.lstat(full);

      if (ctx.cutoff !== null && stats.mtimeMs > ctx.cutoff) {
        ctx.result.keptByAge++;
        emptied = false;
        continue;
      }

      await fsp.unlink(full);
      ctx.result.deletedFiles++;
      ctx.result.freedBytes += stats.size;
      tick(ctx, full);
    } catch (error) {
      // Gesperrte Dateien laufender Prozesse landen hier – wir gehen weiter.
      noteSkip(ctx, full, error);
      emptied = false;
    }
  }

  return emptied;
}

async function cleanTarget(
  definition: TargetDefinition,
  options: CleanOptions,
  emit: Emitter,
): Promise<CleanResult> {
  const result: CleanResult = {
    id: definition.id,
    path: definition.path,
    freedBytes: 0,
    deletedFiles: 0,
    deletedFolders: 0,
    keptByAge: 0,
    skipped: [],
    skippedTotal: 0,
  };

  if (!(await exists(definition.path))) {
    result.error = 'Ordner existiert auf diesem System nicht';
    return result;
  }

  const hours = Number.isFinite(options.minAgeHours) ? Math.max(0, options.minAgeHours) : 0;

  const ctx: PurgeContext = {
    id: definition.id,
    cutoff: hours > 0 ? Date.now() - hours * 3_600_000 : null,
    result,
    emit,
    lastEmit: 0,
  };

  await purgeDirectory(definition.path, ctx);
  return result;
}

/* ------------------------------------------------------------------ *
 * 7. Systeminfos via child_process (PowerShell)
 * ------------------------------------------------------------------ */

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$elevated  = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$drives = Get-PSDrive -PSProvider FileSystem |
  Where-Object { $null -ne $_.Used -or $null -ne $_.Free } |
  ForEach-Object {
    [PSCustomObject]@{ name = $_.Name; used = [double]$_.Used; free = [double]$_.Free }
  }
[PSCustomObject]@{ elevated = $elevated; drives = @($drives) } |
  ConvertTo-Json -Depth 4 -Compress
`;

interface PsPayload {
  elevated?: boolean;
  drives?: Array<{ name?: string; used?: number; free?: number }>;
}

/**
 * Ruft PowerShell EINMAL auf und liest Laufwerksbelegung + Elevation-Status.
 * Der Befehl wird base64-kodiert uebergeben (-EncodedCommand), damit kein
 * Quoting-Problem entsteht und keine Shell-Interpolation stattfindet.
 */
async function readSystemInfo(): Promise<SystemInfo> {
  const info: SystemInfo = {
    hostname: os.hostname(),
    username: os.userInfo().username,
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    isElevated: false,
    versions: {
      electron: process.versions.electron ?? '–',
      node: process.versions.node,
      chrome: process.versions.chrome ?? '–',
      v8: process.versions.v8,
    },
    drives: [],
  };

  if (!IS_WINDOWS) {
    info.driveError = 'Laufwerksinfos sind nur unter Windows verfuegbar.';
    return info;
  }

  try {
    const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );

    const payload = JSON.parse(stdout) as PsPayload;
    info.isElevated = payload.elevated === true;
    info.drives = (payload.drives ?? []).map((drive) => {
      const used = Number(drive.used ?? 0);
      const free = Number(drive.free ?? 0);
      return {
        name: String(drive.name ?? '?'),
        usedBytes: used,
        freeBytes: free,
        totalBytes: used + free,
      };
    });
  } catch (error) {
    info.driveError = describeError(error);
  }

  return info;
}

/* ------------------------------------------------------------------ *
 * 8. Fenster & Splashscreen
 * ------------------------------------------------------------------ */

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;

/** Mindestanzeigedauer, damit der Splash bei schnellem Start nicht aufblitzt. */
const SPLASH_MIN_MS = 1100;
/** Notbremse: Splash verschwindet auch, wenn das Hauptfenster haengt. */
const SPLASH_MAX_MS = 12_000;

let splashShownAt = 0;

/**
 * Assets liegen im gepackten Zustand als `extraResources` NEBEN der asar-Datei
 * (unter `resources/assets`), im Entwicklungsmodus direkt im Projekt.
 * Damit muss nie ein Icon aus dem asar-Archiv gelesen werden – native
 * Icon-Loader koennen das virtuelle Dateisystem nicht aufloesen.
 */
const ASSET_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(app.getAppPath(), 'assets');

function appAsset(name: string): string {
  return path.join(ASSET_DIR, name);
}

/** Erstes vorhandenes Icon – .ico bevorzugt (Windows-Taskleiste). */
function windowIcon(): string | undefined {
  for (const name of ['icon.ico', 'icon.png']) {
    const candidate = appAsset(name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function createSplash(): void {
  splashWindow = new BrowserWindow({
    width: 440,
    height: 262,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    center: true,
    title: 'SystemUtilitybyDGKN@Labs',
    icon: windowIcon(),
    webPreferences: {
      // Der Splash braucht weder Node noch eine Bruecke – er ist reines Markup.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  splashWindow.once('ready-to-show', () => {
    splashShownAt = Date.now();
    splashWindow?.show();
  });

  void splashWindow.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'));

  setTimeout(closeSplash, SPLASH_MAX_MS);
}

function closeSplash(): void {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = null;
}

/** Splash schliessen und Hauptfenster zeigen – fruehestens nach SPLASH_MIN_MS. */
function revealMainWindow(): void {
  const elapsed = splashShownAt > 0 ? Date.now() - splashShownAt : SPLASH_MIN_MS;
  const wait = Math.max(0, SPLASH_MIN_MS - elapsed);

  setTimeout(() => {
    closeSplash();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  }, wait);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    show: false,
    backgroundColor: '#0e1116',
    title: 'SystemUtilitybyDGKN@Labs',
    icon: windowIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true, // Renderer und Preload teilen sich keinen Scope
      nodeIntegration: false, // kein require() im Renderer
      sandbox: true, // Renderer laeuft im Chromium-Sandbox-Prozess
      webviewTag: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', revealMainWindow);
  void mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Keine Navigation und keine neuen Fenster aus dem Renderer heraus.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function progressEmitter(): Emitter {
  return (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.progress, event);
    }
  };
}

/* ------------------------------------------------------------------ *
 * 9. IPC-Handler
 * ------------------------------------------------------------------ */

/** Nimmt nur bekannte IDs an – unbekannte werden verworfen. */
function sanitizeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((v): v is string => typeof v === 'string');
  return [...new Set(ids)].filter((id) => findTarget(id) !== undefined);
}

function registerIpc(): void {
  ipcMain.handle(IPC.cleanerListTargets, async (): Promise<CleanTargetInfo[]> => {
    return Promise.all(
      CLEAN_TARGETS.map(async (definition) => ({
        ...definition,
        exists: await exists(definition.path),
      })),
    );
  });

  ipcMain.handle(IPC.cleanerScan, async (_event, rawIds: unknown): Promise<ScanResult[]> => {
    const emit = progressEmitter();
    const ids = sanitizeIds(rawIds);
    const results: ScanResult[] = [];

    // Bewusst sequenziell: sonst kaempfen die Scans um dieselbe Platte.
    for (const id of ids) {
      const definition = findTarget(id);
      if (!definition) continue;
      results.push(await measure(id, definition.path, emit));
    }

    return results;
  });

  ipcMain.handle(IPC.cleanerConfirm, async (_event, summary: unknown): Promise<boolean> => {
    if (!mainWindow) return false;

    const data = (summary ?? {}) as { count?: number; bytes?: number; minAgeHours?: number };
    const count = Number(data.count ?? 0);
    const bytes = Number(data.bytes ?? 0);
    const hours = Number(data.minAgeHours ?? 0);

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Abbrechen', 'Jetzt bereinigen'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Bereinigung bestaetigen',
      message: `${count} Ordner bereinigen?`,
      detail:
        `Es werden bis zu ${formatBytes(bytes)} freigegeben.\n` +
        (hours > 0 ? `Nur Dateien aelter als ${hours} Stunde(n) werden geloescht.\n` : '') +
        'Gesperrte Dateien laufender Programme werden uebersprungen. ' +
        'Der Vorgang laesst sich nicht rueckgaengig machen.',
    });

    return response === 1;
  });

  ipcMain.handle(
    IPC.cleanerClean,
    async (_event, rawIds: unknown, rawOptions: unknown): Promise<CleanResult[]> => {
      const emit = progressEmitter();
      const ids = sanitizeIds(rawIds);
      const options: CleanOptions = {
        minAgeHours: Math.max(0, Number((rawOptions as CleanOptions | undefined)?.minAgeHours ?? 0)),
      };

      const results: CleanResult[] = [];
      for (const id of ids) {
        const definition = findTarget(id);
        if (!definition) continue;
        results.push(await cleanTarget(definition, options, emit));
      }

      return results;
    },
  );

  ipcMain.handle(IPC.locatorList, async (): Promise<LocatorPath[]> => {
    return Promise.all(
      LOCATOR_PATHS.map(async (definition) => ({
        ...definition,
        exists: await exists(definition.path),
      })),
    );
  });

  ipcMain.handle(IPC.locatorOpen, async (_event, id: unknown): Promise<OperationOk> => {
    const definition = typeof id === 'string' ? findLocator(id) : undefined;
    if (!definition) return { ok: false, error: 'Unbekannter Pfad' };

    // Bei Dateien oeffnen wir den Ordner, nicht die Datei selbst:
    // so startet nie ungewollt ein externes Programm.
    const target = definition.kind === 'file' ? path.dirname(definition.path) : definition.path;

    if (!(await exists(target))) return { ok: false, error: 'Ordner existiert nicht' };

    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle(IPC.locatorReveal, async (_event, id: unknown): Promise<OperationOk> => {
    const definition = typeof id === 'string' ? findLocator(id) : undefined;
    if (!definition) return { ok: false, error: 'Unbekannter Pfad' };
    if (!(await exists(definition.path))) return { ok: false, error: 'Pfad existiert nicht' };

    shell.showItemInFolder(definition.path);
    return { ok: true };
  });

  ipcMain.handle(IPC.locatorCopy, async (_event, id: unknown): Promise<OperationOk> => {
    const definition = typeof id === 'string' ? findLocator(id) : undefined;
    if (!definition) return { ok: false, error: 'Unbekannter Pfad' };

    clipboard.writeText(definition.path);
    return { ok: true };
  });

  ipcMain.handle(IPC.systemInfo, (): Promise<SystemInfo> => readSystemInfo());
}

/** Kleine Helfer-Formatierung fuer den nativen Dialog. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/* ------------------------------------------------------------------ *
 * 10. App-Lifecycle
 * ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    if (!IS_DEV) Menu.setApplicationMenu(null);

    // Sorgt dafuer, dass Windows Taskleiste und Sprungliste unser Icon nutzen.
    app.setAppUserModelId('com.dgkn.labs.systemutility');

    // Laesst Windows die Titelleiste dunkel zeichnen – sonst steht eine helle
    // Systemleiste ueber einem durchgehend dunklen UI.
    nativeTheme.themeSource = 'dark';

    registerIpc();
    createSplash();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
