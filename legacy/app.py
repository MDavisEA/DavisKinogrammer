"""Sprint Cropper — web backend.

Endpoints
---------
GET  /                                    single-page app
POST /api/videos                          upload a video (multipart field "video")
GET  /api/videos/<id>/frames/<n>.jpg      one frame as JPEG
GET  /api/videos/<id>/frames/<n>/detect   people detected in that frame (YOLOv8-pose)

Cropping and grid assembly happen in the browser, so the server only has to
decode frames and run the detector.
"""

import os
import re
import tempfile
import threading
import time
import uuid
from collections import OrderedDict

import cv2
from flask import Flask, abort, jsonify, request, send_from_directory, Response

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.environ.get("MODEL_PATH", os.path.join(BASE_DIR, "yolov8m-pose.pt"))
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", os.path.join(tempfile.gettempdir(), "sprint-cropper-uploads"))
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "500"))
UPLOAD_TTL_HOURS = float(os.environ.get("UPLOAD_TTL_HOURS", "6"))
MAX_FRAME_EDGE = int(os.environ.get("MAX_FRAME_EDGE", "1280"))  # long edge of served frames
DETECT_CONF = float(os.environ.get("DETECT_CONF", "0.3"))

ALLOWED_EXT = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}
ID_RE = re.compile(r"^[0-9a-f]{32}$")

os.makedirs(UPLOAD_DIR, exist_ok=True)

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024


# --------------------------------------------------------------------------- #
# Model (loaded once, lazily; ultralytics inference isn't thread-safe)
# --------------------------------------------------------------------------- #
_model = None
_model_lock = threading.Lock()


def detect_people(frame):
    global _model
    with _model_lock:
        if _model is None:
            from ultralytics import YOLO

            _model = YOLO(MODEL_PATH)
        results = _model(frame, conf=DETECT_CONF, verbose=False)

    h, w = frame.shape[:2]
    people = []
    if results:
        for box in results[0].boxes:
            x1, y1, x2, y2 = (float(v) for v in box.xyxy[0].tolist())
            people.append({
                "box": [x1 / w, y1 / h, x2 / w, y2 / h],  # normalised 0..1
                "conf": round(float(box.conf[0]), 3),
            })
    people.sort(key=lambda p: (p["box"][2] - p["box"][0]) * (p["box"][3] - p["box"][1]), reverse=True)
    return people


# --------------------------------------------------------------------------- #
# Video storage / frame decoding
# --------------------------------------------------------------------------- #
class Video:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.cap = cv2.VideoCapture(path)
        if not self.cap.isOpened():
            raise ValueError("unreadable video")
        self.pos = 0  # index of the frame the next read() returns
        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 30.0
        self.frames = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if self.frames <= 0:  # some containers don't report a count
            self.frames = self._count_frames()
        ok, first = self._read(0)
        if not ok:
            raise ValueError("no decodable frames")
        self.height, self.width = first.shape[:2]

    def _count_frames(self):
        n = 0
        while self.cap.grab():
            n += 1
        self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        self.pos = 0
        return n

    def _read(self, n):
        # Stepping forward a few frames is much cheaper by grabbing than seeking.
        if n < self.pos or n - self.pos > 15:
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, n)
            self.pos = n
        while self.pos < n:
            if not self.cap.grab():
                return False, None
            self.pos += 1
        ok, frame = self.cap.read()
        if ok:
            self.pos += 1
            frame = _fit(frame, MAX_FRAME_EDGE)
        return ok, frame

    def frame(self, n):
        with self.lock:
            return self._read(n)


def _fit(img, max_edge):
    h, w = img.shape[:2]
    scale = max_edge / max(h, w)
    if scale >= 1:
        return img
    return cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)


_videos = {}
_videos_lock = threading.Lock()

_frame_cache = OrderedDict()  # (video_id, n) -> BGR ndarray
_frame_cache_lock = threading.Lock()
FRAME_CACHE_SIZE = 32


def _video_path(video_id):
    for name in os.listdir(UPLOAD_DIR):
        if name.startswith(video_id):
            return os.path.join(UPLOAD_DIR, name)
    return None


def get_video(video_id):
    if not ID_RE.match(video_id):
        abort(404)
    with _videos_lock:
        v = _videos.get(video_id)
        if v is None:
            path = _video_path(video_id)
            if path is None:
                abort(404)
            v = Video(path)
            _videos[video_id] = v
        return v


def get_frame(video_id, n):
    key = (video_id, n)
    with _frame_cache_lock:
        if key in _frame_cache:
            _frame_cache.move_to_end(key)
            return _frame_cache[key]
    v = get_video(video_id)
    if n < 0 or n >= v.frames:
        abort(404)
    ok, frame = v.frame(n)
    if not ok:
        abort(404)
    with _frame_cache_lock:
        _frame_cache[key] = frame
        while len(_frame_cache) > FRAME_CACHE_SIZE:
            _frame_cache.popitem(last=False)
    return frame


def cleanup_old_uploads():
    cutoff = time.time() - UPLOAD_TTL_HOURS * 3600
    for name in os.listdir(UPLOAD_DIR):
        path = os.path.join(UPLOAD_DIR, name)
        try:
            if os.path.getmtime(path) < cutoff:
                vid = name[:32]
                with _videos_lock:
                    v = _videos.pop(vid, None)
                if v is not None:
                    v.cap.release()
                os.remove(path)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.post("/api/videos")
def upload_video():
    cleanup_old_uploads()
    f = request.files.get("video")
    if f is None or not f.filename:
        return jsonify(error="No file uploaded."), 400
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in ALLOWED_EXT:
        return jsonify(error=f"Unsupported file type '{ext}'. Use MP4, MOV, AVI, MKV or WebM."), 400

    video_id = uuid.uuid4().hex
    path = os.path.join(UPLOAD_DIR, video_id + ext)
    f.save(path)
    try:
        v = Video(path)
    except ValueError:
        os.remove(path)
        return jsonify(error="Couldn't read that video. Try re-exporting it as MP4 (H.264)."), 400
    with _videos_lock:
        _videos[video_id] = v

    return jsonify(id=video_id, name=f.filename, frames=v.frames, fps=v.fps,
                   width=v.width, height=v.height)


@app.get("/api/videos/<video_id>/frames/<int:n>.jpg")
def frame_jpeg(video_id, n):
    frame = get_frame(video_id, n)
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if not ok:
        abort(500)
    resp = Response(buf.tobytes(), mimetype="image/jpeg")
    resp.headers["Cache-Control"] = "private, max-age=3600"
    return resp


@app.get("/api/videos/<video_id>/frames/<int:n>/detect")
def frame_detect(video_id, n):
    frame = get_frame(video_id, n)
    return jsonify(frame=n, people=detect_people(frame))


@app.errorhandler(413)
def too_large(_):
    return jsonify(error=f"File too large (limit {MAX_UPLOAD_MB} MB)."), 413


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=False, threaded=True)
