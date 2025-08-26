/*
 * SimpleMix — Rolling preview (seekable, no time limit) + parallel chunked export (WAV)
 * CC BY-NC 4.0 — https://creativecommons.org/licenses/by-nc/4.0/
 */

const OUTPUT_SAMPLE_RATE = 44100;
const MEM_SOFT_CAP_BYTES = 1.2 * 1024 * 1024 * 1024;

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


// Optional player UI (if you keep those)
const playToggle = document.getElementById("playToggle");
const skipBackBtn = document.getElementById("skipBackBtn");
const skipFwdBtn = document.getElementById("skipFwdBtn");

// --- State
let files = [];
let order = [];
let buffers = [];
let lastBlob = null;
let ctx = null;
let pendingSwap = null;

let timeline = []; // [{idx,startSec,endSec,safeX}]
let totalSecCached = 0;

let rolling = null; // RollingPreview instance
let currentSec = 0;
let isPlaying = false;

let lastSkipDir = 0;
let lastSkipAt = 0;
const DOUBLE_SKIP_MS = 700;

function computeSkipSeconds(dir) {
  const now = performance.now();
  const fast = dir === lastSkipDir && now - lastSkipAt < DOUBLE_SKIP_MS;
  lastSkipDir = dir;
  lastSkipAt = now;
  return fast ? 30 : 10;
}

function setPlayingUI(p) {
  isPlaying = p;
  if (playToggle) playToggle.textContent = p ? "⏸ Pause" : "▶ Play";
}

// ---------- Helpers ----------
function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "badge " + (cls || "");
}
function clamp(v, min, max) { v = isFinite(v) ? v : 0; return Math.max(min, Math.min(max, v)); }
function safeDur(buf) { return Math.max(0, isFinite(buf?.duration) ? buf.duration : 0); }
function fmtMmSs(s) { const m = Math.floor(s / 60), ss = Math.floor(s % 60); return `${m}:${String(ss).padStart(2,"0")}`; }
function fmtHhMmSs(s) { const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), ss=Math.floor(s%60); return `${h}:${String(m).padStart(2,"0")}:${String(ss).padStart(2,"0")}`; }

// ---------- Files ----------
addMoreInput.addEventListener("change", async () => {
  await handleFiles(addMoreInput.files);
  addMoreInput.value = "";
});
addMoreBtn.addEventListener("click", () => addMoreInput.click());

async function handleFiles(fileList) {
  if (!fileList.length) return;
  loadingEl.style.display = "block";
  const newFiles = Array.from(fileList);
  const startIndex = files.length;
  files.push(...newFiles);
  order.push(...newFiles.map((_, i) => startIndex + i));
  buffers.length = files.length;
  await decodeAllMetadata(startIndex);
  renderList();
  recalcTimelineAndTotals();
  renderBtn.disabled = files.length < 2;
  loadingEl.style.display = "none";
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
  list.innerHTML = "";
  if (!order.length) { placeholder.style.display = "block"; return; }
  placeholder.style.display = "none";

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
    const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = String(pos + 1);
    const name = document.createElement("strong"); name.textContent = f.name;
    const dur = document.createElement("span"); dur.className = "small muted"; dur.textContent = `(${fmtMmSs(d)})`;
    left.append(badge, name, dur);

    const right = document.createElement("div");
    right.className = "right";
    const up = document.createElement("button");   up.className="icon"; up.textContent="↑"; up.onclick = () => { animateSwap(pos,pos-1); move(pos,-1); };
    const down = document.createElement("button"); down.className="icon"; down.textContent="↓"; down.onclick = () => { animateSwap(pos,pos+1); move(pos, 1); };
    const del = document.createElement("button");  del.className="icon"; del.textContent="🗑️"; del.onclick = () => removeAt(pos);
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
function swapPositions(a, b) { if (a<0||b<0||a>=order.length||b>=order.length) return; const t=order[a]; order[a]=order[b]; order[b]=t; }
function animateSwap(a, b) { pendingSwap = { a, b }; }
function removeAt(pos) {
  if (pos < 0 || pos >= order.length) return;
  const removedIndex = order[pos];
  order.splice(pos, 1);
  files.splice(removedIndex, 1);
  buffers.splice(removedIndex, 1);
  for (let i = 0; i < order.length; i++) if (order[i] > removedIndex) order[i]--;
  renderList();
  recalcTimelineAndTotals();
  renderBtn.disabled = files.length < 2;
}

// ---------- Timeline / duration ----------
function recalcTimelineAndTotals() {
  const xfade = clamp(parseFloat(xfadeInput.value || "0"), 0, 10);
  timeline = [];
  let t = 0;
  for (let i = 0; i < order.length; i++) {
    const idx = order[i];
    const dur = safeDur(buffers[idx]);
    const prevDur = i > 0 ? safeDur(buffers[order[i - 1]]) : 0;
    const safeX = i > 0 ? Math.min(xfade, prevDur / 2, dur / 2) : 0;
    const startSec = t, endSec = t + dur;
    timeline.push({ idx, startSec, endSec, safeX });
    t += dur - safeX;
  }
  totalSecCached = timeline.length ? timeline[timeline.length - 1].endSec : 0;
  totalDurEl.textContent = fmtHhMmSs(totalSecCached);

  // message
  let gateMsg = "";
  const estBytes = totalSecCached * OUTPUT_SAMPLE_RATE * 2 * 4;
  if (estBytes > MEM_SOFT_CAP_BYTES) gateMsg = "⚠️ Very long mix — may affect performance.";
  limitMsgEl.textContent = gateMsg;
  if (limitMsgTop) limitMsgTop.textContent = gateMsg;

}

function estimateTotalSec() {
  const xfade = clamp(parseFloat(xfadeInput.value||'0'),0,10);
  let total=0;
  for (let i=0;i<order.length;i++){
    const d=safeDur(buffers[order[i]]);
    total+=d;
    if(i>0){
      const prev=safeDur(buffers[order[i-1]]);
      total -= Math.max(0, Math.min(xfade, prev/2, d/2));
    }
  }
  return total;
}

// ---------- Windowed offline render ----------
async function renderWindowToBuffer(winStartSec, winEndSec, sampleRate = OUTPUT_SAMPLE_RATE) {
  const frames = Math.max(1, Math.ceil((winEndSec - winStartSec) * sampleRate));
  const offline = new OfflineAudioContext(2, frames, sampleRate);
  scheduleWindowIntoOffline(offline, winStartSec, winEndSec);
  return await offline.startRendering();
}

function scheduleWindowIntoOffline(offline, winStart, winEnd) {
  const xfade = clamp(parseFloat(xfadeInput.value || "0"), 0, 10);

  for (let i = 0; i < timeline.length; i++) {
    const { idx, startSec, endSec } = timeline[i];
    const dur = safeDur(buffers[idx]); if (dur <= 0) continue;

    // overlap
    const ovStart = Math.max(startSec, winStart);
    const ovEnd = Math.min(endSec, winEnd);
    const ovLen = ovEnd - ovStart;
    if (ovLen <= 0) continue;

    const buf = buffers[idx];
    const src = offline.createBufferSource(); src.buffer = buf;
    const g = offline.createGain();

    // normalization
    let target = 1;
    if (normalizeChk.checked) {
      let peak = 0; const ch0 = buf.getChannelData(0);
      for (let k = 0; k < ch0.length; k++) { const v = Math.abs(ch0[k]); if (v > peak) peak = v; }
      if (peak < 1e-6) peak = 1;
      target = Math.min(1, 0.9 / peak);
    }

    const prevDur = i > 0 ? safeDur(buffers[timeline[i - 1].idx]) : 0;
    const safeX = i > 0 ? Math.min(xfade, prevDur / 2, dur / 2) : 0;

    const when = ovStart - winStart;
    const srcOffset = ovStart - startSec;
    const playDur = ovLen;

    // envelope for fades
    g.gain.setValueAtTime(target, when);
    if (safeX > 0) {
      const fadeInStart = startSec;
      const fadeInEnd = startSec + safeX;
      const fadeOutStart = endSec - safeX;
      const fadeOutEnd = endSec;

      const a = when, b = when + playDur;

      const fiStartInWin = Math.max(a, fadeInStart - winStart);
      const fiEndInWin = Math.min(b, fadeInEnd - winStart);
      if (fiEndInWin > fiStartInWin) {
        g.gain.setValueAtTime(0.0001, fiStartInWin);
        g.gain.linearRampToValueAtTime(target, fiEndInWin);
      }
      const foStartInWin = Math.max(a, fadeOutStart - winStart);
      const foEndInWin = Math.min(b, fadeOutEnd - winStart);
      if (foEndInWin > foStartInWin) {
        g.gain.setValueAtTime(target, foStartInWin);
        g.gain.linearRampToValueAtTime(0.0001, foEndInWin);
      }
    }

    src.connect(g).connect(offline.destination);
    src.start(when, srcOffset, playDur);
  }
}

// ---------- RollingPreview (seekable, no time limit) ----------
class RollingPreview {
  constructor(opts = {}) {
    this.W = opts.windowSec ?? 12;
    this.SR = opts.sampleRate ?? OUTPUT_SAMPLE_RATE;
    this.totalSec = opts.totalSec ?? 0;
    this.onBuffered = opts.onBuffered || (() => {});
    this.onProgress = opts.onProgress || (() => {});

    this.curCtx = null;
    this.curSrc = null;
    this.nextBuf = null;

    this.t0 = 0;
    this.startedAt = 0;
    this._stopped = true;
    this._paused = false;

    this._raf = null;
    this._iv = null;
    this._tick = this._tick.bind(this);
    this._gen = 0;

    document.addEventListener("visibilitychange", async () => {
      if (!this.curCtx) return;
      try { await this.curCtx.resume(); } catch {}
    });
  }

  async _stopCurrentOnly() {
    if (this.curSrc) {
      try { this.curSrc.onended = null; this.curSrc.stop(0); } catch {}
      try { this.curSrc.disconnect(); } catch {}
      this.curSrc = null;
    }
    if (this.curCtx) {
      try { await this.curCtx.close(); } catch {}
      this.curCtx = null;
    }
  }

  async stop() {
    this._stopped = true;
    this._paused = false;
    this._stopTicks();
    await this._stopCurrentOnly();
    this.nextBuf = null;
  }

  async pause() {
    this._paused = true;
    this._stopTicks();
    if (this.curCtx?.state === "running") {
      try { await this.curCtx.suspend(); } catch {}
    }
  }

  async play() {
    this._paused = false;
    if (this.curCtx?.state === "suspended") {
      try { await this.curCtx.resume(); } catch {}
    }
    this._startTicks();
  }

  async startAt(sec) { return this.jumpTo(sec); }

  async jumpTo(sec) {
    this._stopped = false;
    this._paused = false;
    this._stopTicks();
    const myGen = ++this._gen;
    await this._stopCurrentOnly();

    // compute window
    const half = this.W / 2;
    let wStart = Math.max(0, sec - half);
    let wEnd = Math.min(this.totalSec, wStart + this.W);
    if (wEnd - wStart < this.W) wStart = Math.max(0, wEnd - this.W);

    const buf = await renderWindowToBuffer(wStart, wEnd, this.SR);
    if (this._gen !== myGen || this._stopped) return;
    this._playBuffer(buf, wStart);

    this._prefetch(wEnd);
    this._startTicks();
  }

  _playBuffer(buf, t0) {
    const myGen = this._gen;
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this.SR });
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start();

    this.curCtx = ctx; this.curSrc = src; this.t0 = t0; this.startedAt = ctx.currentTime;

    src.onended = () => {
      if (this._gen !== myGen || this._stopped || this._paused) return;
      if (this.nextBuf) {
        const next = this.nextBuf; this.nextBuf = null;
        this._playBuffer(next.buf, next.t0);
        this._prefetch(next.t0 + this.W);
      }
    };
  }

  _prefetch(nextStart) {
    if (nextStart >= this.totalSec) return;
    const end = Math.min(this.totalSec, nextStart + this.W);
    const myGen = this._gen;
    renderWindowToBuffer(nextStart, end, this.SR)
      .then((b) => {
        if (this._gen !== myGen) return;
        this.nextBuf = { buf: b, t0: nextStart };
        this.onBuffered({ from: nextStart, to: end });
      })
      .catch(() => {});
  }

  _startTicks() {
    this._stopTicks();
    this._raf = requestAnimationFrame(this._tick);
    this._iv = setInterval(this._tick, 250);
  }
  _stopTicks() {
    if (this._raf) cancelAnimationFrame(this._raf), this._raf = null;
    if (this._iv) clearInterval(this._iv), this._iv = null;
  }

  _tick = () => {
    if (this._stopped || this._paused || !this.curCtx) return;
    if (this.curCtx.state === "suspended") return;
    const elapsed = this.curCtx.currentTime - this.startedAt;
    const globalT = this.t0 + Math.max(0, elapsed);
    this.onProgress(globalT, this.totalSec);
    this._raf = requestAnimationFrame(this._tick);
  };
}



// ---------- Export WAV chunked ----------
async function renderChunkedWAV() {
  setStatus("Preparing offline (WAV)…", "warn");
  progressWrap.style.display = "block";
  progress.value = 0;
  progressText.textContent = "";

  const SR = OUTPUT_SAMPLE_RATE;
  const CHUNK_SEC = 20;
  const totalSec = totalSecCached;

  const chunks = [];
  let renderedSec = 0;

  while (renderedSec < totalSec) {
    const winStart = renderedSec;
    const winEnd = Math.min(totalSec, renderedSec + CHUNK_SEC);
    const buf = await renderWindowToBuffer(winStart, winEnd, SR);

    const L = buf.getChannelData(0);
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const i16 = f32StereoToPCM16Bytes(L, R); // Uint8Array
    chunks.push(i16);

    renderedSec = winEnd;
    progress.value = Math.min(0.98, renderedSec / Math.max(1, totalSec));
    progressText.textContent = `Rendering… ${fmtHhMmSs(renderedSec)} / ${fmtHhMmSs(totalSec)}`;
  }

  const wavBlob = buildWavFromChunks(chunks, SR, 2);
  lastBlob = wavBlob;

  // Init WaveSurfer preview if available
  if (window.initWaveSurferWithBlob && lastBlob instanceof Blob) {
    window.initWaveSurferWithBlob(lastBlob);
  }

  dlBtn.disabled = false;
  setStatus("Done (offline WAV)", "ok");
  progress.value = 1;
  progressText.textContent = "Mix ready.";
}

function buildWavFromChunks(u8chunks, sampleRate, channels) {
  const dataSize = u8chunks.reduce((s, c) => s + c.byteLength, 0);
  const header = wavHeader(sampleRate, channels, dataSize);
  return new Blob([header, ...u8chunks], { type: "audio/wav" });
}

// ---------- Encoding utils ----------
function f32StereoToPCM16Bytes(L, R) {
  const n = Math.min(L.length, R.length);
  const out = new Int16Array(n * 2);
  for (let i = 0, j = 0; i < n; i++) {
    let l = Math.max(-1, Math.min(1, L[i]));
    let r = Math.max(-1, Math.min(1, R[i]));
    out[j++] = l < 0 ? l * 0x8000 : l * 0x7fff;
    out[j++] = r < 0 ? r * 0x8000 : r * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}
function wavHeader(sampleRate, channels, dataBytes) {
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wr(0,"RIFF"); v.setUint32(4, 36 + dataBytes, true); wr(8,"WAVE"); wr(12,"fmt ");
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,channels,true);
  v.setUint32(24,sampleRate,true); v.setUint32(28,sampleRate*channels*2,true);
  v.setUint16(32,channels*2,true); v.setUint16(34,16,true); wr(36,"data"); v.setUint32(40,dataBytes,true);
  return new Uint8Array(buf);
}

// ---------- Actions ----------
renderBtn.addEventListener("click", async () => {
  if (files.length < 2) return;
  if (!timeline.length) recalcTimelineAndTotals();

  // (Plus de live preview ici)
  renderChunkedWAV()
    .then(() => {
      // Après export, on charge l’aperçu dans WaveSurfer (#wave)
      if (window.initWaveSurferWithBlob && lastBlob instanceof Blob) {
        window.initWaveSurferWithBlob(lastBlob);
      }
    })
    .catch((err) => {
      console.error(err);
      setStatus(err.message || String(err), "err");
    });
});


dlBtn.addEventListener("click", () => {
  if (!lastBlob) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(lastBlob);
  a.download = "mix.wav";
  document.body.appendChild(a);
  a.click();
  a.remove();
});
