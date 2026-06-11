// static/js/homies.js
// Homie Maker — visual AI agent personas: dock page, maker wizard, canvas
// pinning, chat bubbles, 3-preset SVG mouths with amplitude lip-sync.
// ES6 module. Backend: routes/homies.py.

import uiModule from './ui.js';

const POLL_MS = 5000;
const PIN_MIN = 64;
const PIN_MAX = 192;
const PIN_DEFAULT = 96;
const BUBBLE_TRUNCATE = 280;

// ---------------------------------------------------------------------------
// Mouth presets — 3 frames each (closed / half / open), inline SVG drawn with
// currentColor so they inherit theme colors; per-homie mouth_color overrides
// via the wrapper's inline `color` style.
// ---------------------------------------------------------------------------

export const MOUTHS = {
  'Line smile': {
    closed: `<svg viewBox="0 0 100 60" xmlns="http://www.w3.org/2000/svg"><path d="M18 30 Q50 46 82 30" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/></svg>`,
    half:   `<svg viewBox="0 0 100 60" xmlns="http://www.w3.org/2000/svg"><path d="M20 26 Q50 40 80 26 Q50 56 20 26 Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`,
    open:   `<svg viewBox="0 0 100 60" xmlns="http://www.w3.org/2000/svg"><ellipse cx="50" cy="32" rx="26" ry="22" fill="currentColor" stroke="currentColor" stroke-width="4"/></svg>`,
  },
  'Teeth': {
    closed: `<svg viewBox="0 0 100 60" xmlns="http://www.w3.org/2000/svg"><path d="M16 28 Q50 44 84 28" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><path d="M30 33 Q50 41 70 33" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity="0.5"/></svg>`,
    half:   `<svg viewBox="0 0 100 60" xmlns="http://www.w3.org/2000/svg"><path d="M18 24 Q50 36 82 24 Q50 52 18 24 Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M26 27 Q50 35 74 27 L72 33 Q50 40 28 33 Z" fill="#fff" opacity="0.92"/></svg>`,
    open:   `<svg viewBox="0 0 100 60" xmlns="http://www.w3.org/2000/svg"><ellipse cx="50" cy="32" rx="28" ry="23" fill="currentColor"/><path d="M25 22 Q50 30 75 22 L74 31 Q50 38 26 31 Z" fill="#fff" opacity="0.92"/><path d="M30 47 Q50 41 70 47 L68 51 Q50 46 32 51 Z" fill="#fff" opacity="0.75"/></svg>`,
  },
  'Robot mouth': {
    closed: `<svg viewBox="0 0 100 60" xmlns="http://www.w3.org/2000/svg"><rect x="16" y="26" width="68" height="8" rx="3" fill="currentColor"/></svg>`,
    half:   `<svg viewBox="0 0 100 60" xmlns="http://www.w3.org/2000/svg"><rect x="16" y="20" width="68" height="20" rx="4" fill="none" stroke="currentColor" stroke-width="4"/><line x1="30" y1="22" x2="30" y2="38" stroke="currentColor" stroke-width="4"/><line x1="44" y1="22" x2="44" y2="38" stroke="currentColor" stroke-width="4"/><line x1="58" y1="22" x2="58" y2="38" stroke="currentColor" stroke-width="4"/><line x1="72" y1="22" x2="72" y2="38" stroke="currentColor" stroke-width="4"/></svg>`,
    open:   `<svg viewBox="0 0 100 60" xmlns="http://www.w3.org/2000/svg"><rect x="14" y="12" width="72" height="36" rx="5" fill="none" stroke="currentColor" stroke-width="4"/><rect x="22" y="19" width="9" height="22" rx="2" fill="currentColor"/><rect x="36" y="19" width="9" height="22" rx="2" fill="currentColor"/><rect x="50" y="19" width="9" height="22" rx="2" fill="currentColor"/><rect x="64" y="19" width="9" height="22" rx="2" fill="currentColor"/></svg>`,
  },
};

export const MOUTH_PRESET_NAMES = Object.keys(MOUTHS);
const MOUTH_FRAMES = ['closed', 'half', 'open'];
const DEFAULT_ANCHOR = { x: 0.5, y: 0.7, scale: 0.35, rotation: 0 };

// ---------------------------------------------------------------------------
// Lip-sync engine — amplitude-driven 3-frame animation (HOMIE spec 3.3).
// Routes an <audio> element through a shared AudioContext AnalyserNode,
// samples RMS ~30fps, maps volume thresholds → closed/half/open.
// ---------------------------------------------------------------------------

let _audioCtx = null;
// An HTMLMediaElement can only ever be given ONE MediaElementSource — cache it.
const _mediaSources = new WeakMap();

function _ctx() {
  if (!_audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    _audioCtx = AC ? new AC() : null;
  }
  if (_audioCtx && _audioCtx.state === 'suspended') {
    _audioCtx.resume().catch(() => {});
  }
  return _audioCtx;
}

export class LipSync {
  /**
   * @param {HTMLAudioElement} audioEl  element being played
   * @param {(frame: string) => void} onFrame  called with 'closed'|'half'|'open'
   */
  constructor(audioEl, onFrame) {
    this.audioEl = audioEl;
    this.onFrame = onFrame;
    this._raf = null;
    this._lastTick = 0;
    this._frame = 'closed';
    this._analyser = null;
    this._buf = null;
    this._onEnd = () => this.stop();
    audioEl.addEventListener('pause', this._onEnd);
    audioEl.addEventListener('ended', this._onEnd);
  }

