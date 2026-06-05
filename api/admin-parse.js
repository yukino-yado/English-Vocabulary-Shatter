import { parseVocabularyWorkbook } from '../server/excel-parser.js';
import { json, methodNotAllowed } from '../server/http.js';

const MAX_FILE_BYTES = 4 * 1024 * 1024;

export default {
  async fetch(request) {
    if(request.method !== 'POST') return methodNotAllowed(['POST']);
    const length = Number(request.headers.get('content-length') || 0);
    if(length > MAX_FILE_BYTES) return json({ error:'ファイルサイズは4MB以下にしてください。' }, 413);
    try {
      const buffer = await request.arrayBuffer();
      if(buffer.byteLength === 0) return json({ error:'ファイルが空です。' }, 400);
      if(buffer.byteLength > MAX_FILE_BYTES) return json({ error:'ファイルサイズは4MB以下にしてください。' }, 413);
      const filename = decodeURIComponent(request.headers.get('x-file-name') || 'uploaded.xlsx');
      const parsed = await parseVocabularyWorkbook(buffer, filename);
      return json({
        ok:true,
        filename:parsed.filename,
        sheetName:parsed.sheetName,
        total:parsed.words.length,
        words:parsed.words,
      });
    } catch(error) {
      return json({ error:error?.message || '単語ファイルを読み取れませんでした。' }, 400);
    }
  },
};
