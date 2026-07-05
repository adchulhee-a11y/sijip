/* ============================================================
   할머니를 위한 시집 — app.js
   화면 4개: 시작 → 시집 목록 → 시 만들기 → 미리보기
   ============================================================ */

/* ----- EmailJS 설정 (https://www.emailjs.com 가입 후 값 입력) ----- */
const EMAIL_CONFIG = {
  publicKey:  'hSDHvNBQH-QK40vGe', // EmailJS > Account > Public Key
  serviceId:  'service_rto9o7h',   // EmailJS > Email Services
  templateId: 'template_t7ma3vm',  // EmailJS > Email Templates
  toEmail:    'paulati@naver.com',
};

const MAX_POEMS = 3;          // 시집 최대 3개
const STORAGE_KEY = 'poems';

/* ----- 상태 ----- */
let poems = [];               // [{id, lines[], updatedAt}]
let currentPoem = null;       // 지금 편집/보기 중인 시
let currentLine = 0;          // 현재 줄 번호 (0=제목, 1=이름, 2~=본문)
let recording = false;        // 말하기 중인가
let interimText = '';         // 인식 중간 결과
let recognition = null;
let recStartTime = 0;         // 녹음 시작 시각 (안내음 에코 필터용)
let pendingDeleteId = null;   // 목록에서 삭제 확인 중인 시
let readingAll = false;       // 전체 낭독 중인가

/* ============================================================
   저장 (모든 변경 즉시 localStorage — 저장 버튼 없음)
   ============================================================ */
function loadPoems() {
  try { poems = JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { poems = []; }
}
function savePoems() {
  // 최근순 정렬 후 최대 3개만 유지
  poems.sort((a, b) => b.updatedAt - a.updatedAt);
  poems = poems.slice(0, MAX_POEMS);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(poems));
}
function touchAndSave() {
  if (currentPoem) currentPoem.updatedAt = Date.now();
  savePoems();
}

/* ============================================================
   화면 전환
   ============================================================ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/* ============================================================
   TTS — 한국어 낭독 (속도 살짝 느리게)
   ============================================================ */
function speak(text, onEnd, rate = 0.9) {
  speechSynthesis.cancel();
  if (!text) { if (onEnd) onEnd(); return; }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR';
  u.rate = rate;
  if (onEnd) u.onend = onEnd;
  speechSynthesis.speak(u);
}

/* ============================================================
   ② 시집 목록
   ============================================================ */
function renderList() {
  const box = document.getElementById('poem-list');
  box.innerHTML = '';
  if (poems.length === 0) {
    box.innerHTML = '<div class="poem-empty">아직 만든 시가 없어요.<br>아래 [새로 만들기]를 눌러 주세요.</div>';
    return;
  }
  poems.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'poem-item';

    const title = document.createElement('span');
    title.className = 'poem-item-title';
    title.textContent = `시집${i + 1} - ${((p.lines[0] || '').trim() || '(제목 없음)')}`;

    const del = document.createElement('button');
    del.className = 'poem-del';
    del.textContent = '삭제';
    del.onclick = (e) => {         // 항목 열기와 겹치지 않게
      e.stopPropagation();
      pendingDeleteId = p.id;
      document.getElementById('confirm-overlay').classList.remove('hidden');
      speak('이 시를 지울까요?');
    };

    div.onclick = () => {          // 목록에서 누르면 미리보기로
      currentPoem = p;
      currentLine = 0;             // 이전으로(편집) 눌렀을 때 첫 줄부터
      interimText = '';
      while (currentPoem.lines.length < 2) currentPoem.lines.push('');
      renderPreview();
      showScreen('screen-preview');
    };

    div.appendChild(title);
    div.appendChild(del);
    box.appendChild(div);
  });
}

/* ============================================================
   ③ 시 만드는 페이지 — 3줄 창, 가운데가 현재 줄
   lines[0]=제목, lines[1]=이름, lines[2~]=본문
   ============================================================ */
function lineLabel(idx) {
  if (idx === 0) return '제목';
  if (idx === 1) return '이름';
  return '본문';
}

function renderEditor() {
  const rows = [
    { el: 'line-prev', idx: currentLine - 1 },
    { el: 'line-cur',  idx: currentLine },
    { el: 'line-next', idx: currentLine + 1 },
  ];
  // 맨 첫 줄일 때는 창을 위로 붙여서 제목/이름/본문이 다 보이게
  if (currentLine === 0) {
    rows[0].idx = 0; rows[1].idx = 1; rows[2].idx = 2;
  }
  rows.forEach(r => {
    const row = document.getElementById(r.el);
    const label = row.querySelector('.line-label');
    const text = row.querySelector('.line-text');
    if (r.idx < 0) { label.textContent = ''; text.innerHTML = ''; row.classList.remove('current'); return; }
    label.textContent = lineLabel(r.idx);
    let html = escapeHtml(currentPoem.lines[r.idx] || '');
    const isCurrent = r.idx === currentLine;
    if (isCurrent && interimText) {
      html += (html ? ' ' : '') + '<span class="interim">' + escapeHtml(interimText) + '</span>';
    }
    text.innerHTML = html;
    row.classList.toggle('current', isCurrent);
  });
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ----- 새 시 만들기 ----- */
function newPoem() {
  currentPoem = { id: Date.now(), lines: ['', ''], updatedAt: Date.now() };
  poems.unshift(currentPoem);
  savePoems();
  currentLine = 0;
  interimText = '';
  renderEditor();
  showScreen('screen-editor');
  speak('제목을 말해 보세요. 말하기 버튼을 누르면 시작해요.');
}

/* ----- 줄 이동 ----- */
function moveLine(delta) {
  stopRecognition();
  const next = currentLine + delta;
  if (next < 0) return;
  currentLine = next;
  while (currentPoem.lines.length <= currentLine) currentPoem.lines.push('');
  touchAndSave();
  renderEditor();
}

/* ----- 지우기 ----- */
function eraseLine() {
  stopRecognition();
  currentPoem.lines[currentLine] = '';
  interimText = '';
  touchAndSave();
  renderEditor();
  speak(lineLabel(currentLine) + ' 줄을 지웠어요.');
}

/* ============================================================
   STT — 말하기 / 말하기 종료
   ============================================================ */
function setupRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = 'ko-KR';
  // continuous=true는 안드로이드 크롬에서 단어 중복/멈춤 버그가 있음
  // → 단발 인식 + onend 자동 재시작 패턴 사용
  rec.continuous = false;
  rec.interimResults = true;

  rec.onresult = (e) => {
    interimText = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      let t = e.results[i][0].transcript.trim();
      // 음성 인식이 자동으로 찍는 문장부호(. , ? 등)는 시에 불필요 → 제거 (전각 포함)
      t = t.replace(/[.,?!;:…。，？！；：·]/g, '').trim();
      // 시작 직후엔 안내음("말씀하세요")이 마이크에 잡힐 수 있으니 걸러냄
      if (Date.now() - recStartTime < 3000) {
        t = t.replace(/말씀\s*하[세셔]요/g, '').trim();
      }
      if (!t) continue;
      if (e.results[i].isFinal) {
        // 확정된 말은 현재 줄에 이어 붙이고 즉시 저장
        const cur = currentPoem.lines[currentLine] || '';
        currentPoem.lines[currentLine] = cur ? cur + ' ' + t : t;
        touchAndSave();
      } else {
        interimText += t;
      }
    }
    renderEditor();
  };

  // 한 발화가 끝날 때마다 인식이 종료됨 → 종료 버튼 전까지 자동 재시작
  rec.onend = () => {
    if (!recording) return;
    try { rec.start(); }
    catch {
      // 즉시 재시작이 안 되는 경우(안드로이드) 잠깐 뒤 한 번 더
      setTimeout(() => { if (recording) { try { rec.start(); } catch { } } }, 200);
    }
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed') {
      recording = false;
      updateRecUI();
      document.getElementById('rec-status').textContent = '마이크 사용을 허용해 주세요';
    }
  };
  return rec;
}

function startSpeaking() {
  if (recording) return;
  if (!recognition) recognition = setupRecognition();
  if (!recognition) {
    document.getElementById('rec-status').textContent = '이 폰에서는 음성 인식이 안 돼요';
    return;
  }
  // 녹음을 즉시 시작하고 안내음은 동시에 재생 (마이크 준비 시간을 안내음이 채움)
  // 안내음이 마이크에 잡혀도 onresult의 에코 필터가 걸러냄
  recording = true;
  interimText = '';
  recStartTime = Date.now();
  try { recognition.start(); } catch { }
  updateRecUI();
  speak('말씀하세요', null, 1.1);
}

function stopRecognition() {
  if (!recording) return;
  recording = false;
  try { recognition.stop(); } catch { }
  // 인식 중이던 중간 결과도 확정해서 붙임
  if (interimText) {
    const cur = currentPoem.lines[currentLine] || '';
    currentPoem.lines[currentLine] = cur ? cur + ' ' + interimText : interimText;
    interimText = '';
    touchAndSave();
  }
  updateRecUI();
  renderEditor();
}

function stopSpeaking() {
  stopRecognition();
  // 들은 내용을 읽어 주며 확인 (듣기 중심 설계)
  const line = currentPoem.lines[currentLine];
  if (line) speak(line);
}

function updateRecUI() {
  const btnSpeak = document.getElementById('btn-speak');
  const btnStop = document.getElementById('btn-speak-stop');
  const status = document.getElementById('rec-status');
  btnSpeak.classList.toggle('recording', recording);
  btnSpeak.disabled = recording;
  btnStop.disabled = !recording;
  status.textContent = recording ? '● 듣고 있어요...' : '';
}

/* ============================================================
   ④ 미리보기 + 완료(메일 보내기)
   ============================================================ */
function renderPreview() {
  const title = (currentPoem.lines[0] || '').trim() || '(제목 없음)';
  const name = (currentPoem.lines[1] || '').trim();
  const body = currentPoem.lines.slice(2).filter(l => l.trim());

  document.getElementById('preview-title').textContent = title;
  document.getElementById('preview-name').textContent = name;
  const bodyEl = document.getElementById('preview-body');
  bodyEl.innerHTML = '';
  body.forEach(line => {
    const p = document.createElement('p');
    p.textContent = line;
    bodyEl.appendChild(p);
  });
}

async function sendMail() {
  const btn = document.getElementById('btn-done');
  const title = (currentPoem.lines[0] || '').trim() || '(제목 없음)';
  const name = (currentPoem.lines[1] || '').trim();
  const content = currentPoem.lines.slice(2).filter(l => l.trim()).join('\n');

  // EmailJS 설정 전이면 메일 앱으로 대신 열기 (임시 동작)
  if (EMAIL_CONFIG.publicKey === 'YOUR_PUBLIC_KEY') {
    location.href = 'mailto:' + EMAIL_CONFIG.toEmail
      + '?subject=' + encodeURIComponent('[시집] ' + title)
      + '&body=' + encodeURIComponent(title + '\n' + name + '\n\n' + content);
    showScreen('screen-list'); renderList();
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '보내는 중...';
  try {
    await emailjs.send(EMAIL_CONFIG.serviceId, EMAIL_CONFIG.templateId, {
      to_email: EMAIL_CONFIG.toEmail,
      poem_title: title,
      poem_name: name,
      poem_content: content,
    });
    speak('시를 보냈어요.');
    showScreen('screen-list');
    renderList();
  } catch (err) {
    speak('보내기에 실패했어요. 다시 눌러 주세요.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '완료<br><small>(메일 보내기)</small>';
  }
}

/* ============================================================
   이벤트 연결
   ============================================================ */
document.getElementById('btn-start').onclick = () => {
  renderList();
  showScreen('screen-list');
};
document.getElementById('btn-new').onclick = newPoem;

document.getElementById('btn-speak').onclick = startSpeaking;
document.getElementById('btn-speak-stop').onclick = stopSpeaking;
document.getElementById('btn-line-prev').onclick = () => moveLine(-1);
document.getElementById('btn-line-next').onclick = () => moveLine(1);
document.getElementById('btn-erase').onclick = eraseLine;
document.getElementById('btn-preview').onclick = () => {
  stopRecognition();
  renderPreview();
  showScreen('screen-preview');
};

document.getElementById('btn-back').onclick = () => {
  stopReading();
  renderEditor();
  showScreen('screen-editor');
};
document.getElementById('btn-done').onclick = () => {
  stopReading();
  sendMail();
};

document.getElementById('btn-to-list').onclick = () => {
  stopReading();
  renderList();
  showScreen('screen-list');
};

/* ----- 전체 낭독 (다시 누르면 멈춤) ----- */
function stopReading() {
  readingAll = false;
  speechSynthesis.cancel();
  document.getElementById('btn-read').textContent = '전체 낭독';
}

document.getElementById('btn-read').onclick = () => {
  if (readingAll) { stopReading(); return; }

  const parts = [];
  const title = (currentPoem.lines[0] || '').trim();
  const name = (currentPoem.lines[1] || '').trim();
  if (title) parts.push(title);
  if (name) parts.push(name);
  currentPoem.lines.slice(2).forEach(l => { if (l.trim()) parts.push(l.trim()); });
  if (parts.length === 0) { speak('아직 쓴 내용이 없어요.'); return; }

  speechSynthesis.cancel();
  readingAll = true;
  const btn = document.getElementById('btn-read');
  btn.textContent = '낭독 멈추기';
  // 행마다 따로 읽어서 시 낭독처럼 사이가 살짝 벌어지게
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p);
    u.lang = 'ko-KR';
    u.rate = 0.85;
    if (i === parts.length - 1) u.onend = stopReading;
    speechSynthesis.speak(u);
  });
};

/* ----- 시 삭제 확인 창 (목록의 삭제 버튼에서 열림) ----- */
document.getElementById('btn-del-no').onclick = () => {
  pendingDeleteId = null;
  document.getElementById('confirm-overlay').classList.add('hidden');
};
document.getElementById('btn-del-yes').onclick = () => {
  poems = poems.filter(p => p.id !== pendingDeleteId);
  savePoems();
  pendingDeleteId = null;
  document.getElementById('confirm-overlay').classList.add('hidden');
  speak('시를 지웠어요.');
  renderList();
};

/* ============================================================
   시작
   ============================================================ */
loadPoems();
if (EMAIL_CONFIG.publicKey !== 'YOUR_PUBLIC_KEY') {
  emailjs.init({ publicKey: EMAIL_CONFIG.publicKey });
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { });
}
