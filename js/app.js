/*
 * SimpleMix — Instant rolling preview (seekable) + chunked export (WAV)
 * CC BY-NC 4.0 — https://creativecommons.org/licenses/by-nc/4.0/
 */

const OUTPUT_SAMPLE_RATE = 44100;
const MEM_SOFT_CAP_BYTES = 1.2 * 1024 * 1024 * 1024;

// Fenêtre plus large + lookahead + micro-fade
const WINDOW_SEC = 24; // au lieu de 12
const LOOKAHEAD_SEC = 4; // précharger 4 s avant la fin
const EDGE_FADE_MS = 8; // petites rampes pour éviter les clics

const safeIdle = (fn) =>
  window.requestIdleCallback ? requestIdleCallback(fn) : setTimeout(fn, 0);

// ---------- UI refs ----------
const addMoreInput = document.getElementById("addMore");
const addMoreBtn = document.getElementById("addMoreBtn");
const list = document.getElementById("tracks");
const placeholder = document.getElementById("tracksPlaceholder");
const renderBtn = document.getElementById("renderBtn");
const dlBtn = document.getElementById("dlBtn");
const statusEl = document.getElementById("status");
const progressWrap = document.getElementById("progressWrap");
const progress = document.getElementById("progress");
const progressText = document.getElementById("progressText");
const xfadeInput = document.getElementById("xfade");
const normalizeChk = document.getElementById("normalize");
const totalDurEl = document.getElementById("totalDur");
const limitMsgEl = document.getElementById("limitMsg");
const limitMsgTop = document.getElementById("limitMsgTop");
const loadingEl = document.getElementById("loading");

// WaveSurfer UI
const $wsTime = document.getElementById("wsTime");
const $wsPlay = document.getElementById("wsPlay");
const $wsPause = document.getElementById("wsPause");
const $wsBack = document.getElementById("wsBack");
const $wsFwd = document.getElementById("wsFwd");

// ---------- State ----------
let files = [];
let order = [];
let buffers = [];
let lastBlob = null;
let ctx = null;
let pendingSwap = null;

let timeline = []; // [{idx, startSec, endSec, safeX}]
let totalSecCached = 0;
let currentSec = 0;

let rolling = null;
let isPlaying = false;

let isExporting = false; // pour ne pas recréer la waveform pendant l'export
let wsBootedOnce = false; // pour éviter les reloads qui remettent le curseur à 0

// WaveSurfer + progressive peaks
// WaveSurfer (visual only)
let ws = null;
const N_BINS = 1024;
let peaksL = null,
  peaksR = null;

// NEW: block feedback loop when we move the cursor ourselves
let wsSeekingByCode = false;

// ---------- Small helpers ----------
function setStatus(text, cls) {
  if (statusEl) {
    statusEl.textContent = text;
    statusEl.className = "badge " + (cls || "");
  }
}
function clamp(v, min, max) {
  v = isFinite(v) ? v : 0;
  return Math.max(min, Math.min(max, v));
}
function safeDur(buf) {
  return Math.max(0, isFinite(buf?.duration) ? buf.duration : 0);
}
function fmtMmSs(s) {
  const m = Math.floor(s / 60),
    ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, "0")}`;
}
function fmtHhMmSs(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(
    ss
  ).padStart(2, "0")}`;
}

function setPlayingUI(p) {
  isPlaying = p; /* label optional */
}

// ---------- Files ----------
addMoreInput?.addEventListener("change", async () => {
  await handleFiles(addMoreInput.files);
  addMoreInput.value = "";
});
addMoreBtn?.addEventListener("click", () => addMoreInput?.click());

async function handleFiles(fileList) {
  if (!fileList?.length) return;
  loadingEl && (loadingEl.style.display = "block");
  try {
    const newFiles = Array.from(fileList);
    const startIndex = files.length;
    files.push(...newFiles);
    order.push(...newFiles.map((_, i) => startIndex + i));
    buffers.length = files.length;
    await decodeAllMetadata(startIndex);
    renderList();
    recalcTimelineAndTotals(); // also boots WaveSurfer
    if (renderBtn) renderBtn.disabled = !(files.length >= 2);
  } finally {
    loadingEl && (loadingEl.style.display = "none");
  }
}

