FROM python:3.11-slim

# OpenCV (pulled in by ultralytics) needs these shared libs
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only PyTorch keeps the image ~1.5 GB smaller than the CUDA build
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py yolov8m-pose.pt ./
COPY static ./static

ENV YOLO_CONFIG_DIR=/tmp/Ultralytics \
    PORT=8000
EXPOSE 8000

# One worker (the model and frame cache live in-process); threads handle concurrent requests.
CMD gunicorn app:app --bind 0.0.0.0:$PORT --workers 1 --threads 4 --timeout 300
