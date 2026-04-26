'use strict';

// ═══════════════════════════════════════════════════════════════
//  DATABASE  (IndexedDB helpers)
//  Three object stores:
//    'recipes'  – recipe objects (id, name, labels, ingredients, steps…)
//    'images'   – base64-encoded image data, keyed by imageId
//    'settings' – key/value pairs for app configuration
// ═══════════════════════════════════════════════════════════════

/** Global IndexedDB connection, set once by openDB() */
let db;

/**
 * Opens (or upgrades) the IndexedDB database to version 2.
 * Creates the three object stores if they don't already exist.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('sahver', 2);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains('recipes'))
        database.createObjectStore('recipes', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('settings'))
        database.createObjectStore('settings', { keyPath: 'key' });
      if (!database.objectStoreNames.contains('images'))
        database.createObjectStore('images', { keyPath: 'id' });
    };

    request.onsuccess = (event) => { db = event.target.result; resolve(db); };
    request.onerror = reject;
  });
}

/** Returns an object store from a new transaction. */
function getStore(storeName, mode = 'readonly') {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const req = getStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = reject;
  });
}

function dbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    const req = getStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = reject;
  });
}

function dbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const req = getStore(storeName, 'readwrite').put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = reject;
  });
}

function dbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const req = getStore(storeName, 'readwrite').delete(key);
    req.onsuccess = () => resolve();
    req.onerror = reject;
  });
}

// ═══════════════════════════════════════════════════════════════
//  APP STATE
// ═══════════════════════════════════════════════════════════════

/** In-memory mirror of the 'recipes' store (kept in sync on every write). */
let recipes = [];

/**
 * Application settings with sensible defaults.
 * Persisted under key 'app' in the 'settings' store.
 */
let settings = {
  labels: ['hommikusöök', 'salat', 'supp', 'roog', 'vegan', 'magustoit', 'suupiste','jook','lihtne','suvine'],

  /**
   * Ingredient densities in g/ml.
   * Used to convert between volume and mass (e.g. "1 cup flour → 188 g").
   */
  densities: {
    'flour, jahu': 0.79,
    'sugar, suhkur, suhkrut': 0.85,
    'butter, või, võid': 0.911,
    'water, vesi, vett': 1,
    'milk, piima': 1.035,
    'cream, koort': 0.994,
    'oil, õli, olive oil, oliiviõli, vegetable oil, taimeõli, rapeseed oil, rapsõli, sunflower oil, päevalilleõli, coconut oil, kookosõli': 0.92,
    'baking soda, küpsetuspulber, küpsetuspulbrit': 0.9,
    'honey, mesi': 1.42,
    'yogurt, jogurt, jogurtit': 1.03,
    'cocoa powder, kakao, kakaod, kakaopulbrit': 0.56,
    'oats, kaerahelbeid, kaerahelbed': 0.4,
  },

  palette: { bg: '#f7f4ee', accent: '#f2b705' },
  lastExport: 0,   // Unix ms timestamp of the last successful export
  dirty: false,    // true whenever recipes have changed since the last export
  migrationVersion: 0, // bumped each time a one-time init() migration runs
};

// ── Navigation state ──────────────────────────────────────────
let activeTab = 'recipes';

// ── Recipe view state ─────────────────────────────────────────
let activeRecipeId = null;  // ID of the recipe currently shown in the detail panel
let editingId = null;       // ID of the recipe being edited (null = creating new)
let formImg = null;         // base64 data URL of the image in the edit form
let formDirty = false;      // true when the form has unsaved changes
let scaleFactor = 1;        // current serving multiplier (e.g. 2× for double portions)
let origServings = 4;       // original serving count from the recipe record

// ── Filter / search state ─────────────────────────────────────
let filterLabels = new Set(); // labels whose filter chips are active
const MAX_RECIPE_NAME = 60; // maximum characters allowed in a recipe name

let searchQuery        = '';    // current text in the search box
let searchIngredients  = true;  // whether search also matches ingredient names
let sortOrder   = 'newest';   // 'newest' | 'alpha'

// ═══════════════════════════════════════════════════════════════
//  SETTINGS HELPERS
// ═══════════════════════════════════════════════════════════════

async function getSetting(key, defaultValue) {
  const row = await dbGet('settings', key);
  return row !== undefined ? row.val : defaultValue;
}

async function setSetting(key, value) {
  await dbPut('settings', { key, val: value });
}

/** Saves the full in-memory settings object to IndexedDB. */
async function saveSettings() {
  await dbPut('settings', { key: 'app', val: { ...settings } });
}

// ═══════════════════════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════════════════════

/** Maps tab identifiers to the IDs of their root <div class="view"> elements. */
const TAB_VIEW_MAP = { convert: 'vc', recipes: 'vr', io: 'vio', settings: 'vs' };

/** Activates the given tab, cross-fading its view into focus. */
function switchTab(tabKey) {
  activeTab = tabKey;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(TAB_VIEW_MAP[tabKey]).classList.add('active');
  document.querySelectorAll('.nav-item, .bn-btn').forEach(el =>
    el.classList.toggle('active', el.dataset.tab === tabKey)
  );
  // Always land on the list panel when switching to Recipes
  if (tabKey === 'recipes') showPanel('pl');
}

/**
 * Shows one of the three recipe sub-panels and hides the others.
 * @param {'pl'|'pd'|'pf'} panelId
 */
function showPanel(panelId) {
  document.querySelectorAll('.rp').forEach(p => p.classList.remove('active'));
  document.getElementById(panelId).classList.add('active');
}

function bindNav() {
  document.getElementById('sb-toggle').addEventListener('click', () =>
    document.getElementById('sidebar').classList.toggle('col')
  );
  document.querySelectorAll('[data-tab]').forEach(el =>
    el.addEventListener('click', async () => {
      // If the form panel is open and has unsaved changes, confirm before leaving
      const formIsOpen = document.getElementById('pf').classList.contains('active');
      if (formIsOpen && formDirty) {
        const leave = await modal(
          'Salvestamata muudatused',
          'Sul on salvestamata muudatused. Kas soovid lahkuda?',
          'Lahku'
        );
        if (!leave) return;
        formDirty = false;
      }
      switchTab(el.dataset.tab);
    })
  );
}

// ═══════════════════════════════════════════════════════════════
//  UI UTILITIES  (toast, modal)
// ═══════════════════════════════════════════════════════════════

let toastTimer;

/**
 * Briefly displays a notification message at the bottom of the screen.
 * @param {string} message
 * @param {number} [duration=2400] - visible time in ms
 */
function toast(message, duration = 2400) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

/**
 * Shows a confirmation modal and returns a Promise that resolves to
 * true (OK clicked) or false (cancelled).
 * @param {string} title
 * @param {string} text
 * @param {string} [okLabel='OK']
 * @returns {Promise<boolean>}
 */
