"""
FFmpeg Video Service — NaPista
Renderiza vídeos personalizados combinando vídeo base + áudios + texto via FFmpeg.
"""
__version__ = "1.0.0"

import io
import json
import os
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

app = FastAPI(title="FFmpeg Video Service", version=__version__)

# ── Diretórios ───────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent
FONTS_DIR = BASE_DIR / "fonts"
CACHE_DIR = Path("/tmp/video_cache")
CACHE_DIR.mkdir(exist_ok=True)

# ── Variáveis de ambiente ────────────────────────────────────────────────────
GOOGLE_DRIVE_VIDEO_ID = os.getenv("GOOGLE_DRIVE_VIDEO_ID", "")
GOOGLE_SERVICE_ACCOUNT_JSON = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "")

# ── Mapeamento de posições para coordenadas FFmpeg ───────────────────────────
POSITION_MAP = {
    "centro":          "x=(w-text_w)/2:y=(h-text_h)/2",
    "baixo_centro":    "x=(w-text_w)/2:y=h-text_h-80",
    "baixo_esquerda":  "x=80:y=h-text_h-80",
    "baixo_direita":   "x=w-text_w-80:y=h-text_h-80",
    "topo":            "x=(w-text_w)/2:y=80",
    "topo_esquerda":   "x=80:y=80",
    "topo_direita":    "x=w-text_w-80:y=80",
}

# ── Mapeamento de fontes ─────────────────────────────────────────────────────
FONT_MAP = {
    "Gravitas One":  "GravitasOne-Regular.ttf",
    "DejaVuSans":    "DejaVuSans.ttf",
    "DejaVu Sans":   "DejaVuSans.ttf",
}


# ── Helpers ──────────────────────────────────────────────────────────────────

def get_font_path(font_family: str) -> str:
    filename = FONT_MAP.get(font_family, "DejaVuSans.ttf")
    path = FONTS_DIR / filename
    if not path.exists():
        raise HTTPException(400, f"Fonte não encontrada: {filename}. Fontes disponíveis: {list(FONT_MAP.keys())}")
    return str(path)


def to_ffmpeg_color(color: str) -> str:
    """Converte cor hex (#E93925) para formato FFmpeg (0xE93925)."""
    if color.startswith("#"):
        return "0x" + color[1:]
    return color


