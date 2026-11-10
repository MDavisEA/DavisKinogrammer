# Sprint Cropper

A free web tool for sprint coaches. Open a video of an athlete, step through it frame by frame, and pull out the athlete at each phase of the stride. The crops go into a labelled 2 × 5 grid (a kinogram) that you can download as a JPEG.

**Your video never leaves your computer.** There is no server, no upload, no account and no analytics. Everything, including the pose detection, runs in your browser, and nothing is saved when you close the page.

Project site: https://sites.google.com/view/sprintcropping/home

## How to use it

1. **Open a video:** drag it onto the page or click **Upload video** (nothing is actually uploaded).
2. **Find the frame** with the scrubber, the step buttons or the keyboard.
3. **Pick the athlete.** The app outlines everyone it detects and chooses for you, using the largest person at first and then the one nearest where the athlete should be based on your earlier crops. Click a different box to switch, or drag your own box if detection misses them.
4. **Add to board** (<kbd>Enter</kbd>). Each crop is placed in the highlighted slot. Click any slot to choose where the next crop goes, and click × on a filled slot to remove it.
5. **Name the phases** by editing the column headers, and add an optional title.
6. **Download grid** saves a JPEG of the whole board.

| Key | Action |
| --- | --- |
| <kbd>←</kbd> / <kbd>→</kbd> | Back / forward 1 frame |
| <kbd>Shift</kbd> + <kbd>←</kbd> / <kbd>→</kbd> | Back / forward 10 frames |
| <kbd>↓</kbd> / <kbd>↑</kbd> | Back / forward 60 frames |
| <kbd>Enter</kbd> | Add selected athlete to board |
| <kbd>N</kbd> | Cycle to next detected person |
| <kbd>Backspace</kbd> | Remove the selected (or last) frame |

## If a video won't open

The browser has to be able to decode the file. iPhone videos use HEVC (H.265), and Chrome decodes that with your computer's graphics hardware.

1. In Chrome, open `chrome://settings/system`, turn on **Use graphics acceleration when available**, and relaunch. At `chrome://gpu`, *Video Decode* should say *Hardware accelerated*.
2. Try Safari, which opens iPhone video with no setup.
3. Convert the video to H.264 MP4 with a free tool such as HandBrake.
4. On iPhone, Settings › Camera › Formats › Most Compatible records H.264.

## Running it yourself

It is a static site in [`site/`](site/). Serve that folder with any web server:

```bash
cd site
python3 -m http.server 8000
```

Then open http://localhost:8000. Opening `index.html` directly from disk won't work, because browsers block the detector worker on `file://` pages.

Pushing to `main` publishes `site/` to GitHub Pages through [`.github/workflows/pages.yml`](.github/workflows/pages.yml). In the repository, go to **Settings › Pages** and set **Source** to **GitHub Actions** once.

## How it works

- `site/app.js`: frame stepping, athlete selection, cropping, the board and grid export.
- `site/mp4times.js`: reads every frame's real timestamp from the file's index so stepping is exact.
- `site/detector.worker.js`: runs the YOLOv8s-pose model in a web worker with [ONNX Runtime Web](https://onnxruntime.ai/) (files in `site/vendor/`).
- `site/models/yolov8s-pose.onnx`: the pose model, exported from Ultralytics YOLOv8s-pose.

The original Python versions (a Flask server app and the first Tkinter desktop app) are kept in [`legacy/`](legacy/).

## License

AGPL-3.0, see [LICENSE](LICENSE). The pose model comes from [Ultralytics YOLOv8](https://github.com/ultralytics/ultralytics), which is AGPL-3.0, and ONNX Runtime Web is MIT-licensed.
