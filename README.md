# gpc-image-editor

A small, project-agnostic, non-destructive in-browser mini photoshop for game
sprite metadata. Built originally for **Golf: Paper Craft** but has zero
golf/game-specific dependencies — drop it into any browser game that wants to
let users crop / resize / rotate / flip / colour-adjust sprites without
modifying the original PNG files.

## What it does

- Source canvas with checker transparency, mouse-wheel zoom, drag pan.
- **Tool palette** in the top-left toolbar — switch between:
  - **Crop** (default): drag a bbox; aspect-lock dropdown (Free / 1:1 / 16:9 / 4:3 / 2:1 / 3:2).
  - **BG remove (magic wand)**: click a background pixel → flood-fill matching pixels to alpha 0 (tolerance slider).
  - **Eyedropper**: click a pixel to read RGBA into the active colour.
  - **Eraser**: brush mode (radius slider, drag to paint pixels to alpha 0).
  - **Fill bucket**: flood-fill area with active colour (tolerance slider).
  - **Slice**: split a sprite-sheet into N children (Grid / Anim strip / Auto-detect).
- Resize, Rotate (90 deg + free slider), Flip horizontal / vertical.
- Adjustment sliders: brightness, contrast, saturation, hue rotate (CSS-filter
  based, baked into the output canvas at apply time).
- Undo / redo (Ctrl/Cmd-Z, Ctrl/Cmd-Shift-Z).
- Apply / Cancel buttons fire user-supplied callbacks with the edits payload.

## Slice mode

Selecting the **Slice** tool reveals a side panel with three modes:

| Mode | Description |
|------|-------------|
| **Grid** | Specify cols x rows. Live grid overlay with corner numbers. "Auto-fit grid" guesses rows from the trimmed source aspect. "Trim transparent" tightens each cell to its alpha bbox. |
| **Anim** | Same as Grid + animation flag. Outputs `<source>-Nf-<idx>.png`; payload includes `frameCount` + `fps`. "Play" cycles through frames at the chosen FPS. |
| **Auto** | Connected-component analysis (4 or 8-connected). Alpha threshold + min-size cull noise. Each detected region becomes a child asset. |

"Apply slice" calls `onSliceApply(payload)` if the host supplied one, otherwise
the editor falls back to multi-PNG download via `<a download>`.

### Slice payload

```js
{
  mode:    'grid' | 'anim' | 'auto',
  params:  { cols, rows, trim, fps?, alphaThreshold?, connectivity?, minSize? },
  source:  { name, w, h },
  children: [ { name, dataUrl, blob, w, h, bounds:{x,y,w,h}, frameIndex? } ]
}
```

The host project decides where to drop the children (e.g. POST to an upload
endpoint or copy into `assets/sliced/<source>__sliced/<source>-NN.png`).

## Photoshop-lite pixel ops

`bgRemove`, `erase`, `fill`, and `bgRemoveColor` are recorded into
`edits.pixelOps[]` (non-destructive, replayable). The pipeline is
`crop -> pixelOps -> resize -> rotate -> filter`.

The editor stores edits as a small JSON blob (`ImageEdits`). It never writes
to the source PNG. The host application persists this blob alongside its own
asset metadata and applies it at draw time via the bundled
`applyEditsToCanvas(img, edits)` helper.

## Install

```html
<link rel="stylesheet" href="src/image-editor.css">
<script src="src/image-editor.js"></script>
```

## Use

```js
const inst = window.ImageEditor.mount({
  container: document.getElementById('image-editor-host'),
  src:       './assets/my-sprite.png',
  edits:     existingEdits || null,
  onChange:  (edits) => console.log('live preview', edits),
  onApply:   (edits) => persistEdits(edits),
  onCancel:  () => closePanel()
});
```

### Apply edits at runtime

```js
const img = new Image();
img.onload = () => {
  const baked = window.ImageEditor.applyEditsToCanvas(img, edits);
  // baked is an HTMLCanvasElement; pass it to ctx.drawImage(baked, x, y).
};
img.src = './assets/my-sprite.png';
```

### `ImageEdits` shape

```js
{
  crop:   { x, y, w, h }   // pixels in source-image space
  resize: { w, h }         // output px after crop (defaults to crop dims)
  rotate: number           // degrees, -180..180
  flip:   { h, v }         // booleans
  filter: { brightness, contrast, saturate, hue }  // CSS filter values
}
```

All fields are optional. Use `ImageEditor.compactEdits(edits)` to drop fields
left at default values before persisting.

## Video to Animation Strip mode (v0.4.0)

Companion API for converting an MP4/WebM clip into a horizontal sprite-sheet
strip. Pure browser — no ffmpeg, no Wasm.

```html
<link rel="stylesheet" href="src/image-editor.css">
<script src="src/image-editor.js"></script>
<script src="src/video-to-strip.js"></script>
```

```js
const inst = window.ImageEditor.mountVideoToStrip({
  container:  document.getElementById('host'),
  videoSrc:   URL.createObjectURL(file),
  sourceName: 'croc-walk',
  onApply: (out) => {
    // out: { stripBlob, stripDataUrl, frames, fps, width, height,
    //        frameWidth, frameHeight, filename, sourceName }
    saveBlob(out.stripBlob, out.filename);
  },
  onCancel: () => inst.destroy()
});
```

UI: scrub preview, frame count (2..32), frame W/H + fit presets (Native /
256 / 512 / Downscale ½), trim start/end, optional crop bbox, optional
chroma key (color picker + tolerance 0..120, click-to-pick from preview;
green `#00FF00` tol 24, magenta `#FF00FF` tol 12 by default), FPS and
filename preview (`<base>-<N>f.png`).

Pipeline per frame: seek → `drawImage(video, [crop →] frameW × frameH)` →
chroma key → copy into strip canvas → free per-frame canvas. Final strip
canvas is `(frameW × N) × frameH`. Uses `requestVideoFrameCallback` when
available with `seeked` fallback (1.5s safety timeout). Remote videos
must be served with permissive CORS or the canvas will be tainted.

See `examples/video-to-strip.html`.

## Standalone demo

Open `examples/standalone.html` in a static server.

## License

MIT.
