FROM python:3.11-slim

# Instala FFmpeg e dependências de sistema
RUN apt-get update && apt-get install -y \
    ffmpeg \
    wget \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia fontes do repo (mais confiável que download no build)
COPY fonts/ fonts/

# Instala dependências Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Railway injeta $PORT automaticamente
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}