async function decodeAllMetadata(start = 0) {
  if (!ctx)
    ctx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: OUTPUT_SAMPLE_RATE,
    });
  for (let i = start; i < files.length; i++) {
    if (buffers[i]) continue;
    try {
      const arr = await files[i].arrayBuffer();
      const buf = await ctx.decodeAudioData(arr);
      buffers[i] = buf;
    } catch (e) {
      console.warn("Decode failed:", files[i]?.name, e);
      alert(
        `Cannot load "${files[i]?.name}".\n` +
          `• The file may be protected (DRM) or invalid.\n` +
          `• Tip (iPhone): save recordings in the Files app (Downloads/iCloud) and retry.`
      );
      buffers[i] = {
        duration: 0,
        numberOfChannels: 2,
        getChannelData: () => new Float32Array(0),
        sampleRate: OUTPUT_SAMPLE_RATE,
      };
    }
  }
}

function renderList() {
  if (!list) return;
  list.innerHTML = "";
  if (!order.length) {
    if (placeholder) placeholder.style.display = "block";
    return;
  }
  if (placeholder) placeholder.style.display = "none";

  order.forEach((idx, pos) => {
    const f = files[idx];
    const d = safeDur(buffers[idx]);
    const li = document.createElement("li");
    li.className = "track";
    li.draggable = true;
    li.dataset.pos = String(pos);

    li.addEventListener("dragstart", (e) => {
      li.classList.add("dragging");
      e.dataTransfer.setData("text/plain", String(pos));
    });
    li.addEventListener("dragend", () => li.classList.remove("dragging"));
    li.addEventListener("dragover", (e) => e.preventDefault());
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
      const to = pos;
      if (!Number.isInteger(from) || from === to) return;
      animateSwap(from, to);
      swapPositions(from, to);
      renderList();
      recalcTimelineAndTotals();
    });

    const left = document.createElement("div");
    left.className = "left";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = String(pos + 1);
    const name = document.createElement("strong");
    name.textContent = f.name;
    const dur = document.createElement("span");
    dur.className = "small muted";
    dur.textContent = `(${fmtMmSs(d)})`;
    left.append(badge, name, dur);

    const right = document.createElement("div");
    right.className = "right";
    const up = document.createElement("button");
    up.className = "icon";
    up.textContent = "↑";
    up.onclick = () => {
      animateSwap(pos, pos - 1);
      move(pos, -1);
    };
    const down = document.createElement("button");
    down.className = "icon";
    down.textContent = "↓";
    down.onclick = () => {
      animateSwap(pos, pos + 1);
      move(pos, 1);
    };
    const del = document.createElement("button");
    del.className = "icon";
    del.textContent = "🗑️";
    del.onclick = () => removeAt(pos);
    right.append(up, down, del);

    li.append(left, right);
    list.appendChild(li);
  });

  if (pendingSwap) {
    const items = Array.from(list.querySelectorAll(".track"));
    const iA = Math.max(0, Math.min(items.length - 1, pendingSwap.a));
    const iB = Math.max(0, Math.min(items.length - 1, pendingSwap.b));
    if (items[iA]) items[iA].classList.add("swap");
    if (items[iB]) items[iB].classList.add("swap");
    setTimeout(() => {
      if (items[iA]) items[iA].classList.remove("swap");
      if (items[iB]) items[iB].classList.remove("swap");
      pendingSwap = null;
    }, 220);
  }
}

function move(pos, delta) {
  const np = pos + delta;
  if (np < 0 || np >= order.length) return;
  swapPositions(pos, np);
  renderList();
  recalcTimelineAndTotals();
}
function swapPositions(a, b) {
  if (a < 0 || b < 0 || a >= order.length || b >= order.length) return;
  const t = order[a];
  order[a] = order[b];
  order[b] = t;
}
function animateSwap(a, b) {
  pendingSwap = { a, b };
}
function removeAt(pos) {
  if (pos < 0 || pos >= order.length) return;
  const removedIndex = order[pos];
  order.splice(pos, 1);
  files.splice(removedIndex, 1);
  buffers.splice(removedIndex, 1);
  for (let i = 0; i < order.length; i++) {
    if (order[i] > removedIndex) order[i]--;
  }
  renderList();
  recalcTimelineAndTotals();
  if (renderBtn) renderBtn.disabled = !(files.length >= 2);
}

// ---------- Timeline & totals (also boots WS) ----------
function recalcTimelineAndTotals() {
  const xfade = clamp(parseFloat(xfadeInput?.value || "0"), 0, 10);
  timeline = [];
  let t = 0;
  for (let i = 0; i < order.length; i++) {
    const idx = order[i];
    const dur = safeDur(buffers[idx]);
    const prevDur = i > 0 ? safeDur(buffers[order[i - 1]]) : 0;
    const safeX = i > 0 ? Math.min(xfade, prevDur / 2, dur / 2) : 0;
    const startSec = t,
      endSec = t + dur;
    timeline.push({ idx, startSec, endSec, safeX });
    t += dur - safeX;
  }
  totalSecCached = timeline.length ? timeline[timeline.length - 1].endSec : 0;
  totalDurEl && (totalDurEl.textContent = fmtHhMmSs(totalSecCached));

  // perf warning only
  let gateMsg = "";
  const estBytes = totalSecCached * OUTPUT_SAMPLE_RATE * 2 * 4;
  if (estBytes > MEM_SOFT_CAP_BYTES)
    gateMsg = "⚠️ Very long mix — may affect performance.";
  limitMsgEl && (limitMsgEl.textContent = gateMsg);
  limitMsgTop && (limitMsgTop.textContent = gateMsg);

  // boot / refresh WaveSurfer placeholder
  wsBoot(totalSecCached);
  safeIdle(() => wsBuildPeaksFromDecoded());
}

// ---------- Offline window renderer ----------
async function renderWindowToBuffer(
  winStartSec,
  winEndSec,
  sampleRate = OUTPUT_SAMPLE_RATE
) {
  const frames = Math.max(1, Math.ceil((winEndSec - winStartSec) * sampleRate));
  const offline = new OfflineAudioContext(2, frames, sampleRate);
  scheduleWindowIntoOffline(offline, winStartSec, winEndSec);
  return await offline.startRendering();
}

function scheduleWindowIntoOffline(offline, winStart, winEnd) {
  const xfade = clamp(parseFloat(xfadeInput?.value || "0"), 0, 10);

  for (let i = 0; i < timeline.length; i++) {
    const { idx, startSec, endSec } = timeline[i];
    const buf = buffers[idx];
    const dur = safeDur(buf);
    if (dur <= 0) continue;

    const ovStart = Math.max(startSec, winStart);
    const ovEnd = Math.min(endSec, winEnd);
    const ovLen = ovEnd - ovStart;
    if (ovLen <= 0) continue;

    const src = offline.createBufferSource();
    src.buffer = buf;
    const g = offline.createGain();

    // normalization
    let target = 1;
    if (normalizeChk?.checked) {
      let peak = 0;
      const ch0 = buf.getChannelData(0);
      for (let k = 0; k < ch0.length; k++) {
        const v = Math.abs(ch0[k]);
        if (v > peak) peak = v;
      }
      if (peak < 1e-6) peak = 1;
      target = Math.min(1, 0.9 / peak);
    }

    const when = ovStart - winStart;
    const srcOffset = ovStart - startSec;
    const playDur = ovLen;

    // approximate fades if intersected
    const prevDur = i > 0 ? safeDur(buffers[timeline[i - 1].idx]) : 0;
    const safeX = i > 0 ? Math.min(xfade, prevDur / 2, dur / 2) : 0;
    const fadeInStart = startSec,
      fadeInEnd = startSec + safeX;
    const fadeOutStart = endSec - safeX,
      fadeOutEnd = endSec;

    g.gain.setValueAtTime(target, when);

    if (safeX > 0) {
      // fade-in inside window
      const a1 = Math.max(when, fadeInStart - winStart);
      const b1 = Math.min(when + playDur, fadeInEnd - winStart);
      if (b1 > a1) {
        g.gain.setValueAtTime(0.0001, a1);
        g.gain.linearRampToValueAtTime(target, b1);
      }
      // fade-out inside window
      const a2 = Math.max(when, fadeOutStart - winStart);
      const b2 = Math.min(when + playDur, fadeOutEnd - winStart);
      if (b2 > a2) {
        g.gain.setValueAtTime(target, a2);
        g.gain.linearRampToValueAtTime(0.0001, b2);
      }
    }

    src.connect(g).connect(offline.destination);
    src.start(when, srcOffset, playDur);
  }
}

