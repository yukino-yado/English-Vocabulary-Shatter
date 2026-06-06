import { list, put } from '@vercel/blob';
import { BASE_WORDS } from './base-words.js';

const PREFIX = 'vocab-data/words-';
const THUMBNAIL_PREFIX = 'vocab-thumbnails/';
const MAX_WORDS_PER_BOOK = 20000;
const MAX_BOOKS = 200;
const MAX_THUMBNAIL_BYTES = 1_500_000;

function hasBlobConfiguration() {
  // VercelのOIDCトークンは通常の環境変数ではなく、実行時のリクエスト
  // コンテキストに自動付与されます。ここではBLOB_STORE_IDの有無だけを
  // 確認し、実際の認証処理は@vercel/blob SDKへ任せます。
  return Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
}

function withBlobStore(options = {}) {
  return process.env.BLOB_STORE_ID
    ? { ...options, storeId: process.env.BLOB_STORE_ID }
    : options;
}

export function blobAuthenticationMode() {
  if(process.env.BLOB_STORE_ID) return 'oidc';
  if(process.env.BLOB_READ_WRITE_TOKEN) return 'read-write-token';
  return 'none';
}

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
    archived: Boolean(rawBook?.archived),
    archivedAt: rawBook?.archivedAt || null,
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
      archived: false,
      archivedAt: null,
      total: words.length,
      words,
    }],
  };
}

export function normalizeCatalog(raw) {
  if(raw?.books && Array.isArray(raw.books)) {
    const books = raw.books.slice(0, MAX_BOOKS).map(normalizeBook).filter(Boolean);
    if(!books.length && Number(raw.schemaVersion) < 4) return baseCatalog();
    return {
      schemaVersion: Math.max(4, Number(raw.schemaVersion) || 0),
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

function blobDatasetVersion(blob) {
  const source = String(blob?.pathname || blob?.url || '');
  const match = source.match(/words-(\d{10,})/);
  const pathnameVersion = match ? Number(match[1]) : 0;
  const uploadedVersion = new Date(blob?.uploadedAt || 0).getTime() || 0;
  return Math.max(pathnameVersion, uploadedVersion);
}

export async function getLatestDataset() {
  if(!hasBlobConfiguration()) return baseCatalog();
  const result = await list(withBlobStore({ prefix: PREFIX, limit: 1000 }));
  if(!result.blobs?.length) return baseCatalog();
  const latest = [...result.blobs].sort((a, b) => blobDatasetVersion(b) - blobDatasetVersion(a))[0];
  const response = await fetch(`${latest.url}?v=${encodeURIComponent(blobDatasetVersion(latest))}`, { cache:'no-store' });
  if(!response.ok) throw new Error('公開済み単語データを読み込めませんでした。');
  return normalizeCatalog(await response.json());
}

export function publicCatalog(rawCatalog) {
  const catalog = normalizeCatalog(rawCatalog);
  const books = catalog.books.filter(book => !book.archived);
  return {
    ...catalog,
    totalBooks: books.length,
    totalWords: books.reduce((sum, book) => sum + book.total, 0),
    books,
  };
}

async function persistCatalog(books, sourceName = '') {
  if(!hasBlobConfiguration()) throw new Error('Vercel Blobがプロジェクトへ接続されていません。BLOB_STORE_IDを確認してください。');
  const now = new Date();
  const normalizedBooks = books.map(normalizeBook).filter(Boolean).map(book => ({ ...book, total:book.words.length }));
  const dataset = {
    schemaVersion: 4,
    version: now.getTime(),
    updatedAt: now.toISOString(),
    sourceName: String(sourceName || '').slice(0, 200),
    totalBooks: normalizedBooks.length,
    totalWords: normalizedBooks.reduce((sum, book) => sum + book.total, 0),
    books: normalizedBooks,
  };
  const pathname = `${PREFIX}${String(dataset.version).padStart(16, '0')}.json`;
  const blob = await put(pathname, JSON.stringify(dataset), withBlobStore({
    access: 'public',
    addRandomSuffix: true,
    cacheControlMaxAge: 60,
  }));
  return { ...dataset, blobUrl:blob.url };
}

export async function manageBook({ bookId = '', action = '', bookName = '', thumbnailAction = 'preserve', thumbnailDataUrl = '' }) {
  if(!hasBlobConfiguration()) throw new Error('Vercel Blobがプロジェクトへ接続されていません。BLOB_STORE_IDを確認してください。');
  const current = normalizeCatalog(await getLatestDataset().catch(() => baseCatalog()));
  const books = current.books.map(book => ({ ...book, words:normalizeWords(book.words) }));
  const index = books.findIndex(book => book.id === String(bookId || ''));
  if(index < 0) throw new Error('指定された教材が見つかりません。');
  const target = books[index];
  const now = new Date();
  if(action === 'archive') {
    if(target.archived) throw new Error('この教材はすでにアーカイブされています。');
    books[index] = { ...target, archived:true, archivedAt:now.toISOString(), updatedAt:now.toISOString() };
  } else if(action === 'restore') {
    books[index] = { ...target, archived:false, archivedAt:null, updatedAt:now.toISOString() };
  } else if(action === 'delete') {
    books.splice(index, 1);
  } else if(action === 'updateMeta') {
    const cleanBookName = String(bookName || '').trim().slice(0, 100);
    if(!cleanBookName) throw new Error('教材名を入力してください。');
    const nextIdentity = normalizeIdentity(cleanBookName);
    const duplicate = books.find((book, bookIndex) => bookIndex !== index && normalizeIdentity(book.name) === nextIdentity);
    if(duplicate) throw new Error('同じ名前の教材がすでにあります。別の名前を指定してください。');
    let nextThumbnail = target.thumbnailUrl || '';
    if(thumbnailAction === 'replace') nextThumbnail = await publishThumbnail(thumbnailDataUrl, cleanBookName, now);
    if(thumbnailAction === 'remove') nextThumbnail = '';
    books[index] = {
      ...target,
      name:cleanBookName,
      thumbnailUrl:nextThumbnail,
      updatedAt:now.toISOString(),
      total:target.words.length,
      words:target.words,
    };
  } else {
    throw new Error('操作内容が正しくありません。');
  }
  const result = await persistCatalog(books, `developer:${action}`);
  const affected = action === 'delete'
    ? { id:target.id, name:target.name, deleted:true, archived:Boolean(target.archived) }
    : result.books.find(book => book.id === target.id) || { id:target.id, name:target.name };
  return { ...result, affectedBook:affected, action };
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
  const blob = await put(pathname, buffer, withBlobStore({
    access: 'public',
    addRandomSuffix: true,
    cacheControlMaxAge: 31536000,
  }));
  return blob.url;
}

export async function publishWords({ rawWords, mode = 'merge', sourceName = '', bookName = '', thumbnailDataUrl = '', thumbnailAction = 'preserve' }) {
  if(!hasBlobConfiguration()) throw new Error('Vercel Blobがプロジェクトへ接続されていません。BLOB_STORE_IDを確認してください。');
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
      archived: false,
      archivedAt: null,
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
      archived: false,
      archivedAt: null,
      total: incoming.length,
      words: incoming,
    });
  }

  const dataset = await persistCatalog(books, sourceName);
  const publishedBook = dataset.books.find(book => normalizeIdentity(book.name) === targetIdentity);
  return { ...dataset, publishedBook };
}
