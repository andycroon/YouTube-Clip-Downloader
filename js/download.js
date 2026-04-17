/**
 * Download pipeline.
 *
 * Paths:
 *   A — full video/audio download (no clip, no re-encode — just stream redirect)
 *   B — clip, precise (re-encode around cut points via FFmpeg.wasm)
 *   C — clip, keyframe-snap copy (fast, slightly imprecise — fallback on slow devices)
 *   D — MP3 320kbps (re-encode audio via FFmpeg.wasm libmp3lame)
 */
window.Downloader = (() => {
  const FFMPEG_CORE_JS     = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js';
  const FFMPEG_CORE_WASM   = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm';
  const FFMPEG_JS          = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.min.js';
  // Self-hosted so it's same-origin — classic Workers require this, and
  // importScripts() from a same-origin worker can then load the core from
  // the CDN without blob-URL quirks.
  const FFMPEG_CLASS_WORKER = 'vendor/ffmpeg/814.ffmpeg.js';

  // Long-clip warning threshold (10 minutes)
  const LONG_CLIP_MS = 10 * 60 * 1000;

  let _ffmpeg = null;
  let _ffmpegLoading = false;

  async function loadFFmpeg(onProgress) {
    if (_ffmpeg) return _ffmpeg;
    if (_ffmpegLoading) { await new Promise(r => setTimeout(r, 200)); return loadFFmpeg(onProgress); }
    _ffmpegLoading = true;

    // Load the @ffmpeg/ffmpeg UMD script if not already present
    if (!window.FFmpegWASM) {
      onProgress?.('Loading FFmpeg…', 5);
      await loadScript(FFMPEG_JS);
    }

    const { FFmpeg } = window.FFmpegWASM;
    const ff = new FFmpeg();

    ff.on('log', ({ message }) => {
      // Parse progress from FFmpeg output lines like "time=00:00:12.34"
      const m = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (m && window._ffmpegDurationSec) {
        const elapsed = parseInt(m[1])*3600 + parseInt(m[2])*60 + parseFloat(m[3]);
        const pct = 10 + Math.min(85, (elapsed / window._ffmpegDurationSec) * 85);
        onProgress?.(`Processing… ${Math.round(pct)}%`, pct);
      }
    });

    onProgress?.('Loading FFmpeg…', 8);

    await ff.load({
      classWorkerURL: new URL(FFMPEG_CLASS_WORKER, document.baseURI).href,
      coreURL: FFMPEG_CORE_JS,
      wasmURL: FFMPEG_CORE_WASM,
    });

    _ffmpeg = ff;
    _ffmpegLoading = false;
    return ff;
  }

  /**
   * Main entry point. Called with selected format + clip range.
   * Dispatches to the correct path.
   */
  async function run({ format, videoFormats, startMs, endMs, durationMs, title, onProgress, onDone, onError }) {
    const isFullVideo = startMs === 0 && endMs >= durationMs - 200;
    const isMp3 = format._isMp3;

    try {
      if (isFullVideo && !isMp3) {
        await pathA(format, title, onProgress, onDone);
      } else if (isMp3) {
        await pathD({ videoFormats, startMs, endMs, durationMs, title, onProgress, onDone });
      } else {
        await pathBC({ format, videoFormats, startMs, endMs, durationMs, title, onProgress, onDone });
      }
    } catch (err) {
      console.error('[download]', err);
      onError?.(err?.message || String(err) || 'Download failed (see console for details)');
    }
  }

  // Path A — full download, no clipping
  async function pathA(format, title, onProgress, onDone) {
    onProgress?.('Fetching stream…', 20);
    // For combined/single streams, we can just fetch the whole thing
    const resp = await fetch(format.url);
    if (!resp.ok) throw new Error(`Stream fetch failed: ${resp.status}`);
    onProgress?.('Downloading…', 50);
    const blob = await resp.blob();
    onProgress?.('Done', 100);
    triggerDownload(blob, sanitiseName(title) + '.' + format.container);
    onDone?.();
  }

  // Path B/C — clip a segment
  async function pathBC({ format, videoFormats, startMs, endMs, durationMs, title, onProgress, onDone }) {
    const clipSec = (endMs - startMs) / 1000;

    window._ffmpegDurationSec = clipSec;

    const ff = await loadFFmpeg((msg, pct) => onProgress?.(msg, pct));

    // For DASH (video-only), we need the best audio stream too
    const needsAudio = format.type === 'video';
    let audioFormat = null;
    if (needsAudio && videoFormats) {
      audioFormat = (videoFormats || []).find(f => f.type === 'audio');
    }

    onProgress?.('Fetching video…', 15);
    const videoBytes = await fetchRange(format.url, startMs, endMs, durationMs, format.filesize);

    let audioBytes = null;
    if (audioFormat) {
      onProgress?.('Fetching audio…', 25);
      audioBytes = await fetchRange(audioFormat.url, startMs, endMs, durationMs, audioFormat.filesize);
    }

    // Write to FFmpeg virtual FS
    await ff.writeFile('input_v' , new Uint8Array(videoBytes));
    if (audioBytes) await ff.writeFile('input_a', new Uint8Array(audioBytes));

    const startSec = startMs / 1000;
    const ext = format.container === 'webm' ? 'webm' : 'mp4';
    const outFile = 'output.' + ext;

    onProgress?.('Processing…', 40);

    // Try precise cut first (re-encode); fall back to copy on failure
    let success = false;
    try {
      if (audioBytes) {
        await ff.exec(['-ss', String(startSec), '-t', String(clipSec),
          '-i', 'input_v', '-i', 'input_a',
          '-c:v', 'libx264', '-c:a', 'aac', '-movflags', 'faststart',
          outFile]);
      } else {
        await ff.exec(['-ss', String(startSec), '-t', String(clipSec),
          '-i', 'input_v', '-c:v', 'libx264', '-movflags', 'faststart', outFile]);
      }
      success = true;
    } catch {
      // Fall back to keyframe-snap copy (Path C)
    }

    if (!success) {
      if (audioBytes) {
        await ff.exec(['-ss', String(startSec), '-t', String(clipSec),
          '-i', 'input_v', '-i', 'input_a', '-c', 'copy', outFile]);
      } else {
        await ff.exec(['-ss', String(startSec), '-t', String(clipSec),
          '-i', 'input_v', '-c', 'copy', outFile]);
      }
    }

    onProgress?.('Saving file…', 95);
    const data = await ff.readFile(outFile);
    await ff.deleteFile('input_v');
    if (audioBytes) await ff.deleteFile('input_a');
    await ff.deleteFile(outFile);

    const mimeType = ext === 'webm' ? 'video/webm' : 'video/mp4';
    const blob = new Blob([data], { type: mimeType });
    triggerDownload(blob, sanitiseName(title) + '_clip.' + ext);
    onProgress?.('Done!', 100);
    onDone?.();
  }

  // Path D — MP3 320kbps
  async function pathD({ videoFormats, startMs, endMs, durationMs, title, onProgress, onDone }) {
    const clipSec = (endMs - startMs) / 1000;
    window._ffmpegDurationSec = clipSec;

    const audioFmt = (videoFormats || []).find(f => f.type === 'audio' || f.type === 'combined');
    if (!audioFmt) throw new Error('No audio stream available for this video');

    const ff = await loadFFmpeg((msg, pct) => onProgress?.(msg, pct));

    onProgress?.('Fetching audio…', 20);
    const bytes = await fetchRange(audioFmt.url, startMs, endMs, durationMs, audioFmt.filesize);
    await ff.writeFile('input_a', new Uint8Array(bytes));

    onProgress?.('Encoding MP3…', 45);
    const startSec = startMs / 1000;
    await ff.exec(['-ss', String(startSec), '-t', String(clipSec),
      '-i', 'input_a',
      '-c:a', 'libmp3lame', '-b:a', '320k',
      'output.mp3']);

    onProgress?.('Saving file…', 95);
    const data = await ff.readFile('output.mp3');
    await ff.deleteFile('input_a');
    await ff.deleteFile('output.mp3');

    const blob = new Blob([data], { type: 'audio/mpeg' });
    triggerDownload(blob, sanitiseName(title) + '_audio.mp3');
    onProgress?.('Done!', 100);
    onDone?.();
  }

  /**
   * Range-fetch a portion of a stream.
   * Estimates the byte range from known file size assuming roughly even bitrate.
   */
  async function fetchRange(url, startMs, endMs, durationMs, fileSizeBytes) {
    if (!fileSizeBytes || !durationMs) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);
      return r.arrayBuffer();
    }

    const PADDING = 512 * 1024;
    const startByte = Math.max(0, Math.floor((startMs / durationMs) * fileSizeBytes) - PADDING);
    const endByte   = Math.min(fileSizeBytes - 1, Math.ceil((endMs / durationMs) * fileSizeBytes) + PADDING);

    const r = await fetch(url, { headers: { Range: `bytes=${startByte}-${endByte}` } });
    if (!r.ok && r.status !== 206) throw new Error(`Fetch failed: ${r.status}`);
    return r.arrayBuffer();
  }

  function triggerDownload(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    requestAnimationFrame(() => { URL.revokeObjectURL(a.href); a.remove(); });
  }

  function sanitiseName(str) {
    return (str || 'video').replace(/[^a-z0-9 _-]/gi, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'video';
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function isLongClip(startMs, endMs) { return (endMs - startMs) > LONG_CLIP_MS; }

  return { run, isLongClip };
})();
