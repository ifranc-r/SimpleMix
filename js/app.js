
  /*
 * SimpleMix
 * Copyright (c) 2025 ifranc-r
 * Licensed under Creative Commons BY-NC 4.0
 * https://creativecommons.org/licenses/by-nc/4.0/
 */


const MAX_SECONDS = 1 * 60 * 60;
const OUTPUT_SAMPLE_RATE = 44100;
const MEM_SOFT_CAP_BYTES = 1.2 * 1024 * 1024 * 1024;

  // --- Encodage WAV 16-bit PCM stéréo ---
function encodeWAV(audioBuffer){
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate || OUTPUT_SAMPLE_RATE;
    const samples = audioBuffer.length;
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = (numChannels>1) ? audioBuffer.getChannelData(1) : ch0;
    const interleaved = new Int16Array(samples*2);
    for(let i=0,j=0;i<samples;i++){
      const sL = Math.max(-1, Math.min(1, ch0[i]));
      const sR = Math.max(-1, Math.min(1, ch1[i]));
      interleaved[j++] = (sL<0? sL*0x8000 : sL*0x7FFF);
      interleaved[j++] = (sR<0? sR*0x8000 : sR*0x7FFF);
    }
    const byteRate = sampleRate * 4; // 16-bit * 2ch
    const blockAlign = 4;
    const dataSize = interleaved.length * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    function wr(off, str){ for(let i=0;i<str.length;i++) view.setUint8(off+i, str.charCodeAt(i)); }
    let o=0;
    wr(o,'RIFF'); o+=4;
    view.setUint32(o,36 + dataSize,true); o+=4;
    wr(o,'WAVE'); o+=4;
    wr(o,'fmt '); o+=4;
    view.setUint32(o,16,true); o+=4; // PCM header size
    view.setUint16(o,1,true); o+=2;  // PCM
    view.setUint16(o,2,true); o+=2;  // channels
    view.setUint32(o,sampleRate,true); o+=4;
    view.setUint32(o,byteRate,true); o+=4;
    view.setUint16(o,blockAlign,true); o+=2;
    view.setUint16(o,16,true); o+=2; // bits
    wr(o,'data'); o+=4;
    view.setUint32(o,dataSize,true); o+=4;
    new Int16Array(buffer,44).set(interleaved);
    return new Blob([buffer], {type:'audio/wav'});
  }

  const addMoreInput= document.getElementById('addMore');
  const addMoreBtn  = document.getElementById('addMoreBtn');
  const list        = document.getElementById('tracks');
  const placeholder = document.getElementById('tracksPlaceholder');
  const renderBtn   = document.getElementById('renderBtn');
  const dlBtn       = document.getElementById('dlBtn');
  const statusEl    = document.getElementById('status');
  const progressWrap= document.getElementById('progressWrap');
  const progress    = document.getElementById('progress');
  const progressText= document.getElementById('progressText');
  const preview     = document.getElementById('preview');
  const xfadeInput  = document.getElementById('xfade');
  const normalizeChk= document.getElementById('normalize');
  const totalDurEl  = document.getElementById('totalDur');
  const limitMsgEl  = document.getElementById('limitMsg');
  const limitMsgTop = document.getElementById('limitMsgTop');
  const loadingEl   = document.getElementById('loading');

  // Boutons actions
  renderBtn.addEventListener('click', onRenderClick);
  dlBtn.addEventListener('click', onDownloadClick);

  async function onRenderClick(){
    if (files.length < 2) return;
    setStatus('Préparation…','warn');
    progressWrap.style.display='block'; progress.value=0; progressText.textContent='';
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({sampleRate:OUTPUT_SAMPLE_RATE});
      // Recalcul total + gardes
      const xfade=clamp(parseFloat(xfadeInput.value||'0'),0,10);
      let totalSec=0;
      for (let i=0;i<order.length;i++){
        const idx=order[i];
        const dur=safeDur(buffers[idx]);
        totalSec+=dur;
        if (i>0 && xfade>0){
          const prevDur=safeDur(buffers[order[i-1]]);
          const safeX=Math.min(xfade,prevDur/2,dur/2);
          totalSec-=Math.max(0,safeX);
        }
      }
      if (!isFinite(totalSec) || totalSec<=0) throw new Error('Durée totale invalide.');
      if (totalSec > MAX_SECONDS) throw new Error('Mix > 1h — réduis ou supprime des pistes.');
      const estBytes=totalSec*OUTPUT_SAMPLE_RATE*2*4;
      if (estBytes > MEM_SOFT_CAP_BYTES) throw new Error('Mix trop lourd pour la RAM du navigateur.');

      const frames = Math.ceil(totalSec * OUTPUT_SAMPLE_RATE);
      const offline = new OfflineAudioContext(2, frames, OUTPUT_SAMPLE_RATE);

      let t = 0;
      for (let i=0;i<order.length;i++){
        const idx = order[i];
        const buffer = buffers[idx];
        const dur = safeDur(buffer);
        const src = offline.createBufferSource(); src.buffer = buffer;
        const g = offline.createGain();
        let target = 1;
        if (normalizeChk.checked){
          let peak = 0; const ch0 = buffer.getChannelData(0);
          for (let k=0;k<ch0.length;k++){ const v = Math.abs(ch0[k]); if (v>peak) peak=v; }
          if (peak<1e-6) peak=1; target = Math.min(1, 0.9/peak);
        }
        const prevDur = i>0 ? safeDur(buffers[order[i-1]]) : 0;
        const safeX = (i>0) ? Math.min(xfade, prevDur/2, dur/2) : 0;

        if (safeX>0){
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(target, t + safeX);
          if (i < order.length-1){
            g.gain.setValueAtTime(target, t + dur - safeX);
            g.gain.linearRampToValueAtTime(0.0001, t + dur);
          }
        } else {
          g.gain.setValueAtTime(target, t);
        }

        src.connect(g).connect(offline.destination);
        src.start(t);
        t += dur - safeX;
      }

      setStatus('Rendu…','warn');
      const rendered = await offline.startRendering();
      progress.value = 0.9;
      const blob = encodeWAV(rendered);
      lastBlob = blob;
      const url = URL.createObjectURL(blob);
      preview.src = url;
      dlBtn.disabled = false;
      setStatus('Terminé','ok');
      progress.value = 1; progressText.textContent = 'Mix prêt.';
    } catch(err){
      console.error(err);
      setStatus(err.message || String(err), 'err');
    }
  }

  function onDownloadClick(){
    if (!lastBlob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(lastBlob);
    a.download = 'mix.wav';
    document.body.appendChild(a); a.click(); a.remove();
  }

  let files = [];
  let order = [];
  let buffers = [];
  let lastBlob = null;
  let ctx = null;
  let pendingSwap = null;

  addMoreInput.addEventListener('change', async () => {
    await handleFiles(addMoreInput.files);
    addMoreInput.value = '';
  });

  addMoreBtn.addEventListener('click', () => {
    addMoreInput.click();
  });

  async function handleFiles(fileList){
    if (!fileList.length) return;
    loadingEl.style.display = 'block';
    const newFiles = Array.from(fileList);
    const startIndex = files.length;
    files.push(...newFiles);
    order.push(...newFiles.map((_,i)=>startIndex+i));
    buffers.length = files.length;
    await decodeAllMetadata(startIndex);
    renderList();
    updateTotalsAndGate();
    loadingEl.style.display = 'none';
  }

  async function decodeAllMetadata(start=0){
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({sampleRate:OUTPUT_SAMPLE_RATE});
    for (let i=start;i<files.length;i++){
      if (buffers[i]) continue;
      try {
        const arr = await files[i].arrayBuffer();
        const buf = await ctx.decodeAudioData(arr);
        buffers[i] = buf;
      } catch(e) {
        buffers[i] = { duration:0, numberOfChannels:2, getChannelData:()=>new Float32Array(0), sampleRate:OUTPUT_SAMPLE_RATE };
      }
    }
  }

  function renderList(){
    list.innerHTML='';
    if (!order.length){ placeholder.style.display='block'; return; }
    placeholder.style.display='none';
    order.forEach((idx,pos)=>{
      const f=files[idx];
      const d=safeDur(buffers[idx]);
      const li=document.createElement('li');
      li.className='track';
      li.draggable=true;li.dataset.pos=String(pos);
      li.addEventListener('dragstart',(e)=>{li.classList.add('dragging');e.dataTransfer.setData('text/plain',String(pos));});
      li.addEventListener('dragend',()=>li.classList.remove('dragging'));
      li.addEventListener('dragover',(e)=>{e.preventDefault();});
      li.addEventListener('drop',(e)=>{e.preventDefault();const from=parseInt(e.dataTransfer.getData('text/plain'),10);const to=pos;if(!Number.isInteger(from)||from===to)return;animateSwap(from,to);swapPositions(from,to);renderList();updateTotalsAndGate();});

      const left=document.createElement('div');left.className='left';
      const badge=document.createElement('span');badge.className='badge';badge.textContent=String(pos+1);
      const name=document.createElement('strong');name.textContent=f.name;
      const dur=document.createElement('span');dur.className='small muted';dur.textContent=`(${fmtMmSs(d)})`;
      left.appendChild(badge);left.appendChild(name);left.appendChild(dur);

      const right=document.createElement('div');right.className='right';
      const up=document.createElement('button');up.className='icon';up.textContent='↑';up.onclick=()=>{animateSwap(pos,pos-1);move(pos,-1);};
      const down=document.createElement('button');down.className='icon';down.textContent='↓';down.onclick=()=>{animateSwap(pos,pos+1);move(pos,1);};
      const del=document.createElement('button');del.className='icon';del.textContent='🗑️';del.onclick=()=>removeAt(pos);
      right.appendChild(up);right.appendChild(down);right.appendChild(del);

      li.appendChild(left);li.appendChild(right);
      list.appendChild(li);
    });

    if (pendingSwap){
      const items = Array.from(list.querySelectorAll('.track'));
      const iA = Math.max(0, Math.min(items.length-1, pendingSwap.a));
      const iB = Math.max(0, Math.min(items.length-1, pendingSwap.b));
      if (items[iA]) items[iA].classList.add('swap');
      if (items[iB]) items[iB].classList.add('swap');
      setTimeout(()=>{
        if (items[iA]) items[iA].classList.remove('swap');
        if (items[iB]) items[iB].classList.remove('swap');
      }, 220);
      pendingSwap = null;
    }
  }

  function move(pos,delta){const np=pos+delta;if(np<0||np>=order.length)return;swapPositions(pos,np);renderList();updateTotalsAndGate();}
  function swapPositions(a,b){if(a<0||b<0||a>=order.length||b>=order.length)return;const tmp=order[a];order[a]=order[b];order[b]=tmp;}
  function animateSwap(a,b){ pendingSwap = {a,b}; }

  function removeAt(pos){
    if(pos<0||pos>=order.length)return;
    const removedIndex=order[pos];
    order.splice(pos,1);
    files.splice(removedIndex,1);
    buffers.splice(removedIndex,1);
    for(let i=0;i<order.length;i++){ if(order[i]>removedIndex) order[i]--; }
    renderList();
    updateTotalsAndGate();
    if(files.length<2){ renderBtn.disabled=true; }
  }

  function updateTotalsAndGate(){
    const xfade=clamp(parseFloat(xfadeInput.value||'0'),0,10);
    let totalSec=0;
    for(let i=0;i<order.length;i++){
      const idx=order[i];
      const dur=safeDur(buffers[idx]);
      totalSec+=dur;
      if(i>0&&xfade>0){
        const prevDur=safeDur(buffers[order[i-1]]);
        const safeX=Math.min(xfade,prevDur/2,dur/2);
        totalSec-=Math.max(0,safeX);
      }
    }
    totalDurEl.textContent=fmtHhMmSs(totalSec);
    let gateMsg='';
    const estBytes=totalSec*OUTPUT_SAMPLE_RATE*2*4;
    const overTime=totalSec>MAX_SECONDS;
    const overMem=estBytes>MEM_SOFT_CAP_BYTES;
    if(overTime){gateMsg='⛔ 1h limit exceeded — remove tracks or reduce crossfade.';}else if(overMem){gateMsg='⚠️ Mix très long — risque de manque de mémoire navigateur.';}
    limitMsgEl.textContent=gateMsg;
    if(limitMsgTop) limitMsgTop.textContent=gateMsg;
    renderBtn.disabled=(files.length<2)||overTime||overMem;
}

function setStatus(text,cls){statusEl.textContent=text;statusEl.className='badge '+(cls||'');}
function clamp(v,min,max){v=isFinite(v)?v:0;return Math.max(min,Math.min(max,v));}
function safeDur(buf){return Math.max(0,isFinite(buf?.duration)?buf.duration:0);}
function fmtMmSs(s){const m=Math.floor(s/60),ss=Math.floor(s%60);return `${m}:${String(ss).padStart(2,'0')}`;}
function fmtHhMmSs(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=Math.floor(s%60);return `${h}h${String(m).padStart(2,'0')}m${String(ss).padStart(2,'0')}s`;}

// Static intro modal — show once (bump KEY to re-show)
(function(){
  const KEY = 'sm_seen_intro_static_v1';
  const modal = document.getElementById('introModal');
  const btn = document.getElementById('smClose');
  if (!modal || !btn) return;

  const show = () => { modal.style.display = 'flex'; modal.setAttribute('aria-hidden','false'); };
  const hide = () => { modal.style.display = 'none'; modal.setAttribute('aria-hidden','true'); localStorage.setItem(KEY, '1'); };

  if (!localStorage.getItem(KEY)) show();
  btn.addEventListener('click', hide);
  modal.addEventListener('click', (e)=>{ if (e.target === modal) hide(); });
})();


