import { getLatestDataset } from '../server/words-store.js';
import { json, methodNotAllowed } from '../server/http.js';

export default {
  async fetch(request) {
    if(request.method !== 'GET') return methodNotAllowed(['GET']);
    try {
      const dataset = await getLatestDataset();
      if(!dataset) return json({ error:'公開済みの単語データはまだありません。' }, 404);
      return json(dataset, 200);
    } catch(error) {
      return json({ error:error?.message || '単語データの取得に失敗しました。' }, 500);
    }
  },
};
