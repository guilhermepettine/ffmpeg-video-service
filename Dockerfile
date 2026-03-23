FROM python:3.11-slim

# Instala FFmpeg e dependências de sistema
RUN apt-get update && apt-get install -y \
    ffmpeg \
    wget \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Baixa fontes antes de definir WORKDIR
RUN mkdir -p /app/fonts && \
    find /usr/share/fonts -name "DejaVuSans.ttf" -exec cp {} /app/fonts/ \; && \
    find /usr/share/fonts -name "DejaVuSans-Bold.ttf" -exec cp {} /app/fonts/ \; && \
    wget -q -O /app/fonts/GravitasOne-Regular.ttf \
        "https://fonts.gstatic.com/s/gravitasone/v19/5h1diZ4hJ3cblKy3LWakKQmqDQROwA.ttf"

WORKDIR /app

# Instala dependências Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Railway injeta $PORT automaticamente
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}
