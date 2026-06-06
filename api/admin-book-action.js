import { json, methodNotAllowed } from '../server/http.js';
import { manageBook, blobAuthenticationMode } from '../server/words-store.js';

export default {
  async fetch(request) {
    if(request.method !== 'POST') return methodNotAllowed(['POST']);
    try {
      const body = await request.json();
      const action = ['archive','restore','delete','updateMeta'].includes(body?.action) ? body.action : '';
      if(!action || !body?.bookId) return json({ error:'教材と操作内容を指定してください。' }, 400);
      const result = await manageBook({
        bookId:body.bookId,
        action,
        bookName:body.bookName || '',
        thumbnailAction:['replace','remove','preserve'].includes(body.thumbnailAction) ? body.thumbnailAction : 'preserve',
        thumbnailDataUrl:body.thumbnailDataUrl || '',
      });
      const books = result.books.map(book => ({
        id:book.id,
        name:book.name,
        total:book.total,
        sourceName:book.sourceName,
        updatedAt:book.updatedAt,
        thumbnailUrl:book.thumbnailUrl,
        archived:Boolean(book.archived),
        archivedAt:book.archivedAt || null,
      }));
      return json({ ok:true, action, affectedBook:result.affectedBook, books, totalBooks:result.totalBooks, totalWords:result.totalWords, updatedAt:result.updatedAt, blobAuthenticationMode:blobAuthenticationMode() });
    } catch(error) {
      return json({ error:error?.message || '教材の操作に失敗しました。' }, 500);
    }
  },
};
