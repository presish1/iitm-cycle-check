const records = window.CYCLE_RECORDS || [];
const overlay = document.querySelector('#overlay');
const video = document.querySelector('#video');
const canvas = document.querySelector('#canvas');
const camera = document.querySelector('#camera');
const hint = document.querySelector('#cameraHint');
const status = document.querySelector('#scanStatus');
const scanButton = document.querySelector('#scanButton');
let stream, scanning = false, starting = false, lastFocus, workerPromise, generation = 0;
let ocrQueue = Promise.resolve(), missedFrames = 0, candidateId = null, candidateCount = 0;

function setNotice(code, message) {
  status.textContent = code ? `${code} · ${message}` : message;
  status.dataset.state = code ? 'error' : 'info';
}
function cameraError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return ['CAM-01', 'Camera access denied. Allow camera access in browser settings or choose a photo.'];
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') return ['CAM-02', 'No camera found. Choose a photo or enter the code.'];
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') return ['CAM-03', 'Camera is busy. Close other camera apps and try again.'];
  return ['CAM-04', 'Could not start the camera. Choose a photo or enter the code.'];
}

function normalizeId(value) {
  const text = String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const match = text.match(/HTL([0-9OIL]{2})([0-9OIL]{4})/);
  if (!match) return null;
  const correct = part => part.replace(/O/g, '0').replace(/[IL]/g, '1');
  return `HTL ${correct(match[1])} ${correct(match[2])}`;
}
function findRecord(id) { return records.find(record => normalizeId(record.id) === normalizeId(id)); }
function stopCamera() {
  generation++; scanning = false; starting = false; missedFrames = 0; candidateId = null; candidateCount = 0;
  stream?.getTracks().forEach(track => track.stop());
  stream = null; video.srcObject = null; camera.classList.remove('active');
  scanButton.querySelector('span').textContent = 'Open camera';
}
function showRecord(value) {
  const id = normalizeId(value);
  if (!id) { setNotice('CODE-01', 'Enter a code in the format HTL 00 0000.'); return false; }
  const record = findRecord(id);
  if (!record) { setNotice('DATA-01', `Code read: ${id}. No matching cycle record.`); return false; }
  stopCamera(); setNotice(null, ''); lastFocus = document.activeElement;
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
function prepImage(target, source, width, height, angle = 0, threshold = 105) {
  const scale = Math.min(1, 1280 / Math.max(width, height));
  target.width = Math.round(width * scale); target.height = Math.round(height * scale);
  const ctx = target.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, target.width, target.height);
  ctx.translate(target.width / 2, target.height / 2);
  ctx.rotate(angle * Math.PI / 180);
  ctx.drawImage(source, -target.width / 2, -target.height / 2, target.width, target.height);
  ctx.resetTransform();
  const raw = ctx.getImageData(0, 0, target.width, target.height);
  if (threshold === 'adaptive') {
    const hist = new Uint32Array(256); let total = 0, sum = 0;
    for (let i = 0; i < raw.data.length; i += 4) { const v = Math.round(raw.data[i] * .299 + raw.data[i+1] * .587 + raw.data[i+2] * .114); if (v < 250) { hist[v]++; sum += v; total++; } }
    let background = 0, backgroundSum = 0, best = 0, cutoff = 105;
    for (let i = 0; i < 256; i++) { background += hist[i]; if (!background || background === total) continue; backgroundSum += i * hist[i]; const diff = backgroundSum / background - (sum - backgroundSum) / (total - background); const score = background * (total - background) * diff * diff; if (score > best) { best = score; cutoff = i; } }
    threshold = cutoff;
  }
  for (let i = 0; i < raw.data.length; i += 4) {
    const brightness = raw.data[i] * .299 + raw.data[i+1] * .587 + raw.data[i+2] * .114;
    const value = brightness > threshold ? 0 : 255;
    raw.data[i] = raw.data[i+1] = raw.data[i+2] = value;
  }
  ctx.putImageData(raw, 0, 0);
  return target;
}
async function readImage(source, width, height, shouldCancel = () => false) {
  // Snapshot first; separate canvases keep cancelled camera and photo jobs isolated.
  const snapshot = document.createElement('canvas');
  const scale = Math.min(1, 1280 / Math.max(width, height));
  snapshot.width = Math.round(width * scale); snapshot.height = Math.round(height * scale);
  snapshot.getContext('2d').drawImage(source, 0, 0, snapshot.width, snapshot.height);
  const run = async () => {
    if (shouldCancel()) return null;
    const worker = await getWorker();
    const processed = document.createElement('canvas');
    // Most images finish on the first pass. More expensive tilt attempts are fallbacks.
    for (const [angle, threshold] of [[0, 105], [0, 'adaptive'], [7, 105], [-7, 105], [14, 105], [-14, 105], [14, 'adaptive'], [-14, 'adaptive']]) {
      if (shouldCancel()) return null;
      const { data } = await worker.recognize(prepImage(processed, snapshot, snapshot.width, snapshot.height, angle, threshold));
      const id = normalizeId(data.text);
      if (id) return id;
    }
    return null;
  };
  const result = ocrQueue.then(run, run);
  ocrQueue = result.catch(() => {});
  return result;
}
function handleDetected(id) {
  if (showRecord(id)) return true;
  stopCamera();
  document.querySelector('#cycleId').value = id;
  return false;
}
async function scanFrame(current) {
  if (!scanning || current !== generation) return;
  try {
    if (video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth) {
      // Limit the inexpensive machine-code check; OCR uses a separate sharper frame.
      const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
      const machineId = normalizeId(code?.data || '');
      const id = machineId || await readImage(video, video.videoWidth, video.videoHeight, () => !scanning || current !== generation);
      if (!scanning || current !== generation) return;
      if (machineId) { handleDetected(machineId); return; }
      if (id) {
        candidateCount = candidateId === id ? candidateCount + 1 : 1; candidateId = id;
        if (candidateCount >= 2) { handleDetected(id); return; }
        setNotice(null, 'Code found. Hold steady to confirm…');
      } else {
        candidateId = null; candidateCount = 0;
        if (++missedFrames >= 4) setNotice('SCAN-01', 'Code not clear yet. Move closer, hold steady and use good light.');
      }
    }
  } catch (_) {
    if (current === generation) { stopCamera(); setNotice('SCAN-02', 'Recognition stopped. Try again, choose a photo or enter the code.'); }
    return;
  }
  if (scanning && current === generation) setTimeout(() => scanFrame(current), candidateCount ? 100 : 250);
}
scanButton.addEventListener('click', async () => {
  if (scanning || starting) { stopCamera(); hint.textContent = 'Place the cycle code inside the frame'; setNotice(null, ''); return; }
  if (!navigator.mediaDevices?.getUserMedia) {
    setNotice('CAM-05', 'Camera unavailable. Open the HTTPS link in a browser or choose a photo.'); return;
  }
  const current = ++generation; starting = true;
  setNotice(null, 'Preparing scanner…'); scanButton.querySelector('span').textContent = 'Close camera';
  try {
    const nextStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    if (current !== generation) { nextStream.getTracks().forEach(track => track.stop()); return; }
    stream = nextStream; video.srcObject = stream; await video.play();
    if (current !== generation) return;
    const track = stream.getVideoTracks()[0];
    try { const caps = track.getCapabilities?.(); if (caps?.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (_) { /* autofocus is optional */ }
    if (current !== generation) return;
    track.addEventListener('ended', () => { if (scanning && current === generation) { stopCamera(); setNotice('CAM-06', 'Camera stopped. Reopen it or choose a photo.'); } }, { once: true });
    starting = false; scanning = true; camera.classList.add('active');
    hint.textContent = 'Hold the code steady and in focus'; scanButton.querySelector('span').textContent = 'Close camera';
  } catch (error) {
    if (current !== generation) return;
    stopCamera(); const [code, message] = cameraError(error); setNotice(code, message); return;
  }
  try {
    await getWorker(); if (!scanning || current !== generation) return;
    setNotice(null, 'Looking for a cycle code…'); scanFrame(current);
  } catch (_) {
    if (current !== generation) return;
    stopCamera(); setNotice('OCR-01', 'Recognition could not load. Check your connection and try again.');
  }
});
document.querySelector('#imageInput').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  stopCamera(); const current = generation; setNotice(null, 'Reading photo…');
  const url = URL.createObjectURL(file); const img = new Image();
  try {
    img.src = url; await img.decode();
  } catch (_) {
    if (current === generation) setNotice('IMG-01', 'Could not open this image. Choose another photo or enter the code.');
    URL.revokeObjectURL(url); event.target.value = ''; return;
  }
  try {
    const id = await readImage(img, img.naturalWidth, img.naturalHeight, () => current !== generation);
    if (current !== generation) return;
    if (id) handleDetected(id); else setNotice('SCAN-01', 'Could not read the code. Use a sharper, well-lit photo or enter it below.');
  } catch (_) {
    if (current === generation) setNotice('OCR-01', 'Recognition could not load. Check your connection and try again.');
  } finally { URL.revokeObjectURL(url); event.target.value = ''; }
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
