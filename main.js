import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import fs from 'fs';
import { pathToFileURL } from 'node:url';
import key from './key.json' with { type: 'json' };

const serviceAccountAuth = new JWT({
  email: key.client_email,
  key: key.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

const doc = new GoogleSpreadsheet('1bjS9PdxydPsdJ98MPOWG5wHY40wvIplP6ORw6NfAHX4', serviceAccountAuth);

const CANVAS_WIDTH = 6850; // 58cm a 300 DPI
const MARGIN_PX = 71;      // 6mm de espaçamento entre estampas, a 300 DPI
const PAGE_HEIGHT_PX = 11811; // 1 metro a 300 DPI

function formatFileName(text) {
  return text.toLowerCase()
             .normalize("NFD").replace(/[\u0300-\u036f]/g, "") 
             .replace(/[^a-z0-9]/g, "_") 
             .replace(/_+/g, "_"); 
}

function readPngSize(filePath) {
  const buf = Buffer.alloc(24);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, 24, 0);
  } finally {
    fs.closeSync(fd);
  }
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isPng) {
    throw new Error(`Arquivo sem tamanho PNG legível: ${filePath}`);
  }
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
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

async function generateDTFSheet() {
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
    return;
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

  if (blocks.length === 0) {
    console.log('Nenhum arquivo de estampa encontrado na pasta /labels.');
    return;
  }

  // Maiores primeiro; as golas entram depois e ocupam a sobra da lateral.
  blocks.sort((a, b) => (b.ow * b.oh) - (a.ow * a.oh));

  const packer = new Packer(CANVAS_WIDTH, MARGIN_PX);
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

  const metrosNecessarios = Math.max(1, Math.ceil(actualHeight / PAGE_HEIGHT_PX));
  const CANVAS_HEIGHT = metrosNecessarios * PAGE_HEIGHT_PX;

  if (metrosNecessarios > 1) {
    console.log(`Aviso: A quantidade exige uma prancha de ${metrosNecessarios} metros (${metrosNecessarios * 100}cm).`);
  }

  const pxToMm = (px) => (px / 300) * 25.4;

  const widthMm = pxToMm(CANVAS_WIDTH);
  const heightMm = pxToMm(CANVAS_HEIGHT);

  let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm.toFixed(3)}mm" height="${heightMm.toFixed(3)}mm" viewBox="0 0 ${widthMm.toFixed(3)} ${heightMm.toFixed(3)}">\n`;

  let estampasProcessadas = 0;

  for (const b of blocks) {
    if (!b.fit) continue;

    const base64Data = fs.readFileSync(b.imagePath, 'base64');
    const mimeType = b.file.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    
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
    estampasProcessadas++;
  }

  svgContent += `</svg>`;

  fs.writeFileSync('bloco_dtf_completo.svg', svgContent);
  const usadoCm = ((actualHeight / 300) * 2.54).toFixed(1);
  console.log(`Pronto! ${estampasProcessadas} estampas em ${usadoCm}cm de altura, numa prancha de 58x${metrosNecessarios * 100}cm.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateDTFSheet();
}