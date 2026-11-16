const records = window.CYCLE_RECORDS || [];
const overlay = document.querySelector('#overlay');
const video = document.querySelector('#video');
const canvas = document.querySelector('#canvas');
const camera = document.querySelector('#camera');
const hint = document.querySelector('#cameraHint');
const status = document.querySelector('#scanStatus');
const scanButton = document.querySelector('#scanButton');
let stream, scanning = false, lastFocus, workerPromise, generation = 0;

function normalizeId(value) {
  const text = String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const match = text.match(/HTL([0-9OIL]{2})([0-9OIL]{4})/);
  if (!match) return null;
  const correct = part => part.replace(/O/g, '0').replace(/[IL]/g, '1');
  return `HTL ${correct(match[1])} ${correct(match[2])}`;
}
function findRecord(id) { return records.find(record => normalizeId(record.id) === normalizeId(id)); }
function stopCamera() {
  generation++; scanning = false;
  stream?.getTracks().forEach(track => track.stop());
  stream = null; video.srcObject = null; camera.classList.remove('active');
  scanButton.querySelector('span').textContent = 'Open camera';
}
function showRecord(value) {
  const id = normalizeId(value);
  if (!id) { status.textContent = 'Enter a code like HTL 26 0001.'; return false; }
  const record = findRecord(id);
  if (!record) { status.textContent = `No cycle found for ${id}. Check the code and try again.`; return false; }
  stopCamera(); status.textContent = ''; lastFocus = document.activeElement;
  document.querySelector('#resultId').textContent = record.id;
  document.querySelector('#resultFrame').textContent = record.frameId || '—';
  document.querySelector('#resultRollNumber').textContent = record.rollNumber || '—';
  document.querySelector('#resultBrand').textContent = record.brand || '—';
  document.querySelector('#resultColour').textContent = record.colour || '—';
  document.querySelector('#resultAge').textContent = record.age != null ? `${record.age} ${Number(record.age) === 1 ? 'year' : 'years'}` : '—';
  const photo = document.querySelector('#cyclePhoto');
  photo.hidden = !record.photo;
  if (record.photo) photo.src = record.photo; else photo.removeAttribute('src');
  document.querySelector('#photoPlaceholder').hidden = !!record.photo;
  document.querySelector('#recordNote').hidden = true;
  overlay.hidden = false; document.body.style.overflow = 'hidden'; document.querySelector('#closeButton').focus();
  return true;
}
function closeSheet() { overlay.hidden = true; document.body.style.overflow = ''; lastFocus?.focus(); }
function getWorker() {
  if (!workerPromise) {
    const asset = path => new URL(path, document.baseURI).href;
    workerPromise = Tesseract.createWorker('eng', 1, { workerPath: asset('vendor/worker.min.js'), corePath: asset('vendor/'), langPath: asset('vendor/'), cacheMethod: 'write' }).then(async worker => {
      await worker.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ' });
      return worker;
    }).catch(error => { workerPromise = null; throw error; });
  }
  return workerPromise;
}
function prepImage(source, width, height) {
  const scale = Math.min(1, 1500 / Math.max(width, height));
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const raw = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // The sticker has light lettering on a dark background. Binarise and invert it.
  for (let i = 0; i < raw.data.length; i += 4) {
    const brightness = raw.data[i] * .299 + raw.data[i+1] * .587 + raw.data[i+2] * .114;
    const value = brightness > 105 ? 0 : 255;
    raw.data[i] = raw.data[i+1] = raw.data[i+2] = value;
  }
  ctx.putImageData(raw, 0, 0);
  return canvas;
}
async function readImage(source, width, height) {
  const worker = await getWorker();
  const { data } = await worker.recognize(prepImage(source, width, height));
  return normalizeId(data.text);
}
async function scanFrame(current) {
  if (!scanning || current !== generation) return;
  try {
    if (video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth) {
      // Support machine-readable codes too, while prioritising printed sticker text.
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(video, 0, 0);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
      const id = normalizeId(code?.data || '') || await readImage(video, video.videoWidth, video.videoHeight);
      if (!scanning || current !== generation) return;
      if (id) { if (showRecord(id)) return; hint.textContent = 'Code found. Check the message below.'; }
    }
  } catch (_) { if (current === generation) status.textContent = 'Could not read the code. Try a photo or enter it below.'; }
  if (scanning && current === generation) setTimeout(() => scanFrame(current), 600);
}
scanButton.addEventListener('click', async () => {
  if (scanning) { stopCamera(); hint.textContent = 'Place the cycle code inside the frame'; status.textContent = ''; return; }
  if (!navigator.mediaDevices?.getUserMedia) { status.textContent = 'Camera unavailable. Choose a photo or enter the code.'; return; }
  try {
    status.textContent = 'Preparing scanner…';
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = stream; await video.play(); scanning = true; const current = ++generation; camera.classList.add('active');
    hint.textContent = 'Hold the code steady and in focus'; scanButton.querySelector('span').textContent = 'Close camera';
    await getWorker(); if (!scanning || current !== generation) return;
    status.textContent = 'Looking for a cycle code…'; scanFrame(current);
  } catch (_) { stopCamera(); status.textContent = 'Could not start the scanner. Choose a photo or enter the code.'; }
});
document.querySelector('#imageInput').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  stopCamera(); status.textContent = 'Reading photo…';
  try {
    const url = URL.createObjectURL(file); const img = new Image();
    try { img.src = url; await img.decode(); const id = await readImage(img, img.naturalWidth, img.naturalHeight); if (id) showRecord(id); else status.textContent = 'Could not read the code. Try a clearer photo or enter it below.'; }
    finally { URL.revokeObjectURL(url); }
  } catch (_) { status.textContent = 'Could not read the photo. Enter the code below.'; }
  event.target.value = '';
});
document.querySelector('#manualForm').addEventListener('submit', event => { event.preventDefault(); showRecord(document.querySelector('#cycleId').value); });
document.querySelector('#closeButton').addEventListener('click', closeSheet);
document.querySelector('#doneButton').addEventListener('click', closeSheet);
overlay.addEventListener('click', event => { if (event.target === overlay) closeSheet(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !overlay.hidden) closeSheet(); });

