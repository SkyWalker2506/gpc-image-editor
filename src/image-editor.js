/* gpc-image-editor v0.5.0 — non-destructive in-browser mini photoshop for game sprites.
 *
 * Companion module: video-to-strip.js exposes
 *   window.ImageEditor.mountVideoToStrip({ container, videoSrc, sourceName, onApply, onCancel })
 *   -> { destroy }   // see src/video-to-strip.js for full API.
 *
 *
 * Public API:
 *   window.ImageEditor.mount({
 *     container: HTMLElement,        // panel root that will host the editor
 *     stage:     HTMLElement,        // optional separate canvas host (else container)
 *     src:       string,             // image src/dataURL to edit
 *     edits:     ImageEdits | null,  // initial edits (crop/resize/rotate/flip/filter/pixelOps)
 *     onChange:  (edits) => void,    // fired on any edit (live)
 *     onApply:   ({ edits, pngBlob, pngDataUrl, width, height }) => void, // Apply
 *                                    // pngBlob/pngDataUrl are the baked output PNG with all
 *                                    // edits flattened (crop/pixelOps/resize/rotate/filter).
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
      try { applyPixelOps(s1, stage1.width, stage1.height, e.pixelOps, e._layers); }
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
  function applyPixelOps(ctx, w, h, ops, layers) {
    const visibleLayers = layers ? new Set(layers.filter(l => l.visible !== false).map(l => l.id)) : null;
    let mode = 'px';                                // 'px' for raw imageData ops, 'cv' for canvas2D ops
    let id = null, px = null;
    const flushPx = () => { if (mode === 'px' && id) { ctx.putImageData(id, 0, 0); id = null; px = null; } };
    const ensurePx = () => {
      if (mode !== 'px') { mode = 'px'; }
      if (!id) { id = ctx.getImageData(0, 0, w, h); px = id.data; }
    };
    const ensureCv = () => { if (mode !== 'cv') { flushPx(); mode = 'cv'; } };

    for (const op of ops || []) {
      if (!op || !op.type) continue;
      if (visibleLayers && !visibleLayers.has(op.layer || 'base')) continue;
      switch (op.type) {
        case 'bgRemove':       ensurePx(); pxBgRemove(px, w, h, op); break;
        case 'fill':           ensurePx(); pxFill(px, w, h, op); break;
        case 'erase':          ensurePx(); pxErase(px, w, h, op); break;
        case 'bgRemoveColor':  ensurePx(); pxBgRemoveColor(px, w, h, op); break;
        case 'paint':          ensureCv(); cvPaint(ctx, op); break;
        case 'line':           ensureCv(); cvLine(ctx, op); break;
        case 'rect':           ensureCv(); cvRect(ctx, op); break;
        case 'circle':         ensureCv(); cvCircle(ctx, op); break;
        case 'gradient':       ensureCv(); cvGradient(ctx, op); break;
        case 'paste':          ensureCv(); cvPaste(ctx, op); break;
        case 'eraseRegion':    ensureCv(); cvEraseRegion(ctx, op); break;
      }
    }
    flushPx();
  }

  function rgbaArrayToCss(c) {
    if (!c) return 'rgba(0,0,0,1)';
    return 'rgba(' + (c[0]|0) + ',' + (c[1]|0) + ',' + (c[2]|0) + ',' + ((c[3] == null ? 255 : c[3]) / 255) + ')';
  }
  function cvPaint(ctx, op) {
    ctx.save();
    ctx.fillStyle = rgbaArrayToCss(op.color);
    ctx.beginPath(); ctx.arc(op.x, op.y, Math.max(1, +op.radius || 4), 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function cvLine(ctx, op) {
    ctx.save();
    ctx.strokeStyle = rgbaArrayToCss(op.color); ctx.lineWidth = Math.max(1, +op.width || 1);
    ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(op.x1, op.y1); ctx.lineTo(op.x2, op.y2); ctx.stroke();
    ctx.restore();
  }
  function cvRect(ctx, op) {
    ctx.save();
    if (op.filled) { ctx.fillStyle = rgbaArrayToCss(op.color); ctx.fillRect(op.x, op.y, op.w, op.h); }
    else { ctx.strokeStyle = rgbaArrayToCss(op.color); ctx.lineWidth = Math.max(1, +op.width || 1); ctx.strokeRect(op.x, op.y, op.w, op.h); }
    ctx.restore();
  }
  function cvCircle(ctx, op) {
    ctx.save();
    ctx.beginPath(); ctx.arc(op.cx, op.cy, Math.max(1, +op.r || 1), 0, Math.PI * 2);
    if (op.filled) { ctx.fillStyle = rgbaArrayToCss(op.color); ctx.fill(); }
    else { ctx.strokeStyle = rgbaArrayToCss(op.color); ctx.lineWidth = Math.max(1, +op.width || 1); ctx.stroke(); }
    ctx.restore();
  }
  function cvGradient(ctx, op) {
    ctx.save();
    let g;
    if (op.gtype === 'radial') {
      const r = Math.hypot(op.x2 - op.x1, op.y2 - op.y1);
      g = ctx.createRadialGradient(op.x1, op.y1, 0, op.x1, op.y1, Math.max(1, r));
    } else {
      g = ctx.createLinearGradient(op.x1, op.y1, op.x2, op.y2);
    }
    g.addColorStop(0, op.colorA || '#ffffff');
    g.addColorStop(1, op.colorB || '#000000');
    ctx.fillStyle = g; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  }
  function cvPaste(ctx, op) {
    if (!op.dataUrl) return;
    if (!op._img) {
      const im = new Image();
      im.src = op.dataUrl;
      op._img = im;
    }
    if (op._img.complete && op._img.naturalWidth) {
      ctx.drawImage(op._img, op.x, op.y, op.w || op._img.naturalWidth, op.h || op._img.naturalHeight);
    } else {
      // Schedule re-render once loaded
      op._img.onload = () => { if (op._onReady) op._onReady(); };
    }
  }
  function cvEraseRegion(ctx, op) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    if (op.shape === 'rect') {
      ctx.fillRect(op.x, op.y, op.w, op.h);
    } else if (op.shape === 'lasso' && Array.isArray(op.points)) {
      ctx.beginPath();
      for (let i = 0; i < op.points.length; i++) {
        const [x, y] = op.points[i];
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
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
    if (mode === 'anim' && params._perCell && params._cells && params._cells.length) {
      // Per-cell anim mode: each frame has its own x/y/w/h
      const cells = params._cells;
      const outW = params.outputW || Math.max(...cells.map(c => c.w));
      const outH = params.outputH || Math.max(...cells.map(c => c.h));
      cells.forEach((cell, i) => {
        const cnv = document.createElement('canvas');
        cnv.width = outW; cnv.height = outH;
        const dx2 = Math.round((outW - cell.w) / 2);
        const dy2 = Math.round((outH - cell.h) / 2);
        cnv.getContext('2d').drawImage(baked, cell.x, cell.y, cell.w, cell.h, dx2, dy2, cell.w, cell.h);
        children.push({ canvas: cnv, bounds: { x: cell.x, y: cell.y, w: cell.w, h: cell.h }, frameIndex: i });
      });
    } else if (mode === 'grid' || mode === 'anim') {
      const cols = Math.max(1, params.cols | 0);
      const rows = Math.max(1, params.rows | 0);
      const padX = Math.max(0, params.paddingX | 0);
      const padY = Math.max(0, params.paddingY | 0);
      const offX = Math.max(0, params.frameOffsetX | 0);
      const offY = Math.max(0, params.frameOffsetY | 0);
      // If no padding set, fall back to simple equal division
      const cw = padX > 0
        ? Math.floor((W - 2 * offX - (cols - 1) * padX) / cols)
        : Math.floor((W - 2 * offX) / cols);
      const ch = padY > 0
        ? Math.floor((H - 2 * offY - (rows - 1) * padY) / rows)
        : Math.floor((H - 2 * offY) / rows);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const sx = offX + c * (cw + padX);
          const sy = offY + r * (ch + padY);
          const cnv = document.createElement('canvas');
          cnv.width = cw; cnv.height = ch;
          cnv.getContext('2d').drawImage(baked, sx, sy, cw, ch, 0, 0, cw, ch);
          let bounds = { x: sx, y: sy, w: cw, h: ch };
          let outCv = cnv;
          if (params.trim) {
            const trimmed = trimAlpha(cnv, params.alphaThreshold || 1);
            outCv = trimmed.canvas;
            bounds = { x: sx + trimmed.bounds.x, y: sy + trimmed.bounds.y,
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
    let zoom = 0;
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

    // M2/M3 state — selection, clipboard, layers, palette
    const PALETTE_DEFAULT = ['#000000','#ffffff','#ff3b30','#ff9500','#ffcc00','#34c759','#00c7be','#007aff','#5856d6','#af52de','#ff2d55','#a2845e'];
    const colorHistory = [];
    let strokeWidth = 4;
    let shapeFilled = false;
    let selection = null;        // { type:'rect',x,y,w,h } | { type:'lasso', points:[[x,y]…] } in source-image space
    let lassoPts = null;         // freehand in-progress
    let shapeStart = null;       // { x, y } in source-image space
    let shapeEnd = null;
    let clipboard = null;        // { dataUrl, w, h, srcX, srcY }
    let pasteFloat = null;       // { dataUrl, x, y, w, h, img }
    let layers = [{ id: 'base', name: 'Base', visible: true, opacity: 1, locked: true }];
    let activeLayerId = 'base';

    // Slice state
    let sliceMode = 'grid';   // grid | anim | auto
    let sliceParams = {
      cols: 4, rows: 5,
      trim: false,
      fps: 8,
      alphaThreshold: 16,
      connectivity: 4,
      minSize: 64,
      paddingX: 0, paddingY: 0,
      frameOffsetX: 0, frameOffsetY: 0
    };
    let sliceChildren = null;       // last computed children
    let sliceAnimFrame = 0;
    let sliceAnimTimer = null;

    // Per-cell anim state (used when sliceMode === 'anim')
    let animCells = [];
    let animDefaultCellW = 256;
    let animDefaultCellH = 256;
    let animFrameCount = 8;
    let animPaddingX = 0;
    let animPaddingY = 0;
    let animOutputW = null;
    let animOutputH = null;
    let animSelectedCell = -1;

    container.innerHTML = '';
    container.classList.add('gpc-ie-root');

    const ui = buildUI(container);

    // Wire accordion: clicking a panel-title toggles collapsed on the parent panel
    container.querySelectorAll('.gpc-ie-panel-title').forEach(titleEl => {
      titleEl.addEventListener('click', () => {
        const panel = titleEl.closest('.gpc-ie-panel');
        if (panel) panel.classList.toggle('collapsed');
      });
    });

    bindUI();
    setSrc(opts.src || '');

    function setSrc(src) {
      imgReady = false;
      zoom = 0;  // reset so ResizeObserver re-runs fitView when modal opens
      sliceChildren = null;
      stopAnimPreview();

      function tryLoad(useCors) {
        const el = new Image();
        if (useCors) el.crossOrigin = 'anonymous';
        el.onload = () => {
          img = el;
          imgReady = true;
          // If anim mode and cells still at default 256, auto-fit from image dimensions
          if (sliceMode === 'anim' && animDefaultCellW === 256 && animFrameCount > 0) {
            animDefaultCellW = Math.max(1, Math.floor(el.naturalWidth / animFrameCount));
            animDefaultCellH = el.naturalHeight;
            buildAnimCells();
            if (activeTool === 'slice') renderSlicePanel();
          }
          // Only fit+render immediately if the canvas has real dimensions.
          // If the modal is still hidden (0×0), the ResizeObserver will call
          // fitView()+render() once the modal becomes visible.
          const _cv = ui ? ui.canvas : null;
          if (_cv && _cv.clientWidth > 0 && _cv.clientHeight > 0) {
            requestAnimationFrame(() => { fitView(); render(); });
          }
        };
        el.onerror = () => {
          if (useCors) {
            // Retry without CORS (image visible but canvas pixel-read blocked)
            tryLoad(false);
          } else {
            imgReady = false;
            render();
          }
        };
        // Cache-bust to avoid stale tainted-canvas from a prior no-cors load
        el.src = src ? (src + (src.includes('?') ? '&' : '?') + '_iecb=' + Date.now()) : '';
      }

      img = new Image(); // reset immediately so render shows blank not stale
      tryLoad(true);
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
            <button data-ie-tool="crop"      title="Crop / select (C)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 1v10a2 2 0 002 2h10M13 15V5a2 2 0 00-2-2H1"/></svg><span>Crop</span></button>
            <button data-ie-tool="rectsel"   title="Rect Select (M)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="3 2"><rect x="2" y="2" width="12" height="12" rx="1"/></svg><span>Select</span></button>
            <button data-ie-tool="lasso"     title="Lasso Select (L)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3c-3 0-5 1.5-5 4s2 4 5 4 5-1.5 5-4c0-1-1-2-2-1l-1 3"/></svg><span>Lasso</span></button>
            <button data-ie-tool="bgRemove"  title="Magic-wand bg remove (W)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M7 9l6 6M3 3l2 2M8 2l1 2M13 3l-2 1M14 8l-2 1M2 8l2-1"/><circle cx="5.5" cy="5.5" r="2.5"/></svg><span>Wand</span></button>
            <button data-ie-tool="eyedrop"   title="Eyedropper (I)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 3a2.8 2.8 0 014 4l-1 1-4-4 1-1zM9 5l-6 6-1 3 3-1 6-6-2-2z"/></svg><span>Eye</span></button>
            <button data-ie-tool="brush"     title="Brush (B)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2 2-8 8-3 1 1-3 8-8z"/><path d="M3 14c1-1 2-1 2 0s-1 1-2 1z" fill="currentColor" stroke="none"/></svg><span>Brush</span></button>
            <button data-ie-tool="erase"     title="Eraser (E)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 5L7 11l-4-4 6-6 4 4z"/><path d="M3 11l2 2H2l1-2z"/><line x1="1" y1="15" x2="15" y2="15"/></svg><span>Erase</span></button>
            <button data-ie-tool="fill"      title="Fill bucket (G)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 14l4-4 6-6-2-2-6 6-2 2 2 2v2zM14 11c0 1.1-.9 2-2 2s-2-.9-2-2c0-1.5 2-4 2-4s2 2.5 2 4z" fill="currentColor" fill-opacity="0.2"/><path d="M4 10l6-6M2 14l4-4"/></svg><span>Fill</span></button>
            <button data-ie-tool="line"      title="Line (U)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="14" x2="14" y2="2"/></svg><span>Line</span></button>
            <button data-ie-tool="rect"      title="Rectangle shape (R)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="4" width="12" height="8" rx="1"/></svg><span>Rect</span></button>
            <button data-ie-tool="circle"    title="Circle shape (O)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/></svg><span>Circle</span></button>
            <button data-ie-tool="gradient"  title="Gradient fill (D)"><svg width="16" height="16" viewBox="0 0 16 16"><defs><linearGradient id="ie-g" x1="0" x2="1"><stop offset="0" stop-color="currentColor" stop-opacity="0.1"/><stop offset="1" stop-color="currentColor" stop-opacity="1"/></linearGradient></defs><rect x="2" y="3" width="12" height="10" rx="1" fill="url(#ie-g)" stroke="currentColor" stroke-width="1.5"/></svg><span>Grad</span></button>
            <button data-ie-tool="slice"     title="Slice mode (S)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="2" width="12" height="12" rx="1"/><line x1="7" y1="2" x2="7" y2="14"/><line x1="2" y1="7" x2="14" y2="7"/></svg><span>Slice</span></button>
          </div>
          <div class="gpc-ie-sep"></div>
          <div class="gpc-ie-group">
            <label>Aspect</label>
            <select data-ie="aspect">${ASPECTS.map(a => `<option value="${a.id}">${a.label}</option>`).join('')}</select>
          </div>
          <div class="gpc-ie-sep"></div>
          <div class="gpc-ie-group">
            <button data-ie="rot-l" title="Rotate -90">⟲ -90</button>
            <button data-ie="rot-r" title="Rotate +90">⟳ +90</button>
            <button data-ie="flip-h" title="Flip horizontal">⇋ H</button>
            <button data-ie="flip-v" title="Flip vertical">⇅ V</button>
          </div>
          <div class="gpc-ie-sep"></div>
          <div class="gpc-ie-group">
            <button data-ie="undo" title="Undo (Cmd+Z)">⟲ Undo</button>
            <button data-ie="redo" title="Redo (Cmd+Shift+Z)">⟳ Redo</button>
            <button data-ie="reset" title="Reset all edits">↺ Reset</button>
          </div>
          <div class="gpc-ie-sep"></div>
          <div class="gpc-ie-group">
            <button data-ie="copy"  title="Copy (Cmd+C)">⎘ Copy</button>
            <button data-ie="paste" title="Paste (Cmd+V)">⎗ Paste</button>
            <button data-ie="cut"   title="Cut (Cmd+X)">✂ Cut</button>
            <button data-ie="delsel" title="Delete selection (Del)">⊘ Del</button>
          </div>
          <div class="gpc-ie-group gpc-ie-grow"></div>
          <div class="gpc-ie-group">
            <button data-ie="back"   class="gpc-ie-btn-back" title="Asset Browser'a dön">&#8592; Geri</button>
            <button data-ie="cancel" class="gpc-ie-btn-ghost">Cancel</button>
            <button data-ie="apply"  class="gpc-ie-btn-primary" style="padding:6px 18px;font-size:13px">Apply</button>
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
            <div class="gpc-ie-row"><button data-ie="slice-apply" class="gpc-ie-btn-primary">Apply</button></div>
            <div class="gpc-ie-row" data-ie="slice-status" style="display:none;font-size:12px;color:#4caf50;padding:4px 0"></div>
            <div class="gpc-ie-row"><button data-ie="slice-zip">Download ZIP</button></div>
            <div class="gpc-ie-row" data-ie="slice-anim-controls" style="display:none">
              <button data-ie="anim-play">▶ Play</button>
              <button data-ie="anim-stop">■ Stop</button>
            </div>
          </div>

          <div class="gpc-ie-panel collapsed">
            <div class="gpc-ie-panel-title">Resize</div>
            <div class="gpc-ie-panel-body">
              <div class="gpc-ie-row"><label>Width</label><input type="number" data-ie="rw" min="1" step="1"></div>
              <div class="gpc-ie-row"><label>Height</label><input type="number" data-ie="rh" min="1" step="1"></div>
              <div class="gpc-ie-row"><label><input type="checkbox" data-ie="rlock" checked> Lock aspect</label></div>
              <div class="gpc-ie-row"><button data-ie="fit-bbox">Fit to crop</button></div>
            </div>
          </div>
          <div class="gpc-ie-panel collapsed">
            <div class="gpc-ie-panel-title">Rotate</div>
            <div class="gpc-ie-panel-body">
              <div class="gpc-ie-row"><label>Angle</label>
                <input type="range" data-ie="rot" min="-180" max="180" step="1" value="0">
                <input type="number" data-ie="rot-num" min="-180" max="180" step="1" value="0" style="width:64px">
              </div>
            </div>
          </div>
          <div class="gpc-ie-panel collapsed">
            <div class="gpc-ie-panel-title">Adjust</div>
            <div class="gpc-ie-panel-body">
              <div class="gpc-ie-row"><label>Brightness</label><input type="range" data-ie="f-bri" min="0" max="2" step="0.01" value="1"></div>
              <div class="gpc-ie-row"><label>Contrast</label><input type="range" data-ie="f-con" min="0" max="2" step="0.01" value="1"></div>
              <div class="gpc-ie-row"><label>Saturate</label><input type="range" data-ie="f-sat" min="0" max="2" step="0.01" value="1"></div>
              <div class="gpc-ie-row"><label>Hue</label><input type="range" data-ie="f-hue" min="-180" max="180" step="1" value="0"></div>
            </div>
          </div>
          <div class="gpc-ie-panel collapsed">
            <div class="gpc-ie-panel-title">Color Palette</div>
            <div class="gpc-ie-panel-body">
              <div class="gpc-ie-row"><label>Active</label><input type="color" data-ie="pal-color" value="#ff0055"><input type="number" data-ie="pal-stroke" min="1" max="64" step="1" value="4" title="Stroke/brush width" style="width:48px"></div>
              <div class="gpc-ie-swatches" data-ie="pal-swatches"></div>
              <div class="gpc-ie-panel-title" style="margin-top:6px;font-size:9px;cursor:default" onclick="event.stopPropagation()">Recent</div>
              <div class="gpc-ie-swatches" data-ie="pal-history"></div>
            </div>
          </div>
          <div class="gpc-ie-panel collapsed">
            <div class="gpc-ie-panel-title">Shape Options</div>
            <div class="gpc-ie-panel-body">
              <div class="gpc-ie-row"><label><input type="checkbox" data-ie="shape-fill"> Filled</label></div>
              <div class="gpc-ie-row"><label>Grad type</label>
                <select data-ie="grad-type"><option value="linear">Linear</option><option value="radial">Radial</option></select>
              </div>
              <div class="gpc-ie-row"><label>Grad A</label><input type="color" data-ie="grad-a" value="#ffffff"></div>
              <div class="gpc-ie-row"><label>Grad B</label><input type="color" data-ie="grad-b" value="#000000"></div>
            </div>
          </div>
          <div class="gpc-ie-panel collapsed" data-ie-pane="layers">
            <div class="gpc-ie-panel-title">Layers</div>
            <div class="gpc-ie-panel-body">
              <div data-ie="layer-list"></div>
              <div class="gpc-ie-row" style="display:flex;gap:4px">
                <button data-ie="layer-add" title="Add layer" style="flex:1">+ Add</button>
                <button data-ie="layer-del" title="Delete active" style="flex:1">− Del</button>
                <button data-ie="layer-flat" title="Flatten all to base" style="flex:1">⌂ Flat</button>
              </div>
            </div>
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
        back: $('[data-ie="back"]'), cancel: $('[data-ie="cancel"]'), apply: $('[data-ie="apply"]'),
        toolBtns: root.querySelectorAll('[data-ie-tool]'),
        toolTitle: $('[data-ie="tool-title"]'),
        toolBody:  $('[data-ie="tool-body"]'),
        paneSlice: $('[data-ie-pane="slice"]'),
        sliceBody: $('[data-ie="slice-body"]'),
        sliceCompute: $('[data-ie="slice-compute"]'),
        sliceApply:   $('[data-ie="slice-apply"]'),
        sliceStatus:  $('[data-ie="slice-status"]'),
        sliceZip:     $('[data-ie="slice-zip"]'),
        sliceModeBtns: root.querySelectorAll('[data-ie-smode]'),
        animCtrls: $('[data-ie="slice-anim-controls"]'),
        animPlay:  $('[data-ie="anim-play"]'),
        animStop:  $('[data-ie="anim-stop"]'),
        // M2/M3 — palette + clipboard + layers
        copy:    $('[data-ie="copy"]'),
        paste:   $('[data-ie="paste"]'),
        cut:     $('[data-ie="cut"]'),
        delsel:  $('[data-ie="delsel"]'),
        palColor:    $('[data-ie="pal-color"]'),
        palStroke:   $('[data-ie="pal-stroke"]'),
        palSwatches: $('[data-ie="pal-swatches"]'),
        palHistory:  $('[data-ie="pal-history"]'),
        shapeFill:   $('[data-ie="shape-fill"]'),
        gradType:    $('[data-ie="grad-type"]'),
        gradA:       $('[data-ie="grad-a"]'),
        gradB:       $('[data-ie="grad-b"]'),
        layerList:   $('[data-ie="layer-list"]'),
        layerAdd:    $('[data-ie="layer-add"]'),
        layerDel:    $('[data-ie="layer-del"]'),
        layerFlat:   $('[data-ie="layer-flat"]')
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
      if (ui.back) ui.back.addEventListener('click', () => { if (typeof opts.onCancel === 'function') opts.onCancel(); });
      ui.cancel.addEventListener('click', () => { if (typeof opts.onCancel === 'function') opts.onCancel(); });
      ui.apply.addEventListener('click', () => {
        if (typeof opts.onApply !== 'function') return;
        const e = getEdits();
        let baked = null;
        try { baked = applyEditsToCanvas(img, e); } catch (_) {}
        if (!baked) { opts.onApply({ edits: e, pngBlob: null, pngDataUrl: null, width: 0, height: 0 }); return; }
        const w = baked.width, h = baked.height;
        let dataUrl = null;
        try { dataUrl = baked.toDataURL('image/png'); } catch (_) {}
        baked.toBlob((blob) => {
          opts.onApply({ edits: e, pngBlob: blob, pngDataUrl: dataUrl, width: w, height: h });
        }, 'image/png');
      });

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

      // M2/M3 — palette, clipboard, layers, shape options
      buildSwatches();
      ui.palColor.addEventListener('input', () => { activeColor = hexToRgb(ui.palColor.value); });
      ui.palColor.addEventListener('change', () => { pushColorHistory(ui.palColor.value); });
      ui.palStroke.addEventListener('input', () => { strokeWidth = Math.max(1, +ui.palStroke.value || 1); });
      ui.palSwatches.addEventListener('click', (ev) => {
        const sw = ev.target.closest('.gpc-ie-swatch'); if (!sw) return;
        ui.palColor.value = sw.dataset.color; activeColor = hexToRgb(sw.dataset.color);
        pushColorHistory(sw.dataset.color);
      });
      ui.palHistory.addEventListener('click', (ev) => {
        const sw = ev.target.closest('.gpc-ie-swatch'); if (!sw) return;
        ui.palColor.value = sw.dataset.color; activeColor = hexToRgb(sw.dataset.color);
      });
      ui.shapeFill.addEventListener('change', () => { shapeFilled = !!ui.shapeFill.checked; });

      ui.copy.addEventListener('click', copySelection);
      ui.paste.addEventListener('click', pasteClipboard);
      ui.cut.addEventListener('click', cutSelection);
      ui.delsel.addEventListener('click', deleteSelection);

      ui.layerAdd.addEventListener('click', () => {
        const id = 'L' + Date.now().toString(36);
        if (layers.length >= 3) { flashInfo('Max 3 layers'); return; }
        layers.push({ id, name: 'Layer ' + layers.length, visible: true, opacity: 1, locked: false });
        activeLayerId = id; renderLayerList();
      });
      ui.layerDel.addEventListener('click', () => {
        if (activeLayerId === 'base') { flashInfo('Cannot delete base'); return; }
        // Drop pixelOps tagged with this layer
        edits.pixelOps = (edits.pixelOps || []).filter(op => (op.layer || 'base') !== activeLayerId);
        layers = layers.filter(l => l.id !== activeLayerId);
        activeLayerId = layers[layers.length - 1].id;
        commit(); renderLayerList();
      });
      ui.layerFlat.addEventListener('click', () => {
        // Move all pixelOps onto base, drop other layers
        (edits.pixelOps || []).forEach(op => { op.layer = 'base'; });
        layers = [{ id: 'base', name: 'Base', visible: true, opacity: 1, locked: true }];
        activeLayerId = 'base';
        commit(); renderLayerList();
      });
      renderLayerList();

      ui.canvas.addEventListener('wheel', onWheel, { passive: false });
      ui.canvas.addEventListener('pointerdown', onPointerDown);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('keydown', onKey);

      const ro = new ResizeObserver(() => {
        fitCanvasBuffer();
        // If the canvas just got real dimensions (e.g. modal opened from display:none),
        // and the image is ready but zoom was never computed, run fitView first.
        if (imgReady && zoom < 0.05) fitView();
        render();
      });
      ro.observe(ui.canvas);

      // Apply caller-requested initial state (e.g. animation strip auto-opens slice/anim mode).
      if (opts.initialSliceMode && ['grid','anim','auto'].includes(opts.initialSliceMode)) {
        sliceMode = opts.initialSliceMode;
      }
      if (opts.initialSliceParams && typeof opts.initialSliceParams === 'object') {
        sliceParams = Object.assign({}, sliceParams, opts.initialSliceParams);
        // If legacy cols-based params passed for anim, derive per-cell defaults
        if (sliceMode === 'anim' && opts.initialSliceParams.cols) {
          animFrameCount = Math.max(1, opts.initialSliceParams.cols | 0);
        }
      }
      buildAnimCells();
      setActiveTool(opts.initialTool && ['crop','rectsel','lasso','bgRemove','eyedrop','brush','erase','fill','line','rect','circle','gradient','slice'].includes(opts.initialTool) ? opts.initialTool : 'crop');
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
      const cursors = { crop:'crosshair', rectsel:'crosshair', lasso:'crosshair',
        bgRemove:'cell', eyedrop:'cell', brush:'crosshair', erase:'cell',
        fill:'cell', line:'crosshair', rect:'crosshair', circle:'crosshair',
        gradient:'crosshair', slice:'crosshair' };
      ui.canvas.style.cursor = cursors[tool] || 'pointer';
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
      if (sliceMode === 'anim') {
        const curOutW = animOutputW || '';
        const curOutH = animOutputH || '';
        body = `
          <div class="gpc-ie-row"><label>Default cell</label>
            <input type="number" data-ie="s-anim-dw" min="1" step="1" value="${animDefaultCellW}" style="width:60px"> ×
            <input type="number" data-ie="s-anim-dh" min="1" step="1" value="${animDefaultCellH}" style="width:60px">
          </div>
          <div class="gpc-ie-row"><label>Frames</label>
            <input type="number" data-ie="s-anim-count" min="1" max="64" step="1" value="${animFrameCount}" style="width:60px">
            <button data-ie="s-anim-autofit" style="margin-left:4px">Auto-fit</button>
          </div>
          <div style="margin-top:8px;font-weight:bold;font-size:11px;color:#aaa;padding:2px 0;">CELLS</div>
          <div data-ie="s-anim-cell-list" style="max-height:160px;overflow-y:auto;margin-bottom:6px;"></div>
          <div data-ie="s-anim-selected-cell" style="display:none;border-top:1px solid #333;padding-top:6px;margin-top:4px;">
            <div style="font-weight:bold;font-size:11px;color:#0df;padding:2px 0;">SELECTED CELL</div>
            <div class="gpc-ie-row">
              <label>W</label><input type="number" data-ie="s-anim-cell-w" min="1" step="1" style="width:70px">
              <label style="margin-left:6px">H</label><input type="number" data-ie="s-anim-cell-h" min="1" step="1" style="width:70px">
            </div>
          </div>
          <div class="gpc-ie-row" style="margin-top:6px;"><label>Output</label>
            <input type="number" data-ie="s-anim-outw" min="1" step="1" value="${curOutW}" placeholder="auto" style="width:60px"> ×
            <input type="number" data-ie="s-anim-outh" min="1" step="1" value="${curOutH}" placeholder="auto" style="width:60px">
            <button data-ie="s-anim-recompute" title="Recompute max" style="margin-left:4px">↻</button>
          </div>
          <div class="gpc-ie-row"><label>Gap X</label>
            <input type="number" data-ie="s-anim-padx" min="0" step="1" value="${animPaddingX}" style="width:50px">
            <label style="margin-left:6px">Y</label>
            <input type="number" data-ie="s-anim-pady" min="0" step="1" value="${animPaddingY}" style="width:50px">
          </div>
          <div class="gpc-ie-row"><label>FPS</label><input type="number" data-ie="s-fps" min="1" max="60" step="1" value="${sliceParams.fps}" style="width:60px"></div>`;
      } else if (sliceMode === 'grid') {
        body = `
          <div class="gpc-ie-row"><label>Cols</label><input type="number" data-ie="s-cols" min="1" step="1" value="${sliceParams.cols}"></div>
          <div class="gpc-ie-row"><label>Rows</label><input type="number" data-ie="s-rows" min="1" step="1" value="${sliceParams.rows}"></div>
          <div class="gpc-ie-row"><label><input type="checkbox" data-ie="s-trim" ${sliceParams.trim ? 'checked' : ''}> Trim transparent</label></div>
          <div class="gpc-ie-row"><button data-ie="s-autofit">Auto-fit grid</button></div>`;
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
      const sOffX  = q('[data-ie="s-offx"]');  if (sOffX)  sOffX.addEventListener('input',  e => { sliceParams.frameOffsetX = Math.max(0, +e.target.value); sliceChildren = null; render(); });
      const sOffY  = q('[data-ie="s-offy"]');  if (sOffY)  sOffY.addEventListener('input',  e => { sliceParams.frameOffsetY = Math.max(0, +e.target.value); sliceChildren = null; render(); });
      const sPadX  = q('[data-ie="s-padx"]');  if (sPadX)  sPadX.addEventListener('input',  e => { sliceParams.paddingX = Math.max(0, +e.target.value); sliceChildren = null; render(); });
      const sPadY  = q('[data-ie="s-pady"]');  if (sPadY)  sPadY.addEventListener('input',  e => { sliceParams.paddingY = Math.max(0, +e.target.value); sliceChildren = null; render(); });

      // Per-cell anim wiring
      if (sliceMode === 'anim') {
        const aDw = q('[data-ie="s-anim-dw"]'); if (aDw) aDw.addEventListener('input', e => { animDefaultCellW = Math.max(1, +e.target.value); buildAnimCells(); renderAnimCellList(); sliceChildren = null; render(); });
        const aDh = q('[data-ie="s-anim-dh"]'); if (aDh) aDh.addEventListener('input', e => { animDefaultCellH = Math.max(1, +e.target.value); buildAnimCells(); renderAnimCellList(); sliceChildren = null; render(); });
        const aCnt = q('[data-ie="s-anim-count"]'); if (aCnt) aCnt.addEventListener('input', e => { animFrameCount = Math.max(1, +e.target.value); buildAnimCells(); renderAnimCellList(); sliceChildren = null; render(); });
        const aFit = q('[data-ie="s-anim-autofit"]'); if (aFit) aFit.addEventListener('click', () => {
          if (!imgReady) return;
          animDefaultCellW = Math.max(1, Math.floor(img.naturalWidth / animFrameCount));
          animDefaultCellH = img.naturalHeight;
          buildAnimCells(); renderAnimCellList(); sliceChildren = null; render();
          // Update inputs
          const dw = q('[data-ie="s-anim-dw"]'); if (dw) dw.value = animDefaultCellW;
          const dh = q('[data-ie="s-anim-dh"]'); if (dh) dh.value = animDefaultCellH;
        });
        const aPX = q('[data-ie="s-anim-padx"]'); if (aPX) aPX.addEventListener('input', e => { animPaddingX = Math.max(0, +e.target.value); recomputeAnimCellPositions(); renderAnimCellList(); sliceChildren = null; render(); });
        const aPY = q('[data-ie="s-anim-pady"]'); if (aPY) aPY.addEventListener('input', e => { animPaddingY = Math.max(0, +e.target.value); recomputeAnimCellPositions(); renderAnimCellList(); sliceChildren = null; render(); });
        const aOW = q('[data-ie="s-anim-outw"]'); if (aOW) aOW.addEventListener('input', e => { animOutputW = e.target.value ? Math.max(1, +e.target.value) : null; });
        const aOH = q('[data-ie="s-anim-outh"]'); if (aOH) aOH.addEventListener('input', e => { animOutputH = e.target.value ? Math.max(1, +e.target.value) : null; });
        const aRec = q('[data-ie="s-anim-recompute"]'); if (aRec) aRec.addEventListener('click', () => {
          if (!animCells.length) return;
          animOutputW = null; animOutputH = null;
          const mw = Math.max(...animCells.map(c => c.w));
          const mh = Math.max(...animCells.map(c => c.h));
          const owIn = q('[data-ie="s-anim-outw"]'); if (owIn) owIn.value = mw;
          const ohIn = q('[data-ie="s-anim-outh"]'); if (ohIn) ohIn.value = mh;
        });
        const aCW = q('[data-ie="s-anim-cell-w"]'); if (aCW) aCW.addEventListener('input', e => {
          if (animSelectedCell < 0 || animSelectedCell >= animCells.length) return;
          animCells[animSelectedCell].w = Math.max(1, +e.target.value);
          recomputeAnimCellPositions(); renderAnimCellList(); sliceChildren = null; render();
        });
        const aCH = q('[data-ie="s-anim-cell-h"]'); if (aCH) aCH.addEventListener('input', e => {
          if (animSelectedCell < 0 || animSelectedCell >= animCells.length) return;
          animCells[animSelectedCell].h = Math.max(1, +e.target.value);
          renderAnimCellList(); sliceChildren = null; render();
        });
        renderAnimCellList();
        updateSelectedCellInputs();
      }
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

    // ---- Per-cell anim helpers ---------------------------------------------
    function buildAnimCells() {
      animCells = [];
      for (let i = 0; i < animFrameCount; i++) {
        const prevX = i === 0 ? 0 : animCells[i - 1].x + animCells[i - 1].w + animPaddingX;
        animCells.push({ x: prevX, y: animPaddingY, w: animDefaultCellW, h: animDefaultCellH });
      }
    }

    function recomputeAnimCellPositions() {
      for (let i = 1; i < animCells.length; i++) {
        animCells[i].x = animCells[i - 1].x + animCells[i - 1].w + animPaddingX;
      }
    }

    function renderAnimCellList() {
      const listEl = ui.sliceBody.querySelector('[data-ie="s-anim-cell-list"]');
      if (!listEl) return;
      listEl.innerHTML = animCells.map((c, i) => `
        <div data-anim-cell="${i}" style="
          display:flex;align-items:center;padding:3px 6px;cursor:pointer;
          border-radius:4px;font-size:11px;
          background:${animSelectedCell === i ? 'rgba(0,221,255,0.15)' : 'transparent'};
          border-left:3px solid ${animSelectedCell === i ? '#0df' : 'transparent'};
        ">
          <span style="color:#aaa;width:20px">${i + 1}</span>
          <span style="flex:1">${c.w}×${c.h}</span>
          <span style="color:#555;font-size:10px">x:${c.x}</span>
        </div>
      `).join('');
      listEl.querySelectorAll('[data-anim-cell]').forEach(el => {
        el.addEventListener('click', () => {
          animSelectedCell = +el.dataset.animCell;
          renderAnimCellList();
          updateSelectedCellInputs();
          render();
        });
      });
    }

    function updateSelectedCellInputs() {
      const panel = ui.sliceBody.querySelector('[data-ie="s-anim-selected-cell"]');
      if (!panel) return;
      if (animSelectedCell < 0 || animSelectedCell >= animCells.length) {
        panel.style.display = 'none';
        return;
      }
      panel.style.display = '';
      const wIn = panel.querySelector('[data-ie="s-anim-cell-w"]');
      const hIn = panel.querySelector('[data-ie="s-anim-cell-h"]');
      if (wIn) wIn.value = animCells[animSelectedCell].w;
      if (hIn) hIn.value = animCells[animSelectedCell].h;
    }

    function bakedSource() {
      // Source baked with crop+filter+pixelOps applied (no rotate/flip — slice grids assume axis-aligned).
      const e = { ...edits, rotate: 0, flip: { h: false, v: false }, resize: null, _layers: layers };
      return applyEditsToCanvas(img, e);
    }

    function computeSlice() {
      if (!imgReady) return null;
      const e = { ...edits, rotate: 0, flip: { h: false, v: false }, resize: null };
      let params = sliceParams;
      if (sliceMode === 'anim') {
        params = { ...sliceParams, _perCell: true, _cells: animCells.map(c => ({ ...c })), outputW: animOutputW, outputH: animOutputH };
      }
      const out = sliceImage(img, e, sliceMode, params);
      return out.children;
    }

    function emitSliceApply() {
      const children = sliceChildren || computeSlice();
      if (!children || !children.length) {
        flashInfo('No slices to apply.');
        return;
      }
      const baseName = (opts.assetName || opts.sourceName || 'sprite').replace(/\.[a-z0-9]+$/i, '');
      const childPayload = [];
      let pendingBlobs = children.length;

      const buildStripAndFinish = () => {
        childPayload.sort((a, b) => (a.frameIndex ?? 0) - (b.frameIndex ?? 0));
        const fW = childPayload[0].w, fH = childPayload[0].h;
        const strip = document.createElement('canvas');
        strip.width = fW * childPayload.length;
        strip.height = fH;
        const sCtx = strip.getContext('2d');
        let stripDone = 0;
        childPayload.forEach((ch, idx) => {
          const tmpImg = new Image();
          tmpImg.onload = () => {
            sCtx.drawImage(tmpImg, idx * fW, 0, fW, fH);
            stripDone++;
            if (stripDone === childPayload.length) {
              strip.toBlob(stripBlob => {
                const payload = {
                  mode: sliceMode,
                  params: sliceMode === 'anim'
                    ? { ...sliceParams, _perCell: true, _cells: animCells.map(c => ({ ...c })), outputW: animOutputW, outputH: animOutputH }
                    : { ...sliceParams },
                  source: { name: baseName, w: img.naturalWidth, h: img.naturalHeight },
                  children: childPayload,
                  stripBlob,
                  stripDataUrl: strip.toDataURL('image/png'),
                  frameW: fW,
                  frameH: fH,
                  frames: childPayload.length
                };
                if (typeof opts.onSliceApply === 'function') {
                  opts.onSliceApply(payload);
                } else {
                  // No host handler → offer ZIP download as fallback.
                  downloadSliceZip(childPayload, baseName);
                }
              }, 'image/png');
            }
          };
          tmpImg.src = ch.dataUrl;
        });
      };

      children.forEach((c, i) => {
        const name = `${baseName}-frame-${i}.png`;
        const dataUrl = c.canvas.toDataURL('image/png');
        c.canvas.toBlob((blob) => {
          childPayload.push({
            name, dataUrl, blob,
            w: c.canvas.width, h: c.canvas.height,
            bounds: c.bounds,
            frameIndex: c.frameIndex !== undefined ? c.frameIndex : i
          });
          pendingBlobs--;
          if (pendingBlobs === 0) buildStripAndFinish();
        }, 'image/png');
      });
    }

    function downloadSliceZip(prebuilt, baseName) {
      const base = baseName || (opts.assetName || opts.sourceName || 'sprite').replace(/\.[a-z0-9]+$/i, '');
      const children = prebuilt || (sliceChildren ? sliceChildren.map((c, i) => ({
        name: `${base}-frame-${i}.png`,
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
        // Draw dark overlay. Then punch out crop area and redraw image there so
        // image pixels are not erased by clearRect.
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(0, 0, cv.width / dpr, cv.height / dpr);
        ctx.clearRect(cx, cy, cw, ch);
        // Redraw image inside the crop window so pixels are visible.
        ctx.save();
        ctx.beginPath();
        ctx.rect(cx, cy, cw, ch);
        ctx.clip();
        const fs2 = buildFilterString(edits.filter);
        if (fs2) ctx.filter = fs2;
        const previewCv2 = bakedSource();
        ctx.drawImage(previewCv2, 0, 0, previewCv2.width, previewCv2.height,
                      dx + (edits.crop ? edits.crop.x * zoom : 0),
                      dy + (edits.crop ? edits.crop.y * zoom : 0),
                      previewCv2.width * zoom, previewCv2.height * zoom);
        ctx.restore();
        ctx.strokeStyle = '#ffb347';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(cx + 0.5, cy + 0.5, cw, ch);
        ctx.setLineDash([]);
        const handles = handlePositions(cx, cy, cw, ch);
        ctx.fillStyle = '#ffb347';
        for (const h of handles) ctx.fillRect(h.x - 4, h.y - 4, 8, 8);
      }

      // M2 — selection marquee
      if (selection) {
        ctx.save();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        if (selection.type === 'rect') {
          ctx.strokeRect(dx + selection.x * zoom + 0.5, dy + selection.y * zoom + 0.5,
            selection.w * zoom, selection.h * zoom);
        } else if (selection.type === 'lasso') {
          ctx.beginPath();
          for (let i = 0; i < selection.points.length; i++) {
            const [x, y] = selection.points[i];
            const sx = dx + x * zoom, sy = dy + y * zoom;
            if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
          }
          ctx.closePath(); ctx.stroke();
        }
        ctx.restore();
      }
      if (lassoPts && lassoPts.length > 1) {
        ctx.save();
        ctx.strokeStyle = '#ffd966'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath();
        for (let i = 0; i < lassoPts.length; i++) {
          const [x, y] = lassoPts[i];
          const sx = dx + x * zoom, sy = dy + y * zoom;
          if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
        }
        ctx.stroke(); ctx.restore();
      }
      // Shape preview while dragging
      if (shapeStart && shapeEnd && dragging && dragging.indexOf('shape-') === 0) {
        const sk = dragging.slice(6);
        const sx = dx + shapeStart.x * zoom, sy = dy + shapeStart.y * zoom;
        const ex = dx + shapeEnd.x * zoom, ey = dy + shapeEnd.y * zoom;
        ctx.save();
        ctx.strokeStyle = rgbToHex(activeColor); ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = Math.max(1, strokeWidth * zoom);
        if (sk === 'line') { ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke(); }
        else if (sk === 'rect') {
          if (shapeFilled) ctx.fillRect(Math.min(sx,ex), Math.min(sy,ey), Math.abs(ex-sx), Math.abs(ey-sy));
          else ctx.strokeRect(Math.min(sx,ex), Math.min(sy,ey), Math.abs(ex-sx), Math.abs(ey-sy));
        } else if (sk === 'circle') {
          const r = Math.hypot(ex-sx, ey-sy);
          ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
          if (shapeFilled) ctx.fill(); else ctx.stroke();
        } else if (sk === 'gradient') {
          ctx.setLineDash([4, 3]); ctx.strokeStyle = '#34c759';
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
        }
        ctx.restore();
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
      if (sliceMode === 'anim' && animCells.length > 0) {
        ctx.font = 'bold 11px Fredoka, sans-serif';
        ctx.textBaseline = 'top';
        animCells.forEach((cell, i) => {
          const isSelected = i === animSelectedCell;
          ctx.strokeStyle = isSelected ? '#00ddff' : 'rgba(255,179,71,0.85)';
          ctx.lineWidth = isSelected ? 2.5 : 1;
          ctx.setLineDash(isSelected ? [] : [4, 3]);
          ctx.strokeRect(dx + cell.x * zoom + 0.5, dy + cell.y * zoom + 0.5, cell.w * zoom, cell.h * zoom);
          ctx.setLineDash([]);
          ctx.fillStyle = isSelected ? '#00ddff' : '#ffb347';
          ctx.fillText(String(i + 1), dx + cell.x * zoom + 4, dy + cell.y * zoom + 2);
          if (isSelected) {
            const hx = dx + (cell.x + cell.w) * zoom - 5;
            const hy = dy + (cell.y + cell.h) * zoom - 5;
            ctx.fillStyle = '#00ddff';
            ctx.fillRect(hx, hy, 10, 10);
          }
        });
      } else if (sliceMode === 'grid') {
        const cols = Math.max(1, sliceParams.cols), rows = Math.max(1, sliceParams.rows);
        const padX = Math.max(0, sliceParams.paddingX | 0);
        const padY = Math.max(0, sliceParams.paddingY | 0);
        const offX = Math.max(0, sliceParams.frameOffsetX | 0);
        const offY = Math.max(0, sliceParams.frameOffsetY | 0);
        const cw = padX > 0
          ? (iw - 2 * offX - (cols - 1) * padX) / cols
          : (iw - 2 * offX) / cols;
        const ch = padY > 0
          ? (ih - 2 * offY - (rows - 1) * padY) / rows
          : (ih - 2 * offY) / rows;

        // Draw frame cells (orange dashed)
        ctx.strokeStyle = 'rgba(255,179,71,0.85)';
        ctx.setLineDash([4, 3]);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const fx = (offX + c * (cw + padX)) * zoom;
            const fy = (offY + r * (ch + padY)) * zoom;
            ctx.strokeRect(dx + fx + 0.5, dy + fy + 0.5, cw * zoom, ch * zoom);
          }
        }

        // Draw padding gaps (cyan fill) when padding is set
        if (padX > 0 || padY > 0) {
          ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(0,220,255,0.18)';
          if (padX > 0) {
            for (let c = 0; c < cols - 1; c++) {
              const gx = (offX + (c + 1) * cw + c * padX) * zoom;
              ctx.fillRect(dx + gx, dy + offY * zoom, padX * zoom, (ih - 2 * offY) * zoom);
            }
          }
          if (padY > 0) {
            for (let r = 0; r < rows - 1; r++) {
              const gy = (offY + (r + 1) * ch + r * padY) * zoom;
              ctx.fillRect(dx + offX * zoom, dy + gy, (iw - 2 * offX) * zoom, padY * zoom);
            }
          }
        }

        ctx.setLineDash([]);
        ctx.fillStyle = '#ffb347';
        ctx.font = 'bold 11px Fredoka, sans-serif';
        ctx.textBaseline = 'top';
        let n = 1;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const fx = (offX + c * (cw + padX)) * zoom;
            const fy = (offY + r * (ch + padY)) * zoom;
            ctx.fillText(String(n++), dx + fx + 4, dy + fy + 2);
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
          const hex = rgbToHex(activeColor); if (ui.palColor) ui.palColor.value = hex;
          pushColorHistory(hex);
          renderToolPanel();
        } catch (_) {}
        return;
      }
      // M2/M3 — selection tools
      if (activeTool === 'rectsel') {
        dragging = 'rectsel';
        cropDragOrig = { ix: ipt.x, iy: ipt.y };
        selection = { type: 'rect', x: ipt.x, y: ipt.y, w: 1, h: 1 };
        return;
      }
      if (activeTool === 'lasso') {
        dragging = 'lasso';
        lassoPts = [[ipt.x, ipt.y]];
        return;
      }
      // Brush — paint stamp ops
      if (activeTool === 'brush') {
        const local = imgPointToCroppedSpace(ipt); if (!local) return;
        edits.pixelOps.push({ type: 'paint', layer: activeLayerId, x: local.x, y: local.y, radius: strokeWidth, color: activeColor.slice() });
        dragging = 'brush'; cropDragOrig = {};
        render(); fire();
        return;
      }
      // Shape tools — defer commit until pointerup
      if (activeTool === 'line' || activeTool === 'rect' || activeTool === 'circle' || activeTool === 'gradient') {
        dragging = 'shape-' + activeTool;
        shapeStart = { x: ipt.x, y: ipt.y };
        shapeEnd = { x: ipt.x, y: ipt.y };
        return;
      }

      // Per-cell anim: click canvas to select cell
      if (activeTool === 'slice' && sliceMode === 'anim') {
        let hit = -1;
        for (let i = 0; i < animCells.length; i++) {
          const c = animCells[i];
          if (ipt.x >= c.x && ipt.x <= c.x + c.w && ipt.y >= c.y && ipt.y <= c.y + c.h) {
            hit = i; break;
          }
        }
        if (hit !== animSelectedCell) {
          animSelectedCell = hit;
          renderAnimCellList();
          updateSelectedCellInputs();
          render();
        }
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
        edits.pixelOps.push({ type: 'erase', layer: activeLayerId, x: local.x, y: local.y, radius: brushRadius });
        render(); fire();
        return;
      }
      if (dragging === 'brush') {
        const local = imgPointToCroppedSpace(ipt); if (!local) return;
        edits.pixelOps.push({ type: 'paint', layer: activeLayerId, x: local.x, y: local.y, radius: strokeWidth, color: activeColor.slice() });
        render(); fire();
        return;
      }
      if (dragging === 'rectsel') {
        const x = Math.min(cropDragOrig.ix, ipt.x), y = Math.min(cropDragOrig.iy, ipt.y);
        const w = Math.abs(ipt.x - cropDragOrig.ix), h = Math.abs(ipt.y - cropDragOrig.iy);
        selection = { type: 'rect', x: Math.round(x), y: Math.round(y), w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
        render(); return;
      }
      if (dragging === 'lasso') {
        lassoPts.push([ipt.x, ipt.y]);
        render(); return;
      }
      if (dragging && dragging.indexOf('shape-') === 0) {
        shapeEnd = { x: ipt.x, y: ipt.y };
        render(); return;
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
      const wasCropOrErase = (dragging === 'erase' || dragging === 'brush' || dragging.startsWith('crop-'));
      const wasLasso = dragging === 'lasso';
      const wasRectSel = dragging === 'rectsel';
      const wasShape = dragging && dragging.indexOf('shape-') === 0;
      const shapeKind = wasShape ? dragging.slice(6) : null;

      dragging = null;
      cropDragOrig = null;

      if (wasLasso && lassoPts && lassoPts.length > 2) {
        selection = { type: 'lasso', points: lassoPts };
      }
      lassoPts = null;

      if (wasShape && shapeStart && shapeEnd) {
        const cr = edits.crop || { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
        const sx = shapeStart.x - cr.x, sy = shapeStart.y - cr.y;
        const ex = shapeEnd.x - cr.x, ey = shapeEnd.y - cr.y;
        if (shapeKind === 'line') {
          edits.pixelOps.push({ type: 'line', layer: activeLayerId, x1: sx, y1: sy, x2: ex, y2: ey, width: strokeWidth, color: activeColor.slice() });
        } else if (shapeKind === 'rect') {
          edits.pixelOps.push({ type: 'rect', layer: activeLayerId, x: Math.min(sx,ex), y: Math.min(sy,ey), w: Math.abs(ex-sx), h: Math.abs(ey-sy), filled: shapeFilled, width: strokeWidth, color: activeColor.slice() });
        } else if (shapeKind === 'circle') {
          edits.pixelOps.push({ type: 'circle', layer: activeLayerId, cx: sx, cy: sy, r: Math.hypot(ex-sx, ey-sy), filled: shapeFilled, width: strokeWidth, color: activeColor.slice() });
        } else if (shapeKind === 'gradient') {
          edits.pixelOps.push({ type: 'gradient', layer: activeLayerId, gtype: ui.gradType.value || 'linear', x1: sx, y1: sy, x2: ex, y2: ey, colorA: ui.gradA.value, colorB: ui.gradB.value });
        }
        commit();
        shapeStart = null; shapeEnd = null;
        return;
      }
      if (wasCropOrErase || wasRectSel) commit();
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
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA')) return;
      if (!container.contains(ae) && ae !== document.body) return;
      const cmd = ev.metaKey || ev.ctrlKey;
      if (cmd && ev.key.toLowerCase() === 'z') { ev.preventDefault(); if (ev.shiftKey) redoOp(); else undoOp(); return; }
      if (cmd && ev.key.toLowerCase() === 'y') { ev.preventDefault(); redoOp(); return; }
      if (cmd && ev.key.toLowerCase() === 'c') { ev.preventDefault(); copySelection(); return; }
      if (cmd && ev.key.toLowerCase() === 'v') { ev.preventDefault(); pasteClipboard(); return; }
      if (cmd && ev.key.toLowerCase() === 'x') { ev.preventDefault(); cutSelection(); return; }
      if (ev.key === 'Escape') { selection = null; lassoPts = null; render(); return; }
      if (ev.key === 'Delete' || ev.key === 'Backspace') { if (selection) { ev.preventDefault(); deleteSelection(); return; } }
      if (cmd) return;
      const map = { c: 'crop', m: 'rectsel', l: 'lasso', i: 'eyedrop', b: 'brush', e: 'erase', g: 'fill', w: 'bgRemove', u: 'line', r: 'rect', o: 'circle', d: 'gradient', s: 'slice' };
      const tool = map[ev.key.toLowerCase()];
      if (tool) { setActiveTool(tool); ev.preventDefault(); }
    }

    // ---- M2/M3 helpers ---------------------------------------------------
    function buildSwatches() {
      ui.palSwatches.innerHTML = PALETTE_DEFAULT.map(c =>
        `<div class="gpc-ie-swatch" data-color="${c}" style="background:${c}"></div>`).join('');
    }
    function pushColorHistory(c) {
      if (colorHistory[0] === c) return;
      colorHistory.unshift(c);
      while (colorHistory.length > 8) colorHistory.pop();
      ui.palHistory.innerHTML = colorHistory.map(col =>
        `<div class="gpc-ie-swatch" data-color="${col}" style="background:${col}"></div>`).join('');
    }
    function renderLayerList() {
      ui.layerList.innerHTML = layers.slice().reverse().map(l => `
        <div class="gpc-ie-layer ${l.id === activeLayerId ? 'active' : ''}" data-layer-id="${l.id}">
          <input type="checkbox" data-layer-vis ${l.visible ? 'checked' : ''}>
          <span class="gpc-ie-layer-name">${l.name}</span>
          <input type="range" data-layer-op min="0" max="1" step="0.05" value="${l.opacity}" title="Opacity">
        </div>`).join('');
      ui.layerList.querySelectorAll('.gpc-ie-layer').forEach(row => {
        const id = row.dataset.layerId;
        row.addEventListener('click', (ev) => {
          if (ev.target.matches('input')) return;
          activeLayerId = id; renderLayerList();
        });
        row.querySelector('[data-layer-vis]').addEventListener('change', (ev) => {
          const l = layers.find(x => x.id === id); if (l) { l.visible = ev.target.checked; render(); }
        });
        row.querySelector('[data-layer-op]').addEventListener('input', (ev) => {
          const l = layers.find(x => x.id === id); if (l) { l.opacity = +ev.target.value; render(); }
        });
      });
    }

    // Build a per-pixel selection mask in cropped-space coords. Returns canvas (or null = no selection / full).
    function buildSelectionMask() {
      if (!selection) return null;
      const cr = edits.crop || { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
      const mask = document.createElement('canvas'); mask.width = cr.w; mask.height = cr.h;
      const mc = mask.getContext('2d');
      mc.fillStyle = '#fff';
      if (selection.type === 'rect') {
        mc.fillRect(selection.x - cr.x, selection.y - cr.y, selection.w, selection.h);
      } else {
        mc.beginPath();
        for (let i = 0; i < selection.points.length; i++) {
          const [x, y] = selection.points[i];
          if (i === 0) mc.moveTo(x - cr.x, y - cr.y); else mc.lineTo(x - cr.x, y - cr.y);
        }
        mc.closePath(); mc.fill();
      }
      return mask;
    }

    function copySelection() {
      if (!selection) { flashInfo('No selection'); return; }
      const baked = bakedSource();
      // Find bbox
      let bbox;
      const cr = edits.crop || { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
      if (selection.type === 'rect') {
        bbox = { x: selection.x - cr.x, y: selection.y - cr.y, w: selection.w, h: selection.h };
      } else {
        const xs = selection.points.map(p => p[0] - cr.x), ys = selection.points.map(p => p[1] - cr.y);
        bbox = { x: Math.floor(Math.min(...xs)), y: Math.floor(Math.min(...ys)),
                 w: Math.ceil(Math.max(...xs) - Math.min(...xs)),
                 h: Math.ceil(Math.max(...ys) - Math.min(...ys)) };
      }
      bbox.x = Math.max(0, bbox.x); bbox.y = Math.max(0, bbox.y);
      bbox.w = Math.min(baked.width - bbox.x, Math.max(1, bbox.w));
      bbox.h = Math.min(baked.height - bbox.y, Math.max(1, bbox.h));
      const out = document.createElement('canvas'); out.width = bbox.w; out.height = bbox.h;
      const oc = out.getContext('2d');
      if (selection.type === 'lasso') {
        oc.save(); oc.beginPath();
        for (let i = 0; i < selection.points.length; i++) {
          const [x, y] = selection.points[i];
          if (i === 0) oc.moveTo(x - cr.x - bbox.x, y - cr.y - bbox.y); else oc.lineTo(x - cr.x - bbox.x, y - cr.y - bbox.y);
        }
        oc.closePath(); oc.clip();
      }
      oc.drawImage(baked, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, bbox.w, bbox.h);
      if (selection.type === 'lasso') oc.restore();
      clipboard = { dataUrl: out.toDataURL('image/png'), w: bbox.w, h: bbox.h, srcX: bbox.x, srcY: bbox.y };
      flashInfo('Copied ' + bbox.w + '×' + bbox.h);
    }
    function pasteClipboard() {
      if (!clipboard) { flashInfo('Clipboard empty'); return; }
      // Stamp paste op at original position
      edits.pixelOps.push({
        type: 'paste',
        layer: activeLayerId,
        dataUrl: clipboard.dataUrl,
        x: clipboard.srcX, y: clipboard.srcY, w: clipboard.w, h: clipboard.h
      });
      commit();
      flashInfo('Pasted');
    }
    function cutSelection() {
      if (!selection) { flashInfo('No selection'); return; }
      copySelection();
      deleteSelection();
    }
    function deleteSelection() {
      if (!selection) { flashInfo('No selection'); return; }
      const cr = edits.crop || { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
      const polyPts = selection.type === 'lasso'
        ? selection.points.map(([x, y]) => [x - cr.x, y - cr.y])
        : null;
      edits.pixelOps.push({
        type: 'eraseRegion',
        layer: activeLayerId,
        shape: selection.type,
        x: selection.type === 'rect' ? selection.x - cr.x : 0,
        y: selection.type === 'rect' ? selection.y - cr.y : 0,
        w: selection.type === 'rect' ? selection.w : 0,
        h: selection.type === 'rect' ? selection.h : 0,
        points: polyPts
      });
      selection = null;
      commit();
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

  // Preserve any properties already attached (e.g. mountVideoToStrip if its
  // script loaded first) by merging onto an existing namespace.
  const existing = root.ImageEditor || {};
  root.ImageEditor = Object.assign(existing, {
    version: '0.4.0',
    mount,
    applyEditsToCanvas,
    compactEdits,
    normalizeEdits,
    sliceImage,
    trimAlpha,
    findConnectedRegions
  });
})(typeof window !== 'undefined' ? window : this);
