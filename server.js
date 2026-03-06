const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const multer = require('multer');

const app = express();
const upload = multer({ dest: '/tmp/uploads/' });

// ============================================================
// CONFIGURACOES - Altere aqui se precisar ajustar
// ============================================================
const CONFIG = {
  // URL direta de download do Google Drive
  VIDEO_BASE_URL: process.env.VIDEO_BASE_URL || 'https://drive.google.com/uc?export=download&id=1uutmYFBRthHOA1QrddljS7ai0vtoKBzV&confirm=t',
  
  // Segundo onde o nome APARECE na tela
  NOME_INICIO_SEG: process.env.NOME_INICIO_SEG || '2',
  
  // Segundo onde o nome SOME da tela
  NOME_FIM_SEG: process.env.NOME_FIM_SEG || '30',
  
  // Segundo onde o audio do nome comeca a tocar
  AUDIO_INICIO_SEG: process.env.AUDIO_INICIO_SEG || '2',

  // Tamanho da fonte do nome na tela
  FONT_SIZE: process.env.FONT_SIZE || '52',

  // Cor da fonte (white, yellow, etc)
  FONT_COLOR: process.env.FONT_COLOR || 'white',

  // Posicao vertical: 'centro', 'topo', 'base'
  POSICAO_NOME: process.env.POSICAO_NOME || 'centro',
};

const VIDEO_BASE_PATH = '/tmp/video_base.mp4';

// ============================================================
// HEALTH CHECK - Para verificar se o servidor esta no ar
// ============================================================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    config: {
      nome_inicio: CONFIG.NOME_INICIO_SEG,
      nome_fim: CONFIG.NOME_FIM_SEG,
      audio_inicio: CONFIG.AUDIO_INICIO_SEG,
      video_base_baixado: fs.existsSync(VIDEO_BASE_PATH),
    }
  });
});

// ============================================================
// BAIXAR VIDEO BASE (uma unica vez)
// ============================================================
function baixarVideoBase() {
  if (fs.existsSync(VIDEO_BASE_PATH)) {
    const stats = fs.statSync(VIDEO_BASE_PATH);
    if (stats.size > 10000) {
      console.log('Video base ja existe em cache (' + Math.round(stats.size / 1024 / 1024) + ' MB)');
      return;
    }
    // Arquivo muito pequeno = download incompleto
    fs.unlinkSync(VIDEO_BASE_PATH);
  }

  console.log('Baixando video base do Google Drive...');
  try {
    execSync(
      `curl -L -o ${VIDEO_BASE_PATH} "${CONFIG.VIDEO_BASE_URL}"`,
      { timeout: 300000 } // 5 minutos de timeout
    );
    const stats = fs.statSync(VIDEO_BASE_PATH);
    console.log('Video base baixado com sucesso! Tamanho: ' + Math.round(stats.size / 1024 / 1024) + ' MB');
  } catch (error) {
    console.error('ERRO ao baixar video base:', error.message);
    throw new Error('Falha ao baixar video base. Verifique a URL.');
  }
}

// ============================================================
// RENDERIZAR VIDEO PERSONALIZADO
// ============================================================
app.post('/render', upload.single('audio'), async (req, res) => {
  const startTime = Date.now();
  let outputPath = null;
  let audioPath = null;

  try {
    // Validar inputs
    const nome = req.body.nome;
    if (!nome) {
      return res.status(400).json({ error: 'Campo "nome" e obrigatorio' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Arquivo "audio" e obrigatorio' });
    }

    audioPath = req.file.path;
    outputPath = `/tmp/output_${Date.now()}.mp4`;

    console.log(`Renderizando video para: ${nome}`);

    // Garantir que o video base esta baixado
    baixarVideoBase();

    // Calcular delay do audio em milissegundos
    const delayMs = Math.round(parseFloat(CONFIG.AUDIO_INICIO_SEG) * 1000);

    // Calcular posicao Y do texto
    let posY = '(h-text_h)/2'; // centro (padrao)
    if (CONFIG.POSICAO_NOME === 'topo') posY = 'h*0.1';
    if (CONFIG.POSICAO_NOME === 'base') posY = 'h*0.85';

    // Limpar nome para uso seguro no FFmpeg (remover caracteres especiais perigosos)
    const nomeLimpo = nome.replace(/'/g, "\u2019").replace(/[\\:;]/g, ' ');

    // Montar comando FFmpeg
    const cmd = [
      'ffmpeg -y',
      `-i ${VIDEO_BASE_PATH}`,
      `-i ${audioPath}`,
      '-filter_complex',
      `"[1:a]adelay=${delayMs}|${delayMs}[delayed];` +
      `[0:a][delayed]amix=inputs=2:duration=first:dropout_transition=0[aout];` +
      `[0:v]drawtext=` +
      `text='${nomeLimpo}':` +
      `fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:` +
      `fontsize=${CONFIG.FONT_SIZE}:` +
      `fontcolor=${CONFIG.FONT_COLOR}:` +
      `borderw=2:bordercolor=black:` +
      `x=(w-text_w)/2:y=${posY}:` +
      `enable='between(t,${CONFIG.NOME_INICIO_SEG},${CONFIG.NOME_FIM_SEG})'[vout]"`,
      '-map "[vout]" -map "[aout]"',
      '-c:v libx264 -preset fast -crf 23',
      '-c:a aac -b:a 128k',
      `-movflags +faststart ${outputPath}`,
    ].join(' ');

    console.log('Executando FFmpeg...');
    execSync(cmd, { timeout: 180000 }); // 3 minutos timeout

    const stats = fs.statSync(outputPath);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Video pronto! ${nome} | ${Math.round(stats.size / 1024 / 1024)} MB | ${elapsed}s`);

    // Enviar video de volta
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeLimpo}.mp4"`);
    
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => {
      // Limpar arquivos temporarios
      try { fs.unlinkSync(outputPath); } catch (e) {}
      try { fs.unlinkSync(audioPath); } catch (e) {}
    });

  } catch (error) {
    console.error('ERRO na renderizacao:', error.message);
    // Limpar arquivos temporarios em caso de erro
    if (outputPath) try { fs.unlinkSync(outputPath); } catch (e) {}
    if (audioPath) try { fs.unlinkSync(audioPath); } catch (e) {}
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`FFmpeg Video Service rodando!`);
  console.log(`Porta: ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Render:  POST http://localhost:${PORT}/render`);
  console.log(`=================================`);
  
  // Pre-baixar o video base ao iniciar
  try {
    baixarVideoBase();
  } catch (e) {
    console.error('Aviso: nao foi possivel pre-baixar o video base. Sera baixado no primeiro render.');
  }
});
