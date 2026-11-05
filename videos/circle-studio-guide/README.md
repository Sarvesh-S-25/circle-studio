# Circle Studio video guide

The deliverable is `Circle-Studio-Getting-Started.mp4`: 100 seconds, 1920 × 1080, 30fps, with music and on-screen instructions. See SAMPLES.md for three ready-to-use briefs, and CREDITS.md for music attribution to retain when sharing.

Editable source: `index.html` and one scene per file in `compositions/`. `build.mjs` regenerates scenes from the chapter definitions; manual scene edits will be replaced if you run it again. `chapters.json` gives chapter times.

From the repository root, with the downloaded local tools present:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File videos/circle-studio-guide/hf.ps1 preview --background --port 4410
powershell -NoProfile -ExecutionPolicy Bypass -File videos/circle-studio-guide/hf.ps1 check --json
powershell -NoProfile -ExecutionPolicy Bypass -File videos/circle-studio-guide/hf.ps1 render --quality delivery --workers 2 --output Circle-Studio-Getting-Started.mp4
```

The wrapper places `.tools/bin` on PATH. It contains FFmpeg 7.1 from the existing Python imageio-ffmpeg installation and FFprobe from ffprobe-static. These tools and temporary review/render caches are ignored. To work elsewhere, install FFmpeg and FFprobe on PATH and use `npx --yes hyperframes@0.8.210` directly.

The delivery file has a final audio mastering pass: FFmpeg `-c:v copy -af volume=2.35 -c:a aac -b:a 192k -movflags +faststart`. Apply that to a newly rendered file once, writing a separate output before replacing it; do not apply it again to the delivered MP4. The final mix measures -16.2 LUFS and -1.7 dBFS true peak.

The local editable preview is http://localhost:4410/#project/circle-studio-guide while its server is running. Edit with Framey opens the HyperFrames desktop app; download: https://hyperframes.studio/studio/download?os=windows&src=cli

`demo.mjs` is a separate temporary fixture for recapturing product screens. It uses port 4407, temporary folders, fictional content, and fake engines; it is not the normal app launcher. The final edit uses saved screenshots and does not require this server.

The four official HyperFrames skills are installed in the user's Codex skills folder: hyperframes, hyperframes-cli, hyperframes-registry, and media-use.
