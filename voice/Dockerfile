# Sunny voice sidecar (Pipecat). Deployed as a SECOND Railway service from
# this repo with root directory set to voice/.
FROM python:3.12-slim

# aiortc/av need a few shared libs that the manylinux wheels expect.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
RUN pip install --no-cache-dir .

COPY . .

# Railway injects PORT; server.py reads it (defaults to 7860).
CMD ["python", "server.py"]