  start() {
    const ctx = _ctx();
    if (!ctx) return; // no Web Audio — mouth simply stays closed
    try {
      let src = _mediaSources.get(this.audioEl);
      if (!src) {
        src = ctx.createMediaElementSource(this.audioEl);
        _mediaSources.set(this.audioEl, src);
        src.connect(ctx.destination); // keep it audible
      }
      this._analyser = ctx.createAnalyser();
      this._analyser.fftSize = 512;
      src.connect(this._analyser);
      this._buf = new Uint8Array(this._analyser.fftSize);
    } catch (e) {
      console.warn('homies: lip-sync analyser unavailable', e);
      return;
    }
    const tick = (t) => {
      this._raf = requestAnimationFrame(tick);
      if (t - this._lastTick < 33) return; // ~30fps sampling
      this._lastTick = t;
      this._analyser.getByteTimeDomainData(this._buf);
      let sum = 0;
      for (let i = 0; i < this._buf.length; i++) {
        const v = (this._buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / this._buf.length);
      const frame = rms < 0.03 ? 'closed' : (rms < 0.09 ? 'half' : 'open');
      if (frame !== this._frame) {
        this._frame = frame;
        try { this.onFrame(frame); } catch {}
      }
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    if (this._analyser) { try { this._analyser.disconnect(); } catch {} this._analyser = null; }
    if (this._frame !== 'closed') {
      this._frame = 'closed';
      try { this.onFrame('closed'); } catch {}
    }
  }

  dispose() {
    this.stop();
    this.audioEl.removeEventListener('pause', this._onEnd);
    this.audioEl.removeEventListener('ended', this._onEnd);
  }
}

// ---------------------------------------------------------------------------
// Mouth overlay rendering
// ---------------------------------------------------------------------------

/** Build (or rebuild) the mouth overlay inside an avatar box element. */
function renderMouth(boxEl, homie, frame = 'closed') {
  let wrap = boxEl.querySelector('.homie-mouth');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'homie-mouth';
    boxEl.appendChild(wrap);
  }
  const preset = MOUTHS[homie.mouth_preset] ? homie.mouth_preset : MOUTH_PRESET_NAMES[0];
  const a = { ...DEFAULT_ANCHOR, ...(homie.mouth_anchor || {}) };
  wrap.innerHTML = MOUTHS[preset][frame] || MOUTHS[preset].closed;
  wrap.style.left = (a.x * 100) + '%';
  wrap.style.top = (a.y * 100) + '%';
  wrap.style.width = (a.scale * 100) + '%';
  wrap.style.transform = `translate(-50%, -50%) rotate(${a.rotation || 0}deg)`;
  wrap.style.color = homie.mouth_color || 'var(--accent-primary, var(--red))';
  wrap.dataset.frame = frame;
  return wrap;
}

/** Avatar box markup (img + mouth overlay). Used by dock cards, pins, editor. */
function avatarBoxHTML(homie, extraClass = '') {
  const src = homie.has_avatar
    ? `/api/homies/${homie.id}/avatar?size=512&v=${encodeURIComponent(homie.updated_at || '')}`
    : '';
  const img = src
    ? `<img class="homie-avatar-img" src="${src}" alt="" draggable="false"/>`
    : `<div class="homie-avatar-placeholder">${escapeHtml((homie.name || '?').slice(0, 2).toUpperCase())}</div>`;
  return `<div class="homie-avatar-box ${extraClass}" data-homie-id="${homie.id}">${img}</div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return res.json();
}

const HomiesAPI = {
  list: () => api('/api/homies'),
  create: (body) => api('/api/homies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  patch: (id, body) => api(`/api/homies/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  remove: (id) => api(`/api/homies/${id}`, { method: 'DELETE' }),
  status: (id) => api(`/api/homies/${id}/status`),
  uploadAvatar: (id, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return api(`/api/homies/${id}/avatar`, { method: 'POST', body: fd });
  },
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _homies = [];          // last fetched list
let _open = false;         // dock panel open?
let _pollTimer = null;
let _speaking = new Set(); // homie ids currently speaking (client-side)
let _bubbleOpenFor = null; // homie id with an open bubble
let _activeLipSync = null; // current LipSync instance
let _ttsAvailable = null;  // cached /api/tts/stats availability

async function ttsAvailable() {
  if (_ttsAvailable !== null) return _ttsAvailable;
  try {
    const stats = await api('/api/tts/stats');
    _ttsAvailable = !!(stats.available && stats.ready && stats.provider !== 'browser');
  } catch { _ttsAvailable = false; }
  return _ttsAvailable;
}

function getHomie(id) { return _homies.find((h) => h.id === id) || null; }

async function refreshHomies() {
  try {
    const data = await HomiesAPI.list();
    _homies = data.homies || [];
  } catch (e) {
    console.warn('homies: list failed', e);
  }
  renderDockGrid();
  syncCanvasPins();
  return _homies;
}

function statusOf(h) {
  if (_speaking.has(h.id)) return 'speaking';
  return h.status === 'working' ? 'working' : 'idle';
}

function startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(async () => {
    const anyPinned = _homies.some((h) => h.pinned);
    if (!_open && !anyPinned) return;
    await refreshHomies();
  }, POLL_MS);
}

function stopPollingIfIdle() {
  if (!_open && !_homies.some((h) => h.pinned) && _pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}
// ---------------------------------------------------------------------------
// Dock panel (sidebar page)
// ---------------------------------------------------------------------------

export function openPanel() {
  if (_open) return;
  _open = true;

  document.body.classList.add('homies-view');
  if (window.innerWidth <= 768) {
    const sb = document.getElementById('sidebar');
    if (sb) sb.classList.add('hidden');
    document.body.classList.add('sidebar-collapsed');
  }
  const btn = document.getElementById('tool-homies-btn');
  if (btn) btn.classList.add('active');

  const pane = document.createElement('div');
  pane.id = 'homies-pane';
  pane.className = 'homies-pane';
  pane.innerHTML = `
    <div class="homies-pane-header">
      <h4 class="homies-pane-title">${HOMIE_ICON_SVG}Homies</h4>
      <span style="flex:1"></span>
      <button id="homies-new-btn" class="homies-new-btn" type="button">+ New Homie</button>
      <button id="homies-close-btn" class="modal-minimize-btn" title="Close" aria-label="Close homies"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="18" x2="18" y2="18"/></svg></button>
    </div>
    <div class="homies-pane-body"><div class="homies-grid" id="homies-grid"></div></div>
  `;
  if (window.innerWidth <= 768) {
    pane.style.position = 'fixed';
    pane.style.inset = '0';
    pane.style.width = '100%';
    pane.style.maxWidth = '100%';
    pane.style.zIndex = '170';
  }
  document.body.appendChild(pane);

  pane.querySelector('#homies-close-btn').addEventListener('click', () => closePanel());
  pane.querySelector('#homies-new-btn').addEventListener('click', () => openEditor(null));
  document.addEventListener('keydown', _escClose);

  refreshHomies();
  startPolling();
}

export function closePanel() {
  if (!_open) return;
  _open = false;
  document.body.classList.remove('homies-view');
  const pane = document.getElementById('homies-pane');
  if (pane) pane.remove();
  const btn = document.getElementById('tool-homies-btn');
  if (btn) btn.classList.remove('active');
  document.removeEventListener('keydown', _escClose);
  stopPollingIfIdle();
}

export function togglePanel() { _open ? closePanel() : openPanel(); }
export function isPanelOpen() { return _open; }

function _escClose(e) {
  if (e.key !== 'Escape') return;
  // Editor and bubbles handle their own Escape first.
  if (document.getElementById('homie-editor-overlay')) return;
  closePanel();
}

const HOMIE_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2.5px;margin-right:6px"><circle cx="12" cy="8" r="5"/><path d="M9 7h.01M15 7h.01"/><path d="M9.5 10.5 Q12 12.5 14.5 10.5"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>`;

function renderDockGrid() {
  const grid = document.getElementById('homies-grid');
  if (!grid) return;
  if (!_homies.length) {
    grid.innerHTML = `
      <div class="homies-empty">
        <div class="homies-empty-icon">${HOMIE_ICON_SVG}</div>
        <p>No homies yet. A homie is your own AI character — avatar, voice, personality — that works alongside you.</p>
        <button class="homies-new-btn" id="homies-empty-new" type="button">+ Make your first homie</button>
      </div>`;
    const b = grid.querySelector('#homies-empty-new');
    if (b) b.addEventListener('click', () => openEditor(null));
    return;
  }
  grid.innerHTML = _homies.map((h) => `
    <div class="homie-card ${h.enabled ? '' : 'homie-disabled'}" data-id="${h.id}">
      ${avatarBoxHTML(h, 'homie-card-avatar')}
      <div class="homie-card-row">
        <span class="homie-status-dot homie-status-${statusOf(h)}" title="${statusOf(h)}"></span>
        <span class="homie-card-name" title="${escapeHtml(h.name)}">${escapeHtml(h.name)}</span>
      </div>
      <div class="homie-card-actions">
        <button class="homie-act homie-act-pin ${h.pinned ? 'active' : ''}" title="${h.pinned ? 'Unpin from canvas' : 'Pin to canvas'}" data-act="pin"><svg width="13" height="13" viewBox="0 0 24 24" fill="${h.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76V7a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3.76a2 2 0 0 0 .59 1.42l1.82 1.82a1 1 0 0 1-.7 1.71H6.29a1 1 0 0 1-.7-1.7l1.82-1.83A2 2 0 0 0 8 10.76z"/></svg></button>
        <button class="homie-act" title="Settings" data-act="settings"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
        <button class="homie-act homie-act-danger" title="Delete" data-act="delete"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>
    </div>
  `).join('');

  // Mouth overlays + card actions
  for (const h of _homies) {
    const card = grid.querySelector(`.homie-card[data-id="${h.id}"]`);
    if (!card) continue;
    const box = card.querySelector('.homie-avatar-box');
    if (box && h.has_avatar) renderMouth(box, h, _speaking.has(h.id) ? 'half' : 'closed');
    card.querySelectorAll('.homie-act').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        try {
          if (act === 'pin') {
            const updated = await HomiesAPI.patch(h.id, { pinned: !h.pinned });
            Object.assign(h, updated);
            renderDockGrid(); syncCanvasPins(); startPolling();
          } else if (act === 'settings') {
            openEditor(h);
          } else if (act === 'delete') {
            if (!window.confirm(`Delete homie "${h.name}"? This removes its avatar and chat history.`)) return;
            await HomiesAPI.remove(h.id);
            _homies = _homies.filter((x) => x.id !== h.id);
            renderDockGrid(); syncCanvasPins();
            uiModule.showToast?.(`${h.name} deleted`);
          }
        } catch (err) {
          uiModule.showError?.(err.message || String(err));
        }
      });
    });
  }
}
// ---------------------------------------------------------------------------
// Homie Maker — create wizard + settings editor (same overlay)
// ---------------------------------------------------------------------------

