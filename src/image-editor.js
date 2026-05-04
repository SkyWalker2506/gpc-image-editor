/* gpc-image-editor — non-destructive in-browser mini photoshop for game sprites.
 *
 * Public API:
 *   window.ImageEditor.mount({
 *     container: HTMLElement,        // panel root that will host the editor
 *     stage:     HTMLElement,        // optional separate canvas host (else container)
 *     src:       string,             // image src/dataURL to edit
 *     edits:     ImageEdits | null,  // initial edits (crop/resize/rotate/flip/filter/pixelOps)
 *     onChange:  (edits) => void,    // fired on any edit (live)
 *     onApply:   (edits) => void,    // fired when user clicks Apply
 *     onCancel:  () => void,         // fired when user clicks Cancel
 *     onSliceApply: (payload) => void // fired when user clicks "Apply slice"
 *                                    //   payload = { mode, params, source:{name,w,h},
 *                                    //               children:[{name, dataUrl, blob, w, h, bounds, frameIndex?}]}
 *                                    // If absent, the editor offers a ZIP download fallback.
 *     sourceName: string             // hint for child-asset naming (defaults to "sprite")
 *   }) => { destroy, getEdits, setSrc, setEdits, render }
 *
 *   window.ImageEditor.applyEditsToCanvas(img, edits) => HTMLCanvasElement
 *     Pure helper. Bakes crop/resize/rotate/flip/filter/pixelOps onto an offscreen canvas.
 *
 * ImageEdits shape (all optional):
 *   {
 *     crop:     { x, y, w, h }
 *     resize:   { w, h }
 *     rotate:   number
 *     flip:     { h, v }
 *     filter:   { brightness, contrast, saturate, hue }
 *     pixelOps: [ { type:'bgRemove'|'erase'|'fill', ... } ]   // applied after crop, before filter
 *   }
 *
 * Slice payload shape (M1 — emitted via onSliceApply):
 *   {
 *     mode:   'grid' | 'anim' | 'auto',
 *     params: { cols, rows, cellW, cellH, trim, fps?, alphaThreshold?, connectivity? },
 *     source: { name, w, h },
 *     children: [
 *       { name, dataUrl, blob, w, h, bounds:{x,y,w,h}, frameIndex? }
 *     ]
 *   }
 */
