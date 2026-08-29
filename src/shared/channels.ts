/**
 * Zentrale Liste aller IPC-Kanaele.
 * Nur Main- und Preload-Prozess importieren diese Datei; der Renderer kennt
 * ausschliesslich die Methoden aus `window.dgkn`.
 */
export const IPC = {
  cleanerListTargets: 'cleaner:list-targets',
  cleanerScan: 'cleaner:scan',
  cleanerConfirm: 'cleaner:confirm',
  cleanerClean: 'cleaner:clean',

  locatorList: 'locator:list',
  locatorOpen: 'locator:open',
  locatorReveal: 'locator:reveal',
  locatorCopy: 'locator:copy',

  systemInfo: 'system:info',

  /** Main -> Renderer (Push) */
  progress: 'op:progress',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
