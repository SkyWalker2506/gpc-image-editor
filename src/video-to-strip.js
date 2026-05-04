/* gpc-image-editor — video-to-strip mode.
 *
 * Public API:
 *   window.ImageEditor.mountVideoToStrip({
 *     container:   HTMLElement,
 *     videoSrc:    string,            // ObjectURL or http(s) URL
 *     sourceName:  string,            // base for filename suggestion (defaults to 'clip')
 *     onApply:     (out) => void,     // out: { stripBlob, stripDataUrl, frames, fps,
 *                                    //         width, height, frameWidth, frameHeight,
 *                                    //         filename, sourceName }
 *     onCancel:    () => void
 *   }) => { destroy }
 *
 * Pure browser. Uses HTMLVideoElement + offscreen canvas. No deps.
 *
 * Pipeline per frame:
 *   seek -> drawImage(video, crop -> frameW x frameH) -> optional chroma key.
 * Final strip canvas is (frameW * N) x frameH, exported as PNG blob.
 */
(function (root) {
  'use strict';

  const NS = 'gpc-ie-v2s';
  const DEFAULT_FPS = 8;

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return { r: 0, g: 255, b: 0 };
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  }

  function applyChromaKey(ctx, w, h, keyHex, tol) {
    if (!w || !h) return;
    const key = hexToRgb(keyHex);
    const tol2 = tol * tol;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const dr = d[i] - key.r;
      const dg = d[i + 1] - key.g;
      const db = d[i + 2] - key.b;
      if (dr * dr + dg * dg + db * db <= tol2) d[i + 3] = 0;
    }
    ctx.putImageData(img, 0, 0);
  }

  // Best-effort precise seek. Returns Promise resolved when frame is ready.
  function seekTo(video, t) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; cleanup(); resolve(); };
      const onSeeked = () => finish();
      const cleanup = () => video.removeEventListener('seeked', onSeeked);
      video.addEventListener('seeked', onSeeked);
      try { video.currentTime = t; } catch (_) { finish(); }
      // Use rVFC for sub-frame precision when available.
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(() => finish());
      }
      setTimeout(finish, 1500); // safety timeout
    });
  }

  function mountVideoToStrip(opts) {
    opts = opts || {};
    const container = opts.container;
    if (!container) throw new Error('mountVideoToStrip: container required');
    const sourceName = opts.sourceName || 'clip';

    container.classList.add(NS);
    container.innerHTML = '';

    // ---- DOM ----
    const root = el('div', NS + '-root');

    const left = el('div', NS + '-left');
    const video = document.createElement('video');
    video.className = NS + '-video';
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.controls = false;
    video.src = opts.videoSrc || '';
    const previewCanvas = el('canvas', NS + '-preview-canvas');
    previewCanvas.width = 320; previewCanvas.height = 180;
    const scrub = el('input', NS + '-scrub');
    scrub.type = 'range'; scrub.min = '0'; scrub.max = '1000'; scrub.value = '0'; scrub.step = '1';
    const timeLabel = el('div', NS + '-time', '0.00 / 0.00s');
    left.appendChild(video);
    left.appendChild(previewCanvas);
    left.appendChild(scrub);
    left.appendChild(timeLabel);

    const center = el('div', NS + '-center');
    const stripWrap = el('div', NS + '-strip-wrap');
    const stripCanvas = el('canvas', NS + '-strip-canvas');
    stripWrap.appendChild(stripCanvas);
    const status = el('div', NS + '-status', 'Load a video to begin.');
    const progress = el('div', NS + '-progress');
    const progressBar = el('div', NS + '-progress-bar');
    progress.appendChild(progressBar);
    center.appendChild(stripWrap);
    center.appendChild(progress);
    center.appendChild(status);

    const right = el('div', NS + '-right');
    right.innerHTML = `
      <div class="${NS}-row"><label>Frame count</label>
        <input type="number" class="${NS}-n" min="2" max="32" value="8"></div>
      <div class="${NS}-row"><label>Frame W</label>
        <input type="number" class="${NS}-fw" min="8" value="256"></div>
      <div class="${NS}-row"><label>Frame H</label>
        <input type="number" class="${NS}-fh" min="8" value="256"></div>
      <div class="${NS}-row"><label>Fit to</label>
        <select class="${NS}-fit">
          <option value="native">Native</option>
          <option value="256" selected>256</option>
          <option value="512">512</option>
          <option value="downscale">Downscale ½</option>
        </select></div>
      <div class="${NS}-row"><label>Trim start</label>
        <input type="range" class="${NS}-trim-start" min="0" max="1000" value="0"></div>
      <div class="${NS}-row"><label>Trim end</label>
        <input type="range" class="${NS}-trim-end" min="0" max="1000" value="1000"></div>
      <div class="${NS}-trim-label">0.00s — 0.00s</div>
      <div class="${NS}-row"><label><input type="checkbox" class="${NS}-key-on"> Chroma key</label></div>
      <div class="${NS}-row"><label>Key color</label>
        <input type="color" class="${NS}-key-color" value="#00ff00">
        <button class="${NS}-pick" type="button">Pick</button></div>
      <div class="${NS}-row"><label>Tolerance</label>
        <input type="range" class="${NS}-key-tol" min="0" max="120" value="24">
        <span class="${NS}-key-tol-val">24</span></div>
      <div class="${NS}-row"><label><input type="checkbox" class="${NS}-crop-on"> Crop</label></div>
      <div class="${NS}-row"><label>Crop x,y</label>
        <input type="number" class="${NS}-crop-x" value="0">
        <input type="number" class="${NS}-crop-y" value="0"></div>
      <div class="${NS}-row"><label>Crop w,h</label>
        <input type="number" class="${NS}-crop-w" value="0">
        <input type="number" class="${NS}-crop-h" value="0"></div>
      <div class="${NS}-row"><label>FPS</label>
        <input type="number" class="${NS}-fps" min="1" max="60" value="${DEFAULT_FPS}"></div>
      <div class="${NS}-filename"></div>
      <div class="${NS}-actions">
        <button class="${NS}-extract" type="button">Extract</button>
        <button class="${NS}-apply" type="button" disabled>Apply</button>
        <button class="${NS}-cancel" type="button">Cancel</button>
      </div>
    `;

    root.appendChild(left);
    root.appendChild(center);
    root.appendChild(right);
    container.appendChild(root);

    const $ = (sel) => right.querySelector(sel);

    // ---- State ----
    const state = {
      duration: 0,
      videoW: 0,
      videoH: 0,
      lastStripBlob: null,
      lastStripDataUrl: null,
      lastFrames: 0,
      lastFrameW: 0,
      lastFrameH: 0,
      pickMode: false,
      destroyed: false
    };

    function updateFilename() {
      const n = parseInt($('.' + NS + '-n').value, 10) || 8;
      $('.' + NS + '-filename').textContent = `Output: ${sourceName}-${n}f.png`;
    }
    updateFilename();

    function fmtTime(t) { return (t || 0).toFixed(2) + 's'; }

    function getTrim() {
      const s = parseInt($('.' + NS + '-trim-start').value, 10) / 1000;
      const e = parseInt($('.' + NS + '-trim-end').value, 10) / 1000;
      const st = clamp(s * state.duration, 0, state.duration);
      const en = clamp(e * state.duration, 0, state.duration);
      return { start: Math.min(st, en), end: Math.max(st, en) };
    }

    function refreshTrimLabel() {
      const { start, end } = getTrim();
      root.querySelector('.' + NS + '-trim-label').textContent =
        fmtTime(start) + ' — ' + fmtTime(end);
    }

    function applyFitPreset() {
      const v = $('.' + NS + '-fit').value;
      let w = state.videoW, h = state.videoH;
      if (v === '256') { w = 256; h = Math.round(state.videoH * (256 / state.videoW)); }
      else if (v === '512') { w = 512; h = Math.round(state.videoH * (512 / state.videoW)); }
      else if (v === 'downscale') { w = Math.round(state.videoW / 2); h = Math.round(state.videoH / 2); }
      $('.' + NS + '-fw').value = w;
      $('.' + NS + '-fh').value = h;
    }

    function getFrameSize() {
      const w = Math.max(8, parseInt($('.' + NS + '-fw').value, 10) || state.videoW);
      const h = Math.max(8, parseInt($('.' + NS + '-fh').value, 10) || state.videoH);
      return { w, h };
    }

    function getCrop() {
      if (!$('.' + NS + '-crop-on').checked) return null;
      const x = parseInt($('.' + NS + '-crop-x').value, 10) || 0;
      const y = parseInt($('.' + NS + '-crop-y').value, 10) || 0;
      const w = parseInt($('.' + NS + '-crop-w').value, 10) || state.videoW;
      const h = parseInt($('.' + NS + '-crop-h').value, 10) || state.videoH;
      return { x, y, w: Math.max(1, w), h: Math.max(1, h) };
    }

    // ---- Preview ----
    const pctx = previewCanvas.getContext('2d');
    function drawPreview() {
      if (!state.videoW) return;
      const aspect = state.videoW / state.videoH;
      let pw = previewCanvas.width, ph = Math.round(pw / aspect);
      if (ph !== previewCanvas.height) previewCanvas.height = ph;
      pctx.fillStyle = '#000';
      pctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
      try { pctx.drawImage(video, 0, 0, previewCanvas.width, previewCanvas.height); }
      catch (_) {}
    }

    video.addEventListener('loadedmetadata', () => {
      state.duration = video.duration || 0;
      state.videoW = video.videoWidth;
      state.videoH = video.videoHeight;
      $('.' + NS + '-crop-w').value = state.videoW;
      $('.' + NS + '-crop-h').value = state.videoH;
      applyFitPreset();
      refreshTrimLabel();
      status.textContent = `Loaded ${state.videoW}×${state.videoH}, ${state.duration.toFixed(2)}s`;
      // Seek to 0 to draw first frame.
      seekTo(video, 0).then(drawPreview);
    });

    video.addEventListener('error', () => {
      status.textContent = 'Failed to load video.';
    });

    scrub.addEventListener('input', () => {
      if (!state.duration) return;
      const t = (parseInt(scrub.value, 10) / 1000) * state.duration;
      timeLabel.textContent = t.toFixed(2) + ' / ' + state.duration.toFixed(2) + 's';
      seekTo(video, t).then(drawPreview);
    });

    // ---- Color picker via canvas click ----
    previewCanvas.addEventListener('click', (e) => {
      if (!state.pickMode) return;
      const rect = previewCanvas.getBoundingClientRect();
      const x = Math.floor((e.clientX - rect.left) * (previewCanvas.width / rect.width));
      const y = Math.floor((e.clientY - rect.top) * (previewCanvas.height / rect.height));
      try {
        const px = pctx.getImageData(x, y, 1, 1).data;
        const hex = '#' + [px[0], px[1], px[2]].map(v => v.toString(16).padStart(2, '0')).join('');
        $('.' + NS + '-key-color').value = hex;
        $('.' + NS + '-key-on').checked = true;
        status.textContent = 'Picked color ' + hex;
      } catch (_) { status.textContent = 'Pick failed (canvas tainted?).'; }
      state.pickMode = false;
      previewCanvas.classList.remove(NS + '-picking');
    });

    $('.' + NS + '-pick').addEventListener('click', () => {
      state.pickMode = true;
      previewCanvas.classList.add(NS + '-picking');
      status.textContent = 'Click a pixel on the preview to pick the chroma color.';
    });

    $('.' + NS + '-key-tol').addEventListener('input', (e) => {
      $('.' + NS + '-key-tol-val').textContent = e.target.value;
    });

    $('.' + NS + '-key-color').addEventListener('change', (e) => {
      // Magenta default tolerance 12, otherwise 24.
      if (/^#?ff00ff$/i.test(e.target.value)) $('.' + NS + '-key-tol').value = 12;
    });

    $('.' + NS + '-fit').addEventListener('change', applyFitPreset);
    $('.' + NS + '-n').addEventListener('input', updateFilename);
    $('.' + NS + '-trim-start').addEventListener('input', refreshTrimLabel);
    $('.' + NS + '-trim-end').addEventListener('input', refreshTrimLabel);

    // ---- Extraction ----
    async function extract() {
      if (!state.duration || !state.videoW) {
        status.textContent = 'Video not ready.';
        return;
      }
      const N = clamp(parseInt($('.' + NS + '-n').value, 10) || 8, 2, 32);
      const { w: fw, h: fh } = getFrameSize();
      const trim = getTrim();
      const span = Math.max(0.001, trim.end - trim.start);
      const crop = getCrop();
      const keyOn = $('.' + NS + '-key-on').checked;
      const keyHex = $('.' + NS + '-key-color').value;
      const keyTol = parseInt($('.' + NS + '-key-tol').value, 10) || 0;

      $('.' + NS + '-extract').disabled = true;
      $('.' + NS + '-apply').disabled = true;

      const frames = [];
      for (let i = 0; i < N; i++) {
        if (state.destroyed) return;
        const t = trim.start + (i / Math.max(1, N - 1)) * span;
        progressBar.style.width = ((i / N) * 100) + '%';
        status.textContent = `Extracting frame ${i + 1}/${N} @ ${t.toFixed(2)}s`;
        await seekTo(video, t);
        // small yield so UI repaints
        await new Promise(r => setTimeout(r, 0));
        const c = document.createElement('canvas');
        c.width = fw; c.height = fh;
        const cx = c.getContext('2d');
        if (crop) {
          cx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, fw, fh);
        } else {
          cx.drawImage(video, 0, 0, fw, fh);
        }
        if (keyOn) applyChromaKey(cx, fw, fh, keyHex, keyTol);
        frames.push(c);
      }

      // Assemble strip.
      status.textContent = 'Assembling strip…';
      progressBar.style.width = '100%';
      stripCanvas.width = fw * N;
      stripCanvas.height = fh;
      const sctx = stripCanvas.getContext('2d');
      sctx.clearRect(0, 0, stripCanvas.width, stripCanvas.height);
      for (let i = 0; i < N; i++) {
        sctx.drawImage(frames[i], i * fw, 0);
        // free per-frame canvas memory after copy
        frames[i].width = 0; frames[i].height = 0;
      }

      const blob = await new Promise((resolve) => stripCanvas.toBlob(resolve, 'image/png'));
      state.lastStripBlob = blob;
      state.lastStripDataUrl = stripCanvas.toDataURL('image/png');
      state.lastFrames = N;
      state.lastFrameW = fw;
      state.lastFrameH = fh;
      status.textContent = `Strip ready: ${stripCanvas.width}×${stripCanvas.height}, ${N} frames.`;
      $('.' + NS + '-extract').disabled = false;
      $('.' + NS + '-apply').disabled = false;
      progressBar.style.width = '0%';
    }

    $('.' + NS + '-extract').addEventListener('click', () => { extract().catch(e => {
      console.error(e); status.textContent = 'Extract failed: ' + (e && e.message || e);
      $('.' + NS + '-extract').disabled = false;
    }); });

    $('.' + NS + '-apply').addEventListener('click', () => {
      if (!state.lastStripBlob) return;
      const fps = clamp(parseInt($('.' + NS + '-fps').value, 10) || DEFAULT_FPS, 1, 60);
      const filename = `${sourceName}-${state.lastFrames}f.png`;
      if (typeof opts.onApply === 'function') {
        opts.onApply({
          stripBlob: state.lastStripBlob,
          stripDataUrl: state.lastStripDataUrl,
          frames: state.lastFrames,
          fps,
          width: stripCanvas.width,
          height: stripCanvas.height,
          frameWidth: state.lastFrameW,
          frameHeight: state.lastFrameH,
          filename,
          sourceName
        });
      }
    });

    $('.' + NS + '-cancel').addEventListener('click', () => {
      if (typeof opts.onCancel === 'function') opts.onCancel();
    });

    function destroy() {
      state.destroyed = true;
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) {}
      container.innerHTML = '';
      container.classList.remove(NS);
    }

    return { destroy };
  }

  // Attach to ImageEditor namespace, creating it if not yet defined.
  root.ImageEditor = root.ImageEditor || {};
  root.ImageEditor.mountVideoToStrip = mountVideoToStrip;
})(typeof window !== 'undefined' ? window : this);