function openEditor(homie) {
  closeEditor();
  const isNew = !homie;
  const h = homie ? JSON.parse(JSON.stringify(homie)) : {
    name: '', mouth_preset: MOUTH_PRESET_NAMES[0],
    mouth_anchor: { ...DEFAULT_ANCHOR }, mouth_color: null,
    voice_config: { engine: 'kokoro', voice: null, speed: 1.0, pitch: 1.0 },
    persona: { motivations: [], frustrations: [], goals: [], channels: [], sliders: {
      cautious_bold: 50, ask_first_autonomous: 50, deliberate_fast: 50, data_driven_intuitive: 50,
    } },
    tool_whitelist: null, pinned: false, enabled: true, has_avatar: false,
  };
  h.persona = h.persona || {};
  h.persona.sliders = { cautious_bold: 50, ask_first_autonomous: 50, deliberate_fast: 50, data_driven_intuitive: 50, ...(h.persona.sliders || {}) };
  let pendingAvatarFile = null;

  const ov = document.createElement('div');
  ov.id = 'homie-editor-overlay';
  ov.className = 'homie-editor-overlay';
  const sliders = h.persona.sliders;
  const channels = new Set(h.persona.channels || []);
  ov.innerHTML = `
  <div class="homie-editor" role="dialog" aria-label="Homie Maker">
    <div class="homie-editor-header">
      <h4>${isNew ? 'New Homie' : `Edit ${escapeHtml(h.name)}`}</h4>
      <span style="flex:1"></span>
      <button class="modal-minimize-btn" id="homie-editor-close" title="Close"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg></button>
    </div>
    <div class="homie-editor-body">

      <div class="homie-ed-section">
        <label class="homie-ed-label">Name</label>
        <input type="text" id="homie-ed-name" maxlength="80" placeholder="e.g. Scout" value="${escapeHtml(h.name)}"/>
      </div>

      <div class="homie-ed-section homie-ed-avatar-row">
        <div class="homie-ed-anchor-wrap">
          <div class="homie-avatar-box homie-ed-preview" id="homie-ed-preview">
            <div class="homie-avatar-placeholder" id="homie-ed-noavatar">PNG</div>
          </div>
          <div class="homie-ed-hint">Drag the mouth to place it. Transparent PNGs look best.</div>
        </div>
        <div class="homie-ed-avatar-controls">
          <label class="homie-ed-label">Avatar (PNG, max 5 MB)</label>
          <input type="file" id="homie-ed-file" accept="image/png"/>
          <label class="homie-ed-label" style="margin-top:10px">Mouth</label>
          <div class="homie-ed-mouth-presets" id="homie-ed-mouths">
            ${MOUTH_PRESET_NAMES.map((p) => `
              <button type="button" class="homie-mouth-choice ${p === h.mouth_preset ? 'active' : ''}" data-preset="${escapeHtml(p)}" title="${escapeHtml(p)}">
                <span class="homie-mouth-choice-svg">${MOUTHS[p].half}</span>
              </button>`).join('')}
          </div>
          <label class="homie-ed-label homie-ed-mini">Mouth size <span id="homie-ed-scale-val"></span></label>
          <input type="range" id="homie-ed-scale" min="5" max="100" value="${Math.round((h.mouth_anchor.scale || 0.35) * 100)}"/>
          <label class="homie-ed-label homie-ed-mini">Rotation <span id="homie-ed-rot-val"></span></label>
          <input type="range" id="homie-ed-rot" min="-45" max="45" value="${Math.round(h.mouth_anchor.rotation || 0)}"/>
          <label class="homie-ed-label homie-ed-mini">Mouth color
            <input type="checkbox" id="homie-ed-color-on" ${h.mouth_color ? 'checked' : ''} style="margin-left:6px;vertical-align:-2px"/>
            <input type="color" id="homie-ed-color" value="${h.mouth_color || '#E8643C'}" ${h.mouth_color ? '' : 'disabled'} style="margin-left:6px;vertical-align:-5px"/>
          </label>
        </div>
      </div>

      <div class="homie-ed-section">
        <label class="homie-ed-label">Motivations <span class="homie-ed-sub">what drives this homie</span><button type="button" class="homie-ed-suggest" data-suggest="motivations" title="Let the model suggest a few">✨ Suggest</button></label>
        <textarea id="homie-ed-motivations" rows="2" placeholder="one per line">${escapeHtml((h.persona.motivations || []).join('\n'))}</textarea>
        <label class="homie-ed-label">Frustrations <span class="homie-ed-sub">what it pushes back on</span><button type="button" class="homie-ed-suggest" data-suggest="frustrations" title="Let the model suggest a few">✨ Suggest</button></label>
        <textarea id="homie-ed-frustrations" rows="2" placeholder="one per line">${escapeHtml((h.persona.frustrations || []).join('\n'))}</textarea>
        <label class="homie-ed-label">Goals <span class="homie-ed-sub">standing objectives, in priority order</span><button type="button" class="homie-ed-suggest" data-suggest="goals" title="Let the model suggest a few">✨ Suggest</button></label>
        <textarea id="homie-ed-goals" rows="3" placeholder="one per line, top = highest priority">${escapeHtml((h.persona.goals || []).join('\n'))}</textarea>
      </div>

      <div class="homie-ed-section">
        <label class="homie-ed-label">Preferred channels <span class="homie-ed-sub">where it proactively writes output</span><button type="button" class="homie-ed-suggest" id="homie-ed-rand-channels" title="Random channel mix">🎲 Randomize</button></label>
        <div class="homie-ed-channels">
          ${['Chat', 'Email', 'Notes', 'Tasks', 'Calendar'].map((c) => `
            <label class="homie-ed-channel"><input type="checkbox" data-channel="${c}" ${channels.has(c) ? 'checked' : ''}/> ${c}</label>`).join('')}
        </div>
      </div>

      <div class="homie-ed-section">
        <label class="homie-ed-label">Decision-making<button type="button" class="homie-ed-suggest" id="homie-ed-rand-sliders" title="Roll a random temperament">🎲 Randomize</button></label>
        ${[
          ['cautious_bold', 'Cautious', 'Bold'],
          ['ask_first_autonomous', 'Ask-first', 'Autonomous'],
          ['deliberate_fast', 'Deliberate', 'Fast'],
          ['data_driven_intuitive', 'Data-driven', 'Intuitive'],
        ].map(([key, l, r]) => `
          <div class="homie-ed-slider-row">
            <span class="homie-ed-slider-left">${l}</span>
            <input type="range" min="0" max="100" data-slider="${key}" value="${sliders[key]}"/>
            <span class="homie-ed-slider-right">${r}</span>
          </div>`).join('')}
      </div>

      <div class="homie-ed-section">
        <label class="homie-ed-label">Voice<button type="button" class="homie-ed-suggest" id="homie-ed-rand-voice" title="Random speed + pitch">🎲 Randomize</button></label>
        <div class="homie-ed-voice-row">
          <select id="homie-ed-voice-engine">
            <option value="kokoro" ${h.voice_config.engine === 'kokoro' ? 'selected' : ''}>Kokoro (default)</option>
            <option value="chatterbox" ${h.voice_config.engine === 'chatterbox' ? 'selected' : ''} disabled>Chatterbox — voice cloning (not installed)</option>
          </select>
          <label class="homie-ed-mini">Speed <input type="number" id="homie-ed-voice-speed" min="0.25" max="4" step="0.05" value="${h.voice_config.speed ?? 1}"/></label>
          <label class="homie-ed-mini">Pitch <input type="number" id="homie-ed-voice-pitch" min="0.25" max="4" step="0.05" value="${h.voice_config.pitch ?? 1}"/></label>
        </div>
        <div class="homie-ed-hint">Uses the server TTS service. Chatterbox voice cloning unlocks when its optional dependency is installed.</div>
      </div>

      <div class="homie-ed-section homie-ed-footer-row">
        <label class="homie-ed-channel"><input type="checkbox" id="homie-ed-enabled" ${h.enabled ? 'checked' : ''}/> Enabled</label>
        <label class="homie-ed-channel"><input type="checkbox" id="homie-ed-pinned" ${h.pinned ? 'checked' : ''}/> Pinned to canvas</label>
        <span style="flex:1"></span>
        <button type="button" class="homies-new-btn" id="homie-ed-save">${isNew ? 'Create homie' : 'Save changes'}</button>
      </div>
      <div class="homie-ed-error" id="homie-ed-error" style="display:none"></div>
    </div>
  </div>`;
  document.body.appendChild(ov);

  const preview = ov.querySelector('#homie-ed-preview');
  const noAvatar = ov.querySelector('#homie-ed-noavatar');

  function refreshPreviewMouth() {
    renderMouth(preview, h, 'half');
  }
  function setPreviewImage(url) {
    let img = preview.querySelector('.homie-avatar-img');
    if (!img) {
      img = document.createElement('img');
      img.className = 'homie-avatar-img';
      img.draggable = false;
      preview.insertBefore(img, preview.firstChild);
    }
    img.src = url;
    if (noAvatar) noAvatar.style.display = 'none';
  }
  if (h.id && h.has_avatar) {
    setPreviewImage(`/api/homies/${h.id}/avatar?size=512&v=${encodeURIComponent(h.updated_at || '')}`);
  }
  refreshPreviewMouth();

  // --- mouth anchor: drag on preview ---
  const mouthEl = () => preview.querySelector('.homie-mouth');
  let dragging = false;
  preview.addEventListener('pointerdown', (e) => {
    const m = mouthEl();
    if (!m) return;
    dragging = true;
    preview.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  preview.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = preview.getBoundingClientRect();
    h.mouth_anchor.x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    h.mouth_anchor.y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    refreshPreviewMouth();
  });
  preview.addEventListener('pointerup', () => { dragging = false; });
  preview.addEventListener('pointercancel', () => { dragging = false; });

  // --- controls ---
  const scaleInput = ov.querySelector('#homie-ed-scale');
  const rotInput = ov.querySelector('#homie-ed-rot');
  const scaleVal = ov.querySelector('#homie-ed-scale-val');
  const rotVal = ov.querySelector('#homie-ed-rot-val');
  const syncSliderLabels = () => {
    scaleVal.textContent = scaleInput.value + '%';
    rotVal.textContent = rotInput.value + '°';
  };
  syncSliderLabels();
  scaleInput.addEventListener('input', () => {
    h.mouth_anchor.scale = parseInt(scaleInput.value, 10) / 100;
    syncSliderLabels(); refreshPreviewMouth();
  });
  rotInput.addEventListener('input', () => {
    h.mouth_anchor.rotation = parseInt(rotInput.value, 10);
    syncSliderLabels(); refreshPreviewMouth();
  });
  ov.querySelectorAll('.homie-mouth-choice').forEach((b) => {
    b.addEventListener('click', () => {
      ov.querySelectorAll('.homie-mouth-choice').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      h.mouth_preset = b.dataset.preset;
      refreshPreviewMouth();
    });
  });
  const colorOn = ov.querySelector('#homie-ed-color-on');
  const colorInput = ov.querySelector('#homie-ed-color');
  colorOn.addEventListener('change', () => {
    colorInput.disabled = !colorOn.checked;
    h.mouth_color = colorOn.checked ? colorInput.value : null;
    refreshPreviewMouth();
  });
  colorInput.addEventListener('input', () => {
    h.mouth_color = colorInput.value;
    refreshPreviewMouth();
  });
  ov.querySelector('#homie-ed-file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    pendingAvatarFile = f;
    setPreviewImage(URL.createObjectURL(f));
    refreshPreviewMouth();
  });

  // --- suggest + randomize ---
  ov.querySelectorAll('.homie-ed-suggest[data-suggest]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const field = btn.dataset.suggest;
      const ta = ov.querySelector('#homie-ed-' + field);
      const lines = (sel) => ov.querySelector(sel).value.split('\n').map((x) => x.trim()).filter(Boolean);
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = '…thinking';
      try {
        const data = await api('/api/homies/persona-suggest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            field,
            name: ov.querySelector('#homie-ed-name').value,
            persona: {
              motivations: lines('#homie-ed-motivations'),
              frustrations: lines('#homie-ed-frustrations'),
              goals: lines('#homie-ed-goals'),
            },
          }),
        });
        const existing = ta.value.trim();
        ta.value = (existing ? existing + '\n' : '') + (data.suggestions || []).join('\n');
      } catch (err) {
        uiModule.showError?.(err.message || String(err));
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });
  });
  const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const randBtnSliders = ov.querySelector('#homie-ed-rand-sliders');
  if (randBtnSliders) randBtnSliders.addEventListener('click', () => {
    ov.querySelectorAll('[data-slider]').forEach((sl) => { sl.value = randInt(0, 100); });
  });
  const randBtnVoice = ov.querySelector('#homie-ed-rand-voice');
  if (randBtnVoice) randBtnVoice.addEventListener('click', () => {
    // Keep it audible: 0.70–1.50 in 0.05 steps.
    ov.querySelector('#homie-ed-voice-speed').value = (randInt(14, 30) * 0.05).toFixed(2);
    ov.querySelector('#homie-ed-voice-pitch').value = (randInt(14, 30) * 0.05).toFixed(2);
  });
  const randBtnChannels = ov.querySelector('#homie-ed-rand-channels');
  if (randBtnChannels) randBtnChannels.addEventListener('click', () => {
    const boxes = Array.from(ov.querySelectorAll('[data-channel]'));
    boxes.forEach((c) => { c.checked = Math.random() < 0.5; });
    // Never leave it empty — guarantee at least one channel.
    if (!boxes.some((c) => c.checked)) boxes[randInt(0, boxes.length - 1)].checked = true;
  });

  // --- close/save ---
  const close = () => { ov.remove(); document.removeEventListener('keydown', escHandler); };
  const escHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', escHandler);
  ov.querySelector('#homie-editor-close').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });

  ov.querySelector('#homie-ed-save').addEventListener('click', async () => {
    const errEl = ov.querySelector('#homie-ed-error');
    errEl.style.display = 'none';
    const lines = (id) => ov.querySelector(id).value.split('\n').map((s) => s.trim()).filter(Boolean);
    const body = {
      name: ov.querySelector('#homie-ed-name').value,
      mouth_preset: h.mouth_preset,
      mouth_anchor: h.mouth_anchor,
      mouth_color: h.mouth_color,
      voice_config: {
        engine: ov.querySelector('#homie-ed-voice-engine').value,
        voice: h.voice_config.voice || null,
        speed: parseFloat(ov.querySelector('#homie-ed-voice-speed').value) || 1,
        pitch: parseFloat(ov.querySelector('#homie-ed-voice-pitch').value) || 1,
      },
      persona: {
        motivations: lines('#homie-ed-motivations'),
        frustrations: lines('#homie-ed-frustrations'),
        goals: lines('#homie-ed-goals'),
        channels: Array.from(ov.querySelectorAll('[data-channel]')).filter((c) => c.checked).map((c) => c.dataset.channel),
        sliders: Object.fromEntries(Array.from(ov.querySelectorAll('[data-slider]')).map((s) => [s.dataset.slider, parseInt(s.value, 10)])),
      },
      pinned: ov.querySelector('#homie-ed-pinned').checked,
      enabled: ov.querySelector('#homie-ed-enabled').checked,
    };
    try {
      let saved;
      if (isNew) {
        saved = await HomiesAPI.create(body);
      } else {
        saved = await HomiesAPI.patch(h.id, body);
      }
      if (pendingAvatarFile) {
        saved = await HomiesAPI.uploadAvatar(saved.id, pendingAvatarFile);
      }
      const idx = _homies.findIndex((x) => x.id === saved.id);
      if (idx >= 0) _homies[idx] = saved; else _homies.push(saved);
      renderDockGrid(); syncCanvasPins(); startPolling();
      uiModule.showToast?.(isNew ? `${saved.name} is alive!` : 'Saved');
      close();
    } catch (err) {
      errEl.textContent = err.message || String(err);
      errEl.style.display = 'block';
    }
  });
}