function modal(title, text, okLabel = 'OK') {
  return new Promise(resolve => {
    document.getElementById('mtitle').textContent = title;
    document.getElementById('mtext').textContent = text;
    document.getElementById('mok').textContent = okLabel;

    const modalEl = document.getElementById('modal');
    modalEl.classList.add('show');

    const okBtn     = document.getElementById('mok');
    const cancelBtn = document.getElementById('mcancel');

    function cleanup(result) {
      modalEl.classList.remove('show');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }

    const onOk     = () => cleanup(true);
    const onCancel = () => cleanup(false);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

/**
 * Three-way modal for situations where Cancel / Alternative / Primary are all needed.
 * Returns: 'primary' | 'alternative' | 'cancel'
 *
 * @param {string} title
 * @param {string} text
 * @param {string} primaryLabel     - rightmost, filled button
 * @param {string} alternativeLabel - middle, outlined button
 * @returns {Promise<'primary'|'alternative'|'cancel'>}
 */
function modalChoice(title, text, primaryLabel, alternativeLabel) {
  return new Promise(resolve => {
    document.getElementById('mtitle').textContent = title;
    document.getElementById('mtext').textContent  = text;
    document.getElementById('mok').textContent    = primaryLabel;

    const altBtn    = document.getElementById('malt');
    altBtn.textContent    = alternativeLabel;
    altBtn.style.display  = '';

    const modalEl   = document.getElementById('modal');
    modalEl.classList.add('show');

    const okBtn     = document.getElementById('mok');
    const cancelBtn = document.getElementById('mcancel');

    function cleanup(result) {
      modalEl.classList.remove('show');
      altBtn.style.display = 'none'; // hide the extra button for future plain modals
      okBtn.removeEventListener('click',     onPrimary);
      altBtn.removeEventListener('click',    onAlternative);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }

    const onPrimary     = () => cleanup('primary');
    const onAlternative = () => cleanup('alternative');
    const onCancel      = () => cleanup('cancel');
    okBtn.addEventListener('click',     onPrimary);
    altBtn.addEventListener('click',    onAlternative);
    cancelBtn.addEventListener('click', onCancel);
  });
}

/**
 * Looks up the density (g/ml) for a substance name, checking all comma-separated
 * aliases in each density key.
 *
 * e.g. key "flour, jahu" matches both "flour" and "jahu".
 * Matching is case-insensitive and trims whitespace around each alias.
 *
 * @param {string} substance - ingredient name as parsed from the input line
 * @returns {number|null} density in g/ml, or null if not found
 */
function getDensity(substance) {
  if (!substance) return null;
  const s = substance.toLowerCase().trim();
  for (const [key, value] of Object.entries(settings.densities || {})) {
    const aliases = key.split(',').map(a => a.trim().toLowerCase());
    if (aliases.includes(s)) return value;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  UNIT CONVERTER — lookup tables
// ═══════════════════════════════════════════════════════════════

/**
 * Volume unit aliases → conversion factor to millilitres.
 * Covers US customary, UK imperial, and metric.
 */
const VOL_ML = {
  tbsp: 14.79, tablespoon: 14.79, tablespoons: 14.79, tb: 14.79, tbl: 14.79,
  tsp: 4.93, teaspoon: 4.93, teaspoons: 4.93,
  c: 236.6, cup: 236.6, cups: 236.6,
  floz: 29.57, usfloz: 29.57, ukfloz: 28.41,
  fluidounce: 29.57, fluidounces: 29.57,
  pint: 568.26, uspint: 473.18, ukpint: 568.26,
  qt: 946.35, quart: 946.35, quarts: 946.35,
  gal: 3785, gallon: 3785, gallons: 3785,
  ml: 1, l: 1000, dl: 100, cl: 10,
};

/**
 * Volume units that should be preserved in the primary output.
 * These are shown as-is with an "ml" equivalent in brackets,
 * rather than being converted to ml as the main unit.
 */
const KEEP_ORIGINAL_UNIT = new Set([
  'tbsp', 'tablespoon', 'tablespoons', 'tb', 'tbl',
  'tsp', 'teaspoon', 'teaspoons',
  'ml', 'l', 'dl', 'cl',
]);

/** Mass unit aliases → conversion factor to grams. */
const MASS_G = {
  oz: 28.35, ounce: 28.35, ounces: 28.35,
  lb: 453.6, lbs: 453.6, pound: 453.6, pounds: 453.6,
  kg: 1000, g: 1, mg: 0.001,
};

// ═══════════════════════════════════════════════════════════════
//  UNIT CONVERTER — parsing & conversion
// ═══════════════════════════════════════════════════════════════

/**
 * Safely parses a fraction string like "3/4" or "1/3".
 * Returns NaN for invalid input. Does NOT use eval().
 */
function parseFraction(str) {
  const parts = str.split('/');
  if (parts.length !== 2) return NaN;
  const numerator   = parseFloat(parts[0]);
  const denominator = parseFloat(parts[1]);
  if (isNaN(numerator) || isNaN(denominator) || denominator === 0) return NaN;
  return numerator / denominator;
}

/**
 * Parses and converts one line of ingredient text to metric.
 *
 * Handles:
 *  - Unicode fraction characters (½ ⅓ ¾ …)
 *  - Mixed numbers ("1 1/2 cups")
 *  - Plain fractions ("3/4 cup")
 *  - Ranges ("5-6 oz chicken")
 *  - Temperatures ("350 F", "180 C")
 *  - Optional stripping of parenthesised remarks
 *
 * @param {string} rawLine
 * @returns {{ html: string } | null}  Formatted HTML, or null if not parseable
 */
/**
 * Reads text from the clipboard with an iOS Safari / non-HTTPS fallback.
 * navigator.clipboard.readText() is blocked on non-HTTPS origins on iOS.
 * Falls back to prompt() which is functional even without permissions.
 * @returns {Promise<string>}
 */
async function readClipboard() {
  if (navigator.clipboard && navigator.clipboard.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      // Permission denied or not HTTPS — fall through to textarea modal
    }
  }
  // iOS Safari / non-HTTPS fallback: show a textarea modal so multiline
  // text is preserved (prompt() collapses newlines on iOS).
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed;inset:0;background:rgba(0,0,0,.5)',
      'display:flex;align-items:center;justify-content:center',
      'z-index:9999;padding:20px',
    ].join(';');

    const box = document.createElement('div');
    box.style.cssText = [
      'background:var(--surface);border-radius:var(--rlg)',
      'padding:20px;width:100%;max-width:420px',
      'display:flex;flex-direction:column;gap:12px',
      'box-shadow:var(--shlg)',
    ].join(';');

    const title = document.createElement('p');
    title.style.cssText = 'font-weight:600;font-size:15px;margin:0';
    title.textContent = 'Kleebi tekst siia:';

    const ta = document.createElement('textarea');
    ta.style.cssText = [
      'width:100%;min-height:120px;padding:10px',
      'border:1px solid var(--border);border-radius:var(--r)',
      'background:var(--bg);color:var(--text)',
      'font-family:var(--fb);font-size:14px;resize:vertical',
    ].join(';');
    ta.placeholder = 'Kleebi siia (Ctrl+V / Cmd+V / pikk vajutus)…';

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn btn-s';
    btnCancel.textContent = 'Tühista';
    btnCancel.style.padding = '8px 14px';

    const btnOk = document.createElement('button');
    btnOk.className = 'btn btn-p';
    btnOk.textContent = 'OK';
    btnOk.style.padding = '8px 14px';

    function finish(value) {
      document.body.removeChild(overlay);
      resolve(value);
    }

    btnCancel.addEventListener('click', () => finish(''));
    btnOk.addEventListener('click',     () => finish(ta.value));

    actions.appendChild(btnCancel);
    actions.appendChild(btnOk);
    box.appendChild(title);
    box.appendChild(ta);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    // Small delay so the keyboard has time to open before we focus
    setTimeout(() => ta.focus(), 80);
  });
}

/**
 * Writes text to the clipboard with a fallback for restricted contexts.
 * @param {string} text
 * @returns {Promise<void>}
 */
async function writeClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch { /* fall through */ }
  }
  // Fallback: select a temporary textarea
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

/**
 * Returns the line with parenthesised content removed, if the checkbox is checked.
 * Exported separately so doConvert can use the cleaned line for its fallback renderer.
 * @param {string} rawLine
 * @returns {string}
 */
function stripParens(rawLine) {
  if (!document.getElementById('cparens').checked) return rawLine;
  return rawLine.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
}

/**
 * Removes common non-ingredient decorations that appear when pasting from
 * recipe websites, PDFs, or apps:
 *
 *   ▢ / □  – checkbox symbols (e.g. from Whisk, Paprika, recipe PDFs)
 *   2x / 3× – standalone multiplier tokens like "2x" or "×2" at line start
 *             NOTE: "2x butter" is stripped to "butter" because the ×N token
 *             carries no unit information the converter can use.
 *   •  · * – bullet characters
 *   1. 1)  – leading list numbering (handled by pasteSteps already, but can
 *             also appear when pasting raw ingredient lists)
 *   1–2    – en-dash / em-dash between digits normalised to a plain hyphen
 *             so that range amounts like "1–2 tsp" parse correctly everywhere.
 *
 * This runs unconditionally — the characters are never meaningful to the
 * converter and stripping them improves parse rates.
 *
 * @param {string} line
 * @returns {string}
 */
function sanitiseLine(line) {
  return line
    // Checkbox / square symbols anywhere in the line
    .replace(/[▢□☐☑☒]/g, '')
    // Leading bullet characters (but NOT a mid-line en-dash, handled below)
    .replace(/^[\s•·\-–—*]+/, '')
    // Leading list numbering: "1." or "1)"
    .replace(/^\d+[.)]\s*/, '')
    // Multiplier token at line start: "2x ", "3× ", "×2 " etc.
    // Only strip when it's a bare Nx/×N with no unit following immediately.
    .replace(/^(\d+\s*[xX×]|[xX×]\s*\d+)\s+/, '')
    // Normalise en-dash / em-dash between digits to a plain hyphen,
    // e.g. "1–2 tsp" → "1-2 tsp". Only between digits to avoid touching
    // prose dashes like "if needed – note 3".
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1-$2')
    // Collapse any double-spaces left behind and trim
    .replace(/\s{2,}/g, ' ')
    // Replace comma between two digits with a dot, e.g. "1,5 cups" → "1.5 cups"
    .replace(/(\d),(\d)/g, '$1.$2')
    .trim();
}

/**
 * Strips parenthesised annotations that are characteristic of converter output,
 * e.g. "(5-10 ml)", "(177 °F)", "(if needed – note 3)".
 * Used by pasteIngredients so that copying converter output back into a recipe
 * doesn't pollute the ingredient name field.
 *
 * Unlike stripParens (which is gated behind a checkbox), this always runs
 * during ingredient paste because these annotations are never part of a name.
 *
 * @param {string} line
 * @returns {string}
 */
function stripConverterAnnotations(line) {
  return line.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
}

function parseLine(rawLine) {
  // Sanitise first (remove checkboxes, bullets, multipliers, list numbers),
  // then strip parens if the user has that option enabled.
  let line = stripParens(sanitiseLine(rawLine));

  // Replace unicode fraction characters with ASCII fractions
  const unicodeFractions = {
    '½': '1/2', '⅓': '1/3', '⅔': '2/3',
    '¼': '1/4', '¾': '3/4', '⅛': '1/8',
    '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
  };
  for (const [unicode, ascii] of Object.entries(unicodeFractions)) {
    line = line.replaceAll(unicode, ascii);
  }

  // ── Temperature: "350 F" → "177 °C"
  const tempMatch = line.match(/^(\d+(?:\.\d+)?)\s*°?\s*(f|c)\b/i);
  if (tempMatch) {
    const value = parseFloat(tempMatch[1]);
    const unit  = tempMatch[2].toLowerCase();
    if (unit === 'f') {
      const celsius = Math.round((value - 32) * 5 / 9);
      return { html: `<span class="cn">${celsius} °C</span> <span class="cu">(${value} °F)</span>` };
    }
    // Already Celsius – show as-is
    return { html: `<span class="cn">${value} °C</span>` };
  }

  // ── Range: "5-6 oz chicken" or "1-2 cups milk"
  const rangeMatch = line.match(/^([\d.,]+(?:\/\d+)?)\s*[-–]\s*([\d.,]+(?:\/\d+)?)\s*([a-zA-Z°]+)(.*)/);
  if (rangeMatch) return convertRange(rangeMatch);

  // ── Mixed number: "1 1/2 cups" → "1.5 cups"
  line = line.replace(/(\d+)\s+(\d+\/\d+)/, (_, whole, frac) => {
    const fracValue = parseFraction(frac);
    return isNaN(fracValue) ? whole : String(parseInt(whole) + fracValue);
  });

  // ── Plain fraction: "3/4 cup" → "0.75 cup"
  line = line.replace(/(\d+)\/(\d+)/g, (_, num, den) =>
    String(parseFloat(num) / parseFloat(den))
  );

  // ── Standard format: "<number> <unit> <substance>"
  const match = line.match(/^([\d.,]+)\s*([a-zA-Z°]+)(.*)/);
  if (!match) return null;

  const number    = parseFloat(match[1].replace(',', '.'));
  const unit      = match[2].toLowerCase().replace(/\.$/, ''); // strip trailing dot
  const substance = match[3].trim().replace(/^of\s+/i, '');   // drop leading "of"

  return convertSingle(number, unit, substance);
}

/**
 * Converts a single quantity (number + unit + optional substance) to metric.
 * For volume units, uses the ingredient density (if known) to also show the mass.
 * For mass units, does the reverse.
 *
 * @param {number} num
 * @param {string} unit      - lowercase, e.g. "cup", "oz"
 * @param {string} substance - ingredient name, e.g. "flour" (used for density lookup)
 * @returns {{ html: string } | null}
 */
