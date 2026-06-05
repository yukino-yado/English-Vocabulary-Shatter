const UNIT_SIZE = 100;
const PART_SIZE = 20;
const PROGRESS_KEYS = [
  'englishVocabAppProgress',
  'englishShatterProgress.v2',
  'mogumoguVocabProgress.v1'
];
const SETTINGS_KEYS = [
  'englishVocabAppSettings',
  'englishShatterSettings.v2',
  'mogumoguVocabSettings.v1'
];
const WORD_DATA_CACHE_KEY = 'englishVocabPublishedWords.v1';
const WORD_DATA_META_KEY = 'englishVocabPublishedWordsMeta.v1';
const BOOK_CATALOG_CACHE_KEY = 'englishVocabBookCatalog.v2';
const PART_CONTINUATION_KEY = 'englishVocabPartContinuation.v1';

const $ = (id) => document.getElementById(id);
const currentBookThumbnail = $('currentBookThumbnail');
const currentBookMeta = $('currentBookMeta');
const bookGrid = $('bookGrid');
const bookSearchInput = $('bookSearchInput');
const bookEmptyMessage = $('bookEmptyMessage');
const unitSelect = $('unitSelect');
const partSelect = $('partSelect');
const modeCountSelect = $('modeCountSelect');
const modeTimeSelect = $('modeTimeSelect');
const modeSummary = $('modeSummary');
const startMessage = $('startMessage');
const unitInfo = $('unitInfo');
const menuScreen = $('menuScreen');
const quizScreen = $('quizScreen');
const resultScreen = $('resultScreen');
const choicesBox = $('choices');
const feedback = $('feedback');
const wordText = $('wordText');
const wordStage = $('wordStage');
const shatterLayer = $('shatterLayer');
const statsScopeSelect = $('statsScopeSelect');
const currentBookName = $('currentBookName');

let catalog = { books:[] };
let currentBook = null;
let progress = loadProgress();
let continuation = loadContinuation();
let activeContinuation = null;
let session = [];
let currentIndex = 0;
let score = 0;
let answered = false;
let settings = loadSettings();
let timerId = null;
let timeLeft = settings.timeLimit || 20;

function safeReadStorage(key){
  try {
    const raw = localStorage.getItem(key);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizedRecord(value){
  const source = value && typeof value === 'object' ? value : {};
  return {
    seen: Math.max(0, Number(source.seen) || 0),
    correct: Math.max(0, Number(source.correct) || 0),
    wrong: Math.max(0, Number(source.wrong) || 0),
    streak: Math.max(0, Number(source.streak) || 0)
  };
}

function recordWeight(record){
  return record.seen * 100000 + record.correct * 100 + record.wrong * 10 + record.streak;
}

function persistProgress(data){
  const serialized = JSON.stringify(data);
  PROGRESS_KEYS.forEach(key => {
    try { localStorage.setItem(key, serialized); } catch {}
  });
}

function loadProgress(){
  const merged = {};
  PROGRESS_KEYS.forEach(key => {
    const saved = safeReadStorage(key);
    if(!saved) return;
    Object.entries(saved).forEach(([id, value]) => {
      const candidate = normalizedRecord(value);
      const current = merged[id];
      if(!current || recordWeight(candidate) > recordWeight(current)) merged[id] = candidate;
    });
  });
  persistProgress(merged);
  return merged;
}

function saveProgress(){ persistProgress(progress); }

function loadContinuation(){
  const saved = safeReadStorage(PART_CONTINUATION_KEY);
  return saved && typeof saved === 'object' ? saved : {};
}

function saveContinuation(){
  try { localStorage.setItem(PART_CONTINUATION_KEY, JSON.stringify(continuation)); } catch {}
}

function persistSettings(data){
  const serialized = JSON.stringify(data);
  SETTINGS_KEYS.forEach(key => {
    try { localStorage.setItem(key, serialized); } catch {}
  });
}

function loadSettings(){
  let base = null;
  for(const key of SETTINGS_KEYS){
    const saved = safeReadStorage(key);
    if(saved){ base = saved; break; }
  }
  base = base || { timeLimit:20, studyCount:10, orderMode:'shuffle', studyTarget:'normal', statsScope:'all', selectedBookId:'', selectedUnit:1, selectedPart:1 };
  if(typeof base.timeLimit !== 'number') base.timeLimit = 20;
  if(!Number.isFinite(Number(base.studyCount))) base.studyCount = 10;
  if(!base.orderMode) base.orderMode = 'shuffle';
  if(!['normal','weak','wrong'].includes(base.studyTarget)) base.studyTarget = 'normal';
  if(!base.statsScope) base.statsScope = 'all';
  if(typeof base.selectedBookId !== 'string') base.selectedBookId = '';
  if(!Number.isFinite(Number(base.selectedUnit)) || Number(base.selectedUnit) < 1) base.selectedUnit = 1;
  if(!Number.isFinite(Number(base.selectedPart)) || Number(base.selectedPart) < 1) base.selectedPart = 1;
  persistSettings(base);
  return base;
}

function saveSettings(){ persistSettings(settings); }

function normalizeWordIdentity(value){
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeThumbnailSource(value){
  const text = String(value || '').trim();
  if(!text || text.length > 2_000_000) return '';
  if(/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(text)) return text;
  try{
    const url = new URL(text);
    return url.protocol === 'https:' ? url.href : '';
  }catch{
    return '';
  }
}

function progressKey(word){
  if(word && word.uid) return String(word.uid);
  const normalized = normalizeWordIdentity(word?.word);
  return normalized ? `word:${normalized}` : `id:${word?.id ?? 'unknown'}`;
}

function progressForWord(word){
  return progress[progressKey(word)] || progress[String(word?.id)] || null;
}

function wordProgress(word){
  const key = progressKey(word);
  if(!progress[key]) progress[key] = normalizedRecord(progress[String(word?.id)]);
  return progress[key];
}

function normalizePublishedWords(rawWords){
  if(!Array.isArray(rawWords)) return [];
  return rawWords.map((item, index) => {
    const word = String(item?.word || '').trim();
    const answers = Array.isArray(item?.answers)
      ? item.answers.map(v => String(v || '').trim()).filter(Boolean)
      : [];
    const meaning = String(item?.meaning || answers.join('　')).trim();
    if(!word || answers.length === 0) return null;
    return {
      id: Number(item?.id) || index + 1,
      uid: String(item?.uid || `word:${normalizeWordIdentity(word)}`),
      word,
      meaning,
      answers
    };
  }).filter(Boolean).sort((a, b) => a.id - b.id).map((item, index) => ({ ...item, id:index + 1 }));
}

function normalizeBook(rawBook, index = 0){
  const words = normalizePublishedWords(rawBook?.words || []);
  if(!words.length) return null;
  const name = String(rawBook?.name || rawBook?.bookName || `学習メニュー${index + 1}`).trim() || `学習メニュー${index + 1}`;
  return {
    id:String(rawBook?.id || `book:${normalizeWordIdentity(name)}`),
    name,
    sourceName:String(rawBook?.sourceName || ''),
    updatedAt:rawBook?.updatedAt || null,
    thumbnailUrl:normalizeThumbnailSource(rawBook?.thumbnailUrl || rawBook?.thumbnailDataUrl || rawBook?.thumbnail || ''),
    total:words.length,
    words
  };
}

function normalizeCatalog(payload){
  if(payload?.books && Array.isArray(payload.books)){
    const books = payload.books.map(normalizeBook).filter(Boolean);
    if(books.length) return { ...payload, books };
  }
  const legacyWords = normalizePublishedWords(payload?.words || payload);
  if(legacyWords.length){
    const name = String(payload?.bookName || payload?.datasetName || '基本英単語').trim() || '基本英単語';
    return { books:[{ id:`book:${normalizeWordIdentity(name)}`, name, words:legacyWords, total:legacyWords.length, sourceName:payload?.sourceName || '', updatedAt:payload?.updatedAt || null, thumbnailUrl:normalizeThumbnailSource(payload?.thumbnailUrl || payload?.thumbnailDataUrl || '') }] };
  }
  return { books:[] };
}

function fallbackCatalog(){
  const words = normalizePublishedWords(WORDS);
  return { books:[{ id:'book:basic-vocabulary', name:'基本英単語', words, total:words.length, sourceName:'同梱初期データ', updatedAt:null, thumbnailUrl:'' }] };
}

function selectCurrentBook(preferredId = ''){
  const preferred = preferredId || settings.selectedBookId;
  currentBook = catalog.books.find(book => book.id === preferred) || catalog.books[0] || fallbackCatalog().books[0];
  WORDS = currentBook.words;
  settings.selectedBookId = currentBook.id;
  saveSettings();
  if(currentBookName) currentBookName.textContent = currentBook.name;
  renderCurrentBookCard();
}

function migrateProgressToStableKeys(){
  let changed = false;
  // 旧版の数値ID記録は、旧版から引き継がれた先頭メニューだけに対応させる。
  const legacyBook = catalog.books[0];
  legacyBook?.words.forEach(word => {
    const key = progressKey(word);
    const legacy = progress[String(word.id)];
    if(legacy && !progress[key]){
      progress[key] = normalizedRecord(legacy);
      changed = true;
    }
  });
  if(changed) saveProgress();
}

async function loadPublishedWords(){
  catalog = fallbackCatalog();

  const cachedCatalog = safeReadStorage(BOOK_CATALOG_CACHE_KEY);
  const normalizedCachedCatalog = normalizeCatalog(cachedCatalog);
  if(normalizedCachedCatalog.books.length) catalog = normalizedCachedCatalog;
  else {
    const legacyCache = safeReadStorage(WORD_DATA_CACHE_KEY);
    const legacyCatalog = normalizeCatalog(Array.isArray(legacyCache) ? { words:legacyCache } : legacyCache);
    if(legacyCatalog.books.length) catalog = legacyCatalog;
  }

  try{
    const response = await fetch('/api/words', { cache:'no-store', headers:{ 'Accept':'application/json' } });
    if(response.ok){
      const payload = await response.json();
      const publishedCatalog = normalizeCatalog(payload);
      if(publishedCatalog.books.length){
        catalog = publishedCatalog;
        try{
          localStorage.setItem(BOOK_CATALOG_CACHE_KEY, JSON.stringify(catalog));
          localStorage.setItem(WORD_DATA_META_KEY, JSON.stringify({ version:payload.version || null, updatedAt:payload.updatedAt || null, sourceName:payload.sourceName || null }));
        }catch{}
      }
    }
  }catch{
    // 通信できない場合は、端末内の最新データまたは同梱データを使用する。
  }

  selectCurrentBook(settings.selectedBookId);
  migrateProgressToStableKeys();
}

function setThumbnail(container, dataUrl){
  if(!container) return;
  container.innerHTML = '';
  const safeUrl = normalizeThumbnailSource(dataUrl);
  container.classList.toggle('no-image', !safeUrl);
  if(safeUrl){
    const image = document.createElement('img');
    image.src = safeUrl;
    image.alt = '';
    image.loading = 'lazy';
    container.appendChild(image);
  }else{
    const label = document.createElement('span');
    label.textContent = 'No Image';
    container.appendChild(label);
  }
}

function renderCurrentBookCard(){
  if(!currentBook) return;
  if(currentBookName) currentBookName.textContent = currentBook.name;
  if(currentBookMeta) currentBookMeta.textContent = `${currentBook.total}語・${Math.ceil(currentBook.total / UNIT_SIZE)} Unit`;
  setThumbnail(currentBookThumbnail, currentBook.thumbnailUrl);
}

function renderBookGrid(query = ''){
  if(!bookGrid) return;
  const normalizedQuery = normalizeWordIdentity(query);
  const books = catalog.books.filter(book => !normalizedQuery || normalizeWordIdentity(book.name).includes(normalizedQuery));
  bookGrid.innerHTML = '';
  books.forEach(book => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `book-card${book.id === currentBook?.id ? ' selected' : ''}`;
    button.dataset.bookId = book.id;

    const thumbnail = document.createElement('div');
    thumbnail.className = 'book-card-thumbnail';
    setThumbnail(thumbnail, book.thumbnailUrl);

    const copy = document.createElement('div');
    copy.className = 'book-card-copy';
    const title = document.createElement('strong');
    title.textContent = book.name;
    const meta = document.createElement('span');
    meta.textContent = `${book.total}語・${Math.ceil(book.total / UNIT_SIZE)} Unit・${Math.ceil(book.total / PART_SIZE)} Part`;
    copy.append(title, meta);

    const badge = document.createElement('span');
    badge.className = 'book-selected-badge';
    badge.textContent = book.id === currentBook?.id ? '選択中' : '選択';
    button.append(thumbnail, copy, badge);
    bookGrid.appendChild(button);
  });
  if(bookEmptyMessage) bookEmptyMessage.classList.toggle('hidden', books.length > 0);
}

function initBooks(){
  renderCurrentBookCard();
  renderBookGrid(bookSearchInput?.value || '');
}

function openBookDialog(){
  if(bookSearchInput) bookSearchInput.value = '';
  renderBookGrid('');
  $('bookDialog').showModal();
  setTimeout(() => bookSearchInput?.focus(), 0);
}

function chooseBook(bookId){
  selectCurrentBook(bookId);
  settings.statsScope = 'all';
  settings.selectedUnit = 1;
  settings.selectedPart = 1;
  initUnits();
  renderBookGrid(bookSearchInput?.value || '');
  $('bookDialog').close();
}

function unitRange(unit){
  const start = (unit - 1) * UNIT_SIZE + 1;
  const end = Math.min(unit * UNIT_SIZE, WORDS.length);
  return {start, end};
}
function unitWords(unit){
  const r = unitRange(unit);
  return WORDS.filter(w => w.id >= r.start && w.id <= r.end);
}
function partRange(unit, part){
  const unitR = unitRange(unit);
  const start = unitR.start + (part - 1) * PART_SIZE;
  const end = Math.min(start + PART_SIZE - 1, unitR.end);
  return { start, end };
}
function partWords(unit, part){
  const r = partRange(unit, part);
  return WORDS.filter(w => w.id >= r.start && w.id <= r.end);
}
function shuffle(array){
  const a = [...array];
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function sameSet(a, b){ return a.length === b.length && a.every(x => b.includes(x)); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function modeText(mode){ return mode === 'sequential' ? '順番通り' : 'シャッフル'; }
function studyTargetText(target){
  if(target === 'weak') return '苦手な単語';
  if(target === 'wrong') return '間違えた単語';
  return '通常学習';
}
function modeSummaryText(){
  return `${studyTargetText(settings.studyTarget)}・${modeText(settings.orderMode)}・${settings.studyCount}単語・${settings.timeLimit}秒`;
}
function clearStartMessage(){
  if(startMessage) startMessage.textContent = '';
}

function initUnits(){
  const unitCount = Math.ceil(WORDS.length / UNIT_SIZE);
  unitSelect.innerHTML = '';
  for(let u=1; u<=unitCount; u++){
    const r = unitRange(u);
    const opt = document.createElement('option');
    opt.value = u;
    opt.textContent = `Unit${u}（${r.start}〜${r.end}）`;
    unitSelect.appendChild(opt);
  }
  const preferredUnit = Number(settings.selectedUnit) || 1;
  unitSelect.value = String(Math.min(Math.max(preferredUnit, 1), unitCount));
  settings.selectedUnit = Number(unitSelect.value || 1);

  statsScopeSelect.innerHTML = '<option value="all">全体</option>';
  for(let u=1; u<=unitCount; u++){
    const r = unitRange(u);
    const opt = document.createElement('option');
    opt.value = String(u);
    opt.textContent = `Unit${u}（${r.start}〜${r.end}）`;
    statsScopeSelect.appendChild(opt);
  }
  if(![...statsScopeSelect.options].some(option => option.value === String(settings.statsScope))) settings.statsScope = 'all';
  statsScopeSelect.value = settings.statsScope || 'all';
  initParts();
  syncModeUI();
  saveSettings();
}

function initParts(){
  const unit = Number(unitSelect.value || 1);
  const words = unitWords(unit);
  const partCount = Math.max(1, Math.ceil(words.length / PART_SIZE));
  partSelect.innerHTML = '';
  for(let part=1; part<=partCount; part++){
    const r = partRange(unit, part);
    const opt = document.createElement('option');
    opt.value = String(part);
    opt.textContent = `Part${part}（${r.start}〜${r.end}）`;
    partSelect.appendChild(opt);
  }
  const preferredPart = Number(settings.selectedPart) || 1;
  partSelect.value = String(Math.min(Math.max(preferredPart, 1), partCount));
  settings.selectedPart = Number(partSelect.value || 1);
  saveSettings();
  updateUnitInfo();
}

function syncModeUI(){
  if(modeSummary) modeSummary.textContent = modeSummaryText();
  document.querySelectorAll('input[name="studyTarget"]').forEach(radio => {
    radio.checked = radio.value === (settings.studyTarget || 'normal');
  });
  document.querySelectorAll('input[name="orderMode"]').forEach(radio => {
    radio.checked = radio.value === (settings.orderMode || 'shuffle');
  });
  if(modeCountSelect) modeCountSelect.value = String(settings.studyCount || 10);
  if(modeTimeSelect) modeTimeSelect.value = String(settings.timeLimit || 20);
}

function updateUnitInfo(){
  const unit = Number(unitSelect.value || 1);
  const part = Number(partSelect.value || 1);
  const words = partWords(unit, part);
  const learned = words.filter(w => progressForWord(w)?.seen > 0).length;
  unitInfo.innerHTML = `<b>${escapeHtml(currentBook?.name || '学習メニュー')}</b><br>Unit${unit}・Part${part}：<b>${words.length}</b> 単語　学習済み：<b>${learned}</b> / ${words.length} 単語`;
  clearStartMessage();
}

function continuationStateKey(unit, part){
  return `${currentBook?.id || 'book:default'}|unit:${unit}|part:${part}|mode:${settings.orderMode || 'shuffle'}`;
}

function makeCycleOrder(pool){
  const ordered = settings.orderMode === 'sequential' ? [...pool] : shuffle(pool);
  return ordered.map(progressKey);
}

function getCycleState(pool, unit, part){
  const key = continuationStateKey(unit, part);
  const signature = pool.map(progressKey).join('|');
  let state = continuation[key];
  const invalid = !state || state.signature !== signature || !Array.isArray(state.order) || !Number.isFinite(Number(state.cursor));
  if(invalid || Number(state.cursor) >= state.order.length){
    state = { signature, order:makeCycleOrder(pool), cursor:0 };
    continuation[key] = state;
    saveContinuation();
  }
  return { key, state };
}

function pickSessionWords(pool, count, unit, part){
  const { key, state } = getCycleState(pool, unit, part);
  const byKey = new Map(pool.map(word => [progressKey(word), word]));
  const remaining = state.order.slice(Number(state.cursor) || 0).map(uid => byKey.get(uid)).filter(Boolean);
  const selected = remaining.slice(0, Math.min(count, remaining.length));
  activeContinuation = { key, startCursor:Number(state.cursor) || 0 };
  return selected;
}

function markCurrentWordStudied(){
  if(!activeContinuation) return;
  const state = continuation[activeContinuation.key];
  if(!state) return;
  state.cursor = Math.max(Number(state.cursor) || 0, activeContinuation.startCursor + currentIndex + 1);
  continuation[activeContinuation.key] = state;
  saveContinuation();
}

function reviewPool(pool){
  if(settings.studyTarget === 'weak'){
    return pool.filter(word => masteryLevel(progressForWord(word)) === '苦手');
  }
  if(settings.studyTarget === 'wrong'){
    return pool.filter(word => (progressForWord(word)?.wrong || 0) > 0);
  }
  return pool;
}

function pickReviewSession(pool, count){
  const ordered = settings.orderMode === 'sequential' ? [...pool] : shuffle(pool);
  activeContinuation = null;
  return ordered.slice(0, Math.min(count, ordered.length));
}

function startQuiz(){
  settings.selectedUnit = Number(unitSelect.value || 1);
  settings.selectedPart = Number(partSelect.value || 1);
  saveSettings();
  const unit = settings.selectedUnit;
  const part = settings.selectedPart;
  const count = Number(settings.studyCount) || 10;
  const basePool = partWords(unit, part);
  const pool = reviewPool(basePool);
  session = settings.studyTarget === 'normal'
    ? pickSessionWords(pool, count, unit, part)
    : pickReviewSession(pool, count);
  if(!session.length){
    const target = studyTargetText(settings.studyTarget);
    startMessage.textContent = `${target}に該当する単語が、このPartにはありません。`;
    return;
  }
  clearStartMessage();
  currentIndex = 0;
  score = 0;
  answered = false;
  menuScreen.classList.add('hidden');
  resultScreen.classList.add('hidden');
  quizScreen.classList.remove('hidden');
  showQuestion();
}

function makeChoices(word){
  const correct = word.answers;
  const correctSet = new Set(correct);
  const allMeanings = WORDS.flatMap(w => w.answers).filter(m => !correctSet.has(m));
  const dummyCount = Math.max(4, 6 - correct.length);
  const dummies = shuffle([...new Set(allMeanings)]).slice(0, dummyCount);
  return shuffle([...correct, ...dummies]);
}

function renderWord(text){
  wordText.classList.remove('word-hidden');
  wordText.innerHTML = [...text].map(ch => `<span class="word-char">${escapeHtml(ch === ' ' ? '\u00A0' : ch)}</span>`).join('');
  shatterLayer.innerHTML = '';
  wordStage.classList.remove('cracked', 'flash', 'shatter-hit');
}

function showQuestion(){
  clearTimer();
  answered = false;
  const w = session[currentIndex];
  renderWord(w.word);
  $('progressText').textContent = `${currentIndex + 1} / ${session.length}`;
  $('progressBar').style.width = `${(currentIndex / session.length) * 100}%`;
  feedback.textContent = '';
  feedback.className = 'feedback';
  $('checkBtn').classList.remove('hidden');
  $('nextBtn').classList.add('hidden');
  choicesBox.innerHTML = makeChoices(w).map(c => `
    <label class="choice" data-choice="${escapeHtml(c)}">
      <input type="checkbox" value="${escapeHtml(c)}" />
      <span>${escapeHtml(c)}</span>
    </label>
  `).join('');
  startTimer();
}

function clearTimer(){
  if(timerId){ clearInterval(timerId); timerId = null; }
}

function startTimer(){
  timeLeft = settings.timeLimit || 20;
  updateTimerView();
  timerId = setInterval(() => {
    timeLeft--;
    updateTimerView();
    if(timeLeft <= 0){
      clearTimer();
      timeUp();
    }
  }, 1000);
}

function updateTimerView(){
  const limit = settings.timeLimit || 20;
  $('timerText').textContent = Math.max(0, timeLeft);
  $('timerBar').style.width = `${Math.max(0, timeLeft) / limit * 100}%`;
  $('timerBar').classList.toggle('danger-time', timeLeft <= 5);
}

function buildFragmentPolygons(columns = 5, rows = 2){
  const fragments = [];
  for(let row=0; row<rows; row++){
    for(let col=0; col<columns; col++){
      const x0 = (col / columns) * 100;
      const x1 = ((col + 1) / columns) * 100;
      const y0 = (row / rows) * 100;
      const y1 = ((row + 1) / rows) * 100;
      const centerX = (x0 + x1) / 2;
      const centerY = (y0 + y1) / 2;
      if((row + col) % 2 === 0){
        fragments.push({ polygon:`polygon(${x0}% ${y0}%, ${x1}% ${y0}%, ${x1}% ${y1}%)`, x:centerX, y:centerY });
        fragments.push({ polygon:`polygon(${x0}% ${y0}%, ${x1}% ${y1}%, ${x0}% ${y1}%)`, x:centerX, y:centerY });
      }else{
        fragments.push({ polygon:`polygon(${x0}% ${y0}%, ${x1}% ${y0}%, ${x0}% ${y1}%)`, x:centerX, y:centerY });
        fragments.push({ polygon:`polygon(${x1}% ${y0}%, ${x1}% ${y1}%, ${x0}% ${y1}%)`, x:centerX, y:centerY });
      }
    }
  }
  return fragments;
}

function shatterWord(){
  const stageRect = wordStage.getBoundingClientRect();
  const wordRect = wordText.getBoundingClientRect();
  const wordStyle = getComputedStyle(wordText);
  const text = wordText.textContent;
  shatterLayer.innerHTML = '';

  wordStage.classList.remove('flash', 'shatter-hit');
  void wordStage.offsetWidth;
  wordStage.classList.add('flash', 'cracked', 'shatter-hit');

  setTimeout(() => {
    buildFragmentPolygons(5, 2).forEach((fragment, index) => {
      const piece = document.createElement('span');
      piece.className = 'glass-word-fragment';
      piece.textContent = text;
      piece.style.left = `${wordRect.left - stageRect.left}px`;
      piece.style.top = `${wordRect.top - stageRect.top}px`;
      piece.style.width = `${wordRect.width}px`;
      piece.style.height = `${wordRect.height}px`;
      piece.style.fontFamily = wordStyle.fontFamily;
      piece.style.fontSize = wordStyle.fontSize;
      piece.style.fontWeight = wordStyle.fontWeight;
      piece.style.letterSpacing = wordStyle.letterSpacing;
      piece.style.lineHeight = wordStyle.lineHeight;
      piece.style.clipPath = fragment.polygon;

      const outwardX = (fragment.x - 50) * 2.8;
      const outwardY = (fragment.y - 50) * 1.9;
      piece.style.setProperty('--dx', `${Math.round(outwardX + Math.random() * 56 - 28)}px`);
      piece.style.setProperty('--dy', `${Math.round(outwardY + Math.random() * 80 - 40)}px`);
      piece.style.setProperty('--rot', `${Math.round(Math.random() * 520 - 260)}deg`);
      piece.style.animationDelay = `${Math.random() * 65}ms`;
      shatterLayer.appendChild(piece);
    });

    for(let i=0; i<30; i++){
      const chip = document.createElement('span');
      chip.className = 'glass-chip';
      const size = 5 + Math.random() * 14;
      chip.style.width = `${size}px`;
      chip.style.height = `${size * (0.7 + Math.random() * 0.8)}px`;
      chip.style.left = `${stageRect.width * 0.5 + (Math.random() * wordRect.width * 0.75 - wordRect.width * 0.375)}px`;
      chip.style.top = `${stageRect.height * 0.48 + (Math.random() * 42 - 21)}px`;
      chip.style.setProperty('--dx', `${Math.round(Math.random() * 250 - 125)}px`);
      chip.style.setProperty('--dy', `${Math.round(Math.random() * 180 - 90)}px`);
      chip.style.setProperty('--rot', `${Math.round(Math.random() * 720 - 360)}deg`);
      chip.style.animationDelay = `${Math.random() * 70}ms`;
      shatterLayer.appendChild(chip);
    }

    wordText.classList.add('word-hidden');
  }, 90);

  setTimeout(() => wordStage.classList.remove('cracked'), 850);
  setTimeout(() => wordStage.classList.remove('flash', 'shatter-hit'), 520);
}

function lockChoicesAndMarkAnswers(correctAnswers, selectedAnswers = []){
  choicesBox.querySelectorAll('.choice').forEach(label => {
    const val = label.dataset.choice;
    const input = label.querySelector('input');
    if(correctAnswers.includes(val)) label.classList.add('correct');
    else if(selectedAnswers.includes(val)) label.classList.add('wrong');
    input.disabled = true;
  });
}

function timeUp(){
  if(answered) return;
  const w = session[currentIndex];
  answered = true;
  const p = wordProgress(w);
  p.seen++;
  p.wrong++;
  p.streak = 0;
  saveProgress();
  markCurrentWordStudied();
  feedback.textContent = `時間切れ！ 正解：${w.answers.join(' / ')}`;
  feedback.className = 'feedback bad';
  lockChoicesAndMarkAnswers(w.answers, []);
  $('checkBtn').classList.add('hidden');
  $('nextBtn').classList.remove('hidden');
  $('progressBar').style.width = `${((currentIndex + 1) / session.length) * 100}%`;
}

function checkAnswer(){
  if(answered) return;
  const w = session[currentIndex];
  const selected = [...choicesBox.querySelectorAll('input:checked')].map(i => i.value);
  if(selected.length === 0){
    feedback.textContent = '少なくとも1つ選んでください。';
    feedback.className = 'feedback bad';
    return;
  }

  clearTimer();
  answered = true;
  const isCorrect = sameSet(selected, w.answers);
  const p = wordProgress(w);
  p.seen++;

  if(isCorrect){
    p.correct++;
    p.streak++;
    score++;
    shatterWord();
    feedback.textContent = '正解！';
    feedback.className = 'feedback good';
  }else{
    p.wrong++;
    p.streak = 0;
    feedback.textContent = `不正解！ 正解：${w.answers.join(' / ')}`;
    feedback.className = 'feedback bad';
  }

  saveProgress();
  markCurrentWordStudied();
  lockChoicesAndMarkAnswers(w.answers, selected);
  $('checkBtn').classList.add('hidden');
  $('nextBtn').classList.remove('hidden');
  $('progressBar').style.width = `${((currentIndex + 1) / session.length) * 100}%`;
}

function nextQuestion(){
  currentIndex++;
  if(currentIndex >= session.length) showResult();
  else showQuestion();
}

function showResult(){
  clearTimer();
  quizScreen.classList.add('hidden');
  resultScreen.classList.remove('hidden');
  $('scoreText').textContent = `${score} / ${session.length} 問 正解`;
  updateUnitInfo();
}

function masteryLevel(p){
  if(!p || p.seen === 0) return null;
  const rate = p.correct / p.seen;
  if(p.streak >= 3 && rate >= 0.9) return '完璧';
  if(rate >= 0.75) return '得意';
  if(rate >= 0.5) return 'うろ覚え';
  return '苦手';
}

function statsWordsForScope(scope){
  if(scope === 'all') return WORDS;
  return unitWords(Number(scope));
}

function renderStats(){
  const scope = statsScopeSelect.value || settings.statsScope || 'all';
  settings.statsScope = scope;
  saveSettings();

  const targetWords = statsWordsForScope(scope);
  const label = scope === 'all' ? `${currentBook?.name || '学習メニュー'}・全体` : `${currentBook?.name || '学習メニュー'}・Unit${scope}`;
  const learned = targetWords.filter(w => progressForWord(w)?.seen > 0).length;
  const learnedPct = Math.round((learned / targetWords.length) * 100);

  $('learnedHeading').textContent = `${label}の学習した量`;
  $('masteryHeading').textContent = `${label}の定着具合`;
  $('statsScopeNote').textContent = `学習済み ${learned} / ${targetWords.length} 単語`;
  $('pieChart').style.background = `conic-gradient(var(--cyan) 0deg ${learnedPct * 3.6}deg, #dce4f1 ${learnedPct * 3.6}deg 360deg)`;
  $('piePercent').textContent = `${learnedPct}%`;
  $('learnedText').textContent = `${learnedPct}%`;
  $('unlearnedText').textContent = `${100 - learnedPct}%`;

  const counts = {'完璧':0, '得意':0, 'うろ覚え':0, '苦手':0};
  targetWords.forEach(w => {
    const level = masteryLevel(progressForWord(w));
    if(level) counts[level]++;
  });

  const max = Math.max(1, ...Object.values(counts));
  $('barChart').innerHTML = Object.entries(counts).map(([category, count]) => `
    <div class="bar-row">
      <div class="bar-label">${category}</div>
      <div class="bar-bg"><div class="bar-fill" style="width:${(count / max) * 100}%"></div></div>
      <div class="bar-count">${count}</div>
    </div>
  `).join('');
}

function openStats(){
  if(![...statsScopeSelect.options].some(option => option.value === String(settings.statsScope))) settings.statsScope = 'all';
  statsScopeSelect.value = settings.statsScope || 'all';
  renderStats();
  $('statsDialog').showModal();
}

function openModeDialog(){
  syncModeUI();
  $('modeDialog').showModal();
}

function saveMode(){
  const selectedTarget = document.querySelector('input[name="studyTarget"]:checked');
  const selectedOrder = document.querySelector('input[name="orderMode"]:checked');
  settings.studyTarget = selectedTarget ? selectedTarget.value : 'normal';
  settings.orderMode = selectedOrder ? selectedOrder.value : 'shuffle';
  settings.studyCount = Number(modeCountSelect.value) || 10;
  settings.timeLimit = Number(modeTimeSelect.value) || 20;
  saveSettings();
  syncModeUI();
  updateUnitInfo();
  $('modeDialog').close();
}

function resetProgress(){
  if(confirm('学習記録をすべてリセットしますか？')){
    progress = {};
    continuation = {};
    activeContinuation = null;
    saveProgress();
    saveContinuation();
    renderStats();
    updateUnitInfo();
  }
}

syncModeUI();
$('openBookDialogBtn').addEventListener('click', openBookDialog);
$('closeBookDialogBtn').addEventListener('click', () => $('bookDialog').close());
bookSearchInput?.addEventListener('input', () => renderBookGrid(bookSearchInput.value));
bookGrid?.addEventListener('click', event => {
  const card = event.target.closest('[data-book-id]');
  if(card) chooseBook(card.dataset.bookId);
});
unitSelect.addEventListener('change', () => {
  settings.selectedUnit = Number(unitSelect.value || 1);
  settings.selectedPart = 1;
  saveSettings();
  initParts();
});
partSelect.addEventListener('change', () => {
  settings.selectedPart = Number(partSelect.value || 1);
  saveSettings();
  updateUnitInfo();
});
statsScopeSelect.addEventListener('change', renderStats);
$('startBtn').addEventListener('click', startQuiz);
$('checkBtn').addEventListener('click', checkAnswer);
$('nextBtn').addEventListener('click', nextQuestion);
$('backBtn').addEventListener('click', () => {
  clearTimer();
  quizScreen.classList.add('hidden');
  menuScreen.classList.remove('hidden');
  updateUnitInfo();
});
$('retryBtn').addEventListener('click', () => {
  resultScreen.classList.add('hidden');
  menuScreen.classList.remove('hidden');
  updateUnitInfo();
});
$('openStatsBtn').addEventListener('click', openStats);
$('closeStatsBtn').addEventListener('click', () => $('statsDialog').close());
$('resetBtn').addEventListener('click', resetProgress);
$('openModeBtn').addEventListener('click', openModeDialog);
$('closeModeBtn').addEventListener('click', () => $('modeDialog').close());
$('saveModeBtn').addEventListener('click', saveMode);

(async function boot(){
  await loadPublishedWords();
  initBooks();
  initUnits();
})();