function closeEditor() {
  const ov = document.getElementById('homie-editor-overlay');
  if (ov) ov.remove();
}
// ---------------------------------------------------------------------------
// Canvas pins — floating draggable homies over the main workspace
// ---------------------------------------------------------------------------

function pinLayer() {
  let layer = document.getElementById('homie-pin-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'homie-pin-layer';
    document.body.appendChild(layer);
  }
  return layer;
}

function syncCanvasPins() {
  const layer = pinLayer();
  const wantIds = new Set(_homies.filter((h) => h.pinned && h.enabled).map((h) => h.id));
  // Remove stale pins
  layer.querySelectorAll('.homie-pin').forEach((el) => {
    if (!wantIds.has(el.dataset.homieId)) {
      if (_bubbleOpenFor === el.dataset.homieId) closeBubble();
      el.remove();
    }
  });
  // Add/update wanted pins
  for (const h of _homies) {
    if (!wantIds.has(h.id)) continue;
    let pin = layer.querySelector(`.homie-pin[data-homie-id="${h.id}"]`);
    if (!pin) {
      pin = createPin(h);
      layer.appendChild(pin);
    }
    updatePin(pin, h);
  }
}

function createPin(h) {
  const pin = document.createElement('div');
  pin.className = 'homie-pin';
  pin.dataset.homieId = h.id;
  pin.innerHTML = `
    ${avatarBoxHTML(h, 'homie-pin-avatar')}
    <span class="homie-status-dot homie-pin-dot"></span>
    <div class="homie-pin-name">${escapeHtml(h.name)}</div>
  `;

  // --- drag to move (persist canvas_pos on release) ---
  let drag = null;
  pin.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = {
      startX: e.clientX, startY: e.clientY,
      origLeft: pin.offsetLeft, origTop: pin.offsetTop,
      moved: false,
    };
    pin.setPointerCapture(e.pointerId);
  });
  pin.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return; // click vs drag threshold
    drag.moved = true;
    const size = pin.offsetWidth;
    const x = Math.min(window.innerWidth - size, Math.max(0, drag.origLeft + dx));
    const y = Math.min(window.innerHeight - size, Math.max(0, drag.origTop + dy));
    pin.style.left = x + 'px';
    pin.style.top = y + 'px';
    if (_bubbleOpenFor === h.id) positionBubble(pin);
  });
  const endDrag = async (e) => {
    if (!drag) return;
    const wasDrag = drag.moved;
    drag = null;
    if (wasDrag) {
      const hh = getHomie(h.id);
      const pos = { ...(hh?.canvas_pos || {}), x: pin.offsetLeft, y: pin.offsetTop };
      try {
        const updated = await HomiesAPI.patch(h.id, { canvas_pos: pos });
        const idx = _homies.findIndex((x) => x.id === h.id);
        if (idx >= 0) _homies[idx] = updated;
      } catch (err) { console.warn('homies: could not persist position', err); }
    } else {
      toggleBubble(h.id);
    }
  };
  pin.addEventListener('pointerup', endDrag);
  pin.addEventListener('pointercancel', () => { drag = null; });

  // --- resize: Alt+wheel or pinch via wheel ctrlKey (64–192px, persisted) ---
  pin.addEventListener('wheel', async (e) => {
    if (!e.altKey && !e.ctrlKey) return;
    e.preventDefault();
    const cur = pin.offsetWidth;
    const next = Math.min(PIN_MAX, Math.max(PIN_MIN, cur + (e.deltaY < 0 ? 8 : -8)));
    if (next === cur) return;
    pin.style.width = next + 'px';
    if (_bubbleOpenFor === h.id) positionBubble(pin);
    clearTimeout(pin._sizeT);
    pin._sizeT = setTimeout(async () => {
      const hh = getHomie(h.id);
      const pos = { ...(hh?.canvas_pos || {}), x: pin.offsetLeft, y: pin.offsetTop, size: next };
      try {
        const updated = await HomiesAPI.patch(h.id, { canvas_pos: pos });
        const idx = _homies.findIndex((x) => x.id === h.id);
        if (idx >= 0) _homies[idx] = updated;
      } catch {}
    }, 400);
  }, { passive: false });

  return pin;
}

