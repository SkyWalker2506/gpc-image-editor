# gpc-image-editor

A small, project-agnostic, non-destructive in-browser mini photoshop for game
sprite metadata. Built originally for **Golf: Paper Craft** but has zero
golf/game-specific dependencies — drop it into any browser game that wants to
let users crop / resize / rotate / flip / colour-adjust sprites without
modifying the original PNG files.

## What it does

- Source canvas with checker transparency, mouse-wheel zoom, drag pan.
- Crop tool: drag a bbox; aspect-lock dropdown (Free / 1:1 / 16:9 / 4:3 / 2:1 / 3:2).
- Resize: width + height inputs with aspect-lock; Fit-to-crop button.
- Rotate: 90° increments + free slider (-180…180°).
- Flip horizontal / vertical.
- Adjustment sliders: brightness, contrast, saturation, hue rotate (CSS-filter
  based, baked into the output canvas at apply time).
- Undo / redo (Ctrl/Cmd-Z, Ctrl/Cmd-Shift-Z).
- Apply / Cancel buttons fire user-supplied callbacks with the edits payload.

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

## Standalone demo

Open `examples/standalone.html` in a static server.

## License

MIT.
