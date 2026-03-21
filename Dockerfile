FROM python:3.11-slim

# Instala FFmpeg e dependências de sistema
RUN apt-get update && apt-get install -y \
    ffmpeg \
    wget \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia fontes do sistema e baixa Gravitas One
RUN mkdir -p fonts && \
    cp /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf fonts/ && \
    cp /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf fonts/ && \
    wget -q -O fonts/GravitasOne-Regular.ttf \
        "https://fonts.gstatic.com/s/gravitasone/v19/5h1diZ4hJ3cblKy3LWakKQmqDQROwA.ttf"

# Instala dependências Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Railway injeta $PORT automaticamente
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}