document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  stopCamera();
  document.querySelectorAll('.tab').forEach(item => { item.classList.remove('active'); item.removeAttribute('aria-current'); });
  tab.classList.add('active'); tab.setAttribute('aria-current', 'page');
  document.querySelector('#scanPage').hidden = tab.dataset.page !== 'scan';
  document.querySelector('#auctionPage').hidden = tab.dataset.page !== 'auction';
}));
const brandFilter = document.querySelector('#brandFilter'), ageFilter = document.querySelector('#ageFilter');
// Add brands supplied by the connected records without duplicating the common choices.
records.forEach(record => { if (record.auction && record.brand && !Array.from(brandFilter.options).some(option => option.value.toLowerCase() === record.brand.toLowerCase())) brandFilter.add(new Option(record.brand, record.brand)); });
function renderListings() {
  const brand = brandFilter.value, age = ageFilter.value;
  const filtered = records.filter(record => {
    if (!record.auction || (brand && String(record.brand || '').toLowerCase() !== brand.toLowerCase())) return false;
    if (!age) return true;
    if (record.age == null || !Number.isFinite(Number(record.age))) return false;
    const years = Number(record.age);
    if (age === '0-1') return years >= 0 && years < 1;
    if (age === '1-3') return years >= 1 && years < 3;
    if (age === '3-5') return years >= 3 && years < 5;
    return years >= 5;
  });
  const container = document.querySelector('#listings'); container.replaceChildren();
  filtered.forEach(record => {
    const card = document.createElement('article'); card.className = 'listing';
    if (record.photo) { const image = document.createElement('img'); image.src = record.photo; image.alt = `${record.brand || 'Cycle'} bicycle`; image.className = 'listing-photo'; card.append(image); }
    const title = document.createElement('strong'); title.textContent = record.brand || 'Cycle';
    const details = document.createElement('p'); details.textContent = [record.id, record.age != null ? `${record.age} years` : null, record.colour].filter(Boolean).join(' · ');
    const button = document.createElement('button'); button.className = 'primary'; button.textContent = 'View details'; button.addEventListener('click', () => showRecord(record.id));
    card.append(title, details, button); container.append(card);
  });
  document.querySelector('#listingCount').textContent = `${filtered.length} ${filtered.length === 1 ? 'cycle' : 'cycles'}`;
  document.querySelector('#emptyListings').hidden = filtered.length > 0;
}
brandFilter.addEventListener('change', renderListings); ageFilter.addEventListener('change', renderListings);
document.querySelector('#clearFilters').addEventListener('click', () => { brandFilter.value = ''; ageFilter.value = ''; renderListings(); });
renderListings();
