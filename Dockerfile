FROM nvcr.io/nvidia/l4t-ml:r36.2.0-py3

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# --- メモリ競合・クラッシュ防止の設定 ---
ENV LD_PRELOAD=/usr/lib/aarch64-linux-gnu/libgomp.so.1:$LD_PRELOAD
ENV MALLOC_CHECK_=3
ENV TF_CPP_MIN_LOG_LEVEL=2
# --------------------------------------

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsm6 \
    libxext6 \
    libgl1-mesa-glx \
    libxrender1 \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --upgrade pip setuptools wheel
RUN pip3 install --no-cache-dir "numpy<2.0.0" "cython<3"

RUN pip3 install --no-cache-dir "deeplabcut[tf] @ git+https://github.com/DeepLabCut/DeepLabCut.git@main"
COPY requirements.txt /app/requirements.txt
RUN pip3 install --no-cache-dir -r /app/requirements.txt

WORKDIR /app