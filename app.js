'use strict';

/* =========================================================
   맛집기록 — 사진 + 위치로 가게를 찾고 폰에 기록하는 앱
   저장: 이 기기 브라우저의 IndexedDB
   검색: 카카오 지도 JavaScript SDK (services 라이브러리)
   ========================================================= */

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayStr = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ---------------- 저장소 (IndexedDB) ---------------- */
const STORE = 'visits';
let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const r = indexedDB.open('food-log', 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbPromise;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req ? req.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const getAll = () => tx('readonly', s => s.getAll());
const getOne = id => tx('readonly', s => s.get(id));
const putRec = v => tx('readwrite', s => s.put(v));
const delRec = id => tx('readwrite', s => s.delete(id));

// 브라우저가 저장공간을 임의로 지우지 않도록 요청
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

/* ---------------- 사진 처리 ---------------- */
// JPEG의 EXIF에서 GPS 좌표와 촬영일 읽기
function readExif(buf) {
  try {
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xFFD8) return null;
    let off = 2;
    while (off + 4 <= v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) return null;
      const size = v.getUint16(off + 2);
      if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
      off += 2 + size;
    }
  } catch (e) { /* 읽을 수 없는 사진은 무시 */ }
  return null;
}
function parseTiff(v, start) {
  const le = v.getUint16(start) === 0x4949;
  const u16 = o => v.getUint16(start + o, le);
  const u32 = o => v.getUint32(start + o, le);
  const readIfd = o => {
    const n = u16(o), tags = {};
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      tags[u16(e)] = { count: u32(e + 4), valOff: e + 8 };
    }
    return tags;
  };
  const ascii = t => {
    const o = t.count > 4 ? u32(t.valOff) : t.valOff;
    let s = '';
    for (let i = 0; i < t.count; i++) {
      const c = v.getUint8(start + o + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const rats = t => {
    const o = u32(t.valOff), a = [];
    for (let i = 0; i < t.count; i++) a.push(u32(o + i * 8) / u32(o + i * 8 + 4));
    return a;
  };
  const out = {};
  const ifd0 = readIfd(u32(4));
  if (ifd0[0x8769]) {
    const ex = readIfd(u32(ifd0[0x8769].valOff));
    if (ex[0x9003]) {
      const m = ascii(ex[0x9003]).match(/^(\d{4}):(\d{2}):(\d{2})(?: (\d{2}):(\d{2}))?/);
      if (m) {
        out.date = `${m[1]}-${m[2]}-${m[3]}`;
        if (m[4]) out.time = `${m[4]}:${m[5]}`;
      }
    }
  }
  if (ifd0[0x8825]) {
    const g = readIfd(u32(ifd0[0x8825].valOff));
    if (g[2] && g[4]) {
      const la = rats(g[2]), lo = rats(g[4]);
      let lat = la[0] + la[1] / 60 + la[2] / 3600;
      let lng = lo[0] + lo[1] / 60 + lo[2] / 3600;
      if (g[1] && ascii(g[1]) === 'S') lat = -lat;
      if (g[3] && ascii(g[3]) === 'W') lng = -lng;
      if (isFinite(lat) && isFinite(lng) && (lat || lng)) out.gps = { lat, lng };
    }
  }
  return out;
}

// 저장 공간 절약을 위해 긴 변 1280px JPEG로 줄이기
async function compress(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const max = 1280;
    const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * sc);
    c.height = Math.round(img.naturalHeight * sc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
    return blob || file;
  } catch (e) {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function processFiles(fileList) {
  const files = [...fileList];
  const out = { photos: [], gps: null, date: null, time: null };
  for (const f of files) {
    if (!out.gps || !out.date) {
      const meta = readExif(await f.slice(0, 256 * 1024).arrayBuffer());
      if (meta) {
        out.gps = out.gps || meta.gps || null;
        if (!out.date && meta.date) { out.date = meta.date; out.time = meta.time || null; }
      }
    }
    out.photos.push(await compress(f));
  }
  return out;
}

// 화면에 띄운 사진 URL은 화면을 바꿀 때 정리
let liveUrls = [];
function objUrl(blob) { const u = URL.createObjectURL(blob); liveUrls.push(u); return u; }
function revokeAll() { liveUrls.forEach(u => URL.revokeObjectURL(u)); liveUrls = []; }

/* ---------------- 카카오 장소 검색 ---------------- */
let kakaoPromise = null;
// 직접 넣은 키가 있으면 그것, 없으면 config.js의 기본 키
const kakaoKey = () => localStorage.getItem('kakaoKey') || window.KAKAO_KEY || '';
function loadKakao() {
  const key = kakaoKey();
  if (!key) return Promise.reject(new Error('NOKEY'));
  if (kakaoPromise) return kakaoPromise;
  kakaoPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&libraries=services&autoload=false`;
    s.onload = () => {
      if (!window.kakao || !kakao.maps) { kakaoPromise = null; return rej(new Error('LOAD')); }
      kakao.maps.load(() => res(new kakao.maps.services.Places()));
    };
    s.onerror = () => { kakaoPromise = null; s.remove(); rej(new Error('LOAD')); };
    document.head.appendChild(s);
  });
  return kakaoPromise;
}
function kakaoErrorMsg(e) {
  if (e && e.message === 'NOKEY') return '설정(⚙)에서 카카오 키를 먼저 넣어주세요.';
  if (e && e.message === 'LOAD') return '카카오 연결 실패: 키가 틀렸거나, 카카오 개발자 사이트에 이 주소(도메인)가 등록되지 않았어요.';
  return '검색 중 문제가 생겼어요. 잠시 후 다시 해보세요.';
}

async function searchNearby(lat, lng) {
  const ps = await loadKakao();
  const S = kakao.maps.services;
  const loc = new kakao.maps.LatLng(lat, lng);
  const byCategory = code => new Promise(res =>
    ps.categorySearch(code, (data, status) => res(status === S.Status.OK ? data : []),
      { location: loc, radius: 200, sort: S.SortBy.DISTANCE }));
  const [food, cafe] = await Promise.all([byCategory('FD6'), byCategory('CE7')]);
  return [...food, ...cafe].sort((a, b) => (+a.distance) - (+b.distance)).slice(0, 15);
}

async function searchKeyword(q, coords) {
  const ps = await loadKakao();
  const S = kakao.maps.services;
  const opt = { size: 15 };
  if (coords) opt.location = new kakao.maps.LatLng(coords.lat, coords.lng);
  return new Promise((res, rej) => ps.keywordSearch(q, (data, status) => {
    if (status === S.Status.OK) res(data);
    else if (status === S.Status.ZERO_RESULT) res([]);
    else rej(new Error('SEARCH'));
  }, opt));
}

function getHere() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('이 브라우저는 위치 기능을 지원하지 않아요.'));
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
      e => rej(new Error(e.code === 1 ? '위치 권한이 꺼져 있어요. 브라우저 설정에서 위치를 허용해 주세요.' : '현재 위치를 가져오지 못했어요.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });
}

const lastCat = c => (c || '').split('>').pop().trim();
const shortAddr = a => (a || '').split(/\s+/).slice(0, 2).join(' ');
const fmtDist = d => { d = +d; return !d && d !== 0 ? '' : d < 1000 ? `${d}m` : `${(d / 1000).toFixed(1)}km`; };

/* ---------------- 상태 ---------------- */
let draft = null;   // 작성/수정 중인 기록
let records = [];   // 목록 캐시

function newDraft() {
  return {
    id: uid(), isNew: true, photos: [], coords: null,
    name: '', address: '', phone: '', category: '', kakaoId: '', kakaoUrl: '', lat: null, lng: null,
    hours: '', closed: '', instagram: '', date: todayStr(), time: nowTime(), rating: 0, memo: '',
  };
}
function nowTime() { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
// 같은 날짜 안에서 방문 시간순 (시간 없는 기록은 뒤로)
const byTime = (a, b) => (a.time || '99:99').localeCompare(b.time || '99:99') || a.createdAt - b.createdAt;

/* ---------------- 화면 전환 (주소창 #으로 관리 → 폰 뒤로가기 지원) ---------------- */
const VIEWS = ['list', 'calendar', 'new', 'edit', 'detail', 'settings'];
function show(name, title) {
  VIEWS.forEach(v => $('#view-' + v).classList.toggle('hidden', v !== name));
  $('#title').textContent = title;
  const home = name === 'list' || name === 'calendar';
  $('#btn-back').classList.toggle('hidden', home);
  $('#btn-settings').classList.toggle('hidden', !home);
  $('#fab').classList.toggle('hidden', !home);
  window.scrollTo(0, 0);
}
const go = hash => { location.hash = hash; };

async function route() {
  revokeAll();
  const h = location.hash.replace(/^#/, '') || '/';
  if (h === '/new') {
    if (!draft || !draft.isNew) { draft = newDraft(); resetNewView(); }
    renderNewThumbs();
    show('new', '새 기록');
  } else if (h === '/edit') {
    if (!draft) return go('/');
    renderEdit();
    show('edit', draft.isNew ? '정보 확인' : '수정');
  } else if (h.startsWith('/v/')) {
    const rec = await getOne(h.slice(3));
    if (!rec) return go('/');
    const sameDay = rec.date ? (await getAll()).filter(r => r.date === rec.date).length : 1;
    renderDetail(rec, sameDay);
    show('detail', rec.name);
  } else if (h === '/cal') {
    draft = null;
    await renderCalendar();
    show('calendar', '맛집기록');
  } else if (h === '/settings') {
    renderSettings();
    show('settings', '설정');
  } else {
    draft = null;
    await renderList();
    show('list', '맛집기록');
  }
}
window.addEventListener('hashchange', route);
$('#btn-back').onclick = () => (history.length > 1 ? history.back() : go('/'));
$('#btn-settings').onclick = () => go('/settings');
$('#fab').onclick = () => { draft = newDraft(); resetNewView(); go('/new'); };

/* ---------------- 목록 ---------------- */
async function renderList() {
  records = await getAll();
  records.sort((a, b) => (b.date || '').localeCompare(a.date || '') || byTime(b, a));
  drawList();
}
function drawList() {
  const q = $('#search').value.trim().toLowerCase();
  const items = q
    ? records.filter(r => [r.name, r.address, r.category, r.memo].join(' ').toLowerCase().includes(q))
    : records;
  $('#empty').classList.toggle('hidden', records.length > 0);
  $('#list').innerHTML = items.map(r => cardHtml(r)).join('') || (records.length ? '<p class="empty">검색 결과가 없어요.</p>' : '');
}
function cardHtml(r, extra = '') {
  return `
    <div class="card" data-id="${esc(r.id)}">
      ${r.photos && r.photos[0] ? `<img src="${objUrl(r.photos[0])}" alt="">` : '<div class="noimg">🍽</div>'}
      <div class="info">
        <div class="nm">${r.featured ? '<span class="crown">👑</span>' : ''}${esc(r.name)}</div>
        <div class="meta">${esc([r.category, shortAddr(r.address)].filter(Boolean).join(' · '))}</div>
        <div class="meta">${esc([r.date, r.time].filter(Boolean).join(' '))} ${r.rating ? `<span class="stars">${'★'.repeat(r.rating)}</span>` : ''}</div>
      </div>
      ${extra}
    </div>`;
}

/* ---------------- 오늘의 대표 맛집 ---------------- */
// 대표로 고른 곳 → 없으면 사진 있는 가장 이른 방문 → 없으면 가장 이른 방문
const repOf = list => list.find(r => r.featured) || list.find(r => r.photos && r.photos.length) || list[0];

// 같은 날짜에서 이 기록만 대표로 (이미 대표면 해제)
async function toggleFeatured(id) {
  const all = await getAll();
  const target = all.find(r => r.id === id);
  if (!target) return;
  const turnOn = !target.featured;
  for (const r of all) {
    if (r.date !== target.date) continue;
    const want = turnOn && r.id === id;
    if (!!r.featured !== want) { r.featured = want; await putRec(r); }
  }
  toast(turnOn ? `👑 ${target.name}을(를) 오늘의 대표 맛집으로 정했어요` : '대표 맛집을 해제했어요');
}
$('#search').addEventListener('input', () => { revokeAll(); drawList(); });
const openCard = e => {
  const c = e.target.closest('.card');
  if (c) go('/v/' + c.dataset.id);
};
$('#list').addEventListener('click', openCard);

// 목록 ↔ 달력 탭 (뒤로가기 기록에 쌓이지 않게 replace)
document.addEventListener('click', e => {
  const b = e.target.closest('.tabs button[data-go]');
  if (b) location.replace('#' + b.dataset.go);
});

/* ---------------- 달력 ---------------- */
const now0 = new Date();
let calY = now0.getFullYear(), calM = now0.getMonth(); // calM: 0~11
let calSel = null;   // 선택한 날짜 'YYYY-MM-DD'
let byDate = {};     // 날짜별 기록

const pad = n => String(n).padStart(2, '0');

async function renderCalendar() {
  const all = await getAll();
  byDate = {};
  for (const r of all) if (r.date) (byDate[r.date] = byDate[r.date] || []).push(r);
  Object.values(byDate).forEach(list => list.sort(byTime));
  // 연도 선택 범위: 기록이 있는 가장 이른 해(최대 10년 전까지 기본) ~ 내년
  const thisY = new Date().getFullYear();
  const years = Object.keys(byDate).map(d => +d.slice(0, 4)).filter(Boolean);
  const minY = Math.min(thisY - 10, calY, ...years), maxY = Math.max(thisY + 1, calY);
  let opts = '';
  for (let y = maxY; y >= minY; y--) opts += `<option value="${y}">${y}</option>`;
  $('#cal-y').innerHTML = opts;
  drawCalendar();
}
$('#cal-y').onchange = e => { calY = +e.target.value; drawCalendar(); };
$('#cal-m').onchange = e => { calM = +e.target.value; drawCalendar(); };

function drawCalendar() {
  revokeAll();
  const prefix = `${calY}-${pad(calM + 1)}-`;
  const first = new Date(calY, calM, 1).getDay();
  const days = new Date(calY, calM + 1, 0).getDate();
  const today = todayStr();

  if (![...$('#cal-y').options].some(o => +o.value === calY)) {
    $('#cal-y').insertAdjacentHTML(calY > +$('#cal-y').options[0].value ? 'afterbegin' : 'beforeend', `<option value="${calY}">${calY}</option>`);
  }
  $('#cal-y').value = calY;
  $('#cal-m').value = calM;
  const monthRecs = Object.keys(byDate).filter(d => d.startsWith(prefix)).reduce((n, d) => n + byDate[d].length, 0);
  $('#cal-count').textContent = monthRecs ? `이번 달 ${monthRecs}곳 기록` : '이번 달 기록 없음';

  let html = '';
  for (let i = 0; i < first; i++) html += '<div class="cal-cell other"></div>';
  for (let d = 1; d <= days; d++) {
    const key = prefix + pad(d);
    const list = byDate[key];
    const cls = ['cal-cell', key === today ? 'today' : '', list ? 'has' : '', key === calSel ? 'sel' : ''].join(' ');
    if (list) {
      const rep = repOf(list);
      html += `<button class="${cls}" type="button" data-d="${key}">
        <span class="circ">${rep.photos && rep.photos.length ? `<img src="${objUrl(rep.photos[0])}" alt="">` : '🍽'}</span>
        <span class="num">${d}</span>
        ${list.length > 1 ? `<span class="badge">${list.length}</span>` : ''}
      </button>`;
    } else {
      html += `<div class="${cls}"><span class="num">${d}</span></div>`;
    }
  }
  $('#cal-grid').innerHTML = html;
  drawCalDay();
}

function drawCalDay() {
  const list = calSel && byDate[calSel];
  if (!list || !calSel.startsWith(`${calY}-${pad(calM + 1)}-`)) { $('#cal-day').innerHTML = ''; return; }
  const [, m, d] = calSel.split('-');
  $('#cal-day').innerHTML = `<h3>${+m}월 ${+d}일 · ${list.length}곳</h3>
    <p class="hint">달력에 보일 대표 맛집을 골라보세요.</p>` +
    list.map(r => cardHtml(r, `<button class="feat-btn ${r.featured ? 'on' : ''}" type="button" data-feat="${esc(r.id)}">${r.featured ? '👑 대표' : '대표로'}</button>`)).join('');
}

function moveMonth(delta) {
  calM += delta;
  if (calM < 0) { calM = 11; calY--; }
  if (calM > 11) { calM = 0; calY++; }
  drawCalendar();
}
$('#cal-prev').onclick = () => moveMonth(-1);
$('#cal-next').onclick = () => moveMonth(1);

$('#cal-grid').addEventListener('click', e => {
  const c = e.target.closest('.cal-cell.has');
  if (!c) return;
  const list = byDate[c.dataset.d];
  if (list.length === 1) return go('/v/' + list[0].id);
  calSel = calSel === c.dataset.d ? null : c.dataset.d;
  drawCalendar();
});
$('#cal-day').addEventListener('click', async e => {
  const fb = e.target.closest('[data-feat]');
  if (!fb) return openCard(e);
  await toggleFeatured(fb.dataset.feat);
  await renderCalendar();
});

// 좌우로 밀어서 달 넘기기
let touchX = null, touchY = null;
$('#cal-grid').addEventListener('touchstart', e => { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }, { passive: true });
$('#cal-grid').addEventListener('touchend', e => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
  touchX = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) moveMonth(dx < 0 ? 1 : -1);
}, { passive: true });

/* ---------------- 새 기록: 사진 → 가게 찾기 ---------------- */
function resetNewView() {
  $('#find').classList.add('hidden');
  $('#others').classList.add('hidden');
  $('#btn-here').classList.remove('hidden');
  $('#guess').innerHTML = '';
  $('#candidates').innerHTML = '';
  $('#name-results').innerHTML = '';
  $('#in-name').value = '';
  $('#loc-status').textContent = '';
}
function renderNewThumbs() {
  $('#new-thumbs').innerHTML = draft.photos.map(p => `<div class="thumb"><img src="${objUrl(p)}" alt=""></div>`).join('');
}

async function onPhotos(files, fromCamera) {
  if (!files || !files.length) return;
  $('#loc-status').innerHTML = '<span class="spinner"></span>사진 읽는 중...';
  $('#find').classList.remove('hidden');
  const r = await processFiles(files);
  draft.photos.push(...r.photos);
  if (!fromCamera && draft.photos.length === r.photos.length) {
    // 앨범 사진: 찍은 날짜·시간을 방문일시로 (정보 없으면 시간은 비움)
    if (r.date) draft.date = r.date;
    draft.time = r.time || '';
  }
  renderNewThumbs();

  if (r.gps) {
    draft.coords = r.gps;
    $('#loc-status').textContent = '사진의 위치 정보로 주변 가게를 찾았어요.';
    await findNearby();
  } else if (fromCamera) {
    $('#loc-status').innerHTML = '<span class="spinner"></span>현재 위치 확인 중...';
    await useHere();
  } else {
    $('#loc-status').textContent = '사진에 위치 정보가 없어요. 지금 가게에 있다면 현재 위치로, 아니면 이름으로 찾아주세요.';
    $('#others').classList.remove('hidden');
  }
}
$('#in-camera').onchange = e => { onPhotos(e.target.files, true); e.target.value = ''; };
$('#in-album').onchange = e => { onPhotos(e.target.files, false); e.target.value = ''; };

async function useHere() {
  try {
    draft.coords = await getHere();
    $('#loc-status').textContent = '현재 위치로 주변 가게를 찾았어요.';
    await findNearby();
  } catch (e) {
    $('#loc-status').textContent = e.message + ' 가게 이름으로 찾아주세요.';
    $('#others').classList.remove('hidden');
  }
}
$('#btn-here').onclick = () => {
  $('#loc-status').innerHTML = '<span class="spinner"></span>현재 위치 확인 중...';
  $('#candidates').innerHTML = '';
  useHere();
};

let nearbyList = [];
async function findNearby() {
  const { lat, lng } = draft.coords;
  try {
    nearbyList = await searchNearby(lat, lng);
  } catch (e) {
    $('#loc-status').textContent = kakaoErrorMsg(e);
    $('#others').classList.remove('hidden');
    return;
  }
  if (!nearbyList.length) {
    $('#guess').innerHTML = '';
    $('#loc-status').textContent = '근처 200m 안에서 음식점·카페를 찾지 못했어요. 이름으로 찾아주세요.';
    $('#others').classList.remove('hidden');
    return;
  }
  const g = nearbyList[0];
  $('#guess').innerHTML = `
    <div class="guess">
      <p class="q">여기 맞나요?</p>
      <div class="nm">${esc(g.place_name)}</div>
      <div class="hint">${esc(lastCat(g.category_name))} · ${esc(fmtDist(g.distance))} · ${esc(g.road_address_name || g.address_name)}</div>
      <div class="row">
        <button class="btn primary" type="button" id="btn-yes">맞아요</button>
        <button class="btn" type="button" id="btn-no">아니에요</button>
      </div>
    </div>`;
  $('#btn-yes').onclick = () => pickPlace(g);
  $('#btn-no').onclick = () => {
    $('#guess').innerHTML = '';
    $('#others').classList.remove('hidden');
    $('#btn-here').classList.add('hidden');
    $('#candidates').innerHTML = '<p class="hint">주변 다른 가게예요. 없으면 아래에 이름을 입력하세요.</p>' + placeButtons(nearbyList.slice(1), 'n');
    $('#in-name').focus();
  };
  $('#others').classList.add('hidden');
}

function placeButtons(list, prefix) {
  return list.map((p, i) => `
    <button class="place" type="button" data-k="${prefix}${i}">
      <b>${esc(p.place_name)}</b>
      <small>${esc([lastCat(p.category_name), fmtDist(p.distance)].filter(Boolean).join(' · '))}</small>
      <small>${esc(p.road_address_name || p.address_name)}</small>
    </button>`).join('');
}

let nameList = [];
$('#candidates').addEventListener('click', e => {
  const b = e.target.closest('.place');
  if (b) pickPlace(nearbyList.slice(1)[+b.dataset.k.slice(1)]);
});
$('#name-results').addEventListener('click', e => {
  const b = e.target.closest('.place');
  if (b) pickPlace(nameList[+b.dataset.k.slice(1)]);
});
$('#name-search').onsubmit = async e => {
  e.preventDefault();
  const q = $('#in-name').value.trim();
  if (!q) return;
  $('#name-results').innerHTML = '<p class="hint"><span class="spinner"></span>검색 중...</p>';
  try {
    nameList = await searchKeyword(q, draft.coords);
    // 위치를 알면 가까운 가게가 위로 오게
    if (draft.coords) nameList.sort((a, b) => (+a.distance || 1e9) - (+b.distance || 1e9));
    $('#name-results').innerHTML = nameList.length
      ? placeButtons(nameList, 'k')
      : '<p class="hint">검색 결과가 없어요. 지역명을 붙여보세요. (예: 성수 ○○카페)</p>';
  } catch (err) {
    $('#name-results').innerHTML = `<p class="hint">${esc(kakaoErrorMsg(err))}</p>`;
  }
};
$('#btn-skip').onclick = () => {
  draft.name = $('#in-name').value.trim();
  go('/edit');
};

function pickPlace(p) {
  Object.assign(draft, {
    name: p.place_name,
    address: p.road_address_name || p.address_name,
    phone: p.phone || '',
    category: lastCat(p.category_name),
    kakaoId: p.id,
    kakaoUrl: p.place_url || '',
    lat: +p.y, lng: +p.x,
  });
  // 다시 방문한 가게면 지난 기록의 영업시간·휴무·인스타를 가져오기
  draft.note = '';
  getAll().then(all => {
    const prev = all.filter(r => r.kakaoId && r.kakaoId === p.id).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (prev) {
      draft.hours = draft.hours || prev.hours || '';
      draft.closed = draft.closed || prev.closed || '';
      draft.instagram = draft.instagram || prev.instagram || '';
      draft.note = `다시 온 가게예요! (지난 방문 ${prev.date}) 영업시간·휴무·인스타를 지난 기록에서 가져왔어요.`;
    }
    go('/edit');
  });
}

/* ---------------- 입력/수정 ---------------- */
const form = $('#edit-form');
const FIELDS = ['name', 'address', 'phone', 'category', 'hours', 'closed', 'instagram', 'date', 'time', 'memo'];

function renderEdit() {
  FIELDS.forEach(f => { form.elements[f].value = draft[f] || ''; });
  renderEditThumbs();
  renderRating();
  updateLinks();
  const note = $('#edit-note');
  note.textContent = draft.note || '';
  note.classList.toggle('hidden', !draft.note);
}
function renderEditThumbs() {
  $('#edit-thumbs').innerHTML = draft.photos.map((p, i) =>
    `<div class="thumb"><img src="${objUrl(p)}" alt=""><button type="button" data-i="${i}" aria-label="사진 삭제">✕</button></div>`).join('');
}
$('#edit-thumbs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  draft.photos.splice(+b.dataset.i, 1);
  renderEditThumbs();
});
$('#in-more').onchange = async e => {
  const r = await processFiles(e.target.files);
  e.target.value = '';
  draft.photos.push(...r.photos);
  renderEditThumbs();
};

function renderRating() {
  $('#rating').innerHTML = [1, 2, 3, 4, 5].map(n =>
    `<button type="button" data-n="${n}" class="${n <= draft.rating ? 'on' : ''}" aria-label="${n}점">★</button>`).join('');
}
$('#rating').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  const n = +b.dataset.n;
  draft.rating = draft.rating === n ? 0 : n;
  renderRating();
});

function lookupLinks(name, address, kakaoUrl) {
  const area = shortAddr(address);
  const q = [name, area].filter(Boolean).join(' ');
  return {
    naver: 'https://map.naver.com/p/search/' + encodeURIComponent(q),
    kakao: kakaoUrl || 'https://map.kakao.com/link/search/' + encodeURIComponent(q),
    insta: 'https://www.google.com/search?q=' + encodeURIComponent(q + ' instagram'),
  };
}
function updateLinks() {
  const name = form.elements.name.value.trim();
  const l = lookupLinks(name, form.elements.address.value, draft.kakaoUrl);
  $('#lk-naver').href = l.naver;
  $('#lk-kakao').href = l.kakao;
  $('#lk-insta').href = l.insta;
}
form.elements.name.addEventListener('input', updateLinks);
form.elements.address.addEventListener('input', updateLinks);

function normInsta(s) {
  s = (s || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  s = s.replace(/^@/, '').replace(/^(www\.)?instagram\.com\//i, '').replace(/[/?#].*$/, '');
  return s ? `https://www.instagram.com/${s}/` : '';
}

form.onsubmit = async e => {
  e.preventDefault();
  FIELDS.forEach(f => { draft[f] = form.elements[f].value.trim(); });
  draft.instagram = normInsta(draft.instagram);
  const now = Date.now();
  const rec = {
    id: draft.id,
    name: draft.name, address: draft.address, phone: draft.phone, category: draft.category,
    kakaoId: draft.kakaoId, kakaoUrl: draft.kakaoUrl, lat: draft.lat, lng: draft.lng,
    hours: draft.hours, closed: draft.closed, instagram: draft.instagram,
    date: draft.date, time: draft.time, rating: draft.rating, memo: draft.memo,
    photos: draft.photos,
    // 방문일을 바꾸면 그 날짜의 대표 지정은 풀림
    featured: !!draft.featured && draft.date === draft.origDate,
    createdAt: draft.createdAt || now, updatedAt: now,
  };
  try {
    await putRec(rec);
  } catch (err) {
    toast('저장에 실패했어요. 폰 저장공간을 확인해 주세요.');
    return;
  }
  const wasNew = draft.isNew;
  draft = null;
  toast('저장했어요');
  // 새 기록: 목록 → 새 기록 → 정보 확인 순으로 왔으니 두 단계 뒤(목록)로
  if (wasNew) history.go(-2); else history.back();
};

/* ---------------- 상세 ---------------- */
function renderDetail(r, sameDay = 1) {
  const l = lookupLinks(r.name, r.address, r.kakaoUrl);
  const row = (k, v) => v ? `<div class="d-row"><div class="k">${k}</div><div class="v">${v}</div></div>` : '';
  $('#view-detail').innerHTML = `
    ${r.photos && r.photos.length ? `<div class="gallery">${r.photos.map(p => `<img src="${objUrl(p)}" alt="">`).join('')}</div>` : ''}
    <h2 class="d-name">${esc(r.name)}</h2>
    <div class="d-sub">${esc([r.category, [r.date, r.time].filter(Boolean).join(' ')].filter(Boolean).join(' · '))}
      ${r.rating ? `<span class="stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span>` : ''}</div>
    <div class="d-rows">
      ${row('주소', r.address ? `<a href="${esc(l.kakao)}" target="_blank" rel="noopener">${esc(r.address)}</a>` : '')}
      ${row('전화', r.phone ? `<a href="tel:${esc(r.phone.replace(/[^\d+]/g, ''))}">${esc(r.phone)}</a>` : '')}
      ${row('영업시간', esc(r.hours))}
      ${row('휴무', esc(r.closed))}
      ${row('인스타', r.instagram ? `<a href="${esc(r.instagram)}" target="_blank" rel="noopener">${esc(r.instagram.replace(/^https?:\/\/(www\.)?/, ''))}</a>` : '')}
    </div>
    ${sameDay > 1 ? `<button id="btn-feat" class="btn full feat-big ${r.featured ? 'on' : ''}" type="button">
        ${r.featured ? '👑 이날의 대표 맛집이에요 (해제하려면 누르기)' : `👑 이날의 대표 맛집으로 선정 <small>(이날 ${sameDay}곳 방문)</small>`}</button>` : ''}
    ${r.memo ? `<div class="d-memo">${esc(r.memo)}</div>` : ''}
    <div class="row wrap" style="margin-top:14px">
      <a class="btn small" href="${esc(l.naver)}" target="_blank" rel="noopener">네이버 지도</a>
      <a class="btn small" href="${esc(l.kakao)}" target="_blank" rel="noopener">카카오맵</a>
    </div>
    <div class="row" style="margin-top:20px">
      <button id="btn-edit" class="btn" type="button" style="flex:1">수정</button>
      <button id="btn-del" class="btn danger" type="button" style="flex:1">삭제</button>
    </div>`;
  if ($('#btn-feat')) $('#btn-feat').onclick = async () => { await toggleFeatured(r.id); route(); };
  $('#btn-edit').onclick = () => {
    draft = { ...r, photos: [...(r.photos || [])], isNew: false, note: '', origDate: r.date };
    go('/edit');
  };
  $('#btn-del').onclick = async () => {
    if (!confirm(`'${r.name}' 기록을 삭제할까요?`)) return;
    await delRec(r.id);
    toast('삭제했어요');
    history.back();
  };
}

/* ---------------- 설정 / 백업 ---------------- */
async function renderSettings() {
  const key = localStorage.getItem('kakaoKey') || '';
  $('#in-key').value = key;
  $('#key-status').textContent = key ? '직접 넣은 키를 쓰고 있어요.'
    : window.KAKAO_KEY ? '기본 키를 쓰고 있어요. 따로 넣지 않아도 돼요.' : '아직 키가 없어요.';
  const all = await getAll();
  let info = `기록 ${all.length}개`;
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    info += ` · 사용 중 약 ${(est.usage / 1048576).toFixed(1)}MB`;
  }
  $('#storage-info').textContent = info;
}
$('#key-form').onsubmit = async e => {
  e.preventDefault();
  const k = $('#in-key').value.trim();
  if (k) localStorage.setItem('kakaoKey', k); else localStorage.removeItem('kakaoKey');
  kakaoPromise = null;
  if (!k) { $('#key-status').textContent = window.KAKAO_KEY ? '직접 넣은 키를 지웠어요. 기본 키를 써요.' : '키를 지웠어요.'; return; }
  $('#key-status').innerHTML = '<span class="spinner"></span>연결 확인 중...';
  try {
    await searchKeyword('스타벅스');
    $('#key-status').textContent = '✅ 카카오 연결 성공! 이제 가게 검색을 쓸 수 있어요.';
  } catch (err) {
    $('#key-status').textContent = '❌ ' + kakaoErrorMsg(err) + ' (키를 바꿨다면 페이지를 새로고침 후 다시 저장해 보세요.)';
  }
};

const blobToDataUrl = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
const dataUrlToBlob = async u => (await fetch(u)).blob();

$('#btn-export').onclick = async () => {
  toast('백업 파일 만드는 중...');
  const all = await getAll();
  const out = [];
  for (const r of all) out.push({ ...r, photos: await Promise.all((r.photos || []).map(blobToDataUrl)) });
  const blob = new Blob([JSON.stringify({ app: 'food-log', version: 1, records: out })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `맛집기록-백업-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};
$('#in-import').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data || !Array.isArray(data.records)) throw new Error();
    for (const r of data.records) {
      r.photos = await Promise.all((r.photos || []).map(dataUrlToBlob));
      await putRec(r);
    }
    toast(`${data.records.length}개 기록을 불러왔어요`);
    renderSettings();
  } catch (err) {
    toast('백업 파일을 읽지 못했어요.');
  }
};

/* ---------------- 시작 ---------------- */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
route();