(function (root) {
  'use strict';

  const ASPECTS = [
    { id: 'free', label: 'Free',  ratio: 0     },
    { id: '1:1',  label: '1:1',   ratio: 1     },
    { id: '16:9', label: '16:9',  ratio: 16/9  },
    { id: '4:3',  label: '4:3',   ratio: 4/3   },
    { id: '2:1',  label: '2:1',   ratio: 2     },
    { id: '3:2',  label: '3:2',   ratio: 3/2   }
  ];

  // ---- Pure helper: bake edits to offscreen canvas ------------------------
  function applyEditsToCanvas(img, edits) {
    if (!img || !img.complete || !img.naturalWidth) return null;
    const e = edits || {};
    const iw = img.naturalWidth, ih = img.naturalHeight;

    const crop = (e.crop && e.crop.w > 0 && e.crop.h > 0)
      ? { x: clampN(e.crop.x, 0, iw), y: clampN(e.crop.y, 0, ih),
          w: clampN(e.crop.w, 1, iw), h: clampN(e.crop.h, 1, ih) }
      : { x: 0, y: 0, w: iw, h: ih };

    const resize = (e.resize && e.resize.w > 0 && e.resize.h > 0)
      ? { w: Math.max(1, Math.round(e.resize.w)), h: Math.max(1, Math.round(e.resize.h)) }
      : { w: crop.w, h: crop.h };

    const rotate = Number(e.rotate) || 0;
    const flipH = !!(e.flip && e.flip.h);
    const flipV = !!(e.flip && e.flip.v);

    // Stage 1: crop -> apply pixel ops on full-res cropped buffer.
    const stage1 = document.createElement('canvas');
    stage1.width = crop.w; stage1.height = crop.h;
    const s1 = stage1.getContext('2d');
    s1.imageSmoothingEnabled = true;
    s1.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);

    if (Array.isArray(e.pixelOps) && e.pixelOps.length) {
      try { applyPixelOps(s1, stage1.width, stage1.height, e.pixelOps); }
      catch (_) {}
    }

    // Final canvas size: tightly bound the rotated rectangle.
    const rad = rotate * Math.PI / 180;
    const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    const outW = Math.max(1, Math.ceil(resize.w * cos + resize.h * sin));
    const outH = Math.max(1, Math.ceil(resize.w * sin + resize.h * cos));

    const cv = document.createElement('canvas');
    cv.width = outW; cv.height = outH;
    const cx = cv.getContext('2d');
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';

    const filter = buildFilterString(e.filter);
    if (filter) cx.filter = filter;

    cx.translate(outW / 2, outH / 2);
    if (rotate) cx.rotate(rad);
    cx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    cx.drawImage(stage1, 0, 0, crop.w, crop.h, -resize.w / 2, -resize.h / 2, resize.w, resize.h);

    return cv;
  }

  function buildFilterString(f) {
    if (!f) return '';
    const parts = [];
    if (f.brightness != null && +f.brightness !== 1) parts.push(`brightness(${+f.brightness})`);
    if (f.contrast   != null && +f.contrast   !== 1) parts.push(`contrast(${+f.contrast})`);
    if (f.saturate   != null && +f.saturate   !== 1) parts.push(`saturate(${+f.saturate})`);
    if (f.hue        != null && +f.hue        !== 0) parts.push(`hue-rotate(${+f.hue}deg)`);
    return parts.join(' ');
  }

  function clampN(v, lo, hi) { v = Number(v); if (!isFinite(v)) return lo; return Math.max(lo, Math.min(hi, v)); }

  // ---- Pixel-op pipeline (replays bgRemove / erase / fill stamps) ---------
  function applyPixelOps(ctx, w, h, ops) {
    const id = ctx.getImageData(0, 0, w, h);
    const px = id.data;
    for (const op of ops) {
      if (!op || !op.type) continue;
      if (op.type === 'bgRemove')      pxBgRemove(px, w, h, op);
      else if (op.type === 'fill')     pxFill(px, w, h, op);
      else if (op.type === 'erase')    pxErase(px, w, h, op);
      else if (op.type === 'bgRemoveColor') pxBgRemoveColor(px, w, h, op);
    }
    ctx.putImageData(id, 0, 0);
  }

  // Flood-fill alpha=0 from (x,y), tolerance 0..255, 4-connected.
  function pxBgRemove(px, w, h, op) {
    const sx = op.x | 0, sy = op.y | 0, tol = +op.tolerance || 32;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
    const i0 = (sy * w + sx) * 4;
    const sr = px[i0], sg = px[i0+1], sb = px[i0+2];
    const visited = new Uint8Array(w * h);
    const stack = [sx, sy];
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const k = y * w + x;
      if (visited[k]) continue;
      visited[k] = 1;
      const i = k * 4;
      if (px[i+3] === 0) continue;
      const dr = Math.abs(px[i] - sr);
      const dg = Math.abs(px[i+1] - sg);
      const db = Math.abs(px[i+2] - sb);
      if (Math.max(dr, dg, db) > tol) continue;
      px[i+3] = 0;
      stack.push(x+1,y, x-1,y, x,y+1, x,y-1);
    }
  }

  // Flood-fill solid color from (x,y) with tolerance.
  function pxFill(px, w, h, op) {
    const sx = op.x | 0, sy = op.y | 0, tol = +op.tolerance || 16;
    const c = op.color || [255,255,255,255];
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
    const i0 = (sy * w + sx) * 4;
    const sr = px[i0], sg = px[i0+1], sb = px[i0+2], sa = px[i0+3];
    const visited = new Uint8Array(w * h);
    const stack = [sx, sy];
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const k = y * w + x;
      if (visited[k]) continue;
      visited[k] = 1;
      const i = k * 4;
      const dr = Math.abs(px[i] - sr);
      const dg = Math.abs(px[i+1] - sg);
      const db = Math.abs(px[i+2] - sb);
      const da = Math.abs(px[i+3] - sa);
      if (Math.max(dr, dg, db, da) > tol) continue;
      px[i] = c[0]; px[i+1] = c[1]; px[i+2] = c[2]; px[i+3] = c[3];
      stack.push(x+1,y, x-1,y, x,y+1, x,y-1);
    }
  }

  // Stamp a circular eraser at (x,y) with radius r → alpha=0.
  function pxErase(px, w, h, op) {
    const cx = op.x | 0, cy = op.y | 0, r = Math.max(1, +op.radius || 8);
    const r2 = r * r;
    const x0 = Math.max(0, cx - r), x1 = Math.min(w - 1, cx + r);
    const y0 = Math.max(0, cy - r), y1 = Math.min(h - 1, cy + r);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx*dx + dy*dy > r2) continue;
        px[(y * w + x) * 4 + 3] = 0;
      }
    }
  }

  // Color-key bg removal (paint all pixels matching a target color → alpha 0).
  function pxBgRemoveColor(px, w, h, op) {
    const tr = op.color[0] | 0, tg = op.color[1] | 0, tb = op.color[2] | 0;
    const tol = +op.tolerance || 32;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i+3] === 0) continue;
      if (Math.abs(px[i]-tr) <= tol && Math.abs(px[i+1]-tg) <= tol && Math.abs(px[i+2]-tb) <= tol) {
        px[i+3] = 0;
      }
    }
  }

  // ---- Slice helpers (pure) ----------------------------------------------
  // Trim a canvas to its non-transparent bbox; returns { canvas, bounds }.
  function trimAlpha(srcCv, alphaThreshold) {
    const w = srcCv.width, h = srcCv.height;
    const ctx = srcCv.getContext('2d');
    const id = ctx.getImageData(0, 0, w, h);
    const px = id.data;
    const T = alphaThreshold == null ? 1 : alphaThreshold;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (px[(y * w + x) * 4 + 3] >= T) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return { canvas: srcCv, bounds: { x: 0, y: 0, w, h } };
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const out = document.createElement('canvas');
    out.width = bw; out.height = bh;
    out.getContext('2d').drawImage(srcCv, minX, minY, bw, bh, 0, 0, bw, bh);
    return { canvas: out, bounds: { x: minX, y: minY, w: bw, h: bh } };
  }

  // Connected-component labelling on alpha-mask (4 or 8-connected).
  // Returns array of { x, y, w, h } bounding boxes.
  function findConnectedRegions(srcCv, alphaThreshold, connectivity, minSize) {
    const w = srcCv.width, h = srcCv.height;
    const ctx = srcCv.getContext('2d');
    const id = ctx.getImageData(0, 0, w, h);
    const px = id.data;
    const T = alphaThreshold == null ? 16 : alphaThreshold;
    const C8 = connectivity === 8;
    const visited = new Uint8Array(w * h);
    const regions = [];
    const stack = new Int32Array(w * h * 2);
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const sk = sy * w + sx;
        if (visited[sk]) continue;
        if (px[sk * 4 + 3] < T) { visited[sk] = 1; continue; }
        // BFS
        let sp = 0;
        stack[sp++] = sx; stack[sp++] = sy;
        visited[sk] = 1;
        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        while (sp > 0) {
          const y = stack[--sp]; const x = stack[--sp];
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          const tryPush = (nx, ny) => {
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
            const k = ny * w + nx;
            if (visited[k]) return;
            visited[k] = 1;
            if (px[k * 4 + 3] < T) return;
            stack[sp++] = nx; stack[sp++] = ny;
          };
          tryPush(x+1, y); tryPush(x-1, y); tryPush(x, y+1); tryPush(x, y-1);
          if (C8) { tryPush(x+1,y+1); tryPush(x-1,y-1); tryPush(x+1,y-1); tryPush(x-1,y+1); }
        }
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        if (bw * bh >= (minSize || 16)) {
          regions.push({ x: minX, y: minY, w: bw, h: bh });
        }
      }
    }
    return regions;
  }

  // Slice a source image into N child canvases. Returns { children:[{canvas,bounds,frameIndex?}] }.
  function sliceImage(img, edits, mode, params) {
    // Apply non-slice edits (crop/filter/pixelOps) to a baked source first.
    const baked = applyEditsToCanvas(img, edits) || (() => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c;
    })();
    const W = baked.width, H = baked.height;
    const children = [];
    if (mode === 'grid' || mode === 'anim') {
      const cols = Math.max(1, params.cols | 0);
      const rows = Math.max(1, params.rows | 0);
      const cw = Math.floor(W / cols);
      const ch = Math.floor(H / rows);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cnv = document.createElement('canvas');
          cnv.width = cw; cnv.height = ch;
          cnv.getContext('2d').drawImage(baked, c * cw, r * ch, cw, ch, 0, 0, cw, ch);
          let bounds = { x: c * cw, y: r * ch, w: cw, h: ch };
          let outCv = cnv;
          if (params.trim) {
            const trimmed = trimAlpha(cnv, params.alphaThreshold || 1);
            outCv = trimmed.canvas;
            bounds = { x: c * cw + trimmed.bounds.x, y: r * ch + trimmed.bounds.y,
                       w: trimmed.bounds.w, h: trimmed.bounds.h };
          }
          children.push({ canvas: outCv, bounds, frameIndex: r * cols + c });
        }
      }
    } else if (mode === 'auto') {
      const regions = findConnectedRegions(baked, params.alphaThreshold || 16, params.connectivity || 4, params.minSize || 64);
      for (let i = 0; i < regions.length; i++) {
        const b = regions[i];
        const cnv = document.createElement('canvas');
        cnv.width = b.w; cnv.height = b.h;
        cnv.getContext('2d').drawImage(baked, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
        children.push({ canvas: cnv, bounds: b });
      }
    }
    return { source: baked, children };
  }

  // ---- Editor instance ----------------------------------------------------
  function mount(opts) {
    opts = opts || {};
    const container = opts.container;
    if (!container) throw new Error('ImageEditor.mount: container required');

    let img = new Image();
    let imgReady = false;
    let edits = normalizeEdits(opts.edits || {});
    let aspect = 'free';
    let zoom = 1;
    let pan = { x: 0, y: 0 };
    let dragging = null;
    let cropDragOrig = null;
    const undo = [];
    const redo = [];

    // Active tool: crop | erase | fill | bgRemove | eyedrop | slice
    let activeTool = 'crop';
    let activeColor = [255, 0, 85, 255];   // RGBA, default magenta-ish
    let brushRadius = 8;
    let toleranceBg = 32;
    let toleranceFill = 16;

    // Slice state
    let sliceMode = 'grid';   // grid | anim | auto
    let sliceParams = {
      cols: 4, rows: 5,
      trim: false,
      fps: 8,
      alphaThreshold: 16,
      connectivity: 4,
      minSize: 64
    };
    let sliceChildren = null;       // last computed children
    let sliceAnimFrame = 0;
    let sliceAnimTimer = null;

    container.innerHTML = '';
    container.classList.add('gpc-ie-root');

    const ui = buildUI(container);
    bindUI();
    setSrc(opts.src || '');

    function setSrc(src) {
      imgReady = false;
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { imgReady = true; fitView(); render(); };
      img.onerror = () => { imgReady = false; render(); };
      img.src = src || '';
      sliceChildren = null;
      stopAnimPreview();
    }

    function setEdits(next) {
      edits = normalizeEdits(next || {});
      pushUndo();
      syncControls();
      render();
    }

    function getEdits() { return cloneEdits(edits); }

    function destroy() {
      stopAnimPreview();
      container.innerHTML = '';
      container.classList.remove('gpc-ie-root');
    }

    // ------------ UI ---------------
    function buildUI(root) {
      const html = `
        <div class="gpc-ie-toolbar">
          <div class="gpc-ie-group">
            <label>Tool</label>
            <button data-ie-tool="crop"      title="Crop / select">▭</button>
            <button data-ie-tool="bgRemove"  title="Magic-wand bg remove">✦</button>
            <button data-ie-tool="eyedrop"   title="Eyedropper">⊙</button>
            <button data-ie-tool="erase"     title="Eraser">⌫</button>
            <button data-ie-tool="fill"      title="Fill bucket">▣</button>
            <button data-ie-tool="slice"     title="Slice mode">⊞</button>
          </div>
          <div class="gpc-ie-group">
            <label>Aspect</label>
            <select data-ie="aspect">${ASPECTS.map(a => `<option value="${a.id}">${a.label}</option>`).join('')}</select>
          </div>
          <div class="gpc-ie-group">
            <button data-ie="rot-l" title="Rotate -90">⟲ 90</button>
            <button data-ie="rot-r" title="Rotate +90">⟳ 90</button>
            <button data-ie="flip-h" title="Flip horizontal">⇋ H</button>
            <button data-ie="flip-v" title="Flip vertical">⇅ V</button>
          </div>
          <div class="gpc-ie-group">
            <button data-ie="undo" title="Undo">⟲ Undo</button>
            <button data-ie="redo" title="Redo">⟳ Redo</button>
            <button data-ie="reset" title="Reset all edits">↺ Reset</button>
          </div>
          <div class="gpc-ie-group gpc-ie-grow"></div>
          <div class="gpc-ie-group">
            <button data-ie="cancel" class="gpc-ie-btn-ghost">Cancel</button>
            <button data-ie="apply"  class="gpc-ie-btn-primary">Apply</button>
          </div>
        </div>
        <div class="gpc-ie-stage">
          <canvas data-ie="canvas" class="gpc-ie-canvas"></canvas>
          <div class="gpc-ie-stage-info" data-ie="info"></div>
        </div>
        <div class="gpc-ie-side">
          <!-- Tool panel (varies per active tool) -->
          <div class="gpc-ie-panel" data-ie-pane="tool">
            <div class="gpc-ie-panel-title" data-ie="tool-title">Crop</div>
            <div data-ie="tool-body"></div>
          </div>

          <!-- Slice panel (visible when slice tool active) -->
          <div class="gpc-ie-panel" data-ie-pane="slice" style="display:none">
            <div class="gpc-ie-panel-title">Slice mode</div>
            <div class="gpc-ie-row gpc-ie-tabs" style="gap:2px">
              <button data-ie-smode="grid">Grid</button>
              <button data-ie-smode="anim">Anim</button>
              <button data-ie-smode="auto">Auto</button>
            </div>
            <div data-ie="slice-body"></div>
            <div class="gpc-ie-row"><button data-ie="slice-compute">Preview slices</button></div>
            <div class="gpc-ie-row"><button data-ie="slice-apply" class="gpc-ie-btn-primary">Apply slice</button></div>
            <div class="gpc-ie-row"><button data-ie="slice-zip">Download ZIP</button></div>
            <div class="gpc-ie-row" data-ie="slice-anim-controls" style="display:none">
              <button data-ie="anim-play">▶ Play</button>
              <button data-ie="anim-stop">■ Stop</button>
            </div>
          </div>

          <div class="gpc-ie-panel">
            <div class="gpc-ie-panel-title">Resize</div>
            <div class="gpc-ie-row"><label>Width</label><input type="number" data-ie="rw" min="1" step="1"></div>
            <div class="gpc-ie-row"><label>Height</label><input type="number" data-ie="rh" min="1" step="1"></div>
            <div class="gpc-ie-row"><label><input type="checkbox" data-ie="rlock" checked> Lock aspect</label></div>
            <div class="gpc-ie-row"><button data-ie="fit-bbox">Fit to crop</button></div>
          </div>
          <div class="gpc-ie-panel">
            <div class="gpc-ie-panel-title">Rotate</div>
            <div class="gpc-ie-row"><label>Angle</label>
              <input type="range" data-ie="rot" min="-180" max="180" step="1" value="0">
              <input type="number" data-ie="rot-num" min="-180" max="180" step="1" value="0" style="width:64px">
            </div>
          </div>
          <div class="gpc-ie-panel">
            <div class="gpc-ie-panel-title">Adjust</div>
            <div class="gpc-ie-row"><label>Brightness</label><input type="range" data-ie="f-bri" min="0" max="2" step="0.01" value="1"></div>
            <div class="gpc-ie-row"><label>Contrast</label><input type="range" data-ie="f-con" min="0" max="2" step="0.01" value="1"></div>
            <div class="gpc-ie-row"><label>Saturate</label><input type="range" data-ie="f-sat" min="0" max="2" step="0.01" value="1"></div>
            <div class="gpc-ie-row"><label>Hue</label><input type="range" data-ie="f-hue" min="-180" max="180" step="1" value="0"></div>
          </div>
        </div>`;
      root.innerHTML = html;
      const $ = (sel) => root.querySelector(sel);
      const ui = {
        root,
        aspect: $('[data-ie="aspect"]'),
        canvas: $('[data-ie="canvas"]'),
        info:   $('[data-ie="info"]'),
        rw: $('[data-ie="rw"]'), rh: $('[data-ie="rh"]'), rlock: $('[data-ie="rlock"]'),
        rot: $('[data-ie="rot"]'), rotNum: $('[data-ie="rot-num"]'),
        fBri: $('[data-ie="f-bri"]'), fCon: $('[data-ie="f-con"]'),
        fSat: $('[data-ie="f-sat"]'), fHue: $('[data-ie="f-hue"]'),
        rotL: $('[data-ie="rot-l"]'), rotR: $('[data-ie="rot-r"]'),
        flipH: $('[data-ie="flip-h"]'), flipV: $('[data-ie="flip-v"]'),
        undo: $('[data-ie="undo"]'), redo: $('[data-ie="redo"]'),
        reset: $('[data-ie="reset"]'), fit: $('[data-ie="fit-bbox"]'),
        cancel: $('[data-ie="cancel"]'), apply: $('[data-ie="apply"]'),
        toolBtns: root.querySelectorAll('[data-ie-tool]'),
        toolTitle: $('[data-ie="tool-title"]'),
        toolBody:  $('[data-ie="tool-body"]'),
        paneSlice: $('[data-ie-pane="slice"]'),
        sliceBody: $('[data-ie="slice-body"]'),
        sliceCompute: $('[data-ie="slice-compute"]'),
        sliceApply:   $('[data-ie="slice-apply"]'),
        sliceZip:     $('[data-ie="slice-zip"]'),
        sliceModeBtns: root.querySelectorAll('[data-ie-smode]'),
        animCtrls: $('[data-ie="slice-anim-controls"]'),
        animPlay:  $('[data-ie="anim-play"]'),
        animStop:  $('[data-ie="anim-stop"]')
      };
      return ui;
    }

    function bindUI() {
      ui.aspect.addEventListener('change', () => { aspect = ui.aspect.value; });

      ui.rotL.addEventListener('click', () => { edits.rotate = ((edits.rotate || 0) - 90) % 360; commit(); });
      ui.rotR.addEventListener('click', () => { edits.rotate = ((edits.rotate || 0) + 90) % 360; commit(); });
      ui.flipH.addEventListener('click', () => { edits.flip.h = !edits.flip.h; commit(); });
      ui.flipV.addEventListener('click', () => { edits.flip.v = !edits.flip.v; commit(); });

      ui.undo.addEventListener('click', undoOp);
      ui.redo.addEventListener('click', redoOp);
      ui.reset.addEventListener('click', () => { edits = normalizeEdits({}); commit(); syncControls(); });
      ui.fit.addEventListener('click', () => {
        if (edits.crop) { edits.resize = { w: edits.crop.w, h: edits.crop.h }; commit(); syncControls(); }
      });
      ui.cancel.addEventListener('click', () => { if (typeof opts.onCancel === 'function') opts.onCancel(); });
      ui.apply.addEventListener('click', () => { if (typeof opts.onApply === 'function') opts.onApply(getEdits()); });

      ui.rw.addEventListener('input', () => onResize('w'));
      ui.rh.addEventListener('input', () => onResize('h'));

      ui.rot.addEventListener('input', () => { edits.rotate = +ui.rot.value; ui.rotNum.value = ui.rot.value; render(); fire(); });
      ui.rot.addEventListener('change', commit);
      ui.rotNum.addEventListener('input', () => { edits.rotate = +ui.rotNum.value; ui.rot.value = ui.rotNum.value; render(); fire(); });
      ui.rotNum.addEventListener('change', commit);

      const filterFields = [['fBri','brightness'], ['fCon','contrast'], ['fSat','saturate'], ['fHue','hue']];
      filterFields.forEach(([k, prop]) => {
        ui[k].addEventListener('input', () => { edits.filter[prop] = +ui[k].value; render(); fire(); });
        ui[k].addEventListener('change', commit);
      });

      // Tool-button bar
      ui.toolBtns.forEach(btn => {
        btn.addEventListener('click', () => setActiveTool(btn.dataset.ieTool));
      });

      // Slice mode tabs
      ui.sliceModeBtns.forEach(btn => {
        btn.addEventListener('click', () => { sliceMode = btn.dataset.ieSmode; renderSlicePanel(); render(); });
      });
      ui.sliceCompute.addEventListener('click', () => {
        sliceChildren = computeSlice();
        render();
      });
      ui.sliceApply.addEventListener('click', () => emitSliceApply());
      ui.sliceZip.addEventListener('click', () => downloadSliceZip());
      ui.animPlay.addEventListener('click', () => startAnimPreview());
      ui.animStop.addEventListener('click', () => stopAnimPreview());

      ui.canvas.addEventListener('wheel', onWheel, { passive: false });
      ui.canvas.addEventListener('pointerdown', onPointerDown);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('keydown', onKey);

      const ro = new ResizeObserver(() => { fitCanvasBuffer(); render(); });
      ro.observe(ui.canvas);

      setActiveTool('crop');
      renderSlicePanel();
      syncControls();
    }

    function setActiveTool(tool) {
      activeTool = tool;
      ui.toolBtns.forEach(b => {
        b.style.background = (b.dataset.ieTool === tool) ? 'var(--ie-accent)' : '';
        b.style.color      = (b.dataset.ieTool === tool) ? '#1a1300' : '';
      });
      ui.paneSlice.style.display = (tool === 'slice') ? '' : 'none';
      renderToolPanel();
      ui.canvas.style.cursor = tool === 'crop' ? 'crosshair'
        : tool === 'eyedrop' ? 'cell'
        : tool === 'erase' ? 'cell'
        : tool === 'slice' ? 'crosshair'
        : 'pointer';
      render();
    }

    function renderToolPanel() {
      const t = activeTool;
      const titles = { crop: 'Crop', bgRemove: 'BG remove (magic wand)',
                       erase: 'Eraser', fill: 'Fill bucket',
                       eyedrop: 'Eyedropper', slice: 'Slice' };
      ui.toolTitle.textContent = titles[t] || t;
      let body = '';
      if (t === 'bgRemove') {
        body = `
          <div class="gpc-ie-row"><label>Tolerance</label><input type="range" data-ie="bg-tol" min="0" max="120" step="1" value="${toleranceBg}"></div>
          <div class="gpc-ie-row"><small style="color:var(--ie-ink-dim)">Click a bg pixel → flood-fill to alpha.</small></div>`;
      } else if (t === 'erase') {
        body = `
          <div class="gpc-ie-row"><label>Brush</label><input type="range" data-ie="er-r" min="2" max="64" step="1" value="${brushRadius}"></div>
          <div class="gpc-ie-row"><small style="color:var(--ie-ink-dim)">Click/drag to erase.</small></div>`;
      } else if (t === 'fill') {
        body = `
          <div class="gpc-ie-row"><label>Tolerance</label><input type="range" data-ie="fl-tol" min="0" max="120" step="1" value="${toleranceFill}"></div>
          <div class="gpc-ie-row"><label>Color</label><input type="color" data-ie="fl-col" value="${rgbToHex(activeColor)}"></div>`;
      } else if (t === 'eyedrop') {
        body = `
          <div class="gpc-ie-row"><label>Active</label><span data-ie="ed-sw" style="display:inline-block;width:24px;height:18px;border:1px solid #fff5;background:${rgbToHex(activeColor)}"></span></div>
          <div class="gpc-ie-row"><small style="color:var(--ie-ink-dim)">Click pixel to read color.</small></div>`;
      } else if (t === 'crop') {
        body = `<div class="gpc-ie-row"><small style="color:var(--ie-ink-dim)">Drag to define crop bbox; corners to nudge.</small></div>`;
      } else if (t === 'slice') {
        body = `<div class="gpc-ie-row"><small style="color:var(--ie-ink-dim)">Configure slice mode in panel below.</small></div>`;
      }
      ui.toolBody.innerHTML = body;
      const q = (s) => ui.toolBody.querySelector(s);
      const bgTol = q('[data-ie="bg-tol"]'); if (bgTol) bgTol.addEventListener('input', e => toleranceBg = +e.target.value);
      const erR   = q('[data-ie="er-r"]');   if (erR)   erR.addEventListener('input',   e => brushRadius = +e.target.value);
      const flTol = q('[data-ie="fl-tol"]'); if (flTol) flTol.addEventListener('input', e => toleranceFill = +e.target.value);
      const flCol = q('[data-ie="fl-col"]'); if (flCol) flCol.addEventListener('input', e => activeColor = hexToRgb(e.target.value));
    }

    function renderSlicePanel() {
      ui.sliceModeBtns.forEach(b => {
        b.style.background = (b.dataset.ieSmode === sliceMode) ? 'var(--ie-accent)' : '';
        b.style.color      = (b.dataset.ieSmode === sliceMode) ? '#1a1300' : '';
      });
      let body = '';
      if (sliceMode === 'grid' || sliceMode === 'anim') {
        body = `
          <div class="gpc-ie-row"><label>Cols</label><input type="number" data-ie="s-cols" min="1" step="1" value="${sliceParams.cols}"></div>
          <div class="gpc-ie-row"><label>Rows</label><input type="number" data-ie="s-rows" min="1" step="1" value="${sliceParams.rows}"></div>
          <div class="gpc-ie-row"><label><input type="checkbox" data-ie="s-trim" ${sliceParams.trim ? 'checked' : ''}> Trim transparent</label></div>
          <div class="gpc-ie-row"><button data-ie="s-autofit">Auto-fit grid</button></div>`;
        if (sliceMode === 'anim') {
          body += `<div class="gpc-ie-row"><label>FPS</label><input type="number" data-ie="s-fps" min="1" max="60" step="1" value="${sliceParams.fps}"></div>`;
        }
      } else if (sliceMode === 'auto') {
        body = `
          <div class="gpc-ie-row"><label>Alpha thr</label><input type="range" data-ie="s-alpha" min="1" max="255" step="1" value="${sliceParams.alphaThreshold}"></div>
          <div class="gpc-ie-row"><label>Connect</label>
            <select data-ie="s-conn">
              <option value="4" ${sliceParams.connectivity===4?'selected':''}>4-way</option>
              <option value="8" ${sliceParams.connectivity===8?'selected':''}>8-way</option>
            </select>
          </div>
          <div class="gpc-ie-row"><label>Min size</label><input type="number" data-ie="s-min" min="4" step="4" value="${sliceParams.minSize}"></div>`;
      }
      ui.sliceBody.innerHTML = body;
      ui.animCtrls.style.display = (sliceMode === 'anim') ? '' : 'none';

      const q = (s) => ui.sliceBody.querySelector(s);
      const sCols  = q('[data-ie="s-cols"]');  if (sCols)  sCols.addEventListener('input',  e => { sliceParams.cols = Math.max(1, +e.target.value); render(); });
      const sRows  = q('[data-ie="s-rows"]');  if (sRows)  sRows.addEventListener('input',  e => { sliceParams.rows = Math.max(1, +e.target.value); render(); });
      const sTrim  = q('[data-ie="s-trim"]');  if (sTrim)  sTrim.addEventListener('change', e => { sliceParams.trim = !!e.target.checked; });
      const sFps   = q('[data-ie="s-fps"]');   if (sFps)   sFps.addEventListener('input',   e => { sliceParams.fps = Math.max(1, +e.target.value); });
      const sAlpha = q('[data-ie="s-alpha"]'); if (sAlpha) sAlpha.addEventListener('input', e => { sliceParams.alphaThreshold = +e.target.value; });
      const sConn  = q('[data-ie="s-conn"]');  if (sConn)  sConn.addEventListener('change', e => { sliceParams.connectivity = +e.target.value; });
      const sMin   = q('[data-ie="s-min"]');   if (sMin)   sMin.addEventListener('input',   e => { sliceParams.minSize = +e.target.value; });
      const sFit   = q('[data-ie="s-autofit"]'); if (sFit) sFit.addEventListener('click', () => autoFitGrid());
    }

    function autoFitGrid() {
      // Trim source to non-transparent bbox, then guess cols/rows by aspect.
      if (!imgReady) return;
      const baked = bakedSource();
      const trimmed = trimAlpha(baked, 1).bounds;
      const aspectR = trimmed.w / Math.max(1, trimmed.h);
      // Use existing cols guess; refine rows from aspect if cells should stay roughly square.
      const cols = sliceParams.cols;
      const cellW = trimmed.w / cols;
      const rows = Math.max(1, Math.round(trimmed.h / cellW));
      sliceParams.rows = rows;
      renderSlicePanel();
      render();
    }

    function bakedSource() {
      // Source baked with crop+filter+pixelOps applied (no rotate/flip — slice grids assume axis-aligned).
      const e = { ...edits, rotate: 0, flip: { h: false, v: false }, resize: null };
      return applyEditsToCanvas(img, e);
    }

    function computeSlice() {
      if (!imgReady) return null;
      const e = { ...edits, rotate: 0, flip: { h: false, v: false }, resize: null };
      const out = sliceImage(img, e, sliceMode, sliceParams);
      return out.children;
    }

    function emitSliceApply() {
      const children = sliceChildren || computeSlice();
      if (!children || !children.length) {
        flashInfo('No slices to apply.');
        return;
      }
      const baseName = (opts.sourceName || 'sprite').replace(/\.[a-z0-9]+$/i, '');
      const childPayload = [];
      let pendingBlobs = children.length;
      const finish = () => {
        if (typeof opts.onSliceApply === 'function') {
          opts.onSliceApply({
            mode: sliceMode,
            params: { ...sliceParams },
            source: { name: baseName, w: img.naturalWidth, h: img.naturalHeight },
            children: childPayload
          });
        } else {
          // No host handler → offer ZIP download as fallback.
          downloadSliceZip(childPayload, baseName);
        }
      };
      children.forEach((c, i) => {
        const idx = String(i + 1).padStart(2, '0');
        const name = sliceMode === 'anim'
          ? `${baseName}-${children.length}f-${idx}.png`
          : `${baseName}-${idx}.png`;
        const dataUrl = c.canvas.toDataURL('image/png');
        c.canvas.toBlob((blob) => {
          childPayload.push({
            name, dataUrl, blob,
            w: c.canvas.width, h: c.canvas.height,
            bounds: c.bounds,
            frameIndex: c.frameIndex
          });
          pendingBlobs--;
          if (pendingBlobs === 0) {
            // preserve original order
            childPayload.sort((a, b) => a.name.localeCompare(b.name));
            finish();
          }
        }, 'image/png');
      });
    }

    function downloadSliceZip(prebuilt, baseName) {
      const children = prebuilt || (sliceChildren ? sliceChildren.map((c, i) => ({
        name: ((opts.sourceName || 'sprite').replace(/\.[a-z0-9]+$/i, '')) + '-' + String(i + 1).padStart(2, '0') + '.png',
        dataUrl: c.canvas.toDataURL('image/png')
      })) : null);
      if (!children || !children.length) { flashInfo('No slices to download.'); return; }
      // No JSZip dep — emit a single concatenated download per child via <a download>.
      // For multi-file we open each in sequence; user-friendly enough as MVP fallback.
      children.forEach((ch, i) => {
        setTimeout(() => {
          const a = document.createElement('a');
          a.href = ch.dataUrl; a.download = ch.name;
          document.body.appendChild(a); a.click(); a.remove();
        }, i * 80);
      });
    }

    function flashInfo(msg) {
      ui.info.textContent = msg;
      setTimeout(() => render(), 1500);
    }

    // ---- Animation preview (slice mode = anim) -------------------------
    function startAnimPreview() {
      stopAnimPreview();
      sliceChildren = computeSlice();
      if (!sliceChildren || !sliceChildren.length) return;
      const period = Math.max(1, Math.round(1000 / Math.max(1, sliceParams.fps)));
      sliceAnimFrame = 0;
      sliceAnimTimer = setInterval(() => {
        sliceAnimFrame = (sliceAnimFrame + 1) % sliceChildren.length;
        render();
      }, period);
    }
    function stopAnimPreview() {
      if (sliceAnimTimer) { clearInterval(sliceAnimTimer); sliceAnimTimer = null; }
    }

    function onResize(which) {
      const ratio = (img.naturalWidth || 1) / (img.naturalHeight || 1);
      let w = +ui.rw.value, h = +ui.rh.value;
      if (ui.rlock.checked) {
        const cropRatio = (edits.crop ? edits.crop.w / edits.crop.h : ratio);
        if (which === 'w') h = Math.round(w / cropRatio);
        else                w = Math.round(h * cropRatio);
        ui.rw.value = w; ui.rh.value = h;
      }
      edits.resize = { w: Math.max(1, w), h: Math.max(1, h) };
      render(); fire();
    }

    function syncControls() {
      ui.rot.value = edits.rotate || 0;
      ui.rotNum.value = edits.rotate || 0;
      ui.fBri.value = edits.filter.brightness;
      ui.fCon.value = edits.filter.contrast;
      ui.fSat.value = edits.filter.saturate;
      ui.fHue.value = edits.filter.hue;
      const r = edits.resize || (edits.crop ? { w: edits.crop.w, h: edits.crop.h } : null);
      if (r) { ui.rw.value = r.w; ui.rh.value = r.h; }
      else if (img.naturalWidth) { ui.rw.value = img.naturalWidth; ui.rh.value = img.naturalHeight; }
    }

    // ---- Canvas / view --------------------------------------------------
    function fitCanvasBuffer() {
      const cv = ui.canvas;
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width  = Math.max(1, Math.floor(r.width  * dpr));
      cv.height = Math.max(1, Math.floor(r.height * dpr));
    }
    function fitView() {
      if (!imgReady) return;
      fitCanvasBuffer();
      const cv = ui.canvas;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = cv.width / dpr, ch = cv.height / dpr;
      const pad = 24;
      const sx = (cw - pad * 2) / img.naturalWidth;
      const sy = (ch - pad * 2) / img.naturalHeight;
      zoom = Math.max(0.05, Math.min(8, Math.min(sx, sy)));
      pan = { x: cw / 2, y: ch / 2 };
      if (!edits.crop) edits.crop = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
      syncControls();
    }

    function render() {
      const cv = ui.canvas;
      const ctx = cv.getContext('2d');
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      drawChecker(ctx, cv.width / dpr, cv.height / dpr);

      if (!imgReady) {
        ctx.fillStyle = '#9099ad';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Loading…', (cv.width / dpr) / 2, (cv.height / dpr) / 2);
        return;
      }

      // Anim-preview takes over the stage when running.
      if (sliceAnimTimer && sliceChildren && sliceChildren.length) {
        const c = sliceChildren[sliceAnimFrame];
        if (c) {
          const cwPx = cv.width / dpr, chPx = cv.height / dpr;
          const s = Math.min(cwPx / c.canvas.width, chPx / c.canvas.height) * 0.8;
          const dw = c.canvas.width * s, dh = c.canvas.height * s;
          ctx.drawImage(c.canvas, (cwPx - dw) / 2, (chPx - dh) / 2, dw, dh);
          ui.info.textContent = `frame ${sliceAnimFrame + 1}/${sliceChildren.length}  •  ${sliceParams.fps} fps`;
        }
        return;
      }

      const iw = img.naturalWidth, ih = img.naturalHeight;
      const dx = pan.x - (iw * zoom) / 2;
      const dy = pan.y - (ih * zoom) / 2;

      // Draw the source image with live filter+pixelOps preview.
      ctx.save();
      const fs = buildFilterString(edits.filter);
      if (fs) ctx.filter = fs;
      // Bake to offscreen so pixelOps preview without mutating source.
      const previewCv = bakedSource();
      ctx.drawImage(previewCv, 0, 0, previewCv.width, previewCv.height,
                    dx + (edits.crop ? edits.crop.x * zoom : 0),
                    dy + (edits.crop ? edits.crop.y * zoom : 0),
                    previewCv.width * zoom, previewCv.height * zoom);
      // Also draw the un-cropped portion dimmed for context.
      // (Skipped — crop overlay below dims it.)
      ctx.restore();

      // Crop overlay only for crop tool
      if (edits.crop && activeTool === 'crop') {
        const cr = edits.crop;
        const cx = dx + cr.x * zoom;
        const cy = dy + cr.y * zoom;
        const cw = cr.w * zoom;
        const ch = cr.h * zoom;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(0, 0, cv.width / dpr, cv.height / dpr);
        ctx.clearRect(cx, cy, cw, ch);
        ctx.strokeStyle = '#ffb347';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(cx + 0.5, cy + 0.5, cw, ch);
        ctx.setLineDash([]);
        const handles = handlePositions(cx, cy, cw, ch);
        ctx.fillStyle = '#ffb347';
        for (const h of handles) ctx.fillRect(h.x - 4, h.y - 4, 8, 8);
      }

      // Slice overlay (grid lines + numbered cells) when slice tool active
      if (activeTool === 'slice') {
        drawSliceOverlay(ctx, dx, dy, iw, ih);
      }

      ui.info.textContent = `${img.naturalWidth}×${img.naturalHeight}  •  zoom ${(zoom * 100).toFixed(0)}%  •  tool: ${activeTool}`;
    }

    function drawSliceOverlay(ctx, dx, dy, iw, ih) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,179,71,0.85)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      if (sliceMode === 'grid' || sliceMode === 'anim') {
        const cols = Math.max(1, sliceParams.cols), rows = Math.max(1, sliceParams.rows);
        const cw = (iw / cols) * zoom, ch = (ih / rows) * zoom;
        for (let c = 0; c <= cols; c++) {
          ctx.beginPath();
          ctx.moveTo(dx + c * cw + 0.5, dy);
          ctx.lineTo(dx + c * cw + 0.5, dy + ih * zoom);
          ctx.stroke();
        }
        for (let r = 0; r <= rows; r++) {
          ctx.beginPath();
          ctx.moveTo(dx, dy + r * ch + 0.5);
          ctx.lineTo(dx + iw * zoom, dy + r * ch + 0.5);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.fillStyle = '#ffb347';
        ctx.font = 'bold 11px Fredoka, sans-serif';
        ctx.textBaseline = 'top';
        let n = 1;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            ctx.fillText(String(n++), dx + c * cw + 4, dy + r * ch + 2);
          }
        }
      } else if (sliceMode === 'auto' && sliceChildren) {
        ctx.setLineDash([]);
        ctx.fillStyle = '#ffb347';
        ctx.font = 'bold 11px Fredoka, sans-serif';
        sliceChildren.forEach((c, i) => {
          const b = c.bounds;
          ctx.strokeStyle = 'rgba(255,179,71,0.95)';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(dx + b.x * zoom + 0.5, dy + b.y * zoom + 0.5, b.w * zoom, b.h * zoom);
          ctx.fillText(String(i + 1), dx + b.x * zoom + 3, dy + b.y * zoom + 2);
        });
      }
      ctx.restore();
    }

    function drawChecker(ctx, w, h) {
      const s = 12;
      ctx.fillStyle = '#1a1d24';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      for (let y = 0; y < h; y += s) {
        for (let x = ((y / s) % 2 ? s : 0); x < w; x += s * 2) {
          ctx.fillRect(x, y, s, s);
        }
      }
    }

    function handlePositions(x, y, w, h) {
      return [
        { id: 'nw', x, y },           { id: 'n', x: x + w / 2, y },        { id: 'ne', x: x + w, y },
        { id: 'w',  x, y: y + h / 2 },                                       { id: 'e',  x: x + w, y: y + h / 2 },
        { id: 'sw', x, y: y + h },    { id: 's', x: x + w / 2, y: y + h }, { id: 'se', x: x + w, y: y + h }
      ];
    }

    // ---- Pointer interaction --------------------------------------------
    function screenToImg(px, py) {
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const dx = pan.x - (iw * zoom) / 2;
      const dy = pan.y - (ih * zoom) / 2;
      return { x: (px - dx) / zoom, y: (py - dy) / zoom };
    }
    function localXY(ev) {
      const r = ui.canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }

    function onWheel(ev) {
      if (!imgReady) return;
      ev.preventDefault();
      const { x, y } = localXY(ev);
      const before = screenToImg(x, y);
      const factor = ev.deltaY > 0 ? 0.9 : 1.1;
      zoom = Math.max(0.05, Math.min(16, zoom * factor));
      const after = screenToImg(x, y);
      pan.x += (after.x - before.x) * zoom;
      pan.y += (after.y - before.y) * zoom;
      render();
    }

    function onPointerDown(ev) {
      if (!imgReady) return;
      const p = localXY(ev);
      const ipt = screenToImg(p.x, p.y);

      // Photoshop-lite tools: stamp pixelOp into edits.
      if (activeTool === 'bgRemove') {
        if (ipt.x < 0 || ipt.y < 0 || ipt.x >= img.naturalWidth || ipt.y >= img.naturalHeight) return;
        const local = imgPointToCroppedSpace(ipt);
        if (!local) return;
        edits.pixelOps.push({ type: 'bgRemove', x: local.x, y: local.y, tolerance: toleranceBg });
        commit();
        return;
      }
      if (activeTool === 'fill') {
        const local = imgPointToCroppedSpace(ipt); if (!local) return;
        edits.pixelOps.push({ type: 'fill', x: local.x, y: local.y, tolerance: toleranceFill, color: activeColor.slice() });
        commit();
        return;
      }
      if (activeTool === 'erase') {
        const local = imgPointToCroppedSpace(ipt); if (!local) return;
        edits.pixelOps.push({ type: 'erase', x: local.x, y: local.y, radius: brushRadius });
        dragging = 'erase';
        cropDragOrig = {};
        render(); fire();
        return;
      }
      if (activeTool === 'eyedrop') {
        const baked = bakedSource();
        const local = imgPointToCroppedSpace(ipt); if (!local) return;
        try {
          const id = baked.getContext('2d').getImageData(local.x | 0, local.y | 0, 1, 1).data;
          activeColor = [id[0], id[1], id[2], id[3] || 255];
          renderToolPanel();
        } catch (_) {}
        return;
      }

      // Crop / slice tools fall through to existing crop interaction (default).
      if (edits.crop) {
        const cr = edits.crop;
        const cx = pan.x - (img.naturalWidth * zoom) / 2 + cr.x * zoom;
        const cy = pan.y - (img.naturalHeight * zoom) / 2 + cr.y * zoom;
        const cw = cr.w * zoom, ch = cr.h * zoom;
        const handles = handlePositions(cx, cy, cw, ch);
        for (const h of handles) {
          if (Math.abs(p.x - h.x) <= 6 && Math.abs(p.y - h.y) <= 6) {
            dragging = 'crop-' + h.id;
            cropDragOrig = { ...cr, ix: ipt.x, iy: ipt.y };
            try { ui.canvas.setPointerCapture(ev.pointerId); } catch (_) {}
            return;
          }
        }
        if (ipt.x >= cr.x && ipt.x <= cr.x + cr.w && ipt.y >= cr.y && ipt.y <= cr.y + cr.h) {
          dragging = 'crop-move';
          cropDragOrig = { ...cr, ix: ipt.x, iy: ipt.y };
          try { ui.canvas.setPointerCapture(ev.pointerId); } catch (_) {}
          return;
        }
      }
      if (ev.button === 1 || ev.shiftKey) {
        dragging = 'pan';
        cropDragOrig = { px: pan.x, py: pan.y, sx: p.x, sy: p.y };
        return;
      }
      if (activeTool === 'crop') {
        dragging = 'crop-new';
        cropDragOrig = { ix: ipt.x, iy: ipt.y };
      }
    }

    // Convert source-image-space point → cropped-space coords (for pixelOps which
    // are interpreted by applyEditsToCanvas after the crop step).
    function imgPointToCroppedSpace(ipt) {
      const cr = edits.crop || { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
      const lx = ipt.x - cr.x, ly = ipt.y - cr.y;
      if (lx < 0 || ly < 0 || lx >= cr.w || ly >= cr.h) return null;
      return { x: lx, y: ly };
    }

    function onPointerMove(ev) {
      if (!dragging) return;
      const p = localXY(ev);
      const ipt = screenToImg(p.x, p.y);
      if (dragging === 'erase') {
        const local = imgPointToCroppedSpace(ipt); if (!local) return;
        edits.pixelOps.push({ type: 'erase', x: local.x, y: local.y, radius: brushRadius });
        render(); fire();
        return;
      }
      if (dragging === 'pan') {
        pan.x = cropDragOrig.px + (p.x - cropDragOrig.sx);
        pan.y = cropDragOrig.py + (p.y - cropDragOrig.sy);
        render();
        return;
      }
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const aspectRatio = ASPECTS.find(a => a.id === aspect).ratio;
      if (dragging === 'crop-new') {
        let x = Math.min(cropDragOrig.ix, ipt.x);
        let y = Math.min(cropDragOrig.iy, ipt.y);
        let w = Math.abs(ipt.x - cropDragOrig.ix);
        let h = Math.abs(ipt.y - cropDragOrig.iy);
        if (aspectRatio) { h = w / aspectRatio; }
        edits.crop = clampCrop({ x, y, w, h }, iw, ih);
      } else if (dragging === 'crop-move') {
        const dx = ipt.x - cropDragOrig.ix;
        const dy = ipt.y - cropDragOrig.iy;
        let nx = cropDragOrig.x + dx, ny = cropDragOrig.y + dy;
        nx = Math.max(0, Math.min(iw - cropDragOrig.w, nx));
        ny = Math.max(0, Math.min(ih - cropDragOrig.h, ny));
        edits.crop = { x: nx, y: ny, w: cropDragOrig.w, h: cropDragOrig.h };
      } else if (dragging.startsWith('crop-')) {
        const handle = dragging.slice(5);
        const o = cropDragOrig;
        let x = o.x, y = o.y, w = o.w, h = o.h;
        if (handle.includes('w')) { const nx = ipt.x; w = (o.x + o.w) - nx; x = nx; }
        if (handle.includes('e')) { w = ipt.x - o.x; }
        if (handle.includes('n')) { const ny = ipt.y; h = (o.y + o.h) - ny; y = ny; }
        if (handle.includes('s')) { h = ipt.y - o.y; }
        if (aspectRatio) { h = w / aspectRatio; }
        edits.crop = clampCrop({ x, y, w, h }, iw, ih);
      }
      render(); fire();
    }
    function onPointerUp(ev) {
      if (!dragging) return;
      try { ui.canvas.releasePointerCapture(ev.pointerId); } catch (_) {}
      const wasCropOrErase = (dragging === 'erase' || dragging.startsWith('crop-'));
      dragging = null;
      cropDragOrig = null;
      if (wasCropOrErase) commit();
    }

    function clampCrop(c, iw, ih) {
      let x = c.x, y = c.y, w = c.w, h = c.h;
      if (w < 0) { x = x + w; w = -w; }
      if (h < 0) { y = y + h; h = -h; }
      x = Math.max(0, Math.min(iw - 1, x));
      y = Math.max(0, Math.min(ih - 1, y));
      w = Math.max(1, Math.min(iw - x, w));
      h = Math.max(1, Math.min(ih - y, h));
      return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    }

    function onKey(ev) {
      if (!container.contains(document.activeElement) && document.activeElement !== document.body) return;
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'z') {
        ev.preventDefault();
        if (ev.shiftKey) redoOp(); else undoOp();
      } else if ((ev.metaKey || ev.ctrlKey) && ev.key === 'y') {
        ev.preventDefault(); redoOp();
      }
    }

    function pushUndo() {
      undo.push(JSON.stringify(edits));
      if (undo.length > 100) undo.shift();
      redo.length = 0;
    }
    function commit() { pushUndo(); render(); fire(); syncControls(); }
    function fire() { if (typeof opts.onChange === 'function') opts.onChange(getEdits()); }
    function undoOp() {
      if (undo.length < 2) return;
      const cur = undo.pop();
      redo.push(cur);
      edits = JSON.parse(undo[undo.length - 1]);
      syncControls(); render(); fire();
    }
    function redoOp() {
      const next = redo.pop(); if (!next) return;
      undo.push(next);
      edits = JSON.parse(next);
      syncControls(); render(); fire();
    }
    pushUndo();

    return {
      destroy, getEdits, setSrc, setEdits, render,
      applyEdits: () => applyEditsToCanvas(img, edits),
      computeSlice: () => { sliceChildren = computeSlice(); render(); return sliceChildren; }
    };
  }

  function rgbToHex(rgba) {
    const h = (n) => ('0' + n.toString(16)).slice(-2);
    return '#' + h(rgba[0]) + h(rgba[1]) + h(rgba[2]);
  }
  function hexToRgb(hex) {
    const m = /^#?([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i.exec(hex || '');
    if (!m) return [255, 0, 85, 255];
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 255];
  }

  function normalizeEdits(e) {
    e = e || {};
    return {
      crop:   e.crop   ? { x: +e.crop.x || 0, y: +e.crop.y || 0, w: +e.crop.w || 0, h: +e.crop.h || 0 } : null,
      resize: e.resize ? { w: +e.resize.w || 0, h: +e.resize.h || 0 } : null,
      rotate: +e.rotate || 0,
      flip:   { h: !!(e.flip && e.flip.h), v: !!(e.flip && e.flip.v) },
      filter: {
        brightness: e.filter && e.filter.brightness != null ? +e.filter.brightness : 1,
        contrast:   e.filter && e.filter.contrast   != null ? +e.filter.contrast   : 1,
        saturate:   e.filter && e.filter.saturate   != null ? +e.filter.saturate   : 1,
        hue:        e.filter && e.filter.hue        != null ? +e.filter.hue        : 0
      },
      pixelOps: Array.isArray(e.pixelOps) ? e.pixelOps.slice() : []
    };
  }

  function cloneEdits(e) { return JSON.parse(JSON.stringify(e)); }

  function compactEdits(e) {
    if (!e) return null;
    const out = {};
    if (e.crop && e.crop.w > 0 && e.crop.h > 0) out.crop = { ...e.crop };
    if (e.resize && e.resize.w > 0 && e.resize.h > 0 && e.crop && (e.resize.w !== e.crop.w || e.resize.h !== e.crop.h)) out.resize = { ...e.resize };
    if (e.rotate) out.rotate = e.rotate;
    if (e.flip && (e.flip.h || e.flip.v)) out.flip = { h: !!e.flip.h, v: !!e.flip.v };
    if (e.filter) {
      const f = {};
      if (e.filter.brightness !== 1) f.brightness = e.filter.brightness;
      if (e.filter.contrast   !== 1) f.contrast   = e.filter.contrast;
      if (e.filter.saturate   !== 1) f.saturate   = e.filter.saturate;
      if (e.filter.hue        !== 0) f.hue        = e.filter.hue;
      if (Object.keys(f).length) out.filter = f;
    }
    if (Array.isArray(e.pixelOps) && e.pixelOps.length) out.pixelOps = e.pixelOps.slice();
    return Object.keys(out).length ? out : null;
  }

  root.ImageEditor = {
    mount,
    applyEditsToCanvas,
    compactEdits,
    normalizeEdits,
    sliceImage,
    trimAlpha,
    findConnectedRegions
  };
})(typeof window !== 'undefined' ? window : this);
