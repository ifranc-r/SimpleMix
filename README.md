# MixBuilder — Experimental Prototype

⚠️ **This project is only a prototype / test version.**  
It was built as a **front-end only demo** (HTML + CSS + JS, using the Web Audio API) to explore the idea of building audio mixes directly in the browser.

## What it does
- 100% local: no server, no upload.
- You can:
  - add multiple audio files,
  - reorder them (drag & drop),
  - apply a crossfade,
  - normalize per track,
  - and render a mix (WAV download).

## Limitations
- Hard limit: **1h max** (to avoid browser crashes).
- Runs in the browser’s memory → not suited for very long or heavy mixes.
- No persistence (files disappear when you refresh).

## Why?
This is a **proof-of-concept** before developing a **real full-stack version** with:
- file uploads,
- server-side rendering (FFmpeg/SoX),
- authentication,
- storage,
- job queue (Messenger).

## Next steps (full version idea)
A real full-stack version would include:
- Symfony API (PHP)
- FFmpeg backend processing (safe, open-source)
- Job queue (Symfony Messenger)
- Authentication (JWT or session)
- File storage (local → S3 later)
- User dashboards

## Disclaimer
This project is for **educational and experimental purposes only**.
The user is fully responsible for ensuring they have the rights to any audio files uploaded.

```html
<div id="previewWrap" style="margin-top:12px; text-align:center">
  <img id="cover" src="img/preview.jpeg" alt="Mix cover"
       style="max-width:200px; display:block; margin:0 auto 12px;">
  <audio id="preview" controls style="width:100%"></audio>
</div>