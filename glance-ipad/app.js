/* Glance for iPad — face-gated private notes (PWA).
 *
 * Everything runs on-device: face-api.js (vendored) for detection / landmarks /
 * 128-d embeddings, WebCrypto for storage encryption, IndexedDB for persistence.
 * Nothing is sent over the network.
 *
 * Security model (see the in-app note): a web app cannot unlock iPadOS itself and
 * a 2D camera is weaker than Face ID. Face unlock here is a convenience gate for
 * the notes in this app; the 6-digit passcode is always the fallback.
 */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────────── i18n ───────────────────────────── */
const I18N = {
  en: {
    welcome: 'Welcome to Glance',
    welcomeBody: 'Lock your private notes behind your face, with a passcode as backup. Everything stays on this iPad.',
    createPin: 'Create a 6-digit passcode',
    confirmPin: 'Confirm your passcode',
    pinWhy: 'The passcode is your backup if face unlock fails, and it protects your data if the face unlock is turned off.',
    pinMismatch: 'Passcodes did not match. Try again.',
    enrollTitle: 'Set up Face Unlock',
    skipFace: 'Skip, passcode only',
    startEnroll: 'Start',
    scanAgain: 'Scan again',
    usePin: 'Use passcode',
    vaultTitle: 'Private Notes',
    newNote: 'New',
    settings: 'Settings',
    lockNow: 'Lock',
    titlePh: 'Title',
    bodyPh: 'Write something private…',
    delete: 'Delete',
    faceUnlock: 'Face unlock',
    liveness: 'Liveness check',
    liveOff: 'Off',
    liveLight: 'Light (1 head turn)',
    liveHeavy: 'Heavy (2 head turns)',
    strictness: 'Match strictness',
    strict: 'Strict',
    normal: 'Normal',
    relaxed: 'Relaxed',
    autoLock: 'Auto-lock after',
    onLeave: 'Only when leaving the app',
    language: 'Language',
    reenroll: 'Re-enroll face',
    addLook: 'Add another look',
    changePin: 'Change passcode',
    wipe: 'Erase everything',
    honesty: 'Glance is a convenience lock, not a security upgrade. An iPad camera sees a flat 2D image, so a video of you may fool it, and a web app cannot unlock iPadOS itself. For anything sensitive rely on your passcode and Face ID / Touch ID.',
    done: 'Done',
    cancel: 'Cancel',
    lookAtCamera: 'Look at the camera',
    moveCloser: 'Move a little closer',
    lookStraight: 'Look straight ahead',
    turnLeft: '← Turn your head toward the left',
    turnRight: 'Turn your head toward the right →',
    matching: 'Checking…',
    noMatch: 'Not recognised',
    scanFailed: 'Could not verify your face',
    camDenied: 'Camera unavailable. Use your passcode.',
    loadingModels: 'Loading face models…',
    unlocked: 'Unlocked',
    wrongPin: 'Wrong passcode',
    tooMany: 'Too many attempts. Try again in {s}s.',
    enrollFront: 'Look straight at the camera',
    enrollLeft: 'Slowly turn your head toward the left',
    enrollRight: 'Now toward the right',
    enrollFront2: 'Look straight again',
    holdStill: 'Hold still…',
    enrollDone: 'Face saved',
    enrollFailed: 'Could not capture your face. Try again in better light.',
    newPinPrompt: 'Enter a new 6-digit passcode',
    pinChanged: 'Passcode changed',
    wipeConfirm: 'Erase all notes, your face data and passcode from this iPad? This cannot be undone.',
    saved: 'Saved',
    untitled: 'Untitled',
    noNotes: 'No notes yet',
    faceLockedPin: 'Too many failed scans. Enter your passcode.',
    addLookTitle: 'Add another look',
    reenrollTitle: 'Re-enroll face',
    changePinTitle: 'Change passcode',
    enterCurrentPin: 'Enter your current passcode',
  },
  th: {
    welcome: 'ยินดีต้อนรับสู่ Glance',
    welcomeBody: 'ล็อกโน้ตส่วนตัวด้วยใบหน้าของคุณ โดยมีรหัสผ่านสำรอง ข้อมูลทั้งหมดอยู่ในไอแพดเครื่องนี้เท่านั้น',
    createPin: 'ตั้งรหัสผ่าน 6 หลัก',
    confirmPin: 'ยืนยันรหัสผ่านอีกครั้ง',
    pinWhy: 'รหัสผ่านใช้เป็นตัวสำรองเมื่อสแกนหน้าไม่ผ่าน และปกป้องข้อมูลเมื่อปิดการสแกนหน้า',
    pinMismatch: 'รหัสผ่านไม่ตรงกัน ลองอีกครั้ง',
    enrollTitle: 'ตั้งค่าการสแกนหน้า',
    skipFace: 'ข้าม ใช้รหัสผ่านอย่างเดียว',
    startEnroll: 'เริ่ม',
    scanAgain: 'สแกนอีกครั้ง',
    usePin: 'ใช้รหัสผ่าน',
    vaultTitle: 'โน้ตส่วนตัว',
    newNote: 'ใหม่',
    settings: 'ตั้งค่า',
    lockNow: 'ล็อก',
    titlePh: 'หัวข้อ',
    bodyPh: 'เขียนอะไรส่วนตัวที่นี่…',
    delete: 'ลบ',
    faceUnlock: 'ปลดล็อกด้วยใบหน้า',
    liveness: 'ตรวจว่าเป็นคนจริง',
    liveOff: 'ปิด',
    liveLight: 'เบา (หันหน้า 1 ครั้ง)',
    liveHeavy: 'เข้ม (หันหน้า 2 ครั้ง)',
    strictness: 'ความเข้มงวดในการเทียบหน้า',
    strict: 'เข้มงวด',
    normal: 'ปกติ',
    relaxed: 'ผ่อนปรน',
    autoLock: 'ล็อกอัตโนมัติหลัง',
    onLeave: 'เฉพาะตอนออกจากแอป',
    language: 'ภาษา',
    reenroll: 'ลงทะเบียนใบหน้าใหม่',
    addLook: 'เพิ่มลักษณะใบหน้า',
    changePin: 'เปลี่ยนรหัสผ่าน',
    wipe: 'ลบข้อมูลทั้งหมด',
    honesty: 'Glance เป็นตัวล็อกเพื่อความสะดวก ไม่ได้เพิ่มความปลอดภัย กล้องไอแพดเห็นภาพแบบ 2 มิติ วิดีโอของคุณอาจหลอกระบบได้ และเว็บแอปปลดล็อก iPadOS เองไม่ได้ ข้อมูลสำคัญให้พึ่งรหัสผ่านและ Face ID / Touch ID',
    done: 'เสร็จ',
    cancel: 'ยกเลิก',
    lookAtCamera: 'มองที่กล้อง',
    moveCloser: 'เขยิบเข้ามาใกล้อีกนิด',
    lookStraight: 'มองตรงไปข้างหน้า',
    turnLeft: '← หันหน้าไปทางซ้าย',
    turnRight: 'หันหน้าไปทางขวา →',
    matching: 'กำลังตรวจสอบ…',
    noMatch: 'ไม่รู้จักใบหน้านี้',
    scanFailed: 'ยืนยันใบหน้าไม่สำเร็จ',
    camDenied: 'ใช้กล้องไม่ได้ กรุณาใช้รหัสผ่าน',
    loadingModels: 'กำลังโหลดโมเดลใบหน้า…',
    unlocked: 'ปลดล็อกแล้ว',
    wrongPin: 'รหัสผ่านไม่ถูกต้อง',
    tooMany: 'ลองหลายครั้งเกินไป ลองใหม่ใน {s} วินาที',
    enrollFront: 'มองตรงที่กล้อง',
    enrollLeft: 'ค่อยๆ หันหน้าไปทางซ้าย',
    enrollRight: 'ตอนนี้หันไปทางขวา',
    enrollFront2: 'มองตรงอีกครั้ง',
    holdStill: 'อยู่นิ่งๆ…',
    enrollDone: 'บันทึกใบหน้าแล้ว',
    enrollFailed: 'จับภาพใบหน้าไม่สำเร็จ ลองใหม่ในที่ที่สว่างขึ้น',
    newPinPrompt: 'ใส่รหัสผ่านใหม่ 6 หลัก',
    pinChanged: 'เปลี่ยนรหัสผ่านแล้ว',
    wipeConfirm: 'ลบโน้ต ข้อมูลใบหน้า และรหัสผ่านทั้งหมดออกจากไอแพดเครื่องนี้ใช่ไหม? ย้อนกลับไม่ได้',
    saved: 'บันทึกแล้ว',
    untitled: 'ไม่มีชื่อ',
    noNotes: 'ยังไม่มีโน้ต',
    faceLockedPin: 'สแกนไม่ผ่านหลายครั้ง กรุณาใส่รหัสผ่าน',
    addLookTitle: 'เพิ่มลักษณะใบหน้า',
    reenrollTitle: 'ลงทะเบียนใบหน้าใหม่',
    changePinTitle: 'เปลี่ยนรหัสผ่าน',
    enterCurrentPin: 'ใส่รหัสผ่านปัจจุบัน',
  },
};
let lang = 'en';
const t = (k, vars) => {
  let s = (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k;
  if (vars) for (const [a, b] of Object.entries(vars)) s = s.replace(`{${a}}`, b);
  return s;
};
function applyI18n() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
}