function convertSingle(num, unit, substance) {
  const substanceLower = substance.toLowerCase().trim();
  const density = getDensity(substanceLower);
  // Substance name always appears OUTSIDE any parenthetical annotation so that
  // stripConverterAnnotations() can cleanly remove "(237 ml)" without eating the name.
  const nameSpan = substanceLower ? ` <span class="cu">${substanceLower}</span>` : '';

  // ── Volume unit
  if (VOL_ML[unit] !== undefined) {
    const ml        = num * VOL_ML[unit];
    const mlRounded = Math.round(ml);

    if (KEEP_ORIGINAL_UNIT.has(unit)) {
      // Keep original unit (e.g. "2 tbsp"), add bracketed ml + g if density known.
      const info = density
        ? `${mlRounded} ml · ${Math.round(ml * density)} g`
        : `${mlRounded} ml`;
      return { html: `<span class="cn">${num} ${unit}</span> <span class="cx">(${info})</span>${nameSpan}` };
    }

    // Convert fully to ml; show g equivalent if density known.
    let html = `<span class="cn">${mlRounded} ml</span>`;
    if (density) html += ` <span class="cx">(≈ ${Math.round(ml * density)} g)</span>`;
    return { html: html + nameSpan };
  }

  // ── Mass unit
  if (MASS_G[unit] !== undefined) {
    const grams        = num * MASS_G[unit];
    const gramsRounded = Math.round(grams);
    let html = `<span class="cn">${gramsRounded} g</span>`;
    if (density) html += ` <span class="cx">(≈ ${Math.round(grams / density)} ml)</span>`;
    return { html: html + nameSpan };
  }

  return null; // unrecognised unit
}

/**
 * Converts a range like "5-6 oz chicken" to metric.
 * @param {RegExpMatchArray} m - regex groups: [full, lo, hi, unit, rest]
 * @returns {{ html: string } | null}
 */
function convertRange(m) {
  const lo  = parseFloat(m[1].replace(',', '.'));
  const hi  = parseFloat(m[2].replace(',', '.'));
  const unit = m[3].toLowerCase();
  const substanceLower = (m[4] || '').trim().replace(/^of\s+/i, '').toLowerCase();
  const density = getDensity(substanceLower);
  // Substance name always appears OUTSIDE any parenthetical annotation.
  const nameSpan = substanceLower ? ` <span class="cu">${substanceLower}</span>` : '';

  if (VOL_ML[unit] !== undefined) {
    const ml1 = Math.round(lo * VOL_ML[unit]);
    const ml2 = Math.round(hi * VOL_ML[unit]);

    if (KEEP_ORIGINAL_UNIT.has(unit)) {
      const info = density
        ? `${ml1}–${ml2} ml · ${Math.round(ml1 * density)}–${Math.round(ml2 * density)} g`
        : `${ml1}–${ml2} ml`;
      return { html: `<span class="cn">${lo}–${hi} ${unit}</span> <span class="cx">(${info})</span>${nameSpan}` };
    }

    let html = `<span class="cn">${ml1}–${ml2} ml</span>`;
    if (density) html += ` <span class="cx">(≈ ${Math.round(ml1 * density)}–${Math.round(ml2 * density)} g)</span>`;
    return { html: html + nameSpan };
  }

  if (MASS_G[unit] !== undefined) {
    const g1 = Math.round(lo * MASS_G[unit]);
    const g2 = Math.round(hi * MASS_G[unit]);
    let html = `<span class="cn">${g1}–${g2} g</span>`;
    if (density) html += ` <span class="cx">(≈ ${Math.round(g1 / density)}–${Math.round(g2 / density)} ml)</span>`;
    return { html: html + nameSpan };
  }

  return null;
}

/** Copies the current converter output (plain text, one line per ingredient) to the clipboard. */
function copyOutput() {
  const lines = [...document.getElementById('co').querySelectorAll('.cln')]
    .map(el => el.textContent)
    .join('\n');
  if (!lines.trim()) return;

  writeClipboard(lines).then(() => {
    const btn = document.getElementById('bcopy');
    btn.textContent = '✅ Kopeeritud';
    setTimeout(() => btn.textContent = '📋 Kopeeri', 2000);
  }).catch(() => toast('⚠️ Kopeerimine ebaõnnestus'));
}

function bindConvert() {
  document.getElementById('ci').addEventListener('input', doConvert);
  document.getElementById('cparens').addEventListener('click', doConvert);

  document.getElementById('bpaste').addEventListener('click', async () => {
    try {
      const text = await readClipboard();
      const ta   = document.getElementById('ci');
      // Append to any existing content rather than overwriting, so the user
      // can paste multiple batches without losing what is already there.
      const sep  = ta.value && !ta.value.endsWith('\n') ? '\n' : '';
      ta.value  += sep + text;
      doConvert();
      const btn  = document.getElementById('bpaste');
      btn.textContent = '✅ Kleebitud';
      setTimeout(() => btn.textContent = '📋 Kleebi', 2000);
    } catch {
      toast('⚠️ Lõikelaua lugemine ebaõnnestus');
    }
  });

  document.getElementById('bclear').addEventListener('click', () => {
    document.getElementById('ci').value = '';
    doConvert();
  });
}

/** Re-runs the converter over every line in the input textarea and updates the output. */
function doConvert() {
  const lines    = document.getElementById('ci').value.split('\n');
  const outputEl = document.getElementById('co');

  if (!lines.join('').trim()) {
    outputEl.innerHTML = '<span style="color:var(--text2);font-style:italic">Kirjuta vasakule...</span>';
    return;
  }

  let html = '';
  for (const rawLine of lines) {
    if (!rawLine.trim()) { continue; } // skip empty lines — don't emit blank rows

    // Sanitise and strip parens before both conversion and fallback display,
    // so e.g. "▢ (optional)" becomes blank rather than echoing back unchanged.
    const cleanedLine = stripParens(sanitiseLine(rawLine.trim()));
    if (!cleanedLine) { continue; } // skip lines that are entirely parenthesised annotations

    const result = parseLine(rawLine.trim());
    if (result) {
      html += `<span class="cln">${result.html}</span>`;
    } else {
      // Pass through unrecognised lines in muted style, using the cleaned text
      html += `<span class="cln" style="color:var(--text2)">${escHtml(cleanedLine)}</span>`;
    }
  }

  outputEl.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════
//  RECIPES — LIST PANEL
// ═══════════════════════════════════════════════════════════════

/** Rebuilds the label filter chip row below the search box. */
function renderFilters() {
  const container = document.getElementById('lfilt');
  container.innerHTML = '';

  // "All" chip – clears the active label filter
  const allChip = document.createElement('span');
  allChip.className = 'fchip' + (filterLabels.size === 0 ? ' on' : '');
  allChip.textContent = 'Kõik';
  allChip.addEventListener('click', () => {
    filterLabels.clear();
    renderFilters();
    renderCards();
  });
  container.appendChild(allChip);

  for (const label of settings.labels) {
    const chip = document.createElement('span');
    chip.className = 'fchip' + (filterLabels.has(label) ? ' on' : '');
    chip.textContent = label;
    chip.addEventListener('click', () => {
      if (filterLabels.has(label)) filterLabels.delete(label);
      else filterLabels.add(label);
      renderFilters();
      renderCards();
    });
    container.appendChild(chip);
  }
}

/**
 * Renders the recipe grid, applying the current text search and label filters.
 * Images are loaded asynchronously from IndexedDB to avoid blocking the render.
 */
function renderCards() {
  const grid = document.getElementById('rcards');

  // Text filter (matches name or any label)
  let filtered = recipes.slice();
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(r =>
      r.name.toLowerCase().includes(q) ||
      (r.labels || []).some(l => l.toLowerCase().includes(q)) ||
      (searchIngredients && (r.ingredients || []).some(i => (i.name || '').toLowerCase().includes(q)))
    );
  }

  // Label filter (recipe must have at least one active label)
  if (filterLabels.size > 0) {
    filtered = filtered.filter(r =>
      (r.labels || []).some(l => filterLabels.has(l))
    );
  }

  // Sort
  if (sortOrder === 'alpha') {
    filtered.sort((a, b) => a.name.localeCompare(b.name, 'et'));
  } else {
    // newest first — use `created` timestamp, fall back to 0 for old recipes
    filtered.sort((a, b) => (b.created || 0) - (a.created || 0));
  }

  grid.innerHTML = '<div class="cards-grid" id="cards-inner"></div>';
  const inner = document.getElementById('cards-inner');

  if (!filtered.length) {
    // Show empty state but still append the add-card below it
    const msg = recipes.length
      ? 'Otsingule vastuseid ei leitud.'
      : 'Alusta esimese retsepti lisamist!';
    inner.innerHTML = `
      <div class="empty">
        <div class="ei">🍽️</div>
        <h3>Retsepte pole</h3>
        <p style="font-size:14px">${msg}</p>
      </div>`;
  }
  for (const recipe of filtered) {
    const card = document.createElement('div');
    card.className = 'rcard';

    const labelChips = (recipe.labels || [])
      .map(l => `<span class="lchip">${escHtml(l)}</span>`)
      .join('');

    // Placeholder image slot; replaced below if the recipe has an image
    card.innerHTML = `
      <div class="rcard-img" id="ci-${recipe.id}"><span class="noimg">🍽️</span></div>
      <div class="rcard-body">
        <div class="rcard-name">${escHtml(recipe.name)}</div>
        <div class="rcard-labels">${labelChips}</div>
        <div class="rcard-meta">
          ${recipe.servings || 1} portsjonit
          ${recipe.updated || recipe.created
            ? ' · ' + new Date(recipe.updated || recipe.created).toLocaleDateString('et-EE')
            : ''}
        </div>
      </div>`;

    card.addEventListener('click', () => openDetail(recipe.id));
    inner.appendChild(card);

    // Load image lazily (stored separately to keep recipe objects small)
    if (recipe.imageId) {
      dbGet('images', recipe.imageId).then(imgRecord => {
        if (!imgRecord) return;
        const slot = document.getElementById('ci-' + recipe.id);
        if (slot) slot.innerHTML = `<img src="${imgRecord.data}" alt="${escHtml(recipe.name)}" loading="lazy">`;
      });
    }
  }

  // Add-recipe card is always last, regardless of active filters
  const addCard = document.createElement('button');
  addCard.className = 'rcard-add';
  addCard.title     = 'Lisa retsept';
  addCard.innerHTML = `
    <span class="rcard-add-icon">+</span>
    <span class="rcard-add-label">Lisa retsept</span>`;
  addCard.addEventListener('click', () => openForm());
  inner.appendChild(addCard);
}