function updatePin(pin, h) {
  const pos = h.canvas_pos || {};
  const size = Math.min(PIN_MAX, Math.max(PIN_MIN, pos.size || PIN_DEFAULT));
  pin.style.width = size + 'px';
  if (pin.dataset.placed !== '1') {
    pin.style.left = Math.min(window.innerWidth - size, Math.max(0, pos.x ?? 100)) + 'px';
    pin.style.top = Math.min(window.innerHeight - size, Math.max(0, pos.y ?? 100)) + 'px';
    pin.dataset.placed = '1';
  }
  const dot = pin.querySelector('.homie-pin-dot');
  if (dot) dot.className = `homie-status-dot homie-pin-dot homie-status-${statusOf(h)}`;
  const nameEl = pin.querySelector('.homie-pin-name');
  if (nameEl && nameEl.textContent !== h.name) nameEl.textContent = h.name;
  const box = pin.querySelector('.homie-avatar-box');
  if (box) {
    // Refresh avatar img if it appeared/changed
    const img = box.querySelector('.homie-avatar-img');
    if (h.has_avatar && !img) {
      box.innerHTML = `<img class="homie-avatar-img" src="/api/homies/${h.id}/avatar?size=512&v=${encodeURIComponent(h.updated_at || '')}" alt="" draggable="false"/>`;
    }
    if (h.has_avatar) {
      const cur = box.querySelector('.homie-mouth')?.dataset.frame || 'closed';
      renderMouth(box, h, _speaking.has(h.id) ? cur : 'closed');
    }
  }
}

