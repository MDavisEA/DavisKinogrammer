# Sprint Cropper

A web app for sprint coaches. Upload a video of an athlete, step through it frame by frame, and pull out the athlete at each phase of the stride. The crops go into a labelled 2 × 5 grid that you can download as a JPEG.

Project site: https://sites.google.com/view/sprintcropping/home

## How it works

1. **Upload** a video: drag it onto the page or click **Upload video**. MP4, MOV, AVI, MKV and WebM are accepted.
2. **Find the frame** with the scrubber, the step buttons or the keyboard.
3. **Pick the athlete.** A YOLOv8-pose model finds everyone in the frame. The app chooses the athlete for you, either the largest person or the one nearest where the athlete is predicted to be from your earlier crops. Click a different box to switch, or drag a box yourself if detection misses them.
4. **Add to board** (<kbd>Enter</kbd>). Each crop is padded to the same 4:5 tile and placed in the highlighted slot. Click any slot to choose where the next crop goes. Hover over a filled slot and click × to remove it.
5. **Name the phases** by editing the column headers. You can also add an optional title.
6. **Download grid** saves a JPEG of the whole board.

| Key | Action |
| --- | --- |
| <kbd>←</kbd> / <kbd>→</kbd> | Back / forward 1 frame |
| <kbd>Shift</kbd> + <kbd>←</kbd> / <kbd>→</kbd> | Back / forward 10 frames |
| <kbd>↓</kbd> / <kbd>↑</kbd> | Back / forward 60 frames |
| <kbd>Enter</kbd> | Add selected athlete to board |
| <kbd>N</kbd> | Cycle to next detected person |
| <kbd>Backspace</kbd> | Remove the selected (or last) frame |

## Running locally

Requires Python 3.10+.

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
python app.py
```

Then open http://localhost:5000.

## Deploying

The repo includes a `Dockerfile`, so any host that runs containers will work (Render, Railway, Fly.io, Google Cloud Run, Hugging Face Spaces, …):

```bash
docker build -t sprint-cropper .
docker run -p 8000:8000 sprint-cropper
```

### Hosting on Render

1. **Push the repo to GitHub.** Render deploys from your GitHub repo.
2. In the [Render dashboard](https://dashboard.render.com), click **New → Web Service** and pick this repo. Grant Render access to it if asked.
3. Configure the service:
   - **Language / Runtime:** Docker (detected from the `Dockerfile`)
   - **Branch:** `main`
   - **Instance type:** choose one with **at least 2 GB of RAM** (Standard or larger). Free and Starter instances don't have enough memory, so the server crashes the first time it runs detection.
   - **Advanced → Health Check Path:** `/`
   - **Advanced → Environment variables:** optional (see the table below). Don't set `PORT`. Render sets it, and the start command reads it.
4. Click **Create Web Service**. The first build takes roughly 5–10 minutes because it installs PyTorch. When it finishes, the app is at `https://<service-name>.onrender.com`.
5. *(Optional)* Add a custom domain under **Settings → Custom Domains**, then create the CNAME record Render shows you at your domain registrar. Render issues the HTTPS certificate automatically.

Every push to `main` redeploys automatically. You can turn this off under **Settings → Auto-Deploy**.

**Troubleshooting**

- **Build fails:** read the build log in the **Events** tab. **Manual Deploy → Clear build cache & deploy** fixes most problems caused by a dependency install timing out.
- **Page loads but detection fails:** check the **Logs** tab. `Killed` or `Out of memory` means the instance needs more RAM.
- **First detection is slow:** this is expected. The model loads on first use, which takes about 5 seconds, and later detections are fast.
- **Large uploads fail:** trim or compress the clip. 4K/60 fps phone footage can be several hundred MB, and the default limit is 500 MB.

### Notes for any host

- **Memory:** plan for at least 2 GB of RAM. PyTorch and the YOLOv8m model take about 1 GB.
- **Single instance:** the app runs one gunicorn worker. Uploaded videos are stored on that instance's local disk, so don't scale it to multiple instances without adding shared storage.
- **Uploads** go to the system temp folder and are deleted after 6 hours. On hosts with temporary disks, including Render, they're also wiped when the server restarts or redeploys. Grids people have already downloaded aren't affected.

Settings are read from environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5000` (`8000` in Docker) | Port to listen on |
| `MAX_UPLOAD_MB` | `500` | Largest video accepted |
| `UPLOAD_TTL_HOURS` | `6` | How long uploads are kept |
| `UPLOAD_DIR` | system temp | Where uploads are stored |
| `MAX_FRAME_EDGE` | `1280` | Frames are downscaled so their longest side is at most this many pixels |
| `DETECT_CONF` | `0.3` | Minimum detection confidence |

## Project layout

```
app.py              Flask backend: upload, frame decoding, pose detection
static/index.html   Page markup
static/app.js       Frame navigation, athlete selection, cropping, board, grid export
static/style.css    Styles (follows the system light/dark setting)
yolov8m-pose.pt     YOLOv8 pose model weights (used by both versions)
desktop/            Original Tkinter desktop app (legacy)
```

The legacy desktop app can still be run with `python desktop/main.py` (dependencies in `desktop/packages.txt`).
