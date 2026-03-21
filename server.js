const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const multer = require('multer');

const app = express();
const upload = multer({ dest: '/tmp/uploads/' });

const CONFIG = {
  VIDEO_BASE_URL:
    process.env.VIDEO_BASE_URL ||
    'https://drive.google.com/uc?export=download&id=1uutmYFBRthHOA1QrddljS7ai0vtoKBzV&confirm=t',
};

const VIDEO_BASE_PATH = '/tmp/video_base.mp4';

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    video_base_baixado: fs.existsSync(VIDEO_BASE_PATH),
  });
});

// ============================================================
// DOWNLOAD DO VIDEO BASE
// ============================================================
function baixarVideoBase() {
  if (fs.existsSync(VIDEO_BASE_PATH)) {
    const stats = fs.statSync(VIDEO_BASE_PATH);
    if (stats.size > 10000) {
      console.log(
        'Video base ja existe em cache (' +
          Math.round(stats.size / 1024 / 1024) +
          ' MB)'
      );
      return;
    }
    fs.unlinkSync(VIDEO_BASE_PATH);
  }

  console.log('Baixando video base...');
  execSync(`curl -L -o ${VIDEO_BASE_PATH} "${CONFIG.VIDEO_BASE_URL}"`, {
    timeout: 300000,
  });

  const stats = fs.statSync(VIDEO_BASE_PATH);
  console.log(
    'Video base baixado com sucesso! Tamanho: ' +
      Math.round(stats.size / 1024 / 1024) +
      ' MB'
  );
}

