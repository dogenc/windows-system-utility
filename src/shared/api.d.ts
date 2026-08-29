/**
 * Ambiente Typdefinitionen (kein import/export auf Top-Level => global sichtbar).
 * Wird von Main-, Preload- und Renderer-Prozess gemeinsam genutzt.
 */

/** Ein Ordner, dessen Inhalt bereinigt werden darf. */
interface CleanTargetInfo {
  /** Stabile ID, die ueber IPC gereicht wird (nie ein roher Pfad!). */
  id: string;
  label: string;
  /** Aufgeloester absoluter Pfad. */
  path: string;
  /** Text fuer die Info-Box im UI. */
  info: string;
  /** Standardmaessig vorausgewaehlt? */
  recommended: boolean;
  /** Braucht in der Regel Administratorrechte. */
  requiresAdmin: boolean;
  /** Existiert der Ordner auf diesem System? */
  exists: boolean;
}

/** Ergebnis einer Groessenberechnung. */
interface ScanResult {
  id: string;
  path: string;
  exists: boolean;
  bytes: number;
  files: number;
  folders: number;
  /** Anzahl Eintraege, die nicht gelesen werden konnten (Rechte, Sperren). */
  unreadable: number;
  error?: string;
}

/** Ein uebersprungener Eintrag beim Loeschen. */
interface SkippedEntry {
  path: string;
  reason: string;
  code: string;
}

/** Ergebnis eines Bereinigungslaufs pro Ziel. */
interface CleanResult {
  id: string;
  path: string;
  freedBytes: number;
  deletedFiles: number;
  deletedFolders: number;
  /** Wegen Altersfilter bewusst behaltene Dateien. */
  keptByAge: number;
  /** Gekuerzte Liste (max. 200 Eintraege) fuer die UI-Ausgabe. */
  skipped: SkippedEntry[];
  skippedTotal: number;
  error?: string;
}

interface CleanOptions {
  /** Nur Dateien loeschen, die aelter als X Stunden sind. 0 = alle. */
  minAgeHours: number;
}

/** Ein Eintrag im Path-Locator. */
interface LocatorPath {
  id: string;
  label: string;
  path: string;
  info: string;
  kind: 'folder' | 'file';
  exists: boolean;
  /** Optionale Warnstufe fuer sensible Pfade (z. B. SSH). */
  sensitive: boolean;
}

interface DriveInfo {
  name: string;
  usedBytes: number;
  freeBytes: number;
  totalBytes: number;
}

interface SystemInfo {
  hostname: string;
  username: string;
  platform: string;
  release: string;
  arch: string;
  totalMemBytes: number;
  freeMemBytes: number;
  isElevated: boolean;
  versions: { electron: string; node: string; chrome: string; v8: string };
  drives: DriveInfo[];
  driveError?: string;
}

/** Fortschrittsmeldung vom Main- an den Renderer-Prozess. */
interface ProgressEvent {
  id: string;
  phase: 'scan' | 'clean';
  currentPath: string;
  files: number;
  bytes: number;
}

interface OperationOk {
  ok: boolean;
  error?: string;
}

/** Die einzige Bruecke zwischen Renderer und Node.js. */
interface DgknApi {
  cleaner: {
    listTargets(): Promise<CleanTargetInfo[]>;
    scan(ids: string[]): Promise<ScanResult[]>;
    confirm(summary: { count: number; bytes: number; minAgeHours: number }): Promise<boolean>;
    clean(ids: string[], options: CleanOptions): Promise<CleanResult[]>;
  };
  locator: {
    list(): Promise<LocatorPath[]>;
    /** Oeffnet den Ordner im Explorer (shell.openPath). */
    open(id: string): Promise<OperationOk>;
    /** Markiert den Eintrag im Explorer (shell.showItemInFolder). */
    reveal(id: string): Promise<OperationOk>;
    /** Legt den Pfad in die Zwischenablage. */
    copy(id: string): Promise<OperationOk>;
  };
  system: {
    info(): Promise<SystemInfo>;
  };
  /** Registriert einen Fortschritts-Listener, liefert die Abmeldefunktion zurueck. */
  onProgress(callback: (event: ProgressEvent) => void): () => void;
}

interface Window {
  readonly dgkn: DgknApi;
}