/* ──────────────────────── IndexedDB key/value ──────────────────────── */
const DB_NAME = 'glance-ipad';
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  return dbp;
}
async function kv(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('kv', mode);
    const out = fn(tx.objectStore('kv'));
    tx.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    tx.onerror = () => rej(tx.error);
  });
}
const kvGet = (k) => kv('readonly', (s) => s.get(k));
const kvSet = (k, v) => kv('readwrite', (s) => s.put(v, k));
const kvClear = () => kv('readwrite', (s) => s.clear());

/* ───────────────────────────── Crypto ───────────────────────────── */
const enc = new TextEncoder();
const dec = new TextDecoder();
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pinKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv: toB64(iv), ct: toB64(ct) };
}
async function open(key, box) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.ct)));
}
const sealJSON = (key, obj) => seal(key, enc.encode(JSON.stringify(obj)));
const openJSON = async (key, box) => JSON.parse(dec.decode(await open(key, box)));
const importVaultKey = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

/* ───────────────────────────── State ───────────────────────────── */
const DEFAULTS = { face: true, live: 1, thr: 0.5, idle: 5, lang: null };
let meta = null;        // persisted config + wrapped keys
let faces = null;       // { descs: number[][] } (decrypted on demand for matching)
let session = null;     // { raw: Uint8Array, key: CryptoKey } while unlocked
let notes = [];
let curNote = null;
let faceStrikes = 0;    // failed face scans since last passcode success
let idleTimer = null;

const saveMeta = () => kvSet('meta', meta);

/* ───────────────────────── Passcode keypad ───────────────────────── */
function makeKeypad(padEl, dotsEl, onComplete) {
  let val = '';
  dotsEl.innerHTML = '<i></i>'.repeat(6);
  const paint = () => [...dotsEl.children].forEach((d, i) => d.classList.toggle('on', i < val.length));
  const press = (k) => {
    if (k === 'del') val = val.slice(0, -1);
    else if (val.length < 6) val += k;
    paint();
    if (val.length === 6) { const v = val; setTimeout(() => onComplete(v), 80); }
  };
  padEl.innerHTML = '';
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].forEach((k) => {
    const b = document.createElement('button');
    b.type = 'button';
    if (k === '') b.className = 'blank';
    else if (k === 'del') { b.className = 'fn'; b.textContent = '⌫'; b.setAttribute('aria-label', 'Delete'); }
    else b.textContent = k;
    if (k) b.addEventListener('click', () => press(k));
    padEl.appendChild(b);
  });
  return {
    reset() { val = ''; paint(); },
    shake() {
      dotsEl.classList.remove('shake'); void dotsEl.offsetWidth; dotsEl.classList.add('shake');
      val = ''; setTimeout(paint, 300);
    },
  };
}

/* ───────────────────────────── Camera ───────────────────────────── */
const camWrap = $('camWrap');
const cam = $('cam');
const ringFg = $('ringFg');
const Cam = {
  async start() {
    if (cam.srcObject) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('no-camera');
    cam.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
    });
    await cam.play();
    for (let i = 0; i < 50 && !cam.videoWidth; i++) await sleep(50);
  },
  stop() {
    const s = cam.srcObject;
    if (s) s.getTracks().forEach((tr) => tr.stop());
    cam.srcObject = null;
    camWrap.hidden = true;
  },
  mount(el) { el.appendChild(camWrap); camWrap.hidden = false; ring(0); },
};
function ring(p, state) {
  camWrap.classList.toggle('ok', state === 'ok');
  camWrap.classList.toggle('bad', state === 'bad');
  ringFg.style.strokeDashoffset = state ? 0 : 100 - 100 * Math.max(0, Math.min(1, p));
}

/* ──────────────────────────── Face engine ──────────────────────────── */
const MODEL_URL = 'vendor/models';
const MIN_FACE = 0.16; // face width as a fraction of the frame; smaller faces give unreliable embeddings
const Face = {
  ready: null,
  load() {
    if (!this.ready) {
      this.ready = (async () => {
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
          faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
        ]);
        this.opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
      })().catch((e) => { this.ready = null; throw e; });
    }
    return this.ready;
  },
  async detect(withDescriptor) {
    if (!cam.videoWidth) return null;
    let task = faceapi.detectSingleFace(cam, this.opts).withFaceLandmarks();
    if (withDescriptor) task = task.withFaceDescriptor();
    const r = await task;
    if (!r) return null;
    r.sizeRatio = r.detection.box.width / cam.videoWidth;
    r.yaw = yawOf(r.landmarks);
    return r;
  },
};
// Nose position relative to the jaw midpoint, normalised by jaw width. Raw video
// coordinates (not mirrored): positive = nose toward larger x = appears at the
// LEFT of the mirrored preview.
function yawOf(lm) {
  const p = lm.positions;
  const l = p[0].x, r = p[16].x;
  return (p[30].x - (l + r) / 2) / (r - l);
}
function minDist(desc, list) {
  let best = Infinity;
  for (const d of list) best = Math.min(best, faceapi.euclideanDistance(desc, d));
  return best;
}

/* Run `step()` ~15x/s until it returns a value other than undefined or token cancels. */
async function loop(token, timeoutMs, step) {
  const t0 = performance.now();
  while (!token.cancelled) {
    if (performance.now() - t0 > timeoutMs) return { ok: false, reason: 'timeout' };
    const out = await step();
    if (out !== undefined) return out;
    await sleep(40);
  }
  return { ok: false, reason: 'cancelled' };
}

/* Enrollment: returns array of 128-d descriptors, or null. */
async function captureSteps(steps, token, say) {
  const out = [];
  let base = null;
  for (let si = 0; si < steps.length; si++) {
    const st = steps[si];
    say(t(st.prompt));
    let stable = 0, got = 0, lastCap = 0;
    const res = await loop(token, 25000, async () => {
      const r = await Face.detect(true);
      if (!r || r.sizeRatio < MIN_FACE || r.detection.score < 0.6) { stable = 0; return undefined; }
      const dy = base == null ? r.yaw : r.yaw - base;
      const poseOk = st.pose === 'front' ? Math.abs(base == null ? r.yaw : dy) < 0.09
        : st.pose === 'left' ? dy > 0.1 && dy < 0.35
        : dy < -0.1 && dy > -0.35;
      if (!poseOk) { stable = 0; return undefined; }
      if (++stable < 3) return undefined;
      if (performance.now() - lastCap < 250) return undefined;
      lastCap = performance.now();
      out.push(Array.from(r.descriptor));
      if (st.pose === 'front' && base == null) base = r.yaw;
      got++;
      ring((si + got / st.shots) / steps.length);
      if (got >= st.shots) return { ok: true };
      say(t('holdStill'));
      return undefined;
    });
    if (!res.ok) return null;
  }
  return out;
}
const ENROLL_STEPS = [
  { pose: 'front', prompt: 'enrollFront', shots: 3 },
  { pose: 'left', prompt: 'enrollLeft', shots: 2 },
  { pose: 'right', prompt: 'enrollRight', shots: 2 },
  { pose: 'front', prompt: 'enrollFront2', shots: 2 },
];
const ADD_STEPS = [{ pose: 'front', prompt: 'enrollFront', shots: 3 }];