/** Set the mouth frame on every visible representation of a homie. */
function setMouthFrame(homieId, frame) {
  const h = getHomie(homieId);
  if (!h) return;
  document.querySelectorAll(`.homie-avatar-box[data-homie-id="${homieId}"]`).forEach((box) => {
    if (box.querySelector('.homie-avatar-img')) renderMouth(box, h, frame);
  });
}

// ---------------------------------------------------------------------------
// Chat bubble — anchored above the pinned homie, flips below near the top
// ---------------------------------------------------------------------------

function toggleBubble(homieId) {
  if (_bubbleOpenFor === homieId) { closeBubble(); return; }
  openBubble(homieId);
}

function closeBubble() {
  const b = document.getElementById('homie-bubble');
  if (b) b.remove();
  _bubbleOpenFor = null;
}

async function openBubble(homieId) {
  closeBubble();
  const h = getHomie(homieId);
  const layer = pinLayer();
  const pin = layer.querySelector(`.homie-pin[data-homie-id="${homieId}"]`);
  if (!h || !pin) return;
  _bubbleOpenFor = homieId;

  const b = document.createElement('div');
  b.id = 'homie-bubble';
  b.className = 'homie-bubble';
  b.innerHTML = `
    <div class="homie-bubble-msg" id="homie-bubble-msg"><span class="homie-bubble-empty">Say hi to ${escapeHtml(h.name)}…</span></div>
    <div class="homie-bubble-inputrow">
      <input type="text" id="homie-bubble-input" placeholder="Talk to ${escapeHtml(h.name)}…" autocomplete="off"/>
      <button id="homie-bubble-send" title="Send"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
    </div>
    <div class="homie-bubble-tail"></div>
  `;
  layer.appendChild(b);
  positionBubble(pin);

  // Show the latest reply from this homie's session, if any.
  loadLatestReply(h, b);

  const input = b.querySelector('#homie-bubble-input');
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await talkToHomie(h, text, b);
  };
  b.querySelector('#homie-bubble-send').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === 'Escape') closeBubble();
  });
  input.focus();
}

