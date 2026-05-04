/* gpc-image-editor — non-destructive in-browser mini photoshop for game sprites.
 *
 * Public API:
 *   window.ImageEditor.mount({
 *     container: HTMLElement,        // panel root that will host the editor
 *     stage:     HTMLElement,        // optional separate canvas host (else container)
 *     src:       string,             // image src/dataURL to edit
 *     edits:     ImageEdits | null,  // initial edits (crop/resize/rotate/flip/filter)
 *     onChange:  (edits) => void,    // fired on any edit (live)
 *     onApply:   (edits) => void,    // fired when user clicks Apply
 *     onCancel:  () => void          // fired when user clicks Cancel
 *   }) => { destroy, getEdits, setSrc, setEdits, render }
 *
 *   window.ImageEditor.applyEditsToCanvas(img, edits) => HTMLCanvasElement
 *     Pure helper. Bakes crop/resize/rotate/flip/filter onto an offscreen canvas.
 *     Game runtimes use this to render edited sprites without touching the source PNG.
 *
 * ImageEdits shape (all optional, all numeric):
 *   {
 *     crop:   { x, y, w, h }   // pixels, source-image space; falsy → full image
 *     resize: { w, h }         // output pixels post-crop; falsy → use crop dims
 *     rotate: number           // degrees, free
 *     flip:   { h, v }         // booleans
 *     filter: { brightness, contrast, saturate, hue }  // CSS filter values
 *   }
 *
 * Project-agnostic: no game-specific paths or storage. Host wires onApply →
 * its own metadata store and reads applyEditsToCanvas() at render time.
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
    cx.drawImage(img,
      crop.x, crop.y, crop.w, crop.h,
      -resize.w / 2, -resize.h / 2, resize.w, resize.h);

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
  function clamp01(v) { return clampN(v, 0, 1); }

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
    let dragging = null;        // 'pan' | 'crop-new' | 'crop-move' | 'crop-N/S/E/W/NE/...'
    let cropDragOrig = null;
    const undo = [];
    const redo = [];
    let undoLockedSnapshot = null;

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
    }

    function setEdits(next) {
      edits = normalizeEdits(next || {});
      pushUndo();
      syncControls();
      render();
    }

    function getEdits() { return cloneEdits(edits); }

    function destroy() {
      container.innerHTML = '';
      container.classList.remove('gpc-ie-root');
    }

    // ------------ UI ---------------
    function buildUI(root) {
      const html = `
        <div class="gpc-ie-toolbar">
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
        cancel: $('[data-ie="cancel"]'), apply: $('[data-ie="apply"]')
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

      // Resize fields
      ui.rw.addEventListener('input', () => onResize('w'));
      ui.rh.addEventListener('input', () => onResize('h'));

      // Rotate slider/number
      ui.rot.addEventListener('input', () => { edits.rotate = +ui.rot.value; ui.rotNum.value = ui.rot.value; render(); fire(); });
      ui.rot.addEventListener('change', commit);
      ui.rotNum.addEventListener('input', () => { edits.rotate = +ui.rotNum.value; ui.rot.value = ui.rotNum.value; render(); fire(); });
      ui.rotNum.addEventListener('change', commit);

      // Filters
      const filterFields = [['fBri','brightness'], ['fCon','contrast'], ['fSat','saturate'], ['fHue','hue']];
      filterFields.forEach(([k, prop]) => {
        ui[k].addEventListener('input', () => { edits.filter[prop] = +ui[k].value; render(); fire(); });
        ui[k].addEventListener('change', commit);
      });

      // Canvas mouse: crop drag & pan & zoom
      ui.canvas.addEventListener('wheel', onWheel, { passive: false });
      ui.canvas.addEventListener('pointerdown', onPointerDown);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('keydown', onKey);

      // Resize observer for canvas backing buffer
      const ro = new ResizeObserver(() => { fitCanvasBuffer(); render(); });
      ro.observe(ui.canvas);

      syncControls();
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
      // Initial crop = full image
      if (!edits.crop) edits.crop = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
      syncControls();
    }

    function render() {
      const cv = ui.canvas;
      const ctx = cv.getContext('2d');
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);

      // Checker bg
      drawChecker(ctx, cv.width / dpr, cv.height / dpr);

      if (!imgReady) {
        ctx.fillStyle = '#9099ad';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Loading…', (cv.width / dpr) / 2, (cv.height / dpr) / 2);
        return;
      }

      const iw = img.naturalWidth, ih = img.naturalHeight;
      const dx = pan.x - (iw * zoom) / 2;
      const dy = pan.y - (ih * zoom) / 2;

      // Draw the source image (with filter for live preview)
      ctx.save();
      const fs = buildFilterString(edits.filter);
      if (fs) ctx.filter = fs;
      ctx.drawImage(img, dx, dy, iw * zoom, ih * zoom);
      ctx.restore();

      // Crop overlay
      if (edits.crop) {
        const cr = edits.crop;
        const cx = dx + cr.x * zoom;
        const cy = dy + cr.y * zoom;
        const cw = cr.w * zoom;
        const ch = cr.h * zoom;
        // dim outside
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(0, 0, cv.width / dpr, cv.height / dpr);
        ctx.clearRect(cx, cy, cw, ch);
        // outline
        ctx.strokeStyle = '#ffb347';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(cx + 0.5, cy + 0.5, cw, ch);
        ctx.setLineDash([]);
        // handles
        const handles = handlePositions(cx, cy, cw, ch);
        ctx.fillStyle = '#ffb347';
        for (const h of handles) ctx.fillRect(h.x - 4, h.y - 4, 8, 8);
      }

      ui.info.textContent = imgReady
        ? `${img.naturalWidth}×${img.naturalHeight}  •  zoom ${(zoom * 100).toFixed(0)}%`
        : '';
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
      // Hit-test crop handles?
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
            ui.canvas.setPointerCapture(ev.pointerId);
            return;
          }
        }
        // Inside crop → move
        if (ipt.x >= cr.x && ipt.x <= cr.x + cr.w && ipt.y >= cr.y && ipt.y <= cr.y + cr.h) {
          dragging = 'crop-move';
          cropDragOrig = { ...cr, ix: ipt.x, iy: ipt.y };
          ui.canvas.setPointerCapture(ev.pointerId);
          return;
        }
      }
      // Space-pan or middle-button
      if (ev.spaceKey || ev.button === 1 || ev.shiftKey) {
        dragging = 'pan';
        cropDragOrig = { px: pan.x, py: pan.y, sx: p.x, sy: p.y };
        return;
      }
      // Otherwise: new crop
      dragging = 'crop-new';
      cropDragOrig = { ix: ipt.x, iy: ipt.y };
    }

    function onPointerMove(ev) {
      if (!dragging) return;
      const p = localXY(ev);
      const ipt = screenToImg(p.x, p.y);
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
      const wasCrop = dragging.startsWith('crop-');
      dragging = null;
      cropDragOrig = null;
      if (wasCrop) commit();
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
      } else if (ev.key === ' ') {
        ev.spaceKey = true;
      }
    }

    // ---- Undo / change firing ------------------------------------------
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
      applyEdits: () => applyEditsToCanvas(img, edits)
    };
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
      }
    };
  }

  function cloneEdits(e) { return JSON.parse(JSON.stringify(e)); }

  // Strip defaults so the persisted blob stays compact (and falsy → "no edits").
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
    return Object.keys(out).length ? out : null;
  }

  root.ImageEditor = {
    mount,
    applyEditsToCanvas,
    compactEdits,
    normalizeEdits
  };
})(typeof window !== 'undefined' ? window : this);
