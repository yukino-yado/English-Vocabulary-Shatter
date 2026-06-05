const $ = id => document.getElementById(id);
let parsedWords = [];
let parsedFilename = '';
let thumbnailDataUrl = '';
let thumbnailFileName = '';
let thumbnailAction = 'preserve';

function setMessage(id, text = '', type = ''){
  const el = $(id);
  el.textContent = text;
  el.className = `message ${type}`.trim();
}

function formatDate(value){
  if(!value) return '未公開';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '―' : date.toLocaleString('ja-JP');
}

function escapeHtml(value){
  return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function safeThumbnailSource(value){
  const text = String(value || '').trim();
  if(!text || text.length > 2_000_000) return '';
  if(/^data:image\/(?:png|jpe?g|webp);base64,/i.test(text)) return text;
  try{
    const url = new URL(text);
    return url.protocol === 'https:' ? url.href : '';
  }catch{
    return '';
  }
}

function thumbnailMarkup(value, className = 'published-book-thumbnail'){
  const safe = safeThumbnailSource(value);
  return safe
    ? `<div class="${className}"><img src="${escapeHtml(safe)}" alt="" /></div>`
    : `<div class="${className} no-image"><span>No Image</span></div>`;
}

async function requestJson(url, options = {}){
  const response = await fetch(url, { ...options, headers:{ Accept:'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if(!response.ok) throw new Error(data.error || `通信に失敗しました（${response.status}）`);
  return data;
}

async function loadCurrentData(){
  $('currentBooks').textContent = '読込中';
  $('currentTotal').textContent = '―';
  $('currentUpdated').textContent = '―';
  $('currentBookList').innerHTML = '';
  try{
    const data = await requestJson('/api/words', { cache:'no-store' });
    const books = Array.isArray(data.books) ? data.books : [{ name:data.bookName || '基本英単語', total:data.total || data.words?.length || 0, updatedAt:data.updatedAt, sourceName:data.sourceName, thumbnailUrl:data.thumbnailUrl || data.thumbnailDataUrl }];
    const totalWords = Number(data.totalWords || books.reduce((sum, book) => sum + Number(book.total || book.words?.length || 0), 0));
    $('currentBooks').textContent = `${books.length}件`;
    $('currentTotal').textContent = `${totalWords}語`;
    $('currentUpdated').textContent = formatDate(data.updatedAt);
    $('currentBookList').innerHTML = books.map(book => `
      <div class="published-book-card">
        ${thumbnailMarkup(book.thumbnailUrl || book.thumbnailDataUrl)}
        <div class="published-book-copy">
          <div>
            <strong>${escapeHtml(book.name || '名称未設定')}</strong>
            <span>${Number(book.total || book.words?.length || 0)}語 / ${Math.ceil(Number(book.total || book.words?.length || 0) / 100)} Unit / ${Math.ceil(Number(book.total || book.words?.length || 0) / 20)} Part</span>
          </div>
          <small>${book.sourceName ? `反映元：${escapeHtml(book.sourceName)}` : ''}${book.updatedAt ? `　更新：${escapeHtml(formatDate(book.updatedAt))}` : ''}</small>
        </div>
      </div>
    `).join('');
    $('currentSource').textContent = '同じ学習メニュー名を入力すると、そのメニューを追加・更新できます。';
  }catch(error){
    $('currentBooks').textContent = '未公開';
    $('currentTotal').textContent = '―';
    $('currentSource').textContent = '最初のファイルを読み込み、生徒用アプリへ反映してください。';
  }
}

function updatePreviewBookName(){
  const name = $('bookNameInput').value.trim();
  $('previewBookName').textContent = name || '未入力';
}

function updatePreviewThumbnailName(){
  const label = thumbnailAction === 'remove' ? 'No Imageに変更' : (thumbnailFileName || '変更なし');
  $('previewThumbnailName').textContent = label;
}

function renderPreview(data){
  parsedWords = data.words || [];
  parsedFilename = data.filename || '';
  $('previewFilename').textContent = parsedFilename || '―';
  $('previewSheet').textContent = data.sheetName || '―';
  $('previewTotal').textContent = `${parsedWords.length}語`;
  updatePreviewBookName();
  updatePreviewThumbnailName();
  $('previewBody').innerHTML = parsedWords.slice(0, 20).map(word => `
    <tr>
      <td>${word.id}</td>
      <td>${escapeHtml(word.word)}</td>
      <td><div class="meaning-list">${word.answers.map(answer => `<span class="meaning-chip">${escapeHtml(answer)}</span>`).join('')}</div></td>
    </tr>
  `).join('');
  $('previewArea').classList.remove('hidden');
}

async function parseFile(file){
  if(!file) return;
  if(file.size > 4 * 1024 * 1024){
    setMessage('parseMessage', 'ファイルサイズは4MB以下にしてください。', 'error');
    return;
  }
  setMessage('parseMessage', '単語ファイルを読み取っています…', 'loading');
  $('previewArea').classList.add('hidden');
  try{
    const response = await fetch('/api/admin-parse', {
      method:'POST',
      headers:{ 'Content-Type':'application/octet-stream', 'X-File-Name':encodeURIComponent(file.name), Accept:'application/json' },
      body:file,
    });
    const data = await response.json().catch(() => ({}));
    if(!response.ok) throw new Error(data.error || 'ファイルを読み取れませんでした。');
    renderPreview(data);
    setMessage('parseMessage', `${data.total}語を読み取りました。学習メニュー名と内容を確認してから反映してください。`, 'success');
  }catch(error){ setMessage('parseMessage', error.message, 'error'); }
}

function readAsDataUrl(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('画像を読み込めませんでした。'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src){
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('画像を表示できませんでした。'));
    image.src = src;
  });
}

async function createThumbnailDataUrl(file){
  const rawUrl = await readAsDataUrl(file);
  const image = await loadImage(rawUrl);
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 450;
  const context = canvas.getContext('2d');
  if(!context) throw new Error('画像の処理に失敗しました。');

  const sourceRatio = image.naturalWidth / image.naturalHeight;
  const targetRatio = canvas.width / canvas.height;
  let sx = 0, sy = 0, sw = image.naturalWidth, sh = image.naturalHeight;
  if(sourceRatio > targetRatio){
    sw = image.naturalHeight * targetRatio;
    sx = (image.naturalWidth - sw) / 2;
  }else{
    sh = image.naturalWidth / targetRatio;
    sy = (image.naturalHeight - sh) / 2;
  }
  context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/webp', 0.82);
}

function renderThumbnailPreview(){
  const preview = $('thumbnailPreview');
  preview.innerHTML = '';
  const safe = safeThumbnailSource(thumbnailDataUrl);
  preview.classList.toggle('no-image', !safe);
  if(safe){
    const image = document.createElement('img');
    image.src = safe;
    image.alt = '選択中のサムネイル';
    preview.appendChild(image);
  }else{
    const label = document.createElement('span');
    label.textContent = 'No Image';
    preview.appendChild(label);
  }
  updatePreviewThumbnailName();
}

async function parseThumbnail(file){
  if(!file) return;
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)){
    setMessage('thumbnailMessage', 'PNG・JPEG・WebP画像を選択してください。', 'error');
    return;
  }
  if(file.size > 8 * 1024 * 1024){
    setMessage('thumbnailMessage', 'サムネイル画像は8MB以下にしてください。', 'error');
    return;
  }
  setMessage('thumbnailMessage', 'サムネイルを軽量化しています…', 'loading');
  try{
    thumbnailDataUrl = await createThumbnailDataUrl(file);
    thumbnailFileName = file.name;
    thumbnailAction = 'replace';
    renderThumbnailPreview();
    setMessage('thumbnailMessage', 'サムネイルを読み込みました。生徒側では横長に表示されます。', 'success');
  }catch(error){
    setMessage('thumbnailMessage', error.message, 'error');
  }
}

function removeThumbnail(){
  thumbnailDataUrl = '';
  thumbnailFileName = '';
  thumbnailAction = 'remove';
  $('thumbnailInput').value = '';
  renderThumbnailPreview();
  setMessage('thumbnailMessage', '反映時にサムネイルを外し、「No Image」に変更します。', 'success');
}

function resetThumbnailAfterPublish(){
  thumbnailDataUrl = '';
  thumbnailFileName = '';
  thumbnailAction = 'preserve';
  $('thumbnailInput').value = '';
  renderThumbnailPreview();
  setMessage('thumbnailMessage', '画像を選択しない場合、既存教材のサムネイルはそのまま保持されます。', '');
}

function selectedMode(){
  return document.querySelector('input[name="publishMode"]:checked')?.value || 'merge';
}

function selectedBookName(){
  return $('bookNameInput').value.trim();
}

function openConfirm(){
  if(!parsedWords.length) return;
  const bookName = selectedBookName();
  if(!bookName){
    setMessage('publishMessage', '生徒側に表示する学習メニュー名を入力してください。', 'error');
    $('bookNameInput').focus();
    return;
  }
  const mode = selectedMode();
  const thumbnailNote = thumbnailAction === 'replace' ? 'サムネイルも更新します。' : thumbnailAction === 'remove' ? 'サムネイルはNo Imageに変更します。' : '既存のサムネイルは保持します。';
  $('confirmText').textContent = mode === 'replace'
    ? `「${bookName}」を、今回読み取った${parsedWords.length}語の内容で作成・置き換えます。${thumbnailNote}`
    : `「${bookName}」へ${parsedWords.length}語を追加・更新します。同じ名前のメニューがない場合は、新しい学習メニューとして追加します。${thumbnailNote}`;
  $('confirmDialog').showModal();
}