// ============================================================
// HELPERS
// ============================================================
function limparTextoFFmpeg(texto) {
  return String(texto || '')
    .replace(/'/g, '\u2019')
    .replace(/[\\:;]/g, ' ')
    .replace(/\n/g, ' ');
}

function fonteSegura(nomeFonte) {
  return String(nomeFonte || 'DejaVuSans').replace(/[^a-zA-Z0-9]/g, '');
}

function getFontFile(fontFamily, bold) {
  const safe = fonteSegura(fontFamily);
  if (bold) {
    return `/usr/share/fonts/truetype/dejavu/${safe}-Bold.ttf`;
  }
  return `/usr/share/fonts/truetype/dejavu/${safe}.ttf`;
}

function getPosY(position) {
  if (position === 'topo') return 'h*0.1';
  if (position === 'base') return 'h*0.85';
  return '(h-text_h)/2';
}

// ============================================================
// RENDER COM TIMELINE
// ============================================================
app.post('/render', upload.any(), async (req, res) => {
  const startTime = Date.now();
  let outputPath = null;

  try {
    baixarVideoBase();

    const timelineRaw = req.body.timeline_json;
    if (!timelineRaw) {
      return res.status(400).json({
        error: 'Campo "timeline_json" e obrigatorio',
      });
    }

    let timeline;
    try {
      timeline = JSON.parse(timelineRaw);
    } catch (e) {
      return res.status(400).json({
        error: 'timeline_json invalido',
      });
    }

    if (!Array.isArray(timeline) || timeline.length === 0) {
      return res.status(400).json({
        error: 'timeline_json deve ser um array com eventos',
      });
    }

    // Mapeia os arquivos recebidos por fieldname
    const filesMap = {};
    for (const file of req.files || []) {
      filesMap[file.fieldname] = file.path;
    }

    outputPath = `/tmp/output_${Date.now()}.mp4`;

    const inputArgs = [`-i ${VIDEO_BASE_PATH}`];
    const audioFilterParts = [];
    const drawTextParts = [];

    let inputIndex = 1;
    const audioLabels = [];

    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];

      if (item.type === 'audio') {
        const fileField = item.file_field;
        const filePath = filesMap[fileField];

        if (!fileField || !filePath) {
          return res.status(400).json({
            error: `Arquivo de audio nao encontrado para file_field "${fileField}"`,
          });
        }

        const start = parseFloat(item.start || 0);
        const delayMs = Math.round(start * 1000);

        inputArgs.push(`-i ${filePath}`);

        const label = `a${i}`;
        audioLabels.push(label);

        audioFilterParts.push(
          `[${inputIndex}:a]adelay=${delayMs}|${delayMs}[${label}]`
        );

        inputIndex++;
      }

      if (item.type === 'text') {
        const text = limparTextoFFmpeg(item.text || '');
        const start = parseFloat(item.start || 0);
        const end = parseFloat(item.end || start + 3);
        const fontSize = item.font_size || 52;
        const fontColor = item.font_color || 'white';
        const fontFamily = item.font_family || 'DejaVuSans';
        const bold = !!item.bold;
        const position = item.position || 'centro';
        const x = item.x || '(w-text_w)/2';
        const y = item.y || getPosY(position);
        const fontFile = getFontFile(fontFamily, bold);

        drawTextParts.push({
          text,
          start,
          end,
          fontSize,
          fontColor,
          fontFile,
          x,
          y,
        });
      }
    }

    // Base de audio: áudio original do vídeo
    const allAudioInputs = ['[0:a]', ...audioLabels.map((l) => `[${l}]`)];
    const amixPart = `${allAudioInputs.join('')}amix=inputs=${allAudioInputs.length}:duration=first:dropout_transition=0[aout]`;

    // Encadeia os drawtexts
    let videoChain = '[0:v]';
    const videoSteps = [];

    if (drawTextParts.length === 0) {
      videoSteps.push(`${videoChain}copy[vout]`);
    } else {
      drawTextParts.forEach((t, idx) => {
        const inLabel = idx === 0 ? '[0:v]' : `[v${idx - 1}]`;
        const outLabel = idx === drawTextParts.length - 1 ? '[vout]' : `[v${idx}]`;

        videoSteps.push(
          `${inLabel}drawtext=` +
            `text='${t.text}':` +
            `fontfile=${t.fontFile}:` +
            `fontsize=${t.fontSize}:` +
            `fontcolor=${t.fontColor}:` +
            `borderw=2:bordercolor=black:` +
            `x=${t.x}:y=${t.y}:` +
            `enable='between(t,${t.start},${t.end})'${outLabel}`
        );
      });
    }

    const filterComplex = [...audioFilterParts, amixPart, ...videoSteps].join(';');

    const cmd = [
      'ffmpeg -y',
      ...inputArgs,
      '-filter_complex',
      `"${filterComplex}"`,
      '-map "[vout]" -map "[aout]"',
      '-c:v libx264 -preset fast -crf 23',
      '-c:a aac -b:a 128k',
      `-movflags +faststart ${outputPath}`,
    ].join(' ');

    console.log('Executando FFmpeg...');
    console.log(cmd);

    execSync(cmd, { timeout: 180000 });

    const stats = fs.statSync(outputPath);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `Video pronto! ${Math.round(stats.size / 1024 / 1024)} MB | ${elapsed}s`
    );

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="video_timeline.mp4"`
    );

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);

    stream.on('end', () => {
      try {
        fs.unlinkSync(outputPath);
      } catch (e) {}

      for (const file of req.files || []) {
        try {
          fs.unlinkSync(file.path);
        } catch (e) {}
      }
    });
  } catch (error) {
    console.error('ERRO na renderizacao:', error.message);

    if (outputPath) {
      try {
        fs.unlinkSync(outputPath);
      } catch (e) {}
    }

    for (const file of req.files || []) {
      try {
        fs.unlinkSync(file.path);
      } catch (e) {}
    }

    res.status(500).json({
      error: error.message,
    });
  }
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('=================================');
  console.log('FFmpeg Video Service rodando!');
  console.log(`Porta: ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Render: POST http://localhost:${PORT}/render`);
  console.log('=================================');

  try {
    baixarVideoBase();
  } catch (e) {
    console.error(
      'Aviso: nao foi possivel pre-baixar o video base. Sera baixado no primeiro render.'
    );
  }
});