// ═══════════════════════════════════════════════════════════════
//  RECIPES — DETAIL PANEL
// ═══════════════════════════════════════════════════════════════

/**
 * Loads a recipe into the detail panel and navigates to it.
 * @param {string} id - recipe ID
 */
async function openDetail(id) {
  activeRecipeId = id;
  const recipe = recipes.find(r => r.id === id);
  if (!recipe) return;

  origServings = recipe.servings || 1;
  scaleFactor  = 1;

  document.getElementById('dname').textContent = recipe.name;
  document.getElementById('sorig').textContent = `Originaal: ${origServings}`;
  document.getElementById('sdisp').textContent = origServings;
  document.getElementById('dlabels').innerHTML = (recipe.labels || [])
    .map(l => `<span class="lchip">${escHtml(l)}</span>`)
    .join('');

  // Hero image
  const heroEl = document.getElementById('dhero');
  heroEl.style.display = 'none';
  if (recipe.imageId) {
    const imgRecord = await dbGet('images', recipe.imageId);
    if (imgRecord) {
      document.getElementById('dhimg').src = imgRecord.data;
      heroEl.style.display = 'block';
    }
  }

  renderIngredients(recipe, 1);
  renderSteps(recipe);
  // Only reset the timer if it's not already running for this session
  if (!timerRunning && timerRemaining === 0) resetTimer();
  else restoreTimerState();
  showPanel('pd');
}

function parseLocaleNumber(str) {
  if (!str) return NaN;
  return parseFloat(str.replace(',', '.'));
}

/**
 * Renders the ingredient list with amounts multiplied by the given scale factor.
 * @param {Object} recipe
 * @param {number} scale - e.g. 2 for double portions
 */
function renderIngredients(recipe, scale) {
  const list = document.getElementById('dil');
  list.innerHTML = '';

  for (const ing of (recipe.ingredients || [])) {
    const li = document.createElement('li');

    const rawAmt = ing.amount || '';
    const num    = parseLocaleNumber(rawAmt);

    const scaled = isNaN(num)
      ? rawAmt
      : fmtNum(num * scale) + ' ' + (ing.unit || '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'view-check';
    cb.setAttribute('aria-label', ing.name || '');
    cb.addEventListener('change', () =>
      li.classList.toggle('checked', cb.checked)
    );

    const spanAmt = document.createElement('span');
    spanAmt.className = 'iamt';
    spanAmt.textContent = scaled.trim();

    const spanName = document.createElement('span');
    spanName.textContent = ing.name || '';

    li.appendChild(cb);
    li.appendChild(spanAmt);
    li.appendChild(spanName);

    list.appendChild(li);
  }
}


/** Renders the numbered step list in the detail panel. */
function renderSteps(recipe) {
  const list = document.getElementById('dsl');
  list.innerHTML = '';
  (recipe.steps || []).forEach((step, index) => {
    const li = document.createElement('li');
    const stepCb = document.createElement('input');
    stepCb.type      = 'checkbox';
    stepCb.className = 'view-check';
    stepCb.setAttribute('aria-label', `Samm ${index + 1}`);
    stepCb.addEventListener('change', () => li.classList.toggle('checked', stepCb.checked));
    li.appendChild(stepCb);
    li.innerHTML += `<span class="snum">${index + 1}</span><span class="stxt">${escHtml(step)}</span>`;
    list.appendChild(li);
  });
}

/**
 * Formats a number for display in the ingredient list:
 * integers are shown whole; decimals are rounded to 2 places.
 */
function fmtNum(n) {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

// ═══════════════════════════════════════════════════════════════
//  RECIPES — EDIT / CREATE FORM
// ═══════════════════════════════════════════════════════════════

/**
 * Opens the recipe form, pre-filled for editing when an ID is provided,
 * or blank for creating a new recipe.
 * @param {string|null} [id=null]
 */
function openForm(id = null) {
  editingId  = id;
  formImg    = null;
  formDirty  = false; // reset — form is clean when first opened
  const recipe = id ? recipes.find(r => r.id === id) : null;

  document.getElementById('ftitle').textContent   = id ? 'Muuda retsepti' : 'Uus retsept';
  document.getElementById('fid').value            = id || '';
  document.getElementById('fname').value          = recipe ? recipe.name : '';
  // Sync counter to the pre-filled name length
  const _fnLen = (recipe ? recipe.name : '').length;
  const _fnCtr = document.getElementById('fname-counter');
  if (_fnCtr) {
    _fnCtr.textContent = `${_fnLen} / ${MAX_RECIPE_NAME}`;
    _fnCtr.style.color = _fnLen >= MAX_RECIPE_NAME ? 'var(--danger)' : 'var(--text2)';
  }
  document.getElementById('fservings').value      = recipe ? recipe.servings : 4;
  document.getElementById('bdel').style.display   = id ? '' : 'none';

  renderFormLabels(recipe ? recipe.labels : []);

  // Reset image preview area
  const preview   = document.getElementById('iprev');
  const removeBtn = document.getElementById('brmimg');
  preview.innerHTML = '<div class="iprev-txt">📷 Vajuta pildi lisamiseks<br><span style="font-size:12px;opacity:.7">või kleebi lõikelaualt (Ctrl+V)</span></div>';
  removeBtn.style.display = 'none';

  if (id && recipe && recipe.imageId) {
    dbGet('images', recipe.imageId).then(imgRecord => {
      if (imgRecord) {
        formImg = imgRecord.data;
        preview.innerHTML = `<img src="${formImg}" alt="">`;
        removeBtn.style.display = '';
      }
    });
  }

  // Populate ingredient rows
  const ingEditor = document.getElementById('ied');
  ingEditor.innerHTML = '';
  if (recipe && recipe.ingredients && recipe.ingredients.length) {
    for (const ing of recipe.ingredients) addIngRow(ing);
  } else {
    addIngRow(); addIngRow(); addIngRow(); // 3 blank rows for a new recipe
  }

  // Populate step rows
  const stepEditor = document.getElementById('sed');
  stepEditor.innerHTML = '';
  if (recipe && recipe.steps && recipe.steps.length) {
    for (const step of recipe.steps) addStepRow(step);
  } else {
    addStepRow(); addStepRow(); // 2 blank rows for a new recipe
  }

  showPanel('pf');
  // Reset scroll position and focus the name field
  const fbody = document.querySelector('.fbody');
  if (fbody) fbody.scrollTop = 0;
  // Small delay so the panel transition completes before focus/keyboard
  setTimeout(() => {
    const nameField = document.getElementById('fname');
    if (nameField) nameField.focus();
  }, 200);
}

/**
 * Renders the label toggle buttons in the form.
 * @param {string[]} activeLabels - labels that should start toggled on
 */
function renderFormLabels(activeLabels) {
  const container = document.getElementById('flabels');
  container.innerHTML = '';
  for (const label of settings.labels) {
    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'ltog' + (activeLabels && activeLabels.includes(label) ? ' on' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => btn.classList.toggle('on'));
    container.appendChild(btn);
  }
}

/** Units available in the ingredient unit dropdown. */
const INGREDIENT_UNITS = ['g', 'kg', 'ml', 'l', 'tk', 'dl', 'tl', 'spl', 'cup', 'oz', 'lb'];

/** Set of known units in lowercase for O(1) lookup. */
const UNIT_SET = new Set(INGREDIENT_UNITS.map(u => u.toLowerCase()));

/**
 * Normalises a unit word to the canonical form stored in INGREDIENT_UNITS.
 * Handles common plurals that appear in converter output or pasted text:
 *   "cups" → "cup",  "lbs" → "lb",  "ounces" → "oz" (via the unit table)
 *
 * Returns the canonical unit string, or null if the word is not a known unit.
 * @param {string} word
 * @returns {string|null}
 */
function normaliseUnit(word) {
  const w = word.toLowerCase();
  if (UNIT_SET.has(w)) return word.toLowerCase();
  // Try stripping a trailing 's' (cups→cup, lbs→lb, etc.)
  if (w.endsWith('s') && UNIT_SET.has(w.slice(0, -1))) return w.slice(0, -1);
  return null; // not a known unit
}

/**
 * Appends one ingredient row to the ingredient editor.
 * @param {Object} [ing={}] - optional pre-filled values { amount, unit, name }
 */
function addIngRow(ing = {}) {
  const editor = document.getElementById('ied');
  const row    = document.createElement('div');
  row.className = 'irow';

  // Default to 'tk' (pieces) when no unit is specified — more useful than 'g'
  // for blank rows and for ingredients without a natural unit.
  const defaultUnit = ing.unit !== undefined ? ing.unit : 'tk';
  const unitOptions = INGREDIENT_UNITS
    .map(u => `<option value="${u}"${defaultUnit === u ? ' selected' : ''}>${u || '—'}</option>`)
    .join('');

  row.innerHTML = `
    <span class="drag-handle" title="Lohista ümberjärjestamiseks">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="4.5" cy="3.5" r=".8" fill="currentColor" stroke="none"/>
        <circle cx="4.5" cy="7"   r=".8" fill="currentColor" stroke="none"/>
        <circle cx="4.5" cy="10.5" r=".8" fill="currentColor" stroke="none"/>
        <circle cx="9.5" cy="3.5" r=".8" fill="currentColor" stroke="none"/>
        <circle cx="9.5" cy="7"   r=".8" fill="currentColor" stroke="none"/>
        <circle cx="9.5" cy="10.5" r=".8" fill="currentColor" stroke="none"/>
      </svg>
    </span>
    <input type="text" class="iamt" placeholder="Kogus" value="${escHtml(ing.amount || '')}" inputmode="decimal">
    <select>${unitOptions}</select>
    <input type="text" class="iname" placeholder="Koostisosa nimi" value="${escHtml(ing.name || '')}">
    <button class="rmbtn" title="Eemalda">×</button>`;

  row.querySelector('.rmbtn').addEventListener('click', () => row.remove());
  editor.appendChild(row);
  return row;
}

/**
 * Appends one step row to the step editor.
 * @param {string} [text=''] - optional pre-filled step text
 */
function addStepRow(text = '') {
  const editor     = document.getElementById('sed');
  const stepNumber = editor.children.length + 1;
  const row        = document.createElement('div');
  row.className    = 'srow';

  row.innerHTML = `
    <span class="drag-handle" title="Lohista ümberjärjestamiseks">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="4.5" cy="3.5" r=".8" fill="currentColor" stroke="none"/>
        <circle cx="4.5" cy="7"   r=".8" fill="currentColor" stroke="none"/>
        <circle cx="4.5" cy="10.5" r=".8" fill="currentColor" stroke="none"/>
        <circle cx="9.5" cy="3.5" r=".8" fill="currentColor" stroke="none"/>
        <circle cx="9.5" cy="7"   r=".8" fill="currentColor" stroke="none"/>
        <circle cx="9.5" cy="10.5" r=".8" fill="currentColor" stroke="none"/>
      </svg>
    </span>
    <span class="snum">${stepNumber}</span>
    <textarea placeholder="Sammu kirjeldus..." rows="2">${escHtml(text)}</textarea>
    <button class="rmbtn" title="Eemalda">×</button>`;

  // On removal, renumber all remaining steps
  row.querySelector('.rmbtn').addEventListener('click', () => {
    row.remove();
    document.getElementById('sed').querySelectorAll('.snum')
      .forEach((el, i) => el.textContent = i + 1);
  });

  editor.appendChild(row);
}

/**
 * Marks the recipe form as having unsaved changes.
 * Called by event delegation on any input/change inside the form body.
 */
function markFormDirty() {
  formDirty = true;
}

/** Reads the form, validates it, and saves the recipe to IndexedDB. */
async function saveForm() {
  const name = document.getElementById('fname').value.trim().slice(0, 60);
  if (!name) { toast('⚠️ Sisesta retsepti nimi'); return; }

  const servings = parseInt(document.getElementById('fservings').value) || 1;

  const labels = Array.from(document.querySelectorAll('#flabels .ltog.on'))
    .map(btn => btn.textContent);

  // Collect non-empty ingredient rows
  const ingredients = [];
  for (const row of document.getElementById('ied').querySelectorAll('.irow')) {
    const inputs = row.querySelectorAll('input, select');
    const amount = inputs[0].value.trim();
    const unit   = inputs[1].value;
    const name_  = inputs[2].value.trim();
    if (name_ || amount) ingredients.push({ amount, unit, name: name_ });
  }

  // Collect non-empty step rows
  const steps = [];
  for (const ta of document.getElementById('sed').querySelectorAll('.srow textarea')) {
    const txt = ta.value.trim();
    if (txt) steps.push(txt);
  }

  // Warn if both ingredients and steps are empty — likely an accidental save
  if (!ingredients.length && !steps.length) {
    const proceed = await modal(
      'Tühi retsept',
      'Retseptil pole ühtegi koostisosa ega sammu. Kas soovid ikkagi salvestada?',
      'Salvesta'
    );
    if (!proceed) return;
  }

  const id = editingId || ('r' + Date.now());
  let imageId = null;

  // Carry over existing imageId when editing
  if (editingId) {
    const existing = recipes.find(r => r.id === editingId);
    imageId = existing ? existing.imageId : null;
  }

  if (formImg) {
    // New or replaced image: store it (reuse existing key when possible)
    imageId = imageId || ('img' + id);
    await dbPut('images', { id: imageId, data: formImg });
  } else if (!formImg && imageId && editingId) {
    // Image was explicitly removed: delete the stored record
    const existing = recipes.find(r => r.id === editingId);
    if (existing && existing.imageId) {
      await dbDelete('images', existing.imageId);
      imageId = null;
    }
  }

  const existingCreated = editingId
    ? (recipes.find(r => r.id === editingId)?.created || Date.now())
    : Date.now();
  const recipe = { id, name, labels, servings, ingredients, steps, imageId,
    created: existingCreated, updated: Date.now() };
  await dbPut('recipes', recipe);

  // Keep the in-memory array in sync
  if (editingId) {
    const idx = recipes.findIndex(r => r.id === editingId);
    if (idx >= 0) recipes[idx] = recipe;
    else recipes.push(recipe);
  } else {
    recipes.push(recipe);
  }

  formDirty = false; // saved — no longer dirty
  markDirty();
  renderCards();
  toast('✅ Retsept salvestatud!');
  activeRecipeId = id;
  await openDetail(id);
}

/** Asks for confirmation then permanently deletes the currently edited recipe. */
async function deleteRecipe() {
  const confirmed = await modal(
    'Kustuta retsept',
    'Oled kindel, et soovid selle retsepti kustutada? Seda ei saa tagasi võtta.',
    'Kustuta'
  );
  if (!confirmed) return;

  const recipe = recipes.find(r => r.id === editingId);
  if (recipe && recipe.imageId) await dbDelete('images', recipe.imageId);
  await dbDelete('recipes', editingId);
  recipes = recipes.filter(r => r.id !== editingId);

  markDirty();
  renderCards();
  toast('🗑️ Retsept kustutatud');
  showPanel('pl');
}

/**
 * Reads ingredient lines from the clipboard and populates the ingredient editor.
 *
 * Parsing strategy for each line (after sanitising and stripping parens):
 *   "2 cups flour"                       → amount=2,   unit=cup,  name=flour
 *   "1-2 tsp (5-10 ml) sugar (optional)" → amount=1-2, unit=tsp,  name=sugar
 *   "2 garlic cloves"                    → amount=2,   unit='',   name=garlic cloves
 *   "salt"                               → amount='',  unit='',   name=salt
 */
async function pasteIngredients() {
  try {
    const text  = await readClipboard();
    const lines = text.split('\n').map(l => sanitiseLine(l.trim())).filter(Boolean);
    const editor = document.getElementById('ied');
    editor.innerHTML = '';

    for (const line of lines) {
      // Remove parenthesised annotations produced by the converter, e.g.:
      //   "1-2 tsp (5-10 ml) sugar (if needed – note 3)"
      //   → "1-2 tsp sugar"
      const cleaned = stripConverterAnnotations(line);
      if (!cleaned) continue;

      // Regex breakdown:
      //   m[1] – optional leading amount: single number OR range (e.g. "1-2", "1/2")
      //   m[2] – a word immediately after the amount (unit or first name word)
      //   m[3] – everything after m[2], may be empty (two-token lines like "1 sibul")
      //   m[4] – fallback: line that starts with a letter (no leading number at all)
      // Note: m[3] is now optional (.*) so "1 sibul" matches with m[3]=''.
      const m = cleaned.match(
        /^([\d.,\/][\d.,\/\s\-]*)\s+([a-zA-ZÀ-ž]+)(.*)?$|^([a-zA-ZÀ-ž].+)$/
      );

      if (!m) {
        // Pure number or unrecognisable — store as name
        addIngRow({ name: cleaned });
        continue;
      }

      // Branch A: line starts with a letter — whole thing is the name
      if (m[4] !== undefined) {
        addIngRow({ name: m[4].trim() });
        continue;
      }

      // Branch B: leading amount + optional unit/word + optional rest
      // e.g. "1 sibul"              → amount=1,   maybeUnit=sibul,  rest=''
      //      "2 garlic cloves"      → amount=2,   maybeUnit=garlic, rest='cloves'
      //      "1 tsp salt"           → amount=1,   maybeUnit=tsp,    rest='salt'
      //      "1-2 tsp (5ml) sugar"  → amount=1-2, maybeUnit=tsp,    rest='sugar'
      const amountRaw = (m[1] || '').trim();
      const maybeUnit = (m[2] || '').trim();
      const rest      = (m[3] || '').trim();
      const canonical = normaliseUnit(maybeUnit);

      // If the word after the amount is a known unit, use it.
      // Otherwise the word IS part of the name — default unit to 'tk'.
      const unitFallback = amountRaw ? 'tk' : '';

      addIngRow({
        amount: amountRaw,
        unit:   canonical || unitFallback,
        // Not a known unit → the word belongs to the name
        name:   canonical ? rest : [maybeUnit, rest].filter(Boolean).join(' '),
      });
    }

    if (!lines.length) addIngRow();
    toast('📋 Kleebitud ' + lines.length + ' rida');
  } catch {
    toast('⚠️ Lõikelaua lugemine ebaõnnestus');
  }
}

/** Reads numbered steps from the clipboard and populates the step editor. */
async function pasteSteps() {
  try {
    const text = await readClipboard();
    const lines = text.split('\n')
      .map(l => l.trim().replace(/^\d+[\.\)]\s*/, '')) // strip "1. " or "1) " prefixes
      .filter(Boolean);
    const editor = document.getElementById('sed');
    editor.innerHTML = '';
    for (const line of lines) addStepRow(line);
    if (!lines.length) addStepRow();
    toast('📋 Kleebitud ' + lines.length + ' sammu');
  } catch {
    toast('⚠️ Lõikelaua lugemine ebaõnnestus');
  }
}

/**
 * Makes the rows inside a container sortable by dragging the .drag-handle.
 * Works with both mouse and touch. After a drop, calls onReorder() so the
 * caller can renumber step labels etc.
 *
 * @param {HTMLElement} container - the parent element whose children are sortable
 * @param {Function}    [onReorder] - optional callback after a successful drop
 */
function enableDragSort(container, onReorder) {
  let dragging = null;

  container.addEventListener('pointerdown', e => {
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    dragging = handle.closest('.irow, .srow');
    if (!dragging) return;
    dragging.classList.add('row-dragging');
    dragging.setPointerCapture(e.pointerId);
  });

  container.addEventListener('pointermove', e => {
    if (!dragging) return;
    e.preventDefault();
    const rows = [...container.querySelectorAll('.irow, .srow')].filter(r => r !== dragging);
    // Find the row whose midpoint we're above
    let target = null;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) { target = row; break; }
    }
    // Move the dragged row before the target (or to the end)
    container.insertBefore(dragging, target || null);
  });

  container.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging.classList.remove('row-dragging');
    dragging = null;
    if (onReorder) onReorder();
  });

  container.addEventListener('pointercancel', () => {
    if (dragging) dragging.classList.remove('row-dragging');
    dragging = null;
  });
}

function bindRecipes() {
  document.getElementById('rsearch').addEventListener('input', e => {
    searchQuery = e.target.value;
    renderCards();
  });

  // Live character counter for recipe name input
  const fnameEl   = document.getElementById('fname');
  const fnameCounter = document.getElementById('fname-counter');
  fnameEl.addEventListener('input', () => {
    const len = fnameEl.value.length;
    fnameCounter.textContent = `${len} / ${MAX_RECIPE_NAME}`;
    fnameCounter.style.color = len >= MAX_RECIPE_NAME ? 'var(--danger)' : 'var(--text2)';
  });

  document.getElementById('bsort-newest').addEventListener('click', () => {
    sortOrder = 'newest';
    document.getElementById('bsort-newest').classList.add('on');
    document.getElementById('bsort-alpha').classList.remove('on');
    renderCards();
  });
  document.getElementById('bsort-alpha').addEventListener('click', () => {
    sortOrder = 'alpha';
    document.getElementById('bsort-alpha').classList.add('on');
    document.getElementById('bsort-newest').classList.remove('on');
    renderCards();
  });

  document.getElementById('csearchings').addEventListener('change', e => {
    searchIngredients = e.target.checked;
    renderCards();
  });

  // Detail panel: back → list; edit → form
  document.getElementById('bback1').addEventListener('click', () => { stopTimer(); showPanel('pl'); });
  document.getElementById('bedit').addEventListener('click', () => openForm(activeRecipeId));

  // Form panel: back → detail (or list if nothing was open); delete; save
  document.getElementById('bback2').addEventListener('click', async () => {
    if (formDirty) {
      const leave = await modal(
        'Salvestamata muudatused',
        'Sul on salvestamata muudatused. Kas soovid lahkuda?',
        'Lahku'
      );
      if (!leave) return;
    }
    formDirty = false;
    // Only return to detail view when editing an existing recipe.
    // When creating a new one, editingId is null so go back to the list.
    if (editingId) openDetail(editingId);
    else showPanel('pl');
  });
  document.getElementById('bdel').addEventListener('click', deleteRecipe);
  document.getElementById('bsave').addEventListener('click', saveForm);

  // Mark form dirty on any change inside the form body (input, textarea, select, checkbox)
  document.querySelector('.fbody').addEventListener('input',  markFormDirty);
  document.querySelector('.fbody').addEventListener('change', markFormDirty);
  // .ltog label buttons fire click, not change — catch them separately
  document.getElementById('flabels').addEventListener('click', e => {
    if (e.target.classList.contains('ltog')) markFormDirty();
  });

  // Drag-to-reorder for ingredient and step rows
  enableDragSort(document.getElementById('ied'), () => markFormDirty());
  enableDragSort(document.getElementById('sed'), () => {
    // Renumber step labels after reorder
    document.getElementById('sed').querySelectorAll('.snum')
      .forEach((el, i) => el.textContent = i + 1);
    markFormDirty();
  });

  // Form – ingredient & step rows
  document.getElementById('baddrow').addEventListener('click', () => addIngRow());
  document.getElementById('baddstep').addEventListener('click', () => addStepRow());
  document.getElementById('bpasteing').addEventListener('click', pasteIngredients);
  document.getElementById('bpastestep').addEventListener('click', pasteSteps);

  // Form – image upload
  /**
   * Loads an image File into the form preview and sets formImg.
   * Shared by the file picker, drag-drop and clipboard paste.
   * @param {File} file
   */
  function setFormImage(file) {
    if (!file || !file.type.startsWith('image/')) {
      toast('⚠️ Lõikelaud ei sisalda pilti');
      return;
    }
    const reader = new FileReader();
    reader.onload = ev => {
      formImg = ev.target.result;
      document.getElementById('iprev').innerHTML = `<img src="${formImg}" alt="">`;
      document.getElementById('brmimg').style.display = '';
      markFormDirty(); // image change not caught by fbody input delegation
    };
    reader.readAsDataURL(file);
  }

  document.getElementById('imgfi').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) setFormImage(file);
  });

  // Paste an image anywhere inside the recipe form panel (Ctrl+V / Cmd+V)
  document.getElementById('pf').addEventListener('paste', e => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItem = items.find(item => item.type.startsWith('image/'));
    if (!imageItem) return; // let normal text paste fall through
    e.preventDefault();
    setFormImage(imageItem.getAsFile());
  });
  document.getElementById('brmimg').addEventListener('click', () => {
    formImg = null;
    document.getElementById('iprev').innerHTML = '<div class="iprev-txt">📷 Vajuta pildi lisamiseks<br><span style="font-size:12px;opacity:.7">või kleebi lõikelaualt (Ctrl+V)</span></div>';
    document.getElementById('brmimg').style.display = 'none';
    markFormDirty();
  });

  // Serving scaler (− / +)
  document.getElementById('bminus').addEventListener('click', () => {
    const current = parseInt(document.getElementById('sdisp').textContent);
    if (current <= 1) return;
    const next = current - 1;
    document.getElementById('sdisp').textContent = next;
    scaleFactor = next / origServings;
    const recipe = recipes.find(r => r.id === activeRecipeId);
    if (recipe) renderIngredients(recipe, scaleFactor);
  });
  document.getElementById('bplus').addEventListener('click', () => {
    const current = parseInt(document.getElementById('sdisp').textContent);
    const next    = current + 1;
    document.getElementById('sdisp').textContent = next;
    scaleFactor = next / origServings;
    const recipe = recipes.find(r => r.id === activeRecipeId);
    if (recipe) renderIngredients(recipe, scaleFactor);
  });

  bindTimer();
}

// ═══════════════════════════════════════════════════════════════
//  COUNTDOWN TIMER
// ═══════════════════════════════════════════════════════════════

let timerInterval  = null;
let timerRemaining = 0;     // seconds left currently displayed
let timerEndTime   = null;  // Date.now() + remaining ms when timer is running
let timerRunning   = false;

/** Persists timer state to sessionStorage so it survives panel navigation. */
function saveTimerState() {
  sessionStorage.setItem('timerEndTime',  timerEndTime  ?? '');
  sessionStorage.setItem('timerRunning',  timerRunning  ? '1' : '');
  sessionStorage.setItem('timerRemaining', timerRemaining);
}

/** Restores timer state from sessionStorage and reconciles elapsed time. */
function restoreTimerState() {
  const savedEnd       = sessionStorage.getItem('timerEndTime');
  const savedRunning   = sessionStorage.getItem('timerRunning') === '1';
  const savedRemaining = parseInt(sessionStorage.getItem('timerRemaining') || '0', 10);

  if (savedRunning && savedEnd) {
    timerEndTime   = parseInt(savedEnd, 10);
    timerRunning   = true;
    // Reconcile: how many seconds are actually left?
    const msLeft = timerEndTime - Date.now();
    if (msLeft <= 0) {
      // Timer already expired while we were away
      timerRemaining = 0;
      timerRunning   = false;
      timerEndTime   = null;
      _renderTimerDisplay(0);
      _setTimerDoneState();
      playAlertSound();
    } else {
      timerRemaining = Math.ceil(msLeft / 1000);
      _renderTimerDisplay(timerRemaining);
      document.getElementById('tstart').textContent = '⏸ Peata';
      document.getElementById('timerw').classList.add('trun');
      timerInterval = setInterval(tickTimer, 1000);
    }
  } else if (!savedRunning && savedRemaining > 0) {
    // Paused timer — restore remaining time without starting
    timerRemaining = savedRemaining;
    timerEndTime   = null;
    _renderTimerDisplay(timerRemaining);
    document.getElementById('tstart').textContent = '▶ Jätka';
  }
}

function _renderTimerDisplay(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  document.getElementById('tdisp').textContent =
    String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function _setTimerDoneState() {
  document.getElementById('timerw').classList.remove('trun');
  document.getElementById('timerw').classList.add('tdone');
  document.getElementById('tstart').textContent = '✅ Valmis!';
}

/**
 * Plays a short four-note ascending chime using the Web Audio API.
 * Triggered automatically when the timer reaches zero.
 */
let audioCtx;
function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}
function unlockAudio() {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') {
    ctx.resume();
  }
}




function playAlertSound() {
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  const notes = [523, 659, 784, 1047];

  notes.forEach((freq, i) => {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.frequency.value = freq;
    osc.type = 'sine';

    const t = now + i * 0.18;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.3, t + 0.05);
    gain.gain.linearRampToValueAtTime(0, t + 0.22);

    osc.start(t);
    osc.stop(t + 0.25);
  });
}


function bindTimer() {
  document.getElementById('tstart').addEventListener('click', toggleTimer);
  document.getElementById('tstart').addEventListener('click', playAlertSound); // unlock audio on first interaction
  document.getElementById('treset').addEventListener('click', resetTimer);

  // Reconcile timer when user returns to the tab / app after being away
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!timerRunning || !timerEndTime) return;

    // Recompute remaining from wall clock
    const msLeft = timerEndTime - Date.now();
    if (msLeft <= 0) {
      // Fired while hidden
      clearInterval(timerInterval);
      timerRunning   = false;
      timerRemaining = 0;
      timerEndTime   = null;
      _renderTimerDisplay(0);
      _setTimerDoneState();
      toast('⏰ Taimer lõppes!', 3000);
      playAlertSound();
      setTimeout(playAlertSound, 1200);
      if ('vibrate' in navigator) navigator.vibrate([300, 100, 300, 100, 300]);
      saveTimerState();
    } else {
      timerRemaining = Math.ceil(msLeft / 1000);
      _renderTimerDisplay(timerRemaining);
    }
  });
}

function toggleTimer() {
  if (timerRunning) pauseTimer();
  else startTimer();
}

function startTimer() {
  // Read the time inputs only when starting from zero
  if (!timerRunning && timerRemaining === 0) {
    const minutes = parseInt(document.getElementById('tmin').value) || 0;
    const seconds = parseInt(document.getElementById('tsec').value) || 0;
    timerRemaining = minutes * 60 + seconds;
    if (timerRemaining <= 0) return;
  }
  timerRunning = true;
  timerEndTime = Date.now() + timerRemaining * 1000;
  document.getElementById('tstart').textContent = '⏸ Peata';
  document.getElementById('timerw').classList.add('trun');
  document.getElementById('timerw').classList.remove('tdone');
  _renderTimerDisplay(timerRemaining); // show immediately, don't wait for first tick
  timerInterval = setInterval(tickTimer, 1000);
  saveTimerState();
}

function pauseTimer() {
  timerRunning = false;
  timerEndTime = null;
  clearInterval(timerInterval);
  document.getElementById('tstart').textContent = '▶ Jätka';
  saveTimerState();
}

/** Stops the timer without resetting the remaining time. */
function stopTimer() {
  timerRunning = false;
  timerEndTime = null;
  clearInterval(timerInterval);
}

/** Stops and resets the timer back to 00:00. */
function resetTimer() {
  stopTimer();
  timerRemaining = 0;
  timerEndTime   = null;
  document.getElementById('tstart').textContent = '▶ Start';
  document.getElementById('tdisp').textContent  = '00:00';
  document.getElementById('timerw').classList.remove('trun', 'tdone');
  saveTimerState();
}

/** Called every second; derives remaining time from timerEndTime and fires alert at zero. */
function tickTimer() {
  // Derive from wall clock so accuracy survives tab sleep / navigation
  const msLeft       = timerEndTime ? timerEndTime - Date.now() : 0;
  timerRemaining     = Math.max(0, Math.ceil(msLeft / 1000));

  _renderTimerDisplay(timerRemaining);

  if (timerRemaining <= 0) {
    stopTimer();
    _setTimerDoneState();
    toast('⏰ Taimer lõppes!', 3000);
    // Play the chime twice with a short gap
    playAlertSound();
    setTimeout(playAlertSound, 1200);
    if ('vibrate' in navigator) navigator.vibrate([300, 100, 300, 100, 300]);
    saveTimerState();
    return;
  }

  saveTimerState();
}

// ═══════════════════════════════════════════════════════════════
//  IMPORT / EXPORT
// ═══════════════════════════════════════════════════════════════

function bindIO() {
  document.getElementById('breset').addEventListener('click', doFactoryReset);
  document.getElementById('bexp').addEventListener('click', () => doExport());
  document.getElementById('bimp').addEventListener('click', () =>
    document.getElementById('impfi').click()
  );
  document.getElementById('impfi').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      try {
        await doImport(JSON.parse(ev.target.result));
      } catch {
        toast('⚠️ Vigane fail – import ebaõnnestus');
      }
    };
    reader.readAsText(file);
    e.target.value = ''; // allow re-selecting the same file next time
  });
}

/**
 * Bundles all recipes, images and settings into a JSON file and triggers a download.
 * The filename includes today's date for easy identification.
 */
/**
 * Wipes ALL data from IndexedDB (recipes, images, settings) and reloads the app,
 * returning it to a factory-fresh state. Requires two-step confirmation.
 */
async function doFactoryReset() {
  // First confirmation
  const step1 = await modal(
    '⚠️ Tehase lähtestamine',
    'See kustutab KÕIK retseptid, pildid ja sätted jäädavalt. Varundamata andmeid ei saa taastada. Kas oled kindel?',
    'Jah, kustuta kõik'
  );
  if (!step1) return;

  // Second confirmation — must type to proceed
  const step2 = await modal(
    'Viimane hoiatus',
    'Kõik andmed kustutatakse JÄÄDAVALT. Seda toimingut ei saa tagasi võtta. Kas jätkan?',
    'Kustutan jäädavalt'
  );
  if (!step2) return;

  // Wipe all three stores
  for (const r   of await dbGetAll('recipes'))  await dbDelete('recipes',  r.id);
  for (const img of await dbGetAll('images'))   await dbDelete('images',   img.id);
  for (const s   of await dbGetAll('settings')) await dbDelete('settings', s.key);

  // Reload to reinitialise with clean defaults
  window.location.reload();
}

/**
 * Triggers a JSON backup download.
 * If stored images exceed IMAGE_WARN_BYTES, warns the user and offers to
 * export without images (structured data only) or include them anyway.
 *
 * @param {boolean} [includeImages=true]
 */
async function doExport(includeImages = true) {
  const IMAGE_WARN_MB    = 5;
  const IMAGE_WARN_BYTES = IMAGE_WARN_MB * 1024 * 1024;

  const allRecipes = await dbGetAll('recipes');
  const allImages  = await dbGetAll('images');

  // Measure total base64 image data size (each char ≈ 1 byte in UTF-16)
  const imageSizeBytes = allImages.reduce((sum, img) => sum + (img.data?.length ?? 0), 0);
  const imageSizeMB    = (imageSizeBytes / (1024 * 1024)).toFixed(1);

  // If images are large and we haven't already been asked, prompt the user
  if (includeImages && imageSizeBytes > IMAGE_WARN_BYTES) {
    const choice = await modalChoice(
      'Suur varukoopia',
      `Retseptide pildid võtavad kokku ${imageSizeMB} MB. Saad eksportida ilma piltideta (väiksem fail, andmed säilivad) või koos piltidega (täielik varukoopia).`,
      'Koos piltidega',
      'Ilma piltideta'
    );
    if (choice === 'cancel') return;
    if (choice === 'alternative') return doExport(false); // re-run without images
    // 'primary' → fall through and export with images
  }

  const payload = {
    recipes:  allRecipes,
    images:   includeImages ? allImages : [],
    settings,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');

  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  link.download = `sahver-${dateStr}${includeImages ? '' : '-no-images'}.json`;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);

  settings.lastExport = Date.now();
  settings.dirty      = false;
  await saveSettings();
  checkBackupWarning();
  toast(includeImages
    ? '✅ Täielik varukoopia alla laetud!'
    : `✅ Varukoopia alla laetud (pildid välja jäetud, ${imageSizeMB} MB säästetud)`
  );
}

/**
 * Imports a JSON backup, replacing ALL existing data after the user confirms.
 * @param {Object} data - parsed JSON from the backup file
 */
async function doImport(data) {
  const confirmed = await modal(
    'Impordi andmed',
    'See asendab kõik olemasolevad retseptid ja sätted imporditud andmetega. Jätka?',
    'Impordi'
  );
  if (!confirmed) return;

  // Wipe existing data from all stores
  for (const r   of await dbGetAll('recipes')) await dbDelete('recipes', r.id);
  for (const img of await dbGetAll('images'))  await dbDelete('images',  img.id);

  // Write imported records
  for (const r   of (data.recipes || [])) await dbPut('recipes', r);
  for (const img of (data.images  || [])) await dbPut('images',  img);
  if (data.settings) Object.assign(settings, data.settings);

  // Treat a successful import as a fresh backup point regardless of whether
  // the file included images — the structured recipe data is what matters.
  settings.lastExport = Date.now();
  settings.dirty      = false;

  await saveSettings();
  recipes = await dbGetAll('recipes');
  applyTheme(settings.palette);
  renderFilters();
  renderCards();
  renderSettingsUI();
  checkBackupWarning(); // dismiss the warning banner immediately after a successful import
  toast('✅ Import õnnestus! ' + recipes.length + ' retsepti laetud.');
}

/**
 * Shows or hides the backup warning banner (and nav badge).
 * The warning is shown when data has been modified but not exported in over 7 days.
 */
function checkBackupWarning() {
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const shouldWarn  = settings.dirty && (Date.now() - settings.lastExport > ONE_WEEK_MS);

  document.getElementById('bwarn').classList.toggle('show',  shouldWarn);
  document.getElementById('bb1').classList.toggle('h', !shouldWarn); // sidebar badge
  document.getElementById('bb2').classList.toggle('h', !shouldWarn); // mobile nav badge
}

/** Marks the data as dirty (unsaved since last export) and triggers a warning check. */
function markDirty() {
  settings.dirty = true;
  saveSettings();  // fire-and-forget
  checkBackupWarning();
}

// ═══════════════════════════════════════════════════════════════
//  SETTINGS UI
// ═══════════════════════════════════════════════════════════════

/**
 * Preset colour palettes shown as swatches.
 * Each entry is a { bg, accent } pair; the last one is the dark theme.
 */
const PALETTES = [
  { bg: '#f7f4ee', accent: '#f2b705' }, // warm amber (default)
  { bg: '#f0f4f0', accent: '#4caf82' }, // fresh green
  { bg: '#f4f0f7', accent: '#9c6fcc' }, // soft purple
  { bg: '#f4f0ee', accent: '#d96a3a' }, // burnt orange
  { bg: '#eef2f7', accent: '#4a7cc7' }, // calm blue
  { bg: '#1c1a14', accent: '#f2b705' }, // dark mode
];

/** Rebuilds the entire settings panel (swatches + label editor + density editor). */
function renderSettingsUI() {
  const swatchContainer = document.getElementById('swatches');
  swatchContainer.innerHTML = '';

  for (const palette of PALETTES) {
    const swatch    = document.createElement('div');
    const isActive  = palette.accent === settings.palette.accent &&
                      palette.bg     === settings.palette.bg;
    swatch.className = 'sw' + (isActive ? ' on' : '');
    swatch.style.background = `linear-gradient(135deg, ${palette.bg} 50%, ${palette.accent} 50%)`;
    swatch.title = palette.accent;
    swatch.addEventListener('click', () => {
      applyTheme(palette);
      document.querySelectorAll('.sw').forEach(s => s.classList.remove('on'));
      swatch.classList.add('on');
      // Keep the colour picker inputs in sync with the selected palette
      document.getElementById('cbg').value  = palette.bg;
      document.getElementById('cacc').value = palette.accent;
      saveSettings(); // user action — persist the palette choice
      markDirty();
    });
    swatchContainer.appendChild(swatch);
  }

  document.getElementById('cbg').value  = settings.palette.bg;
  document.getElementById('cacc').value = settings.palette.accent;
  renderLabelSettings();
  renderDensSettings();
}

function renderLabelSettings() {
  const container = document.getElementById('lman');
  container.innerHTML = '';
  for (const label of settings.labels) {
    const row = document.createElement('div');
    row.className = 'litem';
    row.innerHTML = `<input type="text" value="${escHtml(label)}"><button class="rmbtn">×</button>`;
    row.querySelector('.rmbtn').addEventListener('click', () => row.remove());
    container.appendChild(row);
  }
}