async function publish(){
  $('confirmDialog').close();
  const bookName = selectedBookName();
  if(!bookName) return;
  $('publishBtn').disabled = true;
  setMessage('publishMessage', '生徒用アプリへ反映しています…', 'loading');
  try{
    const result = await requestJson('/api/admin-publish', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({
        words:parsedWords,
        mode:selectedMode(),
        sourceName:parsedFilename,
        bookName,
        thumbnailAction,
        thumbnailDataUrl:thumbnailAction === 'replace' ? thumbnailDataUrl : '',
      }),
    });
    const total = Number(result.book?.total || result.book?.words?.length || parsedWords.length);
    setMessage('publishMessage', `「${bookName}」の反映が完了しました。生徒用アプリには全${total}語として表示されます。`, 'success');
    resetThumbnailAfterPublish();
    await loadCurrentData();
  }catch(error){
    setMessage('publishMessage', error.message, 'error');
  }finally{ $('publishBtn').disabled = false; }
}

$('refreshCurrentBtn').addEventListener('click', loadCurrentData);
$('fileInput').addEventListener('change', event => parseFile(event.target.files?.[0]));
$('thumbnailInput').addEventListener('change', event => parseThumbnail(event.target.files?.[0]));
$('removeThumbnailBtn').addEventListener('click', removeThumbnail);
$('bookNameInput').addEventListener('input', updatePreviewBookName);
$('publishBtn').addEventListener('click', openConfirm);
$('cancelPublishBtn').addEventListener('click', () => $('confirmDialog').close());
$('confirmPublishBtn').addEventListener('click', publish);

document.querySelectorAll('.mode-card input').forEach(input => input.addEventListener('change', () => {
  document.querySelectorAll('.mode-card').forEach(card => card.classList.toggle('selected', card.querySelector('input').checked));
}));

function setupDropZone(element, onFile){
  ['dragenter','dragover'].forEach(type => element.addEventListener(type, event => { event.preventDefault(); element.classList.add('dragover'); }));
  ['dragleave','drop'].forEach(type => element.addEventListener(type, event => { event.preventDefault(); element.classList.remove('dragover'); }));
  element.addEventListener('drop', event => onFile(event.dataTransfer.files?.[0]));
}

setupDropZone($('fileDrop'), parseFile);
setupDropZone($('thumbnailDrop'), parseThumbnail);
renderThumbnailPreview();
loadCurrentData();

function studentAppUrl(){
  return new URL('./index.html', window.location.href).href;
}

function openStudentPreview(){
  const frame = $('studentPreviewFrame');
  frame.src = studentAppUrl();
  $('studentPreviewDialog').showModal();
}

$('openStudentPreviewBtn').addEventListener('click', openStudentPreview);
$('reloadStudentPreviewBtn').addEventListener('click', () => {
  $('studentPreviewFrame').src = `${studentAppUrl()}?previewReload=${Date.now()}`;
});
$('closeStudentPreviewBtn').addEventListener('click', () => {
  $('studentPreviewDialog').close();
  $('studentPreviewFrame').src = 'about:blank';
});
