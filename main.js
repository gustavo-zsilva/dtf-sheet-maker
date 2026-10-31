import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import fs from 'fs';
import key from './key.json' with { type: 'json' };

const SERVICE_ACCOUNT_EMAIL = process.env.SERVICE_ACCOUNT_EMAIL;
const SHEET_ID = process.env.SHEET_ID;

const serviceAccountAuth = new JWT({
  email: key.client_email,
  key: key.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

const doc = new GoogleSpreadsheet("1bjS9PdxydPsdJ98MPOWG5wHY40wvIplP6ORw6NfAHX4", serviceAccountAuth);

const CANVAS_WIDTH = 6850; 
const MARGIN = 118; // 1cm de espaçamento de corte

// Dimensões exatas em pixels (300 DPI)
const DIMENSIONS = {
  'frontal_fisioterapia.png': { w: 2480, h: 1054 },
  'frontal_educacao_fisica.png': { w: 2994, h: 1163 },
  'gola': { w: 806, h: 308 } 
};

function formatFileName(text) {
  return text.toLowerCase()
             .normalize("NFD").replace(/[\u0300-\u036f]/g, "") 
             .replace(/[^a-z0-9]/g, "_") 
             .replace(/_+/g, "_"); 
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
        itemsToPrint.push({ file: 'frontal_fisioterapia.png', ...DIMENSIONS['frontal_fisioterapia.png'] });
      } else if (estampa.toUpperCase().includes('ED FISICA')) {
        itemsToPrint.push({ file: 'frontal_educacao_fisica.png', ...DIMENSIONS['frontal_educacao_fisica.png'] });
      }

      if (tipoPeca && tamanho) {
        let tipoParaArquivo = tipoPeca;
        if (tipoParaArquivo.toUpperCase().includes('DRY FIT')) {
          tipoParaArquivo = 'Dry Fit';
        }

        const neckLabel = `gola_${formatFileName(tipoParaArquivo)}_${formatFileName(tamanho)}.png`;
        itemsToPrint.push({ file: neckLabel, ...DIMENSIONS['gola'] });
      }
    }
  });

  if (itemsToPrint.length === 0) {
    console.log('Nenhum pedido com status "Recebido" encontrado.');
    return;
  }

  itemsToPrint.sort((a, b) => b.h - a.h);

  const composites = [];
  let currentX = 0;
  let currentY = 0;
  let currentRowHeight = 0;

  for (const item of itemsToPrint) {
    const imagePath = `./labels/${item.file}`;
    
    if (fs.existsSync(imagePath)) {
      if (currentX + item.w > CANVAS_WIDTH) {
        currentX = 0;
        currentY += currentRowHeight + MARGIN;
        currentRowHeight = 0; 
      }

      // Guarda também a largura e altura para o construtor do SVG
      composites.push({
        input: imagePath,
        top: currentY,
        left: currentX,
        w: item.w,
        h: item.h
      });

      currentX += item.w + MARGIN;
      if (item.h > currentRowHeight) {
        currentRowHeight = item.h;
      }
    } else {
      console.warn(`Aviso: Arquivo ${imagePath} faltando na pasta /labels.`);
    }
  }

  const actualHeight = currentY + currentRowHeight;
  const PAGE_HEIGHT_PX = 11811; 
  
  const metrosNecessarios = Math.max(1, Math.ceil(actualHeight / PAGE_HEIGHT_PX));
  const CANVAS_HEIGHT = metrosNecessarios * PAGE_HEIGHT_PX;

  if (metrosNecessarios > 1) {
    console.log(`Aviso: A quantidade de pedidos exige uma prancha de ${metrosNecessarios} metros (${metrosNecessarios * 100}cm).`);
  }

  // Constrói o ficheiro SVG forçando o tamanho físico em centímetros
  let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="58cm" height="${metrosNecessarios * 100}cm" viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}">\n`;

  for (const comp of composites) {
    // Converte a imagem para Base64 para embutir diretamente no SVG
    const base64Data = fs.readFileSync(comp.input, 'base64');
    const isSvg = comp.input.endsWith('.svg');
    const mimeType = isSvg ? 'image/svg+xml' : 'image/png';

    svgContent += `  <image href="data:${mimeType};base64,${base64Data}" x="${comp.left}" y="${comp.top}" width="${comp.w}" height="${comp.h}" />\n`;
  }

  svgContent += `</svg>`;

  // Guarda o ficheiro final com a extensão .svg
  fs.writeFileSync('bloco_dtf_completo.svg', svgContent);

  console.log(`Pronto! Prancha SVG gerada com tamanho de 58x${metrosNecessarios * 100}cm (${composites.length} estampas).`);
}

generateDTFSheet();