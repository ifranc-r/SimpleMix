// js/wavesurfer-init.js
let ws = null;

function initWaveSurferWithBlob(input) {
  // Accept Blob or URL string
  let url = null;
  if (input instanceof Blob) {
    url = URL.createObjectURL(input);
  } else if (typeof input === 'string') {
    url = input;
  } else {
    console.error('initWaveSurferWithBlob: expected Blob or URL string. Got:', input);
    return;
  }

  // Destroy previous
  if (ws) { try { ws.destroy(); } catch {} ws = null; }

  ws = WaveSurfer.create({
    container: '#wave',
    waveColor: '#999',
    progressColor: '#000',
    cursorColor: '#333',
    height: 80,
    responsive: true,
    normalize: false,
    hideScrollbar: true,
  });

  const $time = document.getElementById('wsTime');
  const fmt = (s) => { const m=Math.floor(s/60), ss=Math.floor(s%60); return `${m}:${String(ss).padStart(2,'0')}`; };

  ws.on('ready', () => { if ($time) $time.textContent = `00:00 / ${fmt(ws.getDuration() || 0)}`; });
  ws.on('audioprocess', () => { if ($time) $time.textContent = `${fmt(ws.getCurrentTime())} / ${fmt(ws.getDuration() || 0)}`; });
  ws.on('seek', () => { if ($time) $time.textContent = `${fmt(ws.getCurrentTime())} / ${fmt(ws.getDuration() || 0)}`; });

  // Buttons
  document.getElementById('wsPlay')?.addEventListener('click', () => ws.play());
  document.getElementById('wsPause')?.addEventListener('click', () => ws.pause());
  document.getElementById('wsBack')?.addEventListener('click', () => ws.skip(-10));
  document.getElementById('wsFwd')?.addEventListener('click', () => ws.skip(10));

  // Hotkeys
  window.addEventListener('keydown', (e) => {
    const typing = ['INPUT','TEXTAREA'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (typing) return;
    if (e.key === ' ') { e.preventDefault(); ws.playPause(); }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); ws.skip(-10); }
    if (e.key === 'ArrowRight') { e.preventDefault(); ws.skip(10);  }
  });

  ws.load(url);
}

window.initWaveSurferWithBlob = initWaveSurferWithBlob;