function positionBubble(pin) {
  const b = document.getElementById('homie-bubble');
  if (!b) return;
  const pr = pin.getBoundingClientRect();
  const bw = b.offsetWidth || 260;
  const bh = b.offsetHeight || 120;
  let left = pr.left + pr.width / 2 - bw / 2;
  left = Math.min(window.innerWidth - bw - 8, Math.max(8, left));
  // Above the head by default; flip below when near the top edge.
  let top = pr.top - bh - 14;
  const flipped = top < 8;
  if (flipped) top = pr.bottom + 14;
  b.style.left = left + 'px';
  b.style.top = top + 'px';
  b.classList.toggle('homie-bubble-flipped', flipped);
  // Tail points at the homie's head
  const tail = b.querySelector('.homie-bubble-tail');
  if (tail) {
    const tx = Math.min(bw - 24, Math.max(24, pr.left + pr.width / 2 - left));
    tail.style.left = tx + 'px';
  }
}

async function loadLatestReply(h, bubbleEl) {
  if (!h.session_id) return;
  try {
    const res = await fetch(`/api/history/${encodeURIComponent(h.session_id)}`, { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    const msgs = data.history || [];
    const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content);
    if (lastAssistant) setBubbleMessage(bubbleEl, lastAssistant.content);
  } catch {}
}

function setBubbleMessage(bubbleEl, text, { typing = false } = {}) {
  const msgEl = bubbleEl.querySelector('#homie-bubble-msg');
  if (!msgEl) return;
  if (typing) {
    msgEl.innerHTML = `<span class="homie-typing"><span></span><span></span><span></span></span>`;
    return;
  }
  const full = String(text || '').trim();
  if (!full) { msgEl.innerHTML = ''; return; }
  if (full.length > BUBBLE_TRUNCATE) {
    const short = full.slice(0, BUBBLE_TRUNCATE);
    msgEl.textContent = short + '… ';
    const more = document.createElement('a');
    more.href = '#';
    more.textContent = 'more';
    more.className = 'homie-bubble-more';
    more.addEventListener('click', (e) => {
      e.preventDefault();
      msgEl.textContent = full;
      msgEl.classList.add('homie-bubble-expanded');
    });
    msgEl.appendChild(more);
  } else {
    msgEl.textContent = full;
  }
}

// ---------------------------------------------------------------------------
// Talking + voice
// ---------------------------------------------------------------------------

async function talkToHomie(h, text, bubbleEl) {
  setBubbleMessage(bubbleEl, '', { typing: true });
  markWorking(h.id, true);
  let finalText = '';
  try {
    const res = await fetch(`/api/homies/${h.id}/message`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, stream: true }),
    });
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch {}
      throw new Error(detail);
    }
    // Read the SSE stream, accumulating text deltas.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop();
      for (const ev of events) {
        const line = ev.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          if (obj && typeof obj.delta === 'string') finalText += obj.delta;
        } catch {}
      }
    }
  } catch (err) {
    markWorking(h.id, false);
    setBubbleMessage(bubbleEl, `⚠ ${err.message || err}`);
    return;
  }
  markWorking(h.id, false);
  finalText = stripThinkClient(finalText).trim();
  if (document.getElementById('homie-bubble') && _bubbleOpenFor === h.id) {
    setBubbleMessage(bubbleEl, finalText || '(no reply)');
  }
  if (finalText) speakAsHomie(h, finalText);
}