// ---------- Rolling preview ----------
class RollingPreview {
  constructor(opts = {}) {
    this.W = opts.windowSec ?? WINDOW_SEC; // ← utilise ta constante
    this.SR = opts.sampleRate ?? OUTPUT_SAMPLE_RATE;
    this.totalSec = opts.totalSec ?? 0;
    this.onBuffered = opts.onBuffered || (() => {});
    this.onProgress = opts.onProgress || (() => {});

    // Un seul AudioContext pour toute la vie du preview
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: this.SR,
    });

    this.curSrc = null;
    this.nextBuf = null;

    this.t0 = 0; // temps global du début de la fenêtre courante
    this.startedAt = 0; // horloge ctx au moment du start()
    this._stopped = true;
    this._paused = false;

    this._tick = this._tick.bind(this);

    this._raf = null;
    this._iv = null;
    this._gen = 0;

    // Important : on NE suspend PAS en arrière-plan (sinon coupures).
    document.addEventListener("visibilitychange", async () => {
      if (!this.ctx) return;
      try {
        if (document.visibilityState === "visible") await this.ctx.resume();
        // else: ne rien faire → laisse jouer en fond
      } catch {}
    });
  }

  async _stopCurrentOnly() {
    if (this.curSrc) {
      try {
        this.curSrc.onended = null;
        this.curSrc.stop(0);
      } catch {}
      try {
        this.curSrc.disconnect();
      } catch {}
      this.curSrc = null;
    }
    // NE PAS fermer this.ctx ici (il est réutilisé)
  }

  async stop() {
    this._stopped = true;
    this._paused = false;
    this._stopTicks();
    await this._stopCurrentOnly();
    this.nextBuf = null;
    // On peut suspendre le ctx pour économiser la batterie quand on s'arrête vraiment
    try {
      await this.ctx.suspend();
    } catch {}
  }

  async pause() {
    this._paused = true;
    this._stopTicks();
    try {
      await this.ctx.suspend();
    } catch {}
  }

  async play() {
    this._paused = false;
    try {
      await this.ctx.resume();
    } catch {}
    this._startTicks();
  }

  async startAt(sec) {
    return this.jumpTo(sec);
  }

  async jumpTo(sec) {
    this._stopped = false;
    this._paused = false;
    this._stopTicks();
    const myGen = ++this._gen;
    await this._stopCurrentOnly();

    // Make sure audio actually plays
    try {
      await this.ctx.resume();
    } catch {}

    // pick window around 'sec'
    const half = this.W / 2;
    let wStart = Math.max(0, sec - half);
    let wEnd = Math.min(this.totalSec, wStart + this.W);
    if (wEnd - wStart < this.W) wStart = Math.max(0, wEnd - this.W);

    const buf = await renderWindowToBuffer(wStart, wEnd, this.SR);
    if (this._gen !== myGen || this._stopped) return;

    const startOffset = Math.max(0, Math.min(buf.duration, sec - wStart));
    this._playBuffer(buf, wStart, startOffset); // ← pass offset
    this._prefetch(wEnd);
    this._startTicks();
  }

  _tick() {
    if (this._stopped || this._paused || !this.ctx) return;
    if (this.ctx.state === "suspended") return;

    const elapsed = this.ctx.currentTime - this.startedAt;
    const globalT = this.t0 + Math.max(0, elapsed);

    this.onProgress(globalT, this.totalSec);
    wsSetPlayhead(globalT, this.totalSec);
    currentSec = globalT;

    this._raf = requestAnimationFrame(() => this._tick());
  }

  _playBuffer(buf, t0, startOffset = 0) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;

    // anti-click micro-fades
    const g = ctx.createGain();
    const now = ctx.currentTime;
    const dur = buf.duration;
    const fade = EDGE_FADE_MS / 1000;
    const remain = Math.max(0, dur - startOffset);

    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(1.0, now + fade);
    // apply fade-out at end of remaining segment
    g.gain.setValueAtTime(1.0, now + Math.max(0, remain - fade));
    g.gain.linearRampToValueAtTime(0.0001, now + remain);

    src.connect(g).connect(ctx.destination);
    // start inside the rendered window
    src.start(now, startOffset);

    this.curSrc = src;
    this.t0 = t0 + startOffset; // global position matches what we hear
    this.startedAt = now;

    // prefetch based on remaining play time of this buffer
    const nextStart = this.t0 + remain - LOOKAHEAD_SEC;
    this._prefetch(nextStart);

    src.onended = () => {
      if (this._stopped || this._paused) return;
      if (this.nextBuf) {
        const next = this.nextBuf;
        this.nextBuf = null;
        // when chaining, play next buffer from its start (offset 0)
        this._playBuffer(next.buf, next.t0, 0);
      }
    };
  }

  _prefetch(nextStart) {
    if (nextStart >= this.totalSec) return;
    const end = Math.min(this.totalSec, nextStart + this.W);
    const myGen = ++this._gen;
    renderWindowToBuffer(nextStart, end, this.SR)
      .then((b) => {
        if (this._gen !== myGen || this._stopped) return;
        this.nextBuf = { buf: b, t0: nextStart };
        this.onBuffered({ from: nextStart, to: end });
        wsAccumulatePeaks?.(nextStart, end, b);
      })
      .catch(() => {});
  }

  _startTicks() {
    this._stopTicks();
    // rAF pour le front (fluide), setInterval pour l’arrière-plan (rAF est throttle)
    const tick = () => this._tick();
    this._raf = requestAnimationFrame(tick);
    this._iv = setInterval(tick, 250);
  }

  _stopTicks() {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    if (this._iv) {
      clearInterval(this._iv);
      this._iv = null;
    }
  }
}

function wsBoot(totalSec) {
  if (!window.WaveSurfer) return;

  if (!ws) {
    ws = WaveSurfer.create({
      container: "#wave",
      waveColor: "#999",
      progressColor: "#000",
      cursorColor: "#333",
      height: 80,
      interact: true,
    });

    // 1) Seek WaveSurfer → pilote le preview
    const handleSeek = async (progress) => {
      const dur = ws.getDuration() || totalSecCached || 0;
      const when = Math.max(0, Math.min(dur, progress * dur));

      // force l’affichage immédia​t du curseur + temps
      try {
        ws.setTime(when);
      } catch {}
      wsUpdateTime(when, dur);

      if (!rolling) {
        await bootRollingAt(when);
        setPlayingUI(true);
        return;
      }
      await rolling.jumpTo(when);
      setPlayingUI(true);
    };

    ws.on("seek", async (progress) => {
      if (wsSeekingByCode) return; // <-- ignore programmatic seeks
      await handleSeek(progress); // user-initiated seek only
    });

    // 2) Fallback manuel si l’event 'seek' ne part pas (certains contextes)
    const el = document.getElementById("wave");
    el?.addEventListener(
      "pointerdown",
      async (e) => {
        // ignore si WS n'a pas encore de durée connue
        const dur = ws.getDuration() || totalSecCached || 0;
        if (!dur) return;

        const rect = el.getBoundingClientRect();
        const p = Math.max(
          0,
          Math.min(1, (e.clientX - rect.left) / rect.width)
        );
        await handleSeek(p);
      },
      { passive: true }
    );
  }

  // (ré)alloue les peaks si besoin
  if (!peaksL || peaksL.length !== N_BINS) {
    peaksL = new Float32Array(N_BINS);
    peaksR = new Float32Array(N_BINS);
  }

  // charge une première fois la durée (sans décodage) — une seule fois
  if (!wsBootedOnce && !isExporting) {
    try {
      ws.load("", [peaksL, peaksR], totalSec || 0);
      wsBootedOnce = true;
    } catch {}
  }

  wsUpdateTime(0, totalSec || 0);
}

// en haut : const N_BINS = 1024;
function wsAccumulatePeaks(winStartSec, winEndSec, audioBuffer) {
  if (!ws) return;
  const total = ws.getDuration() || totalSecCached || 0;
  if (!total) return;

  const sr = audioBuffer.sampleRate;
  const L = audioBuffer.getChannelData(0);
  const R =
    audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : L;

  // stride plus grand (≈ 40–50 ms) → beaucoup moins de boucles
  const stride = Math.max(1024, Math.floor(sr / 20));

  for (let i = 0; i < L.length; i += stride) {
    const t = winStartSec + i / sr;
    const bin = Math.max(
      0,
      Math.min(N_BINS - 1, Math.floor((t / total) * N_BINS))
    );
    let pL = 0,
      pR = 0,
      jMax = Math.min(L.length, i + stride);
    for (let j = i; j < jMax; j++) {
      const a = Math.abs(L[j]);
      if (a > pL) pL = a;
      const b = Math.abs(R[j]);
      if (b > pR) pR = b;
    }
    if (pL > peaksL[bin]) peaksL[bin] = pL;
    if (pR > peaksR[bin]) peaksR[bin] = pR;
  }
  try {
    ws.load("", [peaksL, peaksR], total);
  } catch {}
}

function wsSetPlayhead(sec, total) {
  if (!ws) return;

  const dur = ws.getDuration() || total || 0;
  wsUpdateTime(sec, dur);

  if (dur <= 0) return;

  const p = Math.max(0, Math.min(1, sec / dur));

  // Avoid hammering WS if we’re already close (prevents jitter)
  const cur =
    typeof ws.getCurrentTime === "function" ? ws.getCurrentTime() || 0 : null;
  if (cur !== null && Math.abs(cur - sec) < 0.08) return;

  try {
    wsSeekingByCode = true; // <-- mute the 'seek' handler
    ws.seekTo(p);
  } catch (_) {
    /* ignore */
  } finally {
    // drop the flag on the next microtask so user clicks still work
    Promise.resolve().then(() => {
      wsSeekingByCode = false;
    });
  }
}

function wsUpdateTime(cur, dur) {
  if (!$wsTime) return;
  $wsTime.textContent = `${fmtHhMmSs(cur || 0)} / ${fmtHhMmSs(dur || 0)}`;
}

// ---------- Export (chunked WAV) ----------
async function renderChunkedWAV() {
  setStatus("Preparing offline (WAV)…", "warn");
  progressWrap && (progressWrap.style.display = "block");
  if (progress) {
    progress.value = 0;
  }
  if (progressText) {
    progressText.textContent = "";
  }

  const SR = OUTPUT_SAMPLE_RATE,
    CHUNK_SEC = 20,
    totalSec = totalSecCached;
  const chunks = [];
  let renderedSec = 0;
  if (!totalSecCached || totalSecCached <= 0) {
    setStatus("Nothing to render (total duration is 0).", "err");
    return;
  }

  while (renderedSec < totalSec) {
    const winStart = renderedSec,
      winEnd = Math.min(totalSec, renderedSec + CHUNK_SEC);
    const buf = await renderWindowToBuffer(winStart, winEnd, SR);

    // collect PCM16 as small blocks (Blob parts)
    const L = buf.getChannelData(0);
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const u8 = f32StereoToPCM16Bytes(L, R);
    chunks.push(u8);

    renderedSec = winEnd;
    if (progress) {
      progress.value = Math.min(0.98, renderedSec / Math.max(1, totalSec));
    }
    if (progressText) {
      progressText.textContent = `Rendering… ${fmtHhMmSs(
        renderedSec
      )} / ${fmtHhMmSs(totalSec)}`;
    }
  }

  const wavBlob = buildWavFromChunks(chunks, SR, 2);
  lastBlob = wavBlob;
  dlBtn && (dlBtn.disabled = false);
  setStatus("Done (offline WAV)", "ok");
  if (progress) {
    progress.value = 1;
  }
  if (progressText) {
    progressText.textContent = "Mix ready.";
  }
}

function f32StereoToPCM16Bytes(L, R) {
  const n = Math.min(L.length, R.length);
  const out = new Int16Array(n * 2);
  for (let i = 0, j = 0; i < n; i++) {
    let l = Math.max(-1, Math.min(1, L[i])),
      r = Math.max(-1, Math.min(1, R[i]));
    out[j++] = l < 0 ? l * 0x8000 : l * 0x7fff;
    out[j++] = r < 0 ? r * 0x8000 : r * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

function wavHeader(sampleRate, channels, dataBytes) {
  const buf = new ArrayBuffer(44),
    v = new DataView(buf);
  const wr = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  wr(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  wr(8, "WAVE");
  wr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  wr(36, "data");
  v.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}

function buildWavFromChunks(u8chunks, sampleRate, channels) {
  const dataSize = u8chunks.reduce((s, c) => s + c.byteLength, 0);
  const header = wavHeader(sampleRate, channels, dataSize);
  return new Blob([header, ...u8chunks], { type: "audio/wav" });
}

// Construit les peaks globaux du mix à partir des AudioBuffer décodés
async function wsBuildPeaksFromDecoded() {
  if (!ws || !timeline.length || !totalSecCached) return;

  // (ré)alloue les peaks d'abord
  if (!peaksL || peaksL.length !== N_BINS) {
    peaksL = new Float32Array(N_BINS);
    peaksR = new Float32Array(N_BINS);
  } else {
    peaksL.fill(0);
    peaksR.fill(0);
  }

  const total = totalSecCached; // <-- défini ici
  const xfade = clamp(parseFloat(xfadeInput?.value || "0"), 0, 10);

  // stride rapide (~20ms). Utilise le SR réel de chaque buffer pour le temps local
  const defaultStride = Math.max(512, Math.floor(OUTPUT_SAMPLE_RATE / 50));

  for (let i = 0; i < timeline.length; i++) {
    const { idx, startSec, endSec } = timeline[i];
    const buf = buffers[idx];
    const dur = safeDur(buf);
    if (dur <= 0) continue;

    // normalisation éventuelle
    let gain = 1;
    if (normalizeChk?.checked) {
      const ch0 = buf.getChannelData(0);
      let p = 0;
      for (let k = 0; k < ch0.length; k++) {
        const v = Math.abs(ch0[k]);
        if (v > p) p = v;
      }
      const peak = Math.max(1e-6, p);
      gain = Math.min(1, 0.9 / peak);
    }

    const prevDur = i > 0 ? safeDur(buffers[timeline[i - 1].idx]) : 0;
    const safeX = i > 0 ? Math.min(xfade, prevDur / 2, dur / 2) : 0;

    const L = buf.getChannelData(0);
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;

    // stride basé sur le SR du buffer
    const stride = Math.max(512, Math.floor(buf.sampleRate / 50));

    for (let s = 0; s < L.length; s += stride) {
      const tLocal = s / buf.sampleRate;
      const tGlobal = startSec + tLocal;
      if (tGlobal < startSec || tGlobal > endSec) continue;

      // enveloppe des fades
      let env = 1;
      if (safeX > 0) {
        if (tLocal < safeX) env = Math.max(0.0001, tLocal / safeX);
        else if (tLocal > dur - safeX)
          env = Math.max(0.0001, (dur - tLocal) / safeX);
      }
      const g = gain * env;

      // peak local
      let pL = 0,
        pR = 0,
        jMax = Math.min(L.length, s + stride);
      for (let j = s; j < jMax; j++) {
        const a = Math.abs(L[j]);
        if (a > pL) pL = a;
        const b = Math.abs(R[j]);
        if (b > pR) pR = b;
      }
      pL *= g;
      pR *= g;

      // bin global
      const bin = Math.max(
        0,
        Math.min(N_BINS - 1, Math.floor((tGlobal / total) * N_BINS))
      );
      if (pL > peaksL[bin]) peaksL[bin] = pL;
      if (pR > peaksR[bin]) peaksR[bin] = pR;
    }
  }

  // Pousse l’ondulation complète dans WaveSurfer (une seule fois)
  if (!isExporting) {
    try {
      ws.load("", [peaksL, peaksR], total);
      wsUpdateTime(0, total);
    } catch {}
  }
}

// ---------- Controls: play/pause & skip ----------
let lastSkipDir = 0,
  lastSkipAt = 0;
const DOUBLE_SKIP_MS = 700;
function computeSkipSeconds(dir) {
  const now = performance.now();
  const fast = dir === lastSkipDir && now - lastSkipAt < DOUBLE_SKIP_MS;
  lastSkipDir = dir;
  lastSkipAt = now;
  return fast ? 30 : 10;
}
async function bootRollingAt(sec) {
  recalcTimelineAndTotals();
  rolling = new RollingPreview({
    windowSec: WINDOW_SEC, // ← ICI
    sampleRate: OUTPUT_SAMPLE_RATE,
    totalSec: totalSecCached,
    onBuffered: () => {},
    onProgress: (t, total) => {
      currentSec = t;
      wsSetPlayhead(t, total);
    },
  });
  await rolling.startAt(sec);
}
async function playOrPause() {
  if (!rolling) {
    await bootRollingAt(currentSec || 0);
    setPlayingUI(true);
    return;
  }
  if (isPlaying) {
    await rolling.pause();
    setPlayingUI(false);
  } else {
    await rolling.play();
    setPlayingUI(true);
  }
}
async function skipBy(delta) {
  const target = clamp((currentSec || 0) + delta, 0, totalSecCached || 0);
  if (!rolling) {
    await bootRollingAt(target);
    setPlayingUI(true);
    return;
  }
  await rolling.jumpTo(target);
  setPlayingUI(true);
}

// Buttons & hotkeys
$wsPlay?.addEventListener("click", () => playOrPause());
$wsPause?.addEventListener("click", async () => {
  if (rolling) {
    await rolling.pause();
    setPlayingUI(false);
  }
});

$wsBack?.addEventListener("click", () => skipBy(-computeSkipSeconds(-1)));
$wsFwd?.addEventListener("click", () => skipBy(+computeSkipSeconds(+1)));
window.addEventListener("keydown", async (e) => {
  const el = document.activeElement;
  const typing =
    el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.isContentEditable);
  if (typing) return;
  if (e.code === "Space") {
    e.preventDefault();
    await playOrPause();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    await skipBy(-computeSkipSeconds(-1));
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    await skipBy(+computeSkipSeconds(+1));
  }
});

// ---------- Generate & Download ----------
renderBtn.addEventListener("click", async () => {
  if (files.length < 2) return;
  if (!timeline.length) recalcTimelineAndTotals();

  // Position de départ = curseur WS s’il existe, sinon 0
  const startAt =
    ws && typeof ws.getCurrentTime === "function"
      ? ws.getCurrentTime() || 0
      : 0;

  // Démarre/relance proprement le rolling preview à la bonne position
  if (rolling) {
    await rolling.stop();
    rolling = null;
    setPlayingUI(false);
  }
  await bootRollingAt(startAt);
  setPlayingUI(true);

  // Lance l'export chunké — et bloque les reload waveform le temps de l’export
  isExporting = true;
  renderChunkedWAV()
    .catch((err) => {
      console.error(err);
      setStatus(err.message || String(err), "err");
    })
    .finally(() => {
      isExporting = false;
    });
});

dlBtn?.addEventListener("click", () => {
  if (!lastBlob) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(lastBlob);
  a.download = "mix.wav";
  document.body.appendChild(a);
  a.click();
  a.remove();
});
