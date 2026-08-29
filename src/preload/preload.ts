/**
 * SystemUtilitybyDGKN@Labs – Preload / ContextBridge
 *
 * Diese Datei ist die einzige Bruecke zwischen Node.js und dem Frontend.
 *
 * WICHTIG – bewusste Design-Entscheidung:
 * Es werden NICHT `fs`, `path` oder `child_process` roh an den Renderer
 * durchgereicht. Das wuerde die Context-Isolation aushebeln: ein einziger
 * eingeschleuster Skript-Schnipsel im Renderer haette dann vollen
 * Dateisystem- und Prozesszugriff.
 *
 * Stattdessen exponieren wir eine schmale, getypte Fassade. Jeder Aufruf
 * geht per `ipcRenderer.invoke` in den Main-Prozess, der dort die Allowlist
 * prueft und erst dann `fs` / `child_process` benutzt.
 *
 * Hinweis: Das Fenster laeuft mit `sandbox: true`. Sandboxed Preloads koennen
 * keine relativen Module per `require` laden – die Kanalnamen stehen deshalb
 * hier als Literale. Das `satisfies`-Constraint gegen den `IpcChannel`-Typ
 * faengt Tippfehler zur Compile-Zeit ab (der `import type` wird beim
 * Kompilieren restlos entfernt und erzeugt kein `require`).
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcChannel } from '../shared/channels';

const CH = {
  cleanerListTargets: 'cleaner:list-targets',
  cleanerScan: 'cleaner:scan',
  cleanerConfirm: 'cleaner:confirm',
  cleanerClean: 'cleaner:clean',
  locatorList: 'locator:list',
  locatorOpen: 'locator:open',
  locatorReveal: 'locator:reveal',
  locatorCopy: 'locator:copy',
  systemInfo: 'system:info',
  progress: 'op:progress',
} satisfies Record<string, IpcChannel>;

/** Nur einfache, strukturklonbare Werte duerfen ueber die Bruecke. */
function toIdArray(value: readonly string[]): string[] {
  return value.filter((id) => typeof id === 'string' && id.length > 0).slice(0, 64);
}

const api: DgknApi = {
  cleaner: {
    listTargets: () => ipcRenderer.invoke(CH.cleanerListTargets),

    scan: (ids) => ipcRenderer.invoke(CH.cleanerScan, toIdArray(ids)),

    confirm: (summary) =>
      ipcRenderer.invoke(CH.cleanerConfirm, {
        count: Number(summary.count) || 0,
        bytes: Number(summary.bytes) || 0,
        minAgeHours: Number(summary.minAgeHours) || 0,
      }),

    clean: (ids, options) =>
      ipcRenderer.invoke(CH.cleanerClean, toIdArray(ids), {
        minAgeHours: Number(options.minAgeHours) || 0,
      }),
  },

  locator: {
    list: () => ipcRenderer.invoke(CH.locatorList),
    open: (id) => ipcRenderer.invoke(CH.locatorOpen, String(id)),
    reveal: (id) => ipcRenderer.invoke(CH.locatorReveal, String(id)),
    copy: (id) => ipcRenderer.invoke(CH.locatorCopy, String(id)),
  },

  system: {
    info: () => ipcRenderer.invoke(CH.systemInfo),
  },

  onProgress: (callback) => {
    // Das IpcRendererEvent (enthaelt u. a. `sender`) wird bewusst
    // NICHT an den Renderer weitergegeben.
    const listener = (_event: unknown, payload: ProgressEvent): void => callback(payload);
    ipcRenderer.on(CH.progress, listener);
    return () => ipcRenderer.removeListener(CH.progress, listener);
  },
};

contextBridge.exposeInMainWorld('dgkn', api);