function renderDensSettings() {
  const container = document.getElementById('denslist');
  container.innerHTML = '';
  for (const [substanceName, density] of Object.entries(settings.densities)) {
    const row = document.createElement('div');
    row.className = 'drow';
    row.innerHTML = `
      <input type="text"   class="dname" value="${escHtml(substanceName)}" placeholder="Aine nimi (nt: flour, jahu)">
      <input type="number" class="dval"  value="${density}" step="0.01" min="0" placeholder="g/ml">
      <button class="rmbtn">×</button>`;
    row.querySelector('.rmbtn').addEventListener('click', () => row.remove());
    container.appendChild(row);
  }
}

function bindSettings() {
  // Apply custom colour picker values
  document.getElementById('bapply').addEventListener('click', () => {
    applyTheme({
      bg:     document.getElementById('cbg').value,
      accent: document.getElementById('cacc').value,
    });
    document.querySelectorAll('.sw').forEach(s => s.classList.remove('on'));
    saveSettings(); // user action — persist the custom palette
    markDirty();
  });

  // ── Labels ──────────────────────────────────────────────────
  document.getElementById('baddlabel').addEventListener('click', () => {
    const container = document.getElementById('lman');
    const row       = document.createElement('div');
    row.className   = 'litem';
    row.innerHTML   = `<input type="text" placeholder="Uus silt"><button class="rmbtn">×</button>`;
    row.querySelector('.rmbtn').addEventListener('click', () => row.remove());
    container.appendChild(row);
    row.querySelector('input').focus();
  });

  document.getElementById('bsavelabels').addEventListener('click', async () => {
    const oldLabels = new Set(settings.labels);
    settings.labels = Array.from(document.querySelectorAll('#lman .litem input'))
      .map(input => input.value.trim())
      .filter(Boolean);
    const newLabels = new Set(settings.labels);

    // Find labels that were removed and strip them from every recipe
    const removed = [...oldLabels].filter(l => !newLabels.has(l));
    if (removed.length) {
      const removedSet = new Set(removed);
      let affected = 0;
      for (const recipe of recipes) {
        const before = (recipe.labels || []).length;
        recipe.labels = (recipe.labels || []).filter(l => !removedSet.has(l));
        if (recipe.labels.length !== before) {
          recipe.updated = Date.now(); // label change counts as an edit
          await dbPut('recipes', recipe);
          affected++;
        }
      }
      if (affected) markDirty();
    }

    await saveSettings();
    markDirty();
    renderFilters();
    renderCards(); // re-render so removed label chips disappear from cards
    toast(removed.length
      ? `✅ Sildid salvestatud – silt "${removed.join('", "')}" eemaldatud kõigist retseptidest`
      : '✅ Sildid salvestatud'
    );
  });

  // ── Densities ────────────────────────────────────────────────
  document.getElementById('badddens').addEventListener('click', () => {
    const container = document.getElementById('denslist');
    const row       = document.createElement('div');
    row.className   = 'drow';
    row.innerHTML   = `
      <input type="text"   class="dname" placeholder="Aine nimi (nt: flour, jahu)">
      <input type="number" class="dval"  step="0.01" min="0" placeholder="g/ml">
      <button class="rmbtn">×</button>`;
    row.querySelector('.rmbtn').addEventListener('click', () => row.remove());
    container.appendChild(row);
    row.querySelector('input').focus();
  });

  document.getElementById('bsavedens').addEventListener('click', async () => {
    const newDensities = {};
    for (const row of document.querySelectorAll('#denslist .drow')) {
      const inputs = row.querySelectorAll('input');
      const name   = inputs[0].value.trim().toLowerCase();
      const value  = parseFloat(inputs[1].value);
      if (name && !isNaN(value)) newDensities[name] = value;
    }
    settings.densities = newDensities;
    await saveSettings();
    markDirty();
    toast('✅ Tihedused salvestatud');
  });
}

// ═══════════════════════════════════════════════════════════════
//  THEME & COLOURS
// ═══════════════════════════════════════════════════════════════

/**
 * Applies a palette to the CSS custom properties on <html>.
 * Dark backgrounds trigger a dark-surface colour scheme automatically.
 * @param {{ bg: string, accent: string }} palette
 */
function applyTheme(palette) {
  settings.palette = { ...palette };
  const root = document.documentElement.style;

  root.setProperty('--bg',        palette.bg);
  root.setProperty('--accent',    palette.accent);
  root.setProperty('--accent-d',  darken(palette.accent, 0.18));
  root.setProperty('--accent-bg', lighten(palette.accent, 0.88));

  // --on-accent: text colour for elements sitting ON the accent background.
  // Derived from the accent's own luminance so contrast is always guaranteed,
  // regardless of whether the overall theme is light or dark.
  // e.g. yellow accent (#f2b705, high luminance) -> dark text
  //      a hypothetical dark-blue accent           -> light text
  const accentIsDark = luminance(palette.accent) < 0.35;
  root.setProperty('--on-accent', accentIsDark ? '#f0ece0' : '#1c1a14');

  // Auto dark-mode when the background luminance is very low
  const isDark = luminance(palette.bg) < 0.15;
  if (isDark) {
    root.setProperty('--surface', '#2a2820');
    root.setProperty('--text',    '#f0ece0');
    root.setProperty('--text2',   '#998f7a');
    root.setProperty('--border',  '#3a372e');
  } else {
    root.setProperty('--surface', '#ffffff');
    root.setProperty('--text',    '#1c1a14');
    root.setProperty('--text2',   '#6b6254');
    root.setProperty('--border',  '#e4ddd0');
  }

  // Update the PWA theme-color meta tag (affects browser chrome on mobile)
  document.querySelector('meta[name=theme-color]').setAttribute('content', palette.accent);
  // NOTE: saveSettings() is NOT called here — applyTheme only updates the DOM and
  // in-memory settings.palette. Callers that represent a user action call saveSettings
  // explicitly, preventing spurious writes during init() from clobbering lastExport.
}

/**
 * Calculates the relative luminance of a hex colour (WCAG formula).
 * @returns {number} 0 (black) … 1 (white)
 */
function luminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  const [r, g, b] = rgb.map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Returns a darker version of a hex colour.
 * @param {string} hex
 * @param {number} amount - 0 (no change) … 1 (black)
 */
function darken(hex, amount) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return rgbToHex(rgb.map(v => Math.max(0, Math.round(v * (1 - amount)))));
}

/**
 * Returns a lighter version of a hex colour.
 * @param {string} hex
 * @param {number} amount - 0 (no change) … 1 (white)
 */
function lighten(hex, amount) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return rgbToHex(rgb.map(v => Math.min(255, Math.round(v + (255 - v) * amount))));
}

/** Converts "#rrggbb" to [r, g, b] integers. */
function hexToRgb(hex) {
  const parts = hex.replace('#', '').match(/.{2}/g);
  return parts ? parts.map(h => parseInt(h, 16)) : null;
}

/** Converts an [r, g, b] array to a "#rrggbb" string. */
function rgbToHex(rgb) {
  return '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
}

// ═══════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════

/**
 * Escapes a string for safe insertion as HTML text content.
 * Prevents XSS when rendering user-supplied recipe names, labels, etc.
 */
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════════════
//  BOOTSTRAP
// ═══════════════════════════════════════════════════════════════

async function init() {
  await openDB();
  recipes = await dbGetAll('recipes');

  // Merge persisted settings over the hard-coded defaults
  const savedSettings = await dbGet('settings', 'app');
  if (savedSettings && savedSettings.val) Object.assign(settings, savedSettings.val);

  // ── Migration v1: add Estonian alias keys to densities ────────
  // Runs exactly once (guarded by migrationVersion). Merges default alias
  // keys whose aliases are not yet covered by any existing saved key.
  if ((settings.migrationVersion || 0) < 1) {
    const DEFAULT_DENSITIES = {
      'flour, jahu': 0.79,
      'sugar, suhkur, suhkrut': 0.85,
      'butter, või, võid': 0.911,
      'water, vesi, vett': 1,
      'milk, piima': 1.035,
      'cream, koort': 0.994,
      'oil, õli, olive oil, oliiviõli, vegetable oil, taimeõli, rapeseed oil, rapsõli, sunflower oil, päevalilleõli, coconut oil, kookosõli': 0.92,
      'baking soda, küpsetuspulber, küpsetuspulbrit': 0.9,
      'honey, mesi': 1.42,
      'yogurt, jogurt, jogurtit': 1.03,
      'cocoa powder, kakao, kakaod, kakaopulbrit': 0.56,
      'oats, kaerahelbeid, kaerahelbed': 0.4,
    };
    const savedAliases = new Set(
      Object.keys(settings.densities)
        .flatMap(k => k.split(',').map(a => a.trim().toLowerCase()))
    );
    for (const [defaultKey, defaultVal] of Object.entries(DEFAULT_DENSITIES)) {
      const defaultAliases = defaultKey.split(',').map(a => a.trim().toLowerCase());
      if (!defaultAliases.some(a => savedAliases.has(a))) {
        settings.densities[defaultKey] = defaultVal;
      }
    }
    settings.migrationVersion = 1;
    await saveSettings();
  }

  applyTheme(settings.palette);
  renderFilters();
  renderCards();
  renderSettingsUI();
  checkBackupWarning();

  // Register the service worker for offline / PWA support (fails silently if absent)
  if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js').then(reg => {
    if (reg.waiting) {
      reg.waiting.postMessage('SKIP_WAITING');
    }

    reg.addEventListener('updatefound', () => {
      const newSW = reg.installing;
      newSW.addEventListener('statechange', () => {
        if (newSW.state === 'installed' && reg.waiting) {
          reg.waiting.postMessage('SKIP_WAITING');
          }
        });
    });
  });
  }


  // Request persistent storage so the browser doesn't evict our cache
  // and IndexedDB data during periods of inactivity. Silently ignored
  // if the API isn't supported or permission is denied.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().then(granted => {
      if (!granted) console.info('[Sahver] Persistent storage not granted — cache may be evicted.');
    });
  }

  bindNav();
  bindConvert();
  bindRecipes();
  bindIO();
  bindSettings();
}

init().catch(console.error);