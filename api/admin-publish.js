import { json, methodNotAllowed } from '../server/http.js';
import { publishWords } from '../server/words-store.js';

export default {
  async fetch(request) {
    if(request.method !== 'POST') return methodNotAllowed(['POST']);
    try {
      const body = await request.json();
      if(!Array.isArray(body.words)) return json({ error:'単語データがありません。' }, 400);
      const result = await publishWords({
        rawWords:body.words,
        mode:body.mode === 'replace' ? 'replace' : 'merge',
        sourceName:body.sourceName || '',
        bookName:body.bookName || '',
        thumbnailDataUrl:body.thumbnailDataUrl || '',
        thumbnailAction:['replace','remove'].includes(body.thumbnailAction) ? body.thumbnailAction : 'preserve',
      });
      return json({
        ok:true,
        version:result.version,
        updatedAt:result.updatedAt,
        totalBooks:result.totalBooks,
        totalWords:result.totalWords,
        book:result.publishedBook,
      });
    } catch(error) {
      return json({ error:error?.message || '単語データの公開に失敗しました。' }, 500);
    }
  },
};