/* Unlock scan with random head-turn liveness. */
async function scanUnlock(token, say) {
  const descs = faces.descs;
  const thr = meta.settings.thr;
  const level = meta.settings.live;
  const challenges = [];
  const pool = ['left', 'right'];
  for (let i = 0; i < level; i++) challenges.push(pool[crypto.getRandomValues(new Uint8Array(1))[0] & 1]);

  let phase = 'search', hits = 0, lost = 0, bad = 0, tick = 0, ci = 0;
  let yawBase = null, baseSamples = [];
  const total = 3 + challenges.length;

  return loop(token, level ? 30000 : 12000, async () => {
    tick++;
    const wantDesc = phase === 'search' || tick % 4 === 0;
    const r = await Face.detect(wantDesc);
    if (!r || r.sizeRatio < MIN_FACE) {
      if (phase === 'challenge' && ++lost > 25) return { ok: false, reason: 'lost' };
      hits = phase === 'search' ? 0 : hits;
      say(t(r ? 'moveCloser' : 'lookAtCamera'));
      return undefined;
    }
    lost = 0;

    if (phase === 'search') {
      const d = minDist(r.descriptor, descs);
      if (d < thr) {
        hits++;
        say(t('matching'));
        ring(hits / total);
        if (hits >= 3) {
          if (!challenges.length) return { ok: true };
          phase = 'challenge'; yawBase = null; baseSamples = []; ci = 0;
        }
      } else { hits = 0; ring(0); say(t('noMatch')); }
      return undefined;
    }

    // Identity must keep holding while the user performs the challenge.
    if (r.descriptor) {
      if (minDist(r.descriptor, descs) > thr + 0.06) { if (++bad >= 2) return { ok: false, reason: 'mismatch' }; }
      else bad = 0;
    }
    if (yawBase == null) {
      say(t('lookStraight'));
      baseSamples.push(r.yaw);
      if (baseSamples.length >= 4) yawBase = baseSamples.reduce((a, b) => a + b, 0) / baseSamples.length;
      return undefined;
    }
    const kind = challenges[ci];
    say(t(kind === 'left' ? 'turnLeft' : 'turnRight'));
    const dy = r.yaw - yawBase;
    const passed = kind === 'left' ? dy > 0.14 : dy < -0.14;
    if (!passed) return undefined;
    // Re-verify identity at the instant the challenge is completed.
    const v = await Face.detect(true);
    if (!v || minDist(v.descriptor, descs) >= thr) return { ok: false, reason: 'mismatch' };
    ci++; yawBase = null; baseSamples = [];
    ring((3 + ci) / total);
    if (ci >= challenges.length) return { ok: true };
    return undefined;
  });
}

/* ───────────────────────────── Screens ───────────────────────────── */
const screens = ['onboard', 'lock', 'vault'];
function show(name) {
  screens.forEach((s) => { $('screen-' + s).hidden = s !== name; });
  if (name === 'vault') Cam.stop();
}

/* ───────────────────────── Vault lifecycle ───────────────────────── */
async function createVault(pin) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const devKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await kvSet('deviceKey', devKey);
  meta = {
    v: 1,
    salt: toB64(salt),
    pinWrap: await seal(await pinKey(pin, salt), raw),
    devWrap: await seal(devKey, raw),
    fails: 0,
    lockUntil: 0,
    hasFace: false,
    settings: { ...DEFAULTS, lang },
  };
  await saveMeta();
  await kvSet('notes', await sealJSON(await importVaultKey(raw), []));
  return raw;
}
async function openSession(raw) {
  session = { raw, key: await importVaultKey(raw) };
  const box = await kvGet('notes');
  notes = box ? await openJSON(session.key, box) : [];
  curNote = notes[0] || null;
  faceStrikes = 0;
  renderVault();
  show('vault');
  armIdle();
}
function lockNow() {
  if (session) session.raw.fill(0);
  session = null; notes = []; curNote = null;
  clearTimeout(idleTimer);
  $('v-title').value = ''; $('v-body').value = '';
  if ($('dlg-settings').open) $('dlg-settings').close();
  if ($('dlg-flow').open) $('dlg-flow').close();
  enterLock();
}
function armIdle() {
  clearTimeout(idleTimer);
  const m = meta && meta.settings.idle;
  if (session && m > 0) idleTimer = setTimeout(lockNow, m * 60000);
}
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { if (session) armIdle(); }, { passive: true }));
document.addEventListener('visibilitychange', () => { if (document.hidden && session) lockNow(); });
window.addEventListener('pagehide', () => { if (session) lockNow(); });

/* Face descriptors are sealed with the device key so they can be read at the lock screen. */
async function loadFaces() {
  faces = null;
  const box = await kvGet('faces');
  const dk = await kvGet('deviceKey');
  if (box && dk) { try { faces = await openJSON(dk, box); } catch { faces = null; } }
}
async function saveFaces(descs) {
  const dk = await kvGet('deviceKey');
  faces = { descs };
  await kvSet('faces', await sealJSON(dk, faces));
  meta.hasFace = true;
  await saveMeta();
}

/* ───────────────────────────── Lock screen ───────────────────────────── */
let scanToken = { cancelled: true };
let lockPad = null;
let clockTimer = null;

