import { list, put } from '@vercel/blob';
import { BASE_WORDS } from './base-words.js';

const PREFIX = 'vocab-data/words-';
const THUMBNAIL_PREFIX = 'vocab-thumbnails/';
const MAX_WORDS_PER_BOOK = 20000;
const MAX_BOOKS = 200;
const MAX_THUMBNAIL_BYTES = 1_500_000;

export function normalizeIdentity(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeThumbnailSource(value) {
  const text = String(value || '').trim();
  if(!text || text.length > 2_000_000) return '';
  if(/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(text)) return text;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function answersFrom(value) {
  if(Array.isArray(value)) return [...new Set(value.map(v => String(v || '').trim()).filter(Boolean))];
  return [];
}

export function normalizeWords(rawWords) {
  if(!Array.isArray(rawWords)) return [];
  const seenUids = new Map();
  const normalized = [];
  for(const raw of rawWords.slice(0, MAX_WORDS_PER_BOOK)) {
    const word = String(raw?.word || '').trim();
    const answers = answersFrom(raw?.answers);
    if(!word || answers.length === 0) continue;
    const baseUid = String(raw?.uid || `word:${normalizeIdentity(word)}`);
    const occurrence = (seenUids.get(baseUid) || 0) + 1;
    seenUids.set(baseUid, occurrence);
    const uid = occurrence === 1 ? baseUid : `${baseUid}#${occurrence}`;
    normalized.push({
      id: normalized.length + 1,
      uid,
      word,
      meaning: String(raw?.meaning || answers.join('　')).trim(),
      answers,
    });
  }
  return normalized;
}

function makeBookId(name) {
  const normalized = normalizeIdentity(name) || `book-${Date.now()}`;
  return `book:${normalized}`;
}

function normalizeBook(rawBook, index = 0) {
  const name = String(rawBook?.name || rawBook?.bookName || `学習メニュー${index + 1}`).trim().slice(0, 100);
  const words = normalizeWords(rawBook?.words || []);
  if(!words.length) return null;
  return {
    id: String(rawBook?.id || makeBookId(name)),
    name,
    sourceName: String(rawBook?.sourceName || '').slice(0, 200),
    updatedAt: rawBook?.updatedAt || null,
    thumbnailUrl: normalizeThumbnailSource(rawBook?.thumbnailUrl || rawBook?.thumbnailDataUrl || rawBook?.thumbnail || ''),
    total: words.length,
    words,
  };
}

function baseCatalog() {
  const words = normalizeWords(BASE_WORDS);
  return {
    schemaVersion: 3,
    version: 0,
    updatedAt: null,
    sourceName: '同梱初期データ',
    totalBooks: 1,
    totalWords: words.length,
    books: [{
      id: 'book:basic-vocabulary',
      name: '基本英単語',
      sourceName: '同梱初期データ',
      updatedAt: null,
      thumbnailUrl: '',
      total: words.length,
      words,
    }],
  };
}

export function normalizeCatalog(raw) {
  if(raw?.books && Array.isArray(raw.books)) {
    const books = raw.books.slice(0, MAX_BOOKS).map(normalizeBook).filter(Boolean);
    if(!books.length) return baseCatalog();
    return {
      schemaVersion: 3,
      version: Number(raw.version) || 0,
      updatedAt: raw.updatedAt || null,
      sourceName: String(raw.sourceName || '').slice(0, 200),
      totalBooks: books.length,
      totalWords: books.reduce((sum, book) => sum + book.total, 0),
      books,
    };
  }

  // 旧バージョンの単一教材データも、自動的に1冊の教材として引き継ぐ。
  if(Array.isArray(raw?.words)) {
    const name = String(raw.bookName || raw.datasetName || '基本英単語').trim() || '基本英単語';
    const book = normalizeBook({
      id: raw.bookId || makeBookId(name),
      name,
      sourceName: raw.sourceName || '',
      updatedAt: raw.updatedAt || null,
      thumbnailUrl: raw.thumbnailUrl || raw.thumbnailDataUrl || '',
      words: raw.words,
    });
    if(book) {
      return {
        schemaVersion: 3,
        version: Number(raw.version) || 0,
        updatedAt: raw.updatedAt || null,
        sourceName: String(raw.sourceName || '').slice(0, 200),
        totalBooks: 1,
        totalWords: book.total,
        books: [book],
      };
    }
  }
  return baseCatalog();
}

export async function getLatestDataset() {
  if(!process.env.BLOB_READ_WRITE_TOKEN) return baseCatalog();
  const result = await list({ prefix: PREFIX, limit: 1000 });
  if(!result.blobs?.length) return baseCatalog();
  const latest = [...result.blobs].sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
  const response = await fetch(`${latest.url}?v=${encodeURIComponent(latest.uploadedAt)}`, { cache:'no-store' });
  if(!response.ok) throw new Error('公開済み単語データを読み込めませんでした。');
  return normalizeCatalog(await response.json());
}

function mergeWords(existingWords, incomingWords) {
  const existing = normalizeWords(existingWords);
  const incoming = normalizeWords(incomingWords);
  const indexByUid = new Map(existing.map((word, index) => [word.uid, index]));
  const merged = existing.map(word => ({ ...word }));
  for(const word of incoming) {
    if(indexByUid.has(word.uid)) {
      const index = indexByUid.get(word.uid);
      merged[index] = { ...word, id: merged[index].id, uid: merged[index].uid };
    } else {
      merged.push({ ...word, id: merged.length + 1 });
      indexByUid.set(word.uid, merged.length - 1);
    }
  }
  return merged.map((word, index) => ({ ...word, id:index + 1 }));
}

function parseThumbnailDataUrl(dataUrl) {
  const match = String(dataUrl || '').trim().match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if(!match) throw new Error('サムネイル画像の形式が正しくありません。');
  const buffer = Buffer.from(match[2], 'base64');
  if(!buffer.length || buffer.length > MAX_THUMBNAIL_BYTES) throw new Error('サムネイル画像が大きすぎます。');
  const mimeType = match[1].toLowerCase();
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  return { buffer, mimeType, extension };
}

async function publishThumbnail(dataUrl, bookName, timestamp) {
  const { buffer, extension } = parseThumbnailDataUrl(dataUrl);
  const slug = normalizeIdentity(bookName).replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'book';
  const pathname = `${THUMBNAIL_PREFIX}${timestamp.getTime()}-${slug}.${extension}`;
  const blob = await put(pathname, buffer, {
    access: 'public',
    addRandomSuffix: true,
    cacheControlMaxAge: 31536000,
  });
  return blob.url;
}

export async function publishWords({ rawWords, mode = 'merge', sourceName = '', bookName = '', thumbnailDataUrl = '', thumbnailAction = 'preserve' }) {
  if(!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Vercel Blobが未設定です。');
  const cleanBookName = String(bookName || '').trim().slice(0, 100);
  if(!cleanBookName) throw new Error('学習メニューの名前を入力してください。');

  const incoming = normalizeWords(rawWords);
  if(incoming.length === 0) throw new Error('公開できる英単語がありません。');

  const current = normalizeCatalog(await getLatestDataset().catch(() => baseCatalog()));
  const books = current.books.map(book => ({ ...book, words: normalizeWords(book.words) }));
  const targetIdentity = normalizeIdentity(cleanBookName);
  const existingIndex = books.findIndex(book => normalizeIdentity(book.name) === targetIdentity);
  const now = new Date();
  const uploadedThumbnailUrl = thumbnailAction === 'replace'
    ? await publishThumbnail(thumbnailDataUrl, cleanBookName, now)
    : '';

  if(existingIndex >= 0) {
    const existing = books[existingIndex];
    const words = mode === 'replace' ? incoming : mergeWords(existing.words, incoming);
    let nextThumbnail = existing.thumbnailUrl || '';
    if(thumbnailAction === 'replace') nextThumbnail = uploadedThumbnailUrl;
    if(thumbnailAction === 'remove') nextThumbnail = '';
    books[existingIndex] = {
      ...existing,
      name: cleanBookName,
      sourceName: String(sourceName || '').slice(0, 200),
      updatedAt: now.toISOString(),
      thumbnailUrl: nextThumbnail,
      total: words.length,
      words,
    };
  } else {
    if(books.length >= MAX_BOOKS) throw new Error(`学習メニューは最大${MAX_BOOKS}件までです。`);
    books.push({
      id: makeBookId(cleanBookName),
      name: cleanBookName,
      sourceName: String(sourceName || '').slice(0, 200),
      updatedAt: now.toISOString(),
      thumbnailUrl: thumbnailAction === 'replace' ? uploadedThumbnailUrl : '',
      total: incoming.length,
      words: incoming,
    });
  }

  const dataset = {
    schemaVersion: 3,
    version: now.getTime(),
    updatedAt: now.toISOString(),
    sourceName: String(sourceName || '').slice(0, 200),
    totalBooks: books.length,
    totalWords: books.reduce((sum, book) => sum + book.words.length, 0),
    books: books.map(book => ({ ...book, total:book.words.length })),
  };

  const pathname = `${PREFIX}${String(dataset.version).padStart(16, '0')}.json`;
  const blob = await put(pathname, JSON.stringify(dataset), {
    access: 'public',
    addRandomSuffix: true,
    cacheControlMaxAge: 60,
  });
  const publishedBook = dataset.books.find(book => normalizeIdentity(book.name) === targetIdentity);
  return { ...dataset, publishedBook, blobUrl: blob.url };
}