function stripThinkClient(s) {
  return String(s || '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
}

function markWorking(homieId, working) {
  const h = getHomie(homieId);
  if (h) h.status = working ? 'working' : 'idle';
  const layer = document.getElementById('homie-pin-layer');
  const pin = layer && layer.querySelector(`.homie-pin[data-homie-id="${homieId}"]`);
  if (pin && h) updatePin(pin, h);
  renderDockGrid();
}

async function speakAsHomie(h, text) {
  if (!(await ttsAvailable())) return;
  try {
    const res = await fetch('/api/tts/synthesize', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 1200), format: 'audio' }),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.crossOrigin = 'anonymous';
    const speed = h.voice_config?.speed;
    if (speed && speed > 0) audio.playbackRate = Math.min(4, Math.max(0.25, speed));

    if (_activeLipSync) { _activeLipSync.dispose(); _activeLipSync = null; }
    _speaking.add(h.id);
    renderDockGrid();
    const layer = document.getElementById('homie-pin-layer');
    const pin = layer && layer.querySelector(`.homie-pin[data-homie-id="${h.id}"]`);
    if (pin) updatePin(pin, getHomie(h.id) || h);

    const sync = new LipSync(audio, (frame) => setMouthFrame(h.id, frame));
    _activeLipSync = sync;
    const cleanup = () => {
      _speaking.delete(h.id);
      setMouthFrame(h.id, 'closed');
      renderDockGrid();
      if (pin) updatePin(pin, getHomie(h.id) || h);
      URL.revokeObjectURL(url);
    };
    audio.addEventListener('ended', cleanup, { once: true });
    audio.addEventListener('pause', cleanup, { once: true });
    await audio.play();
    sync.start();
  } catch (e) {
    _speaking.delete(h.id);
    console.warn('homies: speech failed', e);
  }
}

// ---------------------------------------------------------------------------
// Boot — wire sidebar + rail buttons, restore pinned homies on load
// ---------------------------------------------------------------------------

function bindLaunchers() {
  const toolBtn = document.getElementById('tool-homies-btn');
  if (toolBtn) toolBtn.addEventListener('click', () => togglePanel());
  const railBtn = document.getElementById('rail-homies');
  if (railBtn) railBtn.addEventListener('click', () => togglePanel());
}

async function boot() {
  bindLaunchers();
  // Only fetch on boot when logged in — the fetch 401s harmlessly otherwise.
  try {
    await refreshHomies();
    if (_homies.some((p) => p.pinned)) startPolling();
  } catch {}
  window.addEventListener('resize', () => {
    const layer = document.getElementById('homie-pin-layer');
    if (!layer) return;
    layer.querySelectorAll('.homie-pin').forEach((pin) => {
      const size = pin.offsetWidth;
      pin.style.left = Math.min(window.innerWidth - size, Math.max(0, pin.offsetLeft)) + 'px';
      pin.style.top = Math.min(window.innerHeight - size, Math.max(0, pin.offsetTop)) + 'px';
    });
    if (_bubbleOpenFor) {
      const pin = layer.querySelector(`.homie-pin[data-homie-id="${_bubbleOpenFor}"]`);
      if (pin) positionBubble(pin);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

const homiesModule = {
  openPanel, closePanel, togglePanel, isPanelOpen,
  refreshHomies, MOUTHS, LipSync,
};
export default homiesModule;