function tickClock() {
  $('clock').textContent = new Date().toLocaleTimeString(lang === 'th' ? 'th-TH' : undefined, { hour: '2-digit', minute: '2-digit' });
}
function lockSay(s) { $('lock-prompt').textContent = s; }

async function enterLock() {
  show('lock');
  tickClock(); clearInterval(clockTimer); clockTimer = setInterval(tickClock, 15000);
  scanToken.cancelled = true;
  $('lock-pin').hidden = true;
  $('lock-retry').hidden = true;
  $('lock-usepin').hidden = false;
  $('lk-msg').textContent = '';
  if (!lockPad) lockPad = makeKeypad($('lk-keypad'), $('lk-dots'), tryPin);
  lockPad.reset();
  await loadFaces();
  const useFace = meta.settings.face && faces && faceStrikes < 3;
  if (useFace) startFaceScan();
  else {
    lockSay(faceStrikes >= 3 ? t('faceLockedPin') : '');
    showPin();
  }
}
function showPin() {
  scanToken.cancelled = true;
  Cam.stop();
  $('lock-stage').innerHTML = '';
  $('lock-pin').hidden = false;
  $('lock-usepin').hidden = true;
  $('lock-retry').hidden = true;
}
$('lock-usepin').addEventListener('click', () => { lockSay(''); showPin(); });
$('lock-retry').addEventListener('click', () => { $('lock-retry').hidden = true; startFaceScan(); });

async function startFaceScan() {
  const token = scanToken = { cancelled: false };
  $('lock-pin').hidden = true;
  $('lock-usepin').hidden = false;
  $('lock-retry').hidden = true;
  try {
    lockSay(t('loadingModels'));
    await Face.load();
    if (token.cancelled) return;
    Cam.mount($('lock-stage')); // mount before start: iOS won't play a display:none video
    await Cam.start();
  } catch (e) {
    if (token.cancelled) return;
    lockSay(t('camDenied'));
    showPin();
    return;
  }
  if (token.cancelled) { Cam.stop(); return; }
  lockSay(t('lookAtCamera'));
  let res;
  try { res = await scanUnlock(token, lockSay); } catch (e) { res = { ok: false, reason: 'error' }; }
  if (token.cancelled) return;
  if (res.ok) {
    ring(1, 'ok');
    lockSay(t('unlocked'));
    try {
      const dk = await kvGet('deviceKey');
      const raw = await open(dk, meta.devWrap);
      await sleep(350);
      Cam.stop();
      await openSession(raw);
    } catch (e) { showPin(); }
    return;
  }
  ring(0, 'bad');
  faceStrikes++;
  Cam.stop(); // release the camera; the last frame is not shown
  $('lock-stage').innerHTML = '';
  lockSay(res.reason === 'mismatch' || res.reason === 'timeout' ? t('noMatch') : t('scanFailed'));
  if (faceStrikes >= 3) { lockSay(t('faceLockedPin')); showPin(); }
  else $('lock-retry').hidden = false;
}

async function tryPin(pin) {
  const now = Date.now();
  if (meta.lockUntil > now) {
    $('lk-msg').textContent = t('tooMany', { s: Math.ceil((meta.lockUntil - now) / 1000) });
    lockPad.shake();
    return;
  }
  try {
    const key = await pinKey(pin, fromB64(meta.salt));
    const raw = await open(key, meta.pinWrap);
    meta.fails = 0; meta.lockUntil = 0; await saveMeta();
    await openSession(raw);
  } catch {
    meta.fails++;
    if (meta.fails >= 5) meta.lockUntil = Date.now() + Math.min(3600, 30 * 2 ** (meta.fails - 5)) * 1000;
    await saveMeta();
    lockPad.shake();
    $('lk-msg').textContent = meta.lockUntil > Date.now()
      ? t('tooMany', { s: Math.ceil((meta.lockUntil - Date.now()) / 1000) }) : t('wrongPin');
  }
}

/* ───────────────────────────── Notes UI ───────────────────────────── */
let saveT = null;
function renderVault() {
  const ul = $('v-list');
  ul.innerHTML = '';
  if (!notes.length) {
    const li = document.createElement('li'); li.className = 'muted'; li.textContent = t('noNotes'); ul.appendChild(li);
  }
  notes.forEach((n) => {
    const li = document.createElement('li');
    if (n === curNote) li.className = 'sel';
    const b = document.createElement('b'); b.textContent = n.title || t('untitled');
    const s = document.createElement('span'); s.textContent = (n.body || '').split('\n')[0] || '—';
    li.append(b, s);
    li.addEventListener('click', () => { flushNote(); curNote = n; renderVault(); });
    ul.appendChild(li);
  });
  $('v-title').value = curNote ? curNote.title : '';
  $('v-body').value = curNote ? curNote.body : '';
  $('v-title').disabled = $('v-body').disabled = $('v-del').disabled = !curNote;
}
async function persistNotes() {
  if (!session) return;
  await kvSet('notes', await sealJSON(session.key, notes));
  $('v-status').textContent = t('saved');
}
function flushNote() { if (saveT) { clearTimeout(saveT); saveT = null; persistNotes(); } }
function onEdit() {
  if (!curNote) return;
  curNote.title = $('v-title').value; curNote.body = $('v-body').value; curNote.ts = Date.now();
  $('v-status').textContent = '…';
  clearTimeout(saveT);
  saveT = setTimeout(() => { saveT = null; persistNotes(); renderListOnly(); }, 400);
}
function renderListOnly() {
  const sel = $('v-list').querySelectorAll('li');
  notes.forEach((n, i) => {
    if (!sel[i] || n !== curNote) return;
    sel[i].querySelector('b').textContent = n.title || t('untitled');
    sel[i].querySelector('span').textContent = (n.body || '').split('\n')[0] || '—';
  });
}
$('v-title').addEventListener('input', onEdit);
$('v-body').addEventListener('input', onEdit);
$('v-new').addEventListener('click', () => {
  flushNote();
  curNote = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), title: '', body: '', ts: Date.now() };
  notes.unshift(curNote);
  persistNotes(); renderVault(); $('v-title').focus();
});
$('v-del').addEventListener('click', () => {
  if (!curNote) return;
  notes = notes.filter((n) => n !== curNote);
  curNote = notes[0] || null;
  persistNotes(); renderVault();
});
$('v-lock').addEventListener('click', () => { flushNote(); lockNow(); });

/* ───────────────────────── Enrollment dialogs ───────────────────────── */
const dlgFlow = $('dlg-flow');
let flowToken = { cancelled: true };
dlgFlow.addEventListener('close', () => { flowToken.cancelled = true; Cam.stop(); });
$('flow-cancel').addEventListener('click', () => { flowToken.cancelled = true; dlgFlow.close(); });

async function runEnroll(steps, stageEl, say, append) {
  const token = flowToken = { cancelled: false };
  say(t('loadingModels'));
  try {
    await Face.load();
    if (token.cancelled) return false;
    Cam.mount(stageEl); // mount before start: iOS won't play a display:none video
    await Cam.start();
  } catch { Cam.stop(); say(t('camDenied')); return false; }
  if (token.cancelled) { Cam.stop(); return false; }
  const descs = await captureSteps(steps, token, say);
  Cam.stop();
  if (!descs) { if (!token.cancelled) say(t('enrollFailed')); return false; }
  await loadFaces();
  await saveFaces(append && faces ? faces.descs.concat(descs) : descs);
  return true;
}
async function flowEnroll(titleKey, steps, append) {
  $('flow-title').textContent = t(titleKey);
  $('flow-pin').hidden = true;
  $('flow-stage').hidden = false;
  $('flow-prompt').textContent = '';
  dlgFlow.showModal();
  const ok = await runEnroll(steps, $('flow-stage'), (s) => { $('flow-prompt').textContent = s; }, append);
  if (ok) {
    $('flow-prompt').textContent = t('enrollDone');
    meta.settings.face = true; await saveMeta(); syncSettingsUI();
    await sleep(900);
    dlgFlow.close();
  }
}

/* Passcode change: ask new PIN twice, then re-wrap the vault key. */
function flowChangePin() {
  $('flow-title').textContent = t('changePinTitle');
  $('flow-stage').hidden = true;
  $('flow-pin').hidden = false;
  $('flow-prompt').textContent = t('newPinPrompt');
  let first = null;
  const pad = makeKeypad($('fl-keypad'), $('fl-dots'), async (pin) => {
    if (first == null) { first = pin; pad.reset(); $('flow-prompt').textContent = t('confirmPin'); return; }
    if (pin !== first) { first = null; pad.shake(); $('flow-prompt').textContent = t('pinMismatch'); return; }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    meta.salt = toB64(salt);
    meta.pinWrap = await seal(await pinKey(pin, salt), session.raw);
    meta.fails = 0; meta.lockUntil = 0;
    await saveMeta();
    $('flow-prompt').textContent = t('pinChanged');
    await sleep(900);
    dlgFlow.close();
  });
  dlgFlow.showModal();
}