def download_from_drive(drive_id: str) -> Path:
    """Baixa vídeo do Google Drive, usando cache em /tmp."""
    cache_path = CACHE_DIR / f"{drive_id}.mp4"
    if cache_path.exists():
        return cache_path

    if not GOOGLE_SERVICE_ACCOUNT_JSON:
        raise HTTPException(500, "GOOGLE_SERVICE_ACCOUNT_JSON não configurado")

    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaIoBaseDownload

    sa_info = json.loads(GOOGLE_SERVICE_ACCOUNT_JSON)
    creds = service_account.Credentials.from_service_account_info(
        sa_info, scopes=["https://www.googleapis.com/auth/drive.readonly"]
    )
    service = build("drive", "v3", credentials=creds)
    request = service.files().get_media(fileId=drive_id, supportsAllDrives=True)

    buffer = io.BytesIO()
    downloader = MediaIoBaseDownload(buffer, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()

    cache_path.write_bytes(buffer.getvalue())
    return cache_path


def build_ffmpeg_command(
    video_path: str,
    audio_files: dict,
    timeline: list,
    output_path: str,
) -> list:
    """Monta o comando FFmpeg com base no timeline_json."""

    audio_events = [e for e in timeline if e["type"] == "audio"]
    text_events  = [e for e in timeline if e["type"] == "text"]

    # Inputs: [0] vídeo, [1..N] áudios
    inputs = ["-i", video_path]
    audio_index_map = {}  # field_name → input index
    for i, event in enumerate(audio_events):
        field = event["file_field"]
        inputs += ["-i", str(audio_files[field])]
        audio_index_map[field] = i + 1

    filters = []

    # Delays por áudio gerado
    audio_labels = ["[0:a]"]  # inclui áudio original do vídeo
    for event in audio_events:
        idx = audio_index_map[event["file_field"]]
        delay_ms = int(float(event.get("start", 0)) * 1000)
        label = f"aud{idx}"
        filters.append(f"[{idx}:a]adelay={delay_ms}:all=1[{label}]")
        audio_labels.append(f"[{label}]")

    # Mix de áudios (original + gerados)
    n = len(audio_labels)
    mix_in = "".join(audio_labels)
    filters.append(f"{mix_in}amix=inputs={n}:duration=longest:normalize=0[aout]")

    # Texto (drawtext encadeado)
    video_out = None
    if text_events:
        prev = "0:v"
        for i, event in enumerate(text_events):
            out_label = f"vout{i}"
            font_path = get_font_path(event.get("font_family", "DejaVuSans"))
            color     = to_ffmpeg_color(event.get("font_color", "white"))
            pos       = POSITION_MAP.get(event.get("position", "centro"), POSITION_MAP["centro"])
            size      = event.get("font_size", 64)
            bold      = ":bold=1" if event.get("bold") else ""
            start     = event.get("start", 0)
            end       = event.get("end", 9999)

            # Escapa caracteres especiais no texto
            text = (event.get("text", "")
                    .replace("\\", "\\\\")
                    .replace("'", "\\'")
                    .replace(":", "\\:"))

            filters.append(
                f"[{prev}]drawtext="
                f"fontfile={font_path}:"
                f"text='{text}':"
                f"fontsize={size}:"
                f"fontcolor={color}:"
                f"{pos}:"
                f"enable='between(t,{start},{end})'"
                f"{bold}"
                f"[{out_label}]"
            )
            prev = out_label
        video_out = prev

    # Monta o comando
    filter_complex = ";".join(filters)

    cmd = ["ffmpeg", "-y", *inputs, "-filter_complex", filter_complex]

    if video_out:
        cmd += ["-map", f"[{video_out}]", "-c:v", "libx264", "-preset", "fast"]
    else:
        cmd += ["-map", "0:v", "-c:v", "copy"]

    cmd += ["-map", "[aout]", "-c:a", "aac", "-movflags", "+faststart", output_path]

    return cmd


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    video_cached = bool(GOOGLE_DRIVE_VIDEO_ID and (CACHE_DIR / f"{GOOGLE_DRIVE_VIDEO_ID}.mp4").exists())
    return {"status": "ok", "video_base_baixado": video_cached}


@app.post("/render")
async def render(
    timeline_json:        str        = Form(...),
    video_base_drive_id:  str        = Form(None),
    audio_nome:           UploadFile = File(...),
    audio_empresa:        UploadFile = File(...),
):
    drive_id = video_base_drive_id or GOOGLE_DRIVE_VIDEO_ID
    if not drive_id:
        raise HTTPException(400, "Informe video_base_drive_id ou configure GOOGLE_DRIVE_VIDEO_ID")

    try:
        timeline = json.loads(timeline_json)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"timeline_json inválido: {e}")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)

        # Salva áudios recebidos
        audio_files = {
            "audio_nome":    tmp / "audio_nome.mp3",
            "audio_empresa": tmp / "audio_empresa.mp3",
        }
        audio_files["audio_nome"].write_bytes(await audio_nome.read())
        audio_files["audio_empresa"].write_bytes(await audio_empresa.read())

        # Baixa vídeo base (com cache)
        try:
            video_path = download_from_drive(drive_id)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(500, f"Erro ao baixar vídeo do Drive: {e}")

        output_path = tmp / "output.mp4"

        cmd = build_ffmpeg_command(
            video_path=str(video_path),
            audio_files=audio_files,
            timeline=timeline,
            output_path=str(output_path),
        )

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise HTTPException(500, f"FFmpeg falhou:\n{result.stderr[-1000:]}")

        return Response(content=output_path.read_bytes(), media_type="video/mp4")
