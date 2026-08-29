/**
 * SystemUtilitybyDGKN@Labs – Renderer
 *
 * Laeuft ohne Node.js-Zugriff (contextIsolation + sandbox + strikte CSP).
 * Der einzige Weg nach draussen ist `window.dgkn` aus dem Preload-Skript.
 *
 * Das DOM wird bewusst per createElement/textContent aufgebaut statt per
 * innerHTML – so kann ein Pfadname niemals als Markup interpretiert werden.
 */

const api = window.dgkn;

/* ------------------------------------------------------------------ *
 * DOM-Helfer
 * ------------------------------------------------------------------ */

function need<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Element #${id} fehlt im DOM`);
  return element as T;
}

interface ElementOptions {
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: readonly Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [key, value] of Object.entries(options.attrs ?? {})) {
    node.setAttribute(key, value);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

/** Erzeugt ein Info-Icon mit hinterlegtem Text (Anzeige uebernimmt der Popover-Handler). */
function infoIcon(text: string, label: string): HTMLElement {
  const button = el('button', {
    className: 'info-btn',
    text: 'i',
    attrs: {
      type: 'button',
      'aria-label': label,
      'aria-expanded': 'false',
      'data-info': text,
    },
  });
  return el('span', { className: 'info-wrap' }, [button]);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const digits = exponent === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[exponent] ?? 'B'}`;
}

function formatCount(value: number): string {
  return value.toLocaleString('de-DE');
}

/* ------------------------------------------------------------------ *
 * Elemente
 * ------------------------------------------------------------------ */

const ui = {
  systemLine: need<HTMLParagraphElement>('system-line'),
  elevation: need<HTMLSpanElement>('elevation-badge'),
  refresh: need<HTMLButtonElement>('btn-refresh'),

  ageFilter: need<HTMLSelectElement>('age-filter'),
  scan: need<HTMLButtonElement>('btn-scan'),
  clean: need<HTMLButtonElement>('btn-clean'),

  totalSize: need<HTMLDivElement>('total-size'),
  totalMeta: need<HTMLSpanElement>('total-meta'),
  progress: need<HTMLDivElement>('progress'),
  progressLabel: need<HTMLSpanElement>('progress-label'),

  targetList: need<HTMLUListElement>('target-list'),
  logBox: need<HTMLDetailsElement>('log-box'),
  logCount: need<HTMLSpanElement>('log-count'),
  logBody: need<HTMLPreElement>('log-body'),

  pathFilter: need<HTMLInputElement>('path-filter'),
  pathGrid: need<HTMLDivElement>('path-grid'),

  status: need<HTMLSpanElement>('status'),
  versions: need<HTMLSpanElement>('versions'),
  infoBox: need<HTMLDivElement>('info-box'),
};

/* ------------------------------------------------------------------ *
 * Zustand
 * ------------------------------------------------------------------ */

const state = {
  targets: [] as CleanTargetInfo[],
  scans: new Map<string, ScanResult>(),
  selected: new Set<string>(),
  locators: [] as LocatorPath[],
  busy: false,
};

function setStatus(message: string, tone: 'normal' | 'ok' | 'error' = 'normal'): void {
  ui.status.textContent = message;
  ui.status.className = tone === 'ok' ? 'status--ok' : tone === 'error' ? 'status--error' : '';
}

function setBusy(busy: boolean, label = ''): void {
  state.busy = busy;
  ui.progress.hidden = !busy;
  ui.progressLabel.textContent = label;
  ui.refresh.disabled = busy;
  ui.scan.disabled = busy;
  updateCleanButton();
}

function updateCleanButton(): void {
  const selectable = [...state.selected].filter(
    (id) => state.targets.find((t) => t.id === id)?.exists,
  );
  ui.clean.disabled = state.busy || selectable.length === 0;
}

/* ------------------------------------------------------------------ *
 * Cache & Temp-Cleaner
 * ------------------------------------------------------------------ */

function renderTargets(): void {
  ui.targetList.replaceChildren();

  if (state.targets.length === 0) {
    ui.targetList.appendChild(el('li', { className: 'placeholder', text: 'Keine Ziele gefunden.' }));
    return;
  }

  for (const target of state.targets) {
    const scan = state.scans.get(target.id);

    const checkbox = el('input', {
      attrs: { type: 'checkbox', 'aria-label': `${target.label} auswaehlen` },
    });
    checkbox.checked = state.selected.has(target.id);
    checkbox.disabled = !target.exists;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(target.id);
      else state.selected.delete(target.id);
      updateCleanButton();
    });

    const badges: Node[] = [];
    if (target.requiresAdmin) {
      badges.push(el('span', { className: 'badge badge--warn', text: 'Admin' }));
    }
    if (!target.exists) {
      badges.push(el('span', { className: 'badge badge--missing', text: 'nicht vorhanden' }));
    }

    const label = el('div', { className: 'target__label' }, [
      el('span', { text: target.label }),
      infoIcon(target.info, `Info zu ${target.label}`),
      ...badges,
    ]);

    const main = el('div', { className: 'target__main' }, [
      label,
      el('div', { className: 'target__path', text: target.path, attrs: { title: target.path } }),
    ]);

    const size = el('div', { className: 'target__size' });
    if (!target.exists) {
      size.classList.add('target__size--empty');
      size.textContent = '–';
    } else if (!scan) {
      size.classList.add('target__size--empty');
      size.textContent = 'nicht gescannt';
    } else if (scan.error) {
      size.classList.add('target__size--empty');
      size.textContent = 'Fehler';
      size.title = scan.error;
    } else {
      size.textContent = formatBytes(scan.bytes);
      const detail = el('small', {
        text:
          `${formatCount(scan.files)} Dateien` +
          (scan.unreadable > 0 ? ` · ${formatCount(scan.unreadable)} gesperrt` : ''),
      });
      size.appendChild(detail);
    }

    const row = el(
      'li',
      { className: `target${target.exists ? '' : ' target--missing'}` },
      [checkbox, main, size],
    );

    ui.targetList.appendChild(row);
  }
}

function renderTotals(): void {
  const scans = [...state.scans.values()];
  if (scans.length === 0) {
    ui.totalSize.textContent = '–';
    ui.totalMeta.textContent = 'Noch nicht gescannt';
    return;
  }

  const bytes = scans.reduce((sum, scan) => sum + scan.bytes, 0);
  const files = scans.reduce((sum, scan) => sum + scan.files, 0);
  const locked = scans.reduce((sum, scan) => sum + scan.unreadable, 0);

  ui.totalSize.textContent = formatBytes(bytes);
  ui.totalMeta.textContent =
    `${formatCount(files)} Dateien in ${scans.length} Ordner(n)` +
    (locked > 0 ? ` · ${formatCount(locked)} Eintraege nicht lesbar` : '');
}

async function loadTargets(): Promise<void> {
  state.targets = await api.cleaner.listTargets();

  // Vorauswahl: empfohlene Ziele, die es auf diesem System auch gibt.
  state.selected = new Set(
    state.targets.filter((t) => t.recommended && t.exists).map((t) => t.id),
  );

  renderTargets();
  updateCleanButton();
}

function selectedExistingIds(): string[] {
  return state.targets.filter((t) => state.selected.has(t.id) && t.exists).map((t) => t.id);
}

async function runScan(ids?: string[]): Promise<void> {
  const targetIds = ids ?? state.targets.filter((t) => t.exists).map((t) => t.id);
  if (targetIds.length === 0) {
    setStatus('Keine vorhandenen Ordner zum Scannen.', 'error');
    return;
  }

  setBusy(true, 'Scanne …');
  setStatus('Berechne Ordnergroessen …');

  try {
    const results = await api.cleaner.scan(targetIds);
    for (const result of results) state.scans.set(result.id, result);

    renderTargets();
    renderTotals();
    setStatus('Scan abgeschlossen.', 'ok');
  } catch (error) {
    setStatus(`Scan fehlgeschlagen: ${(error as Error).message}`, 'error');
  } finally {
    setBusy(false);
  }
}

function renderCleanLog(results: readonly CleanResult[]): void {
  const totalSkipped = results.reduce((sum, r) => sum + r.skippedTotal, 0);

  if (totalSkipped === 0) {
    ui.logBox.hidden = true;
    return;
  }

  const lines: string[] = [];
  for (const result of results) {
    if (result.skippedTotal === 0) continue;
    lines.push(`── ${result.path}  (${formatCount(result.skippedTotal)} uebersprungen)`);
    for (const entry of result.skipped) {
      lines.push(`   [${entry.code}] ${entry.path}\n        ${entry.reason}`);
    }
    if (result.skippedTotal > result.skipped.length) {
      lines.push(`   … und ${formatCount(result.skippedTotal - result.skipped.length)} weitere`);
    }
    lines.push('');
  }

  ui.logCount.textContent = formatCount(totalSkipped);
  ui.logBody.textContent = lines.join('\n');
  ui.logBox.hidden = false;
}

async function runClean(): Promise<void> {
  const ids = selectedExistingIds();
  if (ids.length === 0) return;

  const bytes = ids.reduce((sum, id) => sum + (state.scans.get(id)?.bytes ?? 0), 0);
  const minAgeHours = Number(ui.ageFilter.value) || 0;

  // Bestaetigung holt sich der Main-Prozess ueber einen nativen Dialog.
  const confirmed = await api.cleaner.confirm({ count: ids.length, bytes, minAgeHours });
  if (!confirmed) {
    setStatus('Bereinigung abgebrochen.');
    return;
  }

  setBusy(true, 'Bereinige …');
  setStatus('Loesche temporaere Dateien …');

  try {
    const results = await api.cleaner.clean(ids, { minAgeHours });

    const freed = results.reduce((sum, r) => sum + r.freedBytes, 0);
    const files = results.reduce((sum, r) => sum + r.deletedFiles, 0);
    const folders = results.reduce((sum, r) => sum + r.deletedFolders, 0);
    const skipped = results.reduce((sum, r) => sum + r.skippedTotal, 0);
    const kept = results.reduce((sum, r) => sum + r.keptByAge, 0);

    renderCleanLog(results);

    setStatus(
      `${formatBytes(freed)} freigegeben · ${formatCount(files)} Dateien, ` +
        `${formatCount(folders)} Ordner geloescht` +
        (skipped > 0 ? ` · ${formatCount(skipped)} uebersprungen` : '') +
        (kept > 0 ? ` · ${formatCount(kept)} wegen Altersfilter behalten` : ''),
      'ok',
    );
  } catch (error) {
    setStatus(`Bereinigung fehlgeschlagen: ${(error as Error).message}`, 'error');
    setBusy(false);
    return;
  }

  setBusy(false);
  await runScan(ids); // Restgroesse direkt neu ermitteln
}

/* ------------------------------------------------------------------ *
 * Path-Locator
 * ------------------------------------------------------------------ */

function buildPathCard(entry: LocatorPath): HTMLElement {
  const head = el('div', { className: 'path-card__head' }, [
    el('span', { className: 'path-card__label', text: entry.label }),
    infoIcon(entry.info, `Info zu ${entry.label}`),
    ...(entry.exists
      ? entry.sensitive
        ? [el('span', { className: 'badge badge--warn', text: 'sensibel' })]
        : []
      : [el('span', { className: 'badge badge--missing', text: 'nicht vorhanden' })]),
  ]);

  const openButton = el('button', {
    className: 'btn btn--mini',
    text: entry.kind === 'file' ? 'Ordner oeffnen' : 'Oeffnen',
    attrs: { type: 'button' },
  });
  openButton.disabled = !entry.exists;
  openButton.addEventListener('click', () => void handleLocatorAction('open', entry, openButton));

  const revealButton = el('button', {
    className: 'btn btn--mini',
    text: 'Im Explorer zeigen',
    attrs: { type: 'button' },
  });
  revealButton.disabled = !entry.exists;
  revealButton.addEventListener(
    'click',
    () => void handleLocatorAction('reveal', entry, revealButton),
  );

  const copyButton = el('button', {
    className: 'btn btn--mini',
    text: 'Pfad kopieren',
    attrs: { type: 'button' },
  });
  copyButton.addEventListener('click', () => void handleLocatorAction('copy', entry, copyButton));

  const classes = [
    'path-card',
    entry.sensitive ? 'path-card--sensitive' : '',
    entry.exists ? '' : 'path-card--missing',
  ]
    .filter(Boolean)
    .join(' ');

  return el('div', { className: classes }, [
    head,
    el('div', { className: 'path-card__path', text: entry.path }),
    el('div', { className: 'path-card__actions' }, [openButton, revealButton, copyButton]),
  ]);
}

async function handleLocatorAction(
  action: 'open' | 'reveal' | 'copy',
  entry: LocatorPath,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  try {
    const result = await api.locator[action](entry.id);
    if (result.ok) {
      const verb =
        action === 'copy' ? 'Pfad kopiert' : action === 'reveal' ? 'Im Explorer markiert' : 'Geoeffnet';
      setStatus(`${verb}: ${entry.path}`, 'ok');
    } else {
      setStatus(`${entry.label}: ${result.error ?? 'Aktion fehlgeschlagen'}`, 'error');
    }
  } catch (error) {
    setStatus(`${entry.label}: ${(error as Error).message}`, 'error');
  } finally {
    button.disabled = action !== 'copy' && !entry.exists ? true : false;
  }
}

function renderPaths(): void {
  const query = ui.pathFilter.value.trim().toLowerCase();
  const visible = query
    ? state.locators.filter(
        (entry) =>
          entry.label.toLowerCase().includes(query) || entry.path.toLowerCase().includes(query),
      )
    : state.locators;

  ui.pathGrid.replaceChildren();

  if (visible.length === 0) {
    ui.pathGrid.appendChild(
      el('p', { className: 'placeholder', text: 'Kein Pfad passt zum Filter.' }),
    );
    return;
  }

  for (const entry of visible) ui.pathGrid.appendChild(buildPathCard(entry));
}

async function loadPaths(): Promise<void> {
  state.locators = await api.locator.list();
  renderPaths();
}

/* ------------------------------------------------------------------ *
 * Systeminfo
 * ------------------------------------------------------------------ */

async function loadSystemInfo(): Promise<void> {
  const info = await api.system.info();

  const drives = info.drives
    .filter((drive) => drive.totalBytes > 0)
    .map((drive) => `${drive.name}: ${formatBytes(drive.freeBytes)} frei`)
    .join('  ·  ');

  ui.systemLine.textContent =
    `${info.username}@${info.hostname}  ·  ${info.platform} ${info.release} (${info.arch})` +
    (drives ? `  ·  ${drives}` : info.driveError ? `  ·  ${info.driveError}` : '');

  ui.elevation.textContent = info.isElevated
    ? 'Rechte: Administrator'
    : 'Rechte: Standardbenutzer';
  ui.elevation.className = `badge ${info.isElevated ? 'badge--ok' : 'badge--muted'}`;
  ui.elevation.title = info.isElevated
    ? 'System-Ordner wie C:\\Windows\\Temp koennen vollstaendig bereinigt werden.'
    : 'Ohne Administratorrechte werden geschuetzte Dateien uebersprungen.';

  ui.versions.textContent = `Electron ${info.versions.electron} · Node ${info.versions.node} · Chromium ${info.versions.chrome}`;
}

/* ------------------------------------------------------------------ *
 * Info-Boxen (Hover + Klick)
 * ------------------------------------------------------------------ */

let pinnedInfo: HTMLElement | null = null;

function showInfo(button: HTMLElement): void {
  const text = button.dataset['info'];
  if (!text) return;

  ui.infoBox.textContent = text;
  ui.infoBox.hidden = false;

  const anchor = button.getBoundingClientRect();
  const box = ui.infoBox.getBoundingClientRect();
  const margin = 8;

  let left = anchor.left + anchor.width / 2 - box.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin));

  // Unterhalb anzeigen, bei Platzmangel oberhalb.
  const below = anchor.bottom + margin;
  const top = below + box.height > window.innerHeight - margin ? anchor.top - box.height - margin : below;

  ui.infoBox.style.left = `${Math.round(left)}px`;
  ui.infoBox.style.top = `${Math.round(Math.max(margin, top))}px`;
}

function hideInfo(): void {
  ui.infoBox.hidden = true;
  if (pinnedInfo) {
    pinnedInfo.setAttribute('aria-expanded', 'false');
    pinnedInfo = null;
  }
}

function asInfoButton(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('.info-btn') : null;
}

function wireInfoBoxes(): void {
  document.addEventListener('mouseover', (event) => {
    if (pinnedInfo) return;
    const button = asInfoButton(event.target);
    if (button) showInfo(button);
    else if (!ui.infoBox.hidden) hideInfo();
  });

  document.addEventListener('focusin', (event) => {
    const button = asInfoButton(event.target);
    if (button) showInfo(button);
  });

  document.addEventListener('click', (event) => {
    const button = asInfoButton(event.target);

    if (!button) {
      hideInfo();
      return;
    }

    if (pinnedInfo === button) {
      hideInfo();
      return;
    }

    if (pinnedInfo) pinnedInfo.setAttribute('aria-expanded', 'false');
    pinnedInfo = button;
    button.setAttribute('aria-expanded', 'true');
    showInfo(button);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideInfo();
  });

  // Beim Scrollen/Resize wandert der Anker – Box einfach schliessen.
  window.addEventListener('resize', hideInfo);
  document.querySelector('.layout')?.addEventListener('scroll', hideInfo, { passive: true });
}

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

function wireEvents(): void {
  ui.scan.addEventListener('click', () => void runScan());
  ui.clean.addEventListener('click', () => void runClean());
  ui.pathFilter.addEventListener('input', renderPaths);

  ui.refresh.addEventListener('click', () => {
    state.scans.clear();
    void bootstrap();
  });

  api.onProgress((event) => {
    const prefix = event.phase === 'scan' ? 'Scanne' : 'Loesche';
    ui.progressLabel.textContent =
      `${prefix}  ${formatCount(event.files)} Dateien · ${formatBytes(event.bytes)}  —  ${event.currentPath}`;
  });

  wireInfoBoxes();
}

async function bootstrap(): Promise<void> {
  setBusy(true, 'Lade …');
  try {
    await Promise.all([loadSystemInfo(), loadTargets(), loadPaths()]);
    renderTotals();
    setStatus('Bereit. Klicke auf „Groesse berechnen“, um zu starten.');
  } catch (error) {
    setStatus(`Initialisierung fehlgeschlagen: ${(error as Error).message}`, 'error');
  } finally {
    setBusy(false);
  }
}

wireEvents();
void bootstrap();