/* ───────────────────────────── Settings ───────────────────────────── */
const dlgSet = $('dlg-settings');
function syncSettingsUI() {
  const s = meta.settings;
  $('s-face').checked = !!s.face && !!meta.hasFace;
  $('s-live').value = String(s.live);
  $('s-thr').value = s.thr.toFixed(2);
  $('s-idle').value = String(s.idle);
  $('s-lang').value = lang;
  $('s-addlook').disabled = !meta.hasFace;
}
$('v-settings').addEventListener('click', () => { flushNote(); syncSettingsUI(); dlgSet.showModal(); });
$('s-face').addEventListener('change', async (e) => {
  if (e.target.checked && !meta.hasFace) { e.target.checked = false; dlgSet.close(); flowEnroll('reenrollTitle', ENROLL_STEPS, false); return; }
  meta.settings.face = e.target.checked; await saveMeta();
});
$('s-live').addEventListener('change', async (e) => { meta.settings.live = +e.target.value; await saveMeta(); });
$('s-thr').addEventListener('change', async (e) => { meta.settings.thr = +e.target.value; await saveMeta(); });
$('s-idle').addEventListener('change', async (e) => { meta.settings.idle = +e.target.value; await saveMeta(); armIdle(); });
$('s-lang').addEventListener('change', async (e) => {
  lang = meta.settings.lang = e.target.value; await saveMeta(); applyI18n(); syncSettingsUI(); renderVault();
});
$('s-reenroll').addEventListener('click', () => { dlgSet.close(); flowEnroll('reenrollTitle', ENROLL_STEPS, false); });
$('s-addlook').addEventListener('click', () => { dlgSet.close(); flowEnroll('addLookTitle', ADD_STEPS, true); });
$('s-changepin').addEventListener('click', () => { dlgSet.close(); flowChangePin(); });
$('s-wipe').addEventListener('click', async () => {
  if (!confirm(t('wipeConfirm'))) return;
  await kvClear();
  clearTimeout(idleTimer);
  meta = null; faces = null; session = null; notes = []; curNote = null; faceStrikes = 0;
  dlgSet.close();
  Cam.stop();
  startOnboarding();
});

/* ───────────────────────────── Onboarding ───────────────────────────── */
let obPad = null, obFirst = null, obRaw = null;
function startOnboarding() {
  show('onboard');
  $('ob-pin').hidden = false; $('ob-face').hidden = true;
  $('ob-msg').textContent = '';
  obFirst = null; obRaw = null;
  document.querySelector('#ob-pin h2').textContent = t('createPin');
  obPad = makeKeypad($('ob-keypad'), $('ob-dots'), async (pin) => {
    if (obFirst == null) {
      obFirst = pin; obPad.reset();
      document.querySelector('#ob-pin h2').textContent = t('confirmPin');
      $('ob-msg').textContent = '';
      return;
    }
    if (pin !== obFirst) {
      obFirst = null; obPad.shake();
      document.querySelector('#ob-pin h2').textContent = t('createPin');
      $('ob-msg').textContent = t('pinMismatch');
      return;
    }
    obRaw = await createVault(pin);
    $('ob-pin').hidden = true; $('ob-face').hidden = false;
    $('ob-prompt').textContent = '';
    $('ob-start').disabled = false;
  });
}
$('ob-skip').addEventListener('click', async () => {
  meta.settings.face = false; await saveMeta();
  await openSession(obRaw); obRaw = null;
});
$('ob-start').addEventListener('click', async () => {
  $('ob-start').disabled = true;
  const ok = await runEnroll(ENROLL_STEPS, $('ob-stage'), (s) => { $('ob-prompt').textContent = s; }, false);
  if (ok) {
    $('ob-prompt').textContent = t('enrollDone');
    await sleep(900);
    $('ob-stage').innerHTML = '';
    await openSession(obRaw); obRaw = null;
  } else $('ob-start').disabled = false;
});

/* ───────────────────────────── Boot ───────────────────────────── */
async function boot() {
  const stored = await kvGet('meta').catch(() => null);
  meta = stored || null;
  lang = (meta && meta.settings.lang)
    || ((navigator.language || 'en').toLowerCase().startsWith('th') ? 'th' : 'en');
  applyI18n();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!meta) startOnboarding(); else enterLock();
}
boot();
})();
