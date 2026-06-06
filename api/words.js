import { getLatestDataset, publicCatalog, blobAuthenticationMode } from '../server/words-store.js';
import { json, methodNotAllowed } from '../server/http.js';

export default {
  async fetch(request) {
    if(request.method !== 'GET') return methodNotAllowed(['GET']);
    try {
      const dataset = await getLatestDataset();
      if(!dataset) return json({ error:'公開済みの単語データはまだありません。' }, 404);
      const includeArchived = new URL(request.url).searchParams.get('includeArchived') === '1';
      if(includeArchived) return json({ ...dataset, blobAuthenticationMode:blobAuthenticationMode() }, 200);
      return json(publicCatalog(dataset), 200);
    } catch(error) {
      return json({ error:error?.message || '単語データの取得に失敗しました。' }, 500);
    }
  },
};
