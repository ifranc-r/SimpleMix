# 🎶 SimpleMix
[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](LICENSE.md)

Just load your tracks, order them, crossfade, and download.  
No ads, no accounts, no cloud. **100% local, minimal, free.**

**SimpleMix** was created to answer a simple demand:  
most audio tools are **too complex** and overloaded with features.  
# 🎶 Simplemix — *Make your mix in 2 clicks.*
[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](LICENSE.md)



**SimpleMix is a lightweight, open-source tool** to quickly **create** a continuous **mix from multiple audio tracks** — directly in your browser.
---

## Tutorial


Go to https://ifranc-r.github.io/Simplemix/
1. Choose your 🎵Tracks 
2. Arrange it & Crossfade
3. get our *Your_Mix.wav* (Listen & Download)


## Why Simplemix?

Most audio editors and DJ tools are too complex for simple tasks.

If you only want to:
- Join several tracks into one
- Control the order (drag & drop or ↑↓ buttons)
- Smooth transitions with crossfade
- Normalize volumes so nothing clips
- Export locally in high-quality WAV

…then SimpleMix gives you exactly that — in seconds.

---

## ✅ Features
- 100% browser-based (no server, no upload)
- Crossfade between tracks (configurable in seconds)
- Drag & drop reordering
- Instant preview before exporting
- Local export: WAV 44.1kHz stereo
- Privacy-first: nothing ever leaves your computer

---

## ⚠️ Limitations
Hard time limit: 1 hour per mix (to keep your browser stable)
Export format: currently WAV only (MP3 planned)

---

## 🖼️ Preview image
You can display a static preview image above the audio player.

Example included in this repo:  
`preview.png`

In `index.html`:
<img id="cover" src="preview.png" alt="Mix cover" style="max-width:200px; display:block; margin:0 auto 12px;">


---------

⚠️ **This project is only a prototype / test version.**  
It was built as a **front-end only demo** (HTML + CSS + JS, using the Web Audio API) to explore the idea of building audio mixes directly in the browser.


---

## Next steps (full version vision)  

A complete version could be built with:  
- **Symfony API (PHP)** — robust backend framework  
- **FFmpeg** — safe, open-source audio rendering  
- **Symfony Messenger** — job queue for heavy tasks  
- **JWT or sessions** — secure authentication  
- **Database + storage** — for projects & files  
- **User dashboards** — manage, preview, and re-download mixes  

> **SimpleMix today = demo of what’s possible client-side.  
> Tomorrow = scalable full-stack audio tool.**

## Disclaimer
This project is for **educational and experimental purposes only**.
The user is fully responsible for ensuring they have the rights to any audio files uploaded.

## 📜 License
This project is licensed under **Creative Commons BY-NC 4.0**.  
You are free to use, modify, and share it for personal and educational purposes.  
**Commercial use is strictly prohibited.**
