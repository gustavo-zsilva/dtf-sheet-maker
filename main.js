import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import fs from 'fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import key from './key.json' with { type: 'json' };

const serviceAccountAuth = new JWT({
  email: key.client_email,
  key: key.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

const doc = new GoogleSpreadsheet('1bjS9PdxydPsdJ98MPOWG5wHY40wvIplP6ORw6NfAHX4', serviceAccountAuth);

const DPI = 300;
const MARGIN_PX = 71; // 6mm de espaçamento entre estampas, a 300 DPI
const PAGE_HEIGHT_CM = 100;
const EXTRA_DIR = './extra-stamps';
const WIDTHS_CM = ['58', '60', '57'];

function cmToPx(cm) {
  return Math.round(cm / 2.54 * DPI);
}

function formatFileName(text) {
  return text.toLowerCase()
             .normalize("NFD").replace(/[\u0300-\u036f]/g, "") 
             .replace(/[^a-z0-9]/g, "_") 
             .replace(/_+/g, "_"); 
}

function readPngSize(filePath) {
  const buf = fs.readFileSync(filePath);
  const isPng = buf.length >= 24 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG';
  if (!isPng) {
    throw new Error(`Arquivo sem tamanho PNG legível: ${filePath}`);
  }

  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  let dpi = DPI;
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (type === 'pHYs' && length >= 9 && buf[offset + 16] === 1) {
      const ppm = buf.readUInt32BE(offset + 8);
      if (ppm > 0) dpi = ppm * 0.0254;
    }
    if (type === 'IEND') break;
    offset += 12 + length;
  }

  const scale = DPI / dpi;
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

function svgAttr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
  return match ? match[2] : null;
}

// mm/cm/in são tamanho físico. px (ou sem unidade) é o pixel CSS do Inkscape, 96 por polegada.
function lengthToPx(value) {
  const match = String(value).trim().match(/^([0-9]*\.?[0-9]+)\s*(mm|cm|in|px|pt)?$/i);
  if (!match) return null;
  const n = parseFloat(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  switch ((match[2] || 'px').toLowerCase()) {
    case 'mm': return n / 25.4 * DPI;
    case 'cm': return n / 2.54 * DPI;
    case 'in': return n * DPI;
    case 'pt': return n / 72 * DPI;
    case 'px': return n / 96 * DPI;
    default: return null;
  }
}

function readSvgSize(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const tag = text.match(/<svg\b[^>]*>/i)?.[0];
  if (!tag) throw new Error('SVG sem elemento raiz');

  let w = lengthToPx(svgAttr(tag, 'width') || '');
  let h = lengthToPx(svgAttr(tag, 'height') || '');
  const viewBox = svgAttr(tag, 'viewBox');
  if ((!w || !h) && viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      if (!w) w = lengthToPx(`${parts[2]}px`);
      if (!h) h = lengthToPx(`${parts[3]}px`);
    }
  }
  if (!w || !h) throw new Error('SVG sem largura e altura');
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

function readArtworkSize(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return readPngSize(filePath);
  if (ext === '.svg') return readSvgSize(filePath);
  throw new Error('use PNG ou SVG');
}

function pxToCm(px) {
  return (px / DPI * 2.54).toFixed(1);
}

function loadExtraStamps() {
  fs.mkdirSync(EXTRA_DIR, { recursive: true });
  const blocks = [];
  for (const name of fs.readdirSync(EXTRA_DIR)) {
    if (name.startsWith('.')) continue;
    const imagePath = path.join(EXTRA_DIR, name);
    if (!fs.statSync(imagePath).isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (ext !== '.png' && ext !== '.svg') {
      console.warn(`Aviso: ${name} ignorado. A pasta extra-stamps aceita PNG ou SVG.`);
      continue;
    }
    try {
      const { w, h } = readArtworkSize(imagePath);
      console.log(`Estampa extra: ${name} — ${pxToCm(w)} x ${pxToCm(h)} cm`);
      blocks.push({ file: name, imagePath, ow: w, oh: h });
    } catch (err) {
      console.warn(`Aviso: não foi possível medir ${name}. ${err.message}`);
    }
  }
  return blocks;
}

function createPrompter() {
  const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });
  const pending = [];
  let waiter = null;
  const deliver = (line) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(line);
    } else {
      pending.push(line);
    }
  };
  rl.on('line', deliver);
  rl.on('close', () => deliver(''));
  return {
    question(prompt) {
      output.write(prompt);
      if (pending.length) return Promise.resolve(pending.shift());
      return new Promise((resolve) => { waiter = resolve; });
    },
    close() {
      rl.removeAllListeners('line');
      rl.removeAllListeners('close');
      rl.close();
    },
  };
}

async function ask(prompter, question, allowed, fallback) {
  while (true) {
    const raw = (await prompter.question(question)).trim().toLowerCase();
    const answer = raw.replace(/\s*cm$/, '');
    if (!answer) return fallback;
    if (allowed.includes(answer)) return answer;
    console.log(`Digite ${allowed.join(' ou ')}. Enter mantém ${fallback}.`);
  }
}

async function askSheetOptions() {
  const prompter = createPrompter();
  try {
    const formato = await ask(prompter, 'Formato da prancha (svg/png) [svg]: ', ['svg', 'png'], 'svg');
    const largura = await ask(prompter, 'Largura em cm (58, 60 ou 57) [58]: ', WIDTHS_CM, '58');
    return { formato, larguraCm: Number(largura) };
  } finally {
    prompter.close();
  }
}

// A margem entra no retângulo ocupado, mas a folha de encaixe é 6mm mais larga
// que a área imprimível. Assim o vão da direita não perde esses 6mm e cabe
// mais uma etiqueta. As sobras continuam retângulos livres (MaxRects).
class Packer {
  constructor(width, margin) {
    this.width = width;
    this.margin = margin;
    this.free = [{ x: 0, y: 0, w: width + margin, h: Number.MAX_SAFE_INTEGER }];
  }

  fit(blocks) {
    for (const block of blocks) {
      const spot = this.findSpot(block.ow, block.oh);
      if (!spot) {
        block.fit = null;
        continue;
      }
      block.rotated = spot.rotated;
      block.fit = { x: spot.x, y: spot.y };
      this.place(spot.x, spot.y, spot.w + this.margin, spot.h + this.margin);
    }
  }

  findSpot(ow, oh) {
    let best = null;
    for (const rotated of [false, true]) {
      const w = rotated ? oh : ow;
      const h = rotated ? ow : oh;
      const pw = w + this.margin;
      const ph = h + this.margin;
      for (const rect of this.free) {
        if (pw > rect.w || ph > rect.h || rect.x + w > this.width) continue;
        const score = [rect.y, rect.x, ph, rotated ? 1 : 0];
        if (!best || this.lower(score, best.score)) {
          best = { score, x: rect.x, y: rect.y, w, h, rotated };
        }
      }
    }
    return best;
  }

  lower(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  }

  place(x, y, w, h) {
    const next = [];
    for (const rect of this.free) {
      if (x >= rect.x + rect.w || x + w <= rect.x || y >= rect.y + rect.h || y + h <= rect.y) {
        next.push(rect);
        continue;
      }
      if (x > rect.x) next.push({ x: rect.x, y: rect.y, w: x - rect.x, h: rect.h });
      if (x + w < rect.x + rect.w) next.push({ x: x + w, y: rect.y, w: rect.x + rect.w - (x + w), h: rect.h });
      if (y > rect.y) next.push({ x: rect.x, y: rect.y, w: rect.w, h: y - rect.y });
      if (y + h < rect.y + rect.h) next.push({ x: rect.x, y: y + h, w: rect.w, h: rect.y + rect.h - (y + h) });
    }
    this.free = this.prune(next);
  }

  prune(rects) {
    const kept = [];
    for (let i = 0; i < rects.length; i++) {
      const a = rects[i];
      if (a.w <= 0 || a.h <= 0) continue;
      let redundant = false;
      for (let j = 0; j < rects.length; j++) {
        if (i === j) continue;
        const b = rects[j];
        const inside = a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
        if (!inside) continue;
        const same = a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
        if (!same || j < i) {
          redundant = true;
          break;
        }
      }
      if (!redundant) kept.push(a);
    }
    return kept;
  }
}

async function writePng(blocks, canvasWidth, canvasHeight, filePath) {
  const composites = [];
  for (const b of blocks) {
    if (!b.fit) continue;
    const placedW = b.rotated ? b.oh : b.ow;
    const placedH = b.rotated ? b.ow : b.oh;
    let pipeline = sharp(b.imagePath, { density: DPI, limitInputPixels: false });
    if (b.rotated) {
      pipeline = pipeline.rotate(90, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    }
    const png = await pipeline.resize(placedW, placedH, { fit: 'fill' }).png().toBuffer();
    composites.push({ input: png, left: b.fit.x, top: b.fit.y });
  }

  await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
    limitInputPixels: false,
  }).composite(composites).withMetadata({ density: DPI }).png().toFile(filePath);
}

async function generateDTFSheet() {
  const { formato, larguraCm } = await askSheetOptions();
  const canvasWidth = cmToPx(larguraCm);
  const pageHeightPx = cmToPx(PAGE_HEIGHT_CM);

  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['Pedidos']; 
  const rows = await sheet.getRows();

  const itemsToPrint = [];

  rows.forEach(row => {
    const status = row.get('Status');
    if (status === 'Recebido') {
      const estampa = row.get('Estampa') || '';
      const tipoPeca = row.get('Tipo de Peça') || '';
      const tamanho = row.get('Tamanho') || '';

      if (estampa.toUpperCase().includes('FISIO')) {
        itemsToPrint.push({ file: 'frontal_fisioterapia.png' });
      } else if (estampa.toUpperCase().includes('ED FISICA')) {
        itemsToPrint.push({ file: 'frontal_educacao_fisica.png' });
      }

      if (tipoPeca && tamanho) {
        let tipoParaArquivo = tipoPeca;
        if (tipoParaArquivo.toUpperCase().includes('DRY FIT')) {
          tipoParaArquivo = 'Dry Fit';
        }
        const neckLabel = `gola_${formatFileName(tipoParaArquivo)}_${formatFileName(tamanho)}.png`;
        itemsToPrint.push({ file: neckLabel });
      }
    }
  });

  if (itemsToPrint.length === 0) {
    console.log('Nenhum pedido com status "Recebido" encontrado.');
  }

  const blocks = [];
  for (const item of itemsToPrint) {
    const imagePath = `./labels/${item.file}`;
    if (!fs.existsSync(imagePath)) {
      console.warn(`Aviso: Arquivo ${imagePath} faltando.`);
      continue;
    }
    const { w, h } = readPngSize(imagePath);
    blocks.push({ file: item.file, imagePath, ow: w, oh: h });
  }

  blocks.push(...loadExtraStamps());

  if (blocks.length === 0) {
    console.log('Nada para imprimir.');
    return;
  }

  // Maiores primeiro; as golas e as sobras entram depois e ocupam a lateral.
  blocks.sort((a, b) => (b.ow * b.oh) - (a.ow * a.oh));

  const packer = new Packer(canvasWidth, MARGIN_PX);
  packer.fit(blocks);

  let actualHeight = 0;
  for (const b of blocks) {
    if (!b.fit) {
      console.warn(`Aviso: sem espaço na folha para ${b.file}.`);
      continue;
    }
    const placedH = b.rotated ? b.ow : b.oh;
    const bottom = b.fit.y + placedH;
    if (bottom > actualHeight) actualHeight = bottom;
  }

  const metrosNecessarios = Math.max(1, Math.ceil(actualHeight / pageHeightPx));
  const canvasHeight = metrosNecessarios * pageHeightPx;

  if (metrosNecessarios > 1) {
    console.log(`Aviso: A quantidade exige uma prancha de ${metrosNecessarios} metros (${metrosNecessarios * 100}cm).`);
  }

  const pxToMm = (px) => (px / DPI) * 25.4;
  const fitted = blocks.filter(b => b.fit);
  const arquivo = formato === 'png' ? 'bloco_dtf_completo.png' : 'bloco_dtf_completo.svg';

  if (formato === 'png') {
    await writePng(fitted, canvasWidth, canvasHeight, arquivo);
  } else {
    const widthMm = pxToMm(canvasWidth);
    const heightMm = pxToMm(canvasHeight);
    let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm.toFixed(3)}mm" height="${heightMm.toFixed(3)}mm" viewBox="0 0 ${widthMm.toFixed(3)} ${heightMm.toFixed(3)}">\n`;

    for (const b of fitted) {
      const base64Data = fs.readFileSync(b.imagePath, 'base64');
      const mimeType = path.extname(b.file).toLowerCase() === '.svg' ? 'image/svg+xml' : 'image/png';
      const xMm = pxToMm(b.fit.x);
      const yMm = pxToMm(b.fit.y);
      const owMm = pxToMm(b.ow);
      const ohMm = pxToMm(b.oh);

      if (b.rotated) {
        const transX = (xMm + ohMm).toFixed(3);
        const transY = yMm.toFixed(3);
        svgContent += `  <image href="data:${mimeType};base64,${base64Data}" width="${owMm.toFixed(3)}" height="${ohMm.toFixed(3)}" transform="translate(${transX}, ${transY}) rotate(90)" />\n`;
      } else {
        svgContent += `  <image href="data:${mimeType};base64,${base64Data}" x="${xMm.toFixed(3)}" y="${yMm.toFixed(3)}" width="${owMm.toFixed(3)}" height="${ohMm.toFixed(3)}" />\n`;
      }
    }

    svgContent += `</svg>`;
    fs.writeFileSync(arquivo, svgContent);
  }

  const estampasProcessadas = fitted.length;

  const usadoCm = pxToCm(actualHeight);
  console.log(`Pronto! ${estampasProcessadas} estampas em ${usadoCm}cm de altura, numa prancha de ${larguraCm}x${metrosNecessarios * PAGE_HEIGHT_CM}cm (${arquivo}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateDTFSheet().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}