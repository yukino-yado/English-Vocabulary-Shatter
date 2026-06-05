import * as XLSX from 'xlsx';

function splitMeaning(value) {
  const text = String(value || '').replace(/\r?\n/g, '　').trim();
  if(!text) return [];
  const labelled = text.match(/【[^】]+】[^【]*/g)?.map(v => v.trim()).filter(Boolean) || [];
  if(labelled.length) return labelled;
  return [text];
}

function isHeaderRow(word, meaning) {
  const left = String(word || '').trim().toLowerCase();
  const right = String(meaning || '').trim().toLowerCase();
  return ['英単語','単語','word','english','english word'].includes(left)
    || ['意味','日本語','meaning','japanese'].includes(right);
}

function normalizePair(wordValue, meaningValue, answersValue = null) {
  const word = String(wordValue || '').replace(/^\uFEFF/, '').trim();
  const meaning = String(meaningValue || '').trim();
  const suppliedAnswers = Array.isArray(answersValue)
    ? answersValue.map(value => String(value || '').trim()).filter(Boolean)
    : [];
  const answers = suppliedAnswers.length ? suppliedAnswers : splitMeaning(meaning);
  if(!word || (!meaning && !answers.length) || isHeaderRow(word, meaning)) return null;
  return { word, meaning:meaning || answers.join('　'), answers };
}

function rowsToWords(rows) {
  const words = [];
  for(const row of rows || []) {
    const first = String(row?.[0] ?? '').replace(/^\uFEFF/, '').trim();
    const second = String(row?.[1] ?? '').trim();
    const third = String(row?.[2] ?? '').trim();

    // 新形式：A列＝英単語、B列＝意味。旧形式のA列番号・B列単語・C列意味も読み取り可能。
    const oldNumber = Number(first.replace(/,/g, ''));
    const legacyFormat = Number.isFinite(oldNumber) && oldNumber > 0 && second && third;
    const item = normalizePair(legacyFormat ? second : first, legacyFormat ? third : second);
    if(item) words.push({ id:words.length + 1, ...item });
  }
  return words;
}

function parseJson(buffer) {
  const text = Buffer.from(buffer).toString('utf8').replace(/^\uFEFF/, '').trim();
  const parsed = JSON.parse(text);
  const source = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.words) ? parsed.words : [];
  const words = [];
  for(const row of source) {
    let item = null;
    if(Array.isArray(row)) {
      item = normalizePair(row[0], row[1], row[2]);
    } else if(row && typeof row === 'object') {
      const word = row.word ?? row.english ?? row['英単語'] ?? row['単語'];
      const meaning = row.meaning ?? row.japanese ?? row['意味'] ?? row['日本語'];
      item = normalizePair(word, meaning, row.answers);
    }
    if(item) words.push({ id:words.length + 1, ...item });
  }
  return words;
}

function textLinesToRows(text, allowAlternatingLines = false) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(line => line.replace(/[\u00A0\u2000-\u200B]/g, ' ').trim())
    .filter(Boolean);
  const rows = [];
  const used = new Set();
  const englishOnly = /^(?:\d+[.)、]?\s*)?[A-Za-z][A-Za-z0-9'’./-]*(?:\s+[A-Za-z][A-Za-z0-9'’./-]*)*$/;
  const pairPattern = /^(?:\d+[.)、]?\s*)?([A-Za-z][A-Za-z0-9'’./-]*(?:\s+[A-Za-z][A-Za-z0-9'’./-]*)*)\s+(.+)$/;

  lines.forEach((line, index) => {
    if(/^\d+$/.test(line)) return;
    for(const delimiter of ['\t', '|', '｜']) {
      const splitAt = line.indexOf(delimiter);
      if(splitAt > -1) {
        rows.push([line.slice(0, splitAt), line.slice(splitAt + delimiter.length)]);
        used.add(index);
        return;
      }
    }
    const commaAt = line.indexOf(',');
    if(commaAt > -1) {
      rows.push([line.slice(0, commaAt), line.slice(commaAt + 1)]);
      used.add(index);
      return;
    }
    const wideSpaceParts = line.split(/\s{2,}/).filter(Boolean);
    if(wideSpaceParts.length >= 2) {
      rows.push([wideSpaceParts[0], wideSpaceParts.slice(1).join(' ')]);
      used.add(index);
      return;
    }
    const match = line.match(pairPattern);
    if(match && match[2] && !englishOnly.test(match[2])) {
      rows.push([match[1], match[2]]);
      used.add(index);
    }
  });

  // PDFでは英単語と意味が別行になる場合があるため、英単語行の直後を意味として補完する。
  if(allowAlternatingLines) {
    for(let index = 0; index < lines.length - 1; index++) {
      if(used.has(index) || used.has(index + 1)) continue;
      const current = lines[index];
      const next = lines[index + 1];
      if(englishOnly.test(current) && !englishOnly.test(next) && !/^\d+$/.test(next)) {
        rows.push([current.replace(/^\d+[.)、]?\s*/, ''), next]);
        used.add(index);
        used.add(index + 1);
        index++;
      }
    }
  }
  return rows;
}

function parsePlainText(buffer) {
  const text = Buffer.from(buffer).toString('utf8');
  return rowsToWords(textLinesToRows(text, false));
}

function parseSpreadsheet(buffer) {
  const workbook = XLSX.read(Buffer.from(buffer), { type:'buffer', raw:false });
  const sheetName = workbook.SheetNames.includes('元') ? '元' : workbook.SheetNames[0];
  if(!sheetName) throw new Error('読み取れるシートが見つかりません。');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header:1, defval:'', raw:false });
  return { words:rowsToWords(rows), sourceLabel:sheetName };
}

async function parsePdf(buffer) {
  let parsePdfBuffer;
  try {
    ({ default:parsePdfBuffer } = await import('pdf-parse/lib/pdf-parse.js'));
  } catch {
    const module = await import('pdf-parse');
    parsePdfBuffer = module.default || module;
  }
  if(typeof parsePdfBuffer !== 'function') throw new Error('PDF読み取り機能を初期化できませんでした。');
  const result = await parsePdfBuffer(Buffer.from(buffer));
  const text = String(result?.text || '').trim();
  if(!text) {
    throw new Error('PDFから文字を読み取れませんでした。画像だけで作られたPDFではなく、文字を選択できるPDFを使用してください。');
  }
  const words = rowsToWords(textLinesToRows(text, true));
  if(!words.length) {
    throw new Error('PDF内から英単語と意味の組み合わせを読み取れませんでした。英単語と意味だけを、1行または交互の行に配置してください。');
  }
  return { words, sourceLabel:'PDF' };
}

export async function parseVocabularyWorkbook(arrayBuffer, filename = '') {
  const extension = String(filename).toLowerCase().split('.').pop();
  let words = [];
  let sourceLabel = 'ファイル';
  let firstError = null;

  const tryParser = async (parser, label) => {
    if(words.length) return;
    try {
      const result = await parser(arrayBuffer);
      words = Array.isArray(result) ? result : result.words;
      sourceLabel = Array.isArray(result) ? label : result.sourceLabel || label;
    } catch(error) {
      firstError ||= error;
    }
  };

  if(extension === 'pdf') {
    await tryParser(parsePdf, 'PDF');
  } else if(extension === 'json') {
    await tryParser(parseJson, 'JSON');
  } else if(['txt','text'].includes(extension)) {
    await tryParser(parsePlainText, 'テキスト');
  } else if(['csv','tsv'].includes(extension)) {
    await tryParser(parseSpreadsheet, '表データ');
    if(!words.length) await tryParser(parsePlainText, 'テキスト');
  } else {
    await tryParser(parseSpreadsheet, '表データ');
    if(!words.length) await tryParser(parseJson, 'JSON');
    if(!words.length) await tryParser(parsePlainText, 'テキスト');
  }

  if(!words.length) {
    throw new Error(firstError?.message || '英単語と意味の2列から単語を読み取れませんでした。英単語と意味だけを入力してください。');
  }
  return { filename, sheetName:sourceLabel, words };
}
