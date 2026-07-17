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
const STORAGE_KEY = 'poems_beta';   // 본판과 저장소 분리

/* ----- 임시 디버그: 오류가 나면 화면 하단에 표시 (원인 파악용) ----- */
function showFatal(msg) {
  let el = document.getElementById('err-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'err-banner';
    el.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#8b0000;color:#fff;'
      + 'font-size:15px;font-family:monospace;padding:8px 10px;z-index:99;white-space:pre-wrap;';
    document.body.appendChild(el);
  }
  el.textContent = '오류: ' + msg;
}
window.addEventListener('error', (e) => showFatal(e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => showFatal(String(e.reason)));

/* ----- 상태 ----- */
let poems = [];               // [{id, lines[], updatedAt}]
let currentPoem = null;       // 지금 편집/보기 중인 시
let currentLine = 0;          // 현재 줄 번호 (0=제목, 1=이름, 2~=본문)
let recording = false;        // 말하기 중인가
let interimText = '';         // 인식 중간 결과
let recognition = null;
let recStartTime = 0;         // 녹음 시작 시각 (안내음 에코 필터용)
let pendingDeleteId = null;   // 목록에서 삭제 확인 중인 시
let pendingInterim = '';      // 종료 시점의 중간 결과 (최종 결과 못 받으면 이걸 사용)
let awaitingFinal = false;    // 종료 후 최종 결과 대기 중인가
let settleLineIndex = 0;      // 종료 시점의 현재 줄 (그 사이 줄 이동해도 원래 줄에 기록)
let stopSettleTimer = null;
let onStopSettled = null;     // 종료 확정 후 실행할 작업 (예: 줄 읽어주기)

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
  try {
    if (!text) { if (onEnd) onEnd(); return; }
    const doSpeak = () => {
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'ko-KR';
        u.rate = rate;
        // 한국어 음성이 있으면 명시적으로 지정 (기기별 기본값 문제 회피)
        const ko = speechSynthesis.getVoices().find(v => v.lang && v.lang.replace('_', '-').startsWith('ko'));
        if (ko) u.voice = ko;
        if (onEnd) u.onend = onEnd;
        speechSynthesis.speak(u);
      } catch (e) { if (onEnd) onEnd(); }
    };
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      speechSynthesis.cancel();
      // 안드로이드 크롬: cancel 직후 speak는 무시됨 → 잠깐 뒤에 실행
      setTimeout(doSpeak, 80);
    } else {
      doSpeak();
    }
  } catch (e) { if (onEnd) onEnd(); }
}

// 안드로이드: 음성 목록이 비동기 로딩됨 — 미리 불러두기
if ('speechSynthesis' in window) {
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
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
      currentLine = 0;             // 편집하기 눌렀을 때 첫 줄부터
      interimText = '';
      while (currentPoem.lines.length < 2) currentPoem.lines.push('');
      resetRecite();
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
  // 지우기는 인식 중이던 말도 함께 버림 (지운 줄에 다시 적히면 안 됨)
  try { if (recognition) recognition.abort(); } catch { }
  settleStop(false);
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
    // 종료 처리까지 끝난 뒤 도착하는 늦은 결과는 무시 (중복 방지)
    if (!recording && !awaitingFinal) return;
    interimText = '';
    let gotFinal = false;
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
        // 확정된 말은 줄에 이어 붙이고 즉시 저장
        // (종료 후 도착한 최종 결과는 종료 시점의 줄에 기록)
        appendToLine(recording ? currentLine : settleLineIndex, t);
        gotFinal = true;
      } else if (recording) {
        interimText += t;
      }
    }
    if (!recording && gotFinal) {
      // 종료 후 최종 결과 도착 — 따로 담아둔 중간 결과는 버림 (같은 내용이므로)
      settleStop(false);
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
  // 직전 종료의 확정 대기가 남아 있으면 지금 확정하고 새로 시작 (중복 방지)
  if (awaitingFinal) {
    try { recognition.abort(); } catch { }
    settleStop(true);
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

function appendToLine(idx, t) {
  while (currentPoem.lines.length <= idx) currentPoem.lines.push('');
  const cur = currentPoem.lines[idx] || '';
  currentPoem.lines[idx] = cur ? cur + ' ' + t : t;
  touchAndSave();
}

/* 종료 확정: 최종 결과를 받았거나(usePending=false)
   기다려도 안 와서 중간 결과로 확정할 때(usePending=true) */
function settleStop(usePending) {
  if (stopSettleTimer) { clearTimeout(stopSettleTimer); stopSettleTimer = null; }
  awaitingFinal = false;
  if (usePending && pendingInterim) appendToLine(settleLineIndex, pendingInterim);
  pendingInterim = '';
  renderEditor();
  // 미리보기 화면을 보고 있으면 늦게 확정된 마지막 말도 반영
  if (document.getElementById('screen-preview').classList.contains('active')) renderPreview();
  if (onStopSettled) { const cb = onStopSettled; onStopSettled = null; cb(); }
}

function stopRecognition() {
  if (!recording) return;
  recording = false;
  // 중간 결과는 바로 붙이지 않고 담아만 둠 — 잠시 뒤 도착하는
  // 최종 결과(더 정확)가 오면 그걸 쓰고, 안 오면 이걸로 확정 (중복 방지)
  pendingInterim = interimText;
  interimText = '';
  settleLineIndex = currentLine;
  awaitingFinal = true;
  try { recognition.stop(); } catch { }
  stopSettleTimer = setTimeout(() => settleStop(true), 1200);
  updateRecUI();
  renderEditor();
}

function stopSpeaking() {
  if (!recording) return;
  // 종료가 확정된 뒤에(마지막 말까지 줄에 들어간 뒤에) 읽어 주기
  onStopSettled = () => {
    const line = currentPoem.lines[settleLineIndex];
    if (line) speak(line);
  };
  stopRecognition();
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

async function sendMail(voicePath, btn, btnHtml) {
  const title = (currentPoem.lines[0] || '').trim() || '(제목 없음)';
  const name = (currentPoem.lines[1] || '').trim();
  const content = currentPoem.lines.slice(2).filter(l => l.trim()).join('\n');

  // EmailJS 설정 전이면 메일 앱으로 대신 열기 (임시 동작)
  if (EMAIL_CONFIG.publicKey === 'YOUR_PUBLIC_KEY') {
    location.href = 'mailto:' + EMAIL_CONFIG.toEmail
      + '?subject=' + encodeURIComponent('[시집] ' + title)
      + '&body=' + encodeURIComponent(title + '\n' + name + '\n\n' + content);
    showScreen('screen-list'); renderList();
    return true;
  }

  if (btn) { btn.disabled = true; btn.innerHTML = '보내는 중...'; }
  try {
    await emailjs.send(EMAIL_CONFIG.serviceId, EMAIL_CONFIG.templateId, {
      to_email: EMAIL_CONFIG.toEmail,
      poem_title: title,
      poem_name: name,
      poem_content: content,
      poem_voice: voicePath || '(녹음 없음)',
    });
    speak('시를 보냈어요.');
    showScreen('screen-list');
    renderList();
    return true;
  } catch (err) {
    speak('보내기에 실패했어요. 다시 눌러 주세요.');
    return false;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = btnHtml || ''; }
  }
}

/* ============================================================
   ⑤ 낭독 녹음 — 미리보기에서 [낭독 하기]로 녹음, [완료]로 함께 전송
   (받아쓰기와 시간을 분리: 안드로이드는 마이크 동시 사용 불가)
   ============================================================ */
const SUPA = {
  url: 'YOUR_SUPABASE_URL',        // 예: https://xxxx.supabase.co
  anonKey: 'YOUR_SUPABASE_ANON_KEY',
  bucket: 'voices',
};

let reciteStream = null, reciteRecorder = null, reciteChunks = [];
let reciting = false;             // 낭독 녹음 중인가
let reciteBlob = null;            // 낭독 종료 후 보관 중인 녹음
let pendingVoicePath = null;      // 업로드 성공 후 메일만 실패했을 때 재전송용

function updateReciteUI(msg) {
  const btn = document.getElementById('btn-read');
  btn.innerHTML = reciting ? '낭독 종료' : '낭독 하기';
  btn.classList.toggle('recording', reciting);
  const st = document.getElementById('preview-status');
  st.textContent = (msg !== undefined) ? msg : (reciting ? '● 녹음하고 있어요...' : '');
}

/* 미리보기를 드나들 때 녹음 상태 정리 (편집하면 이전 녹음은 무효) */
function resetRecite() {
  if (reciting) {
    reciting = false;
    stopReciteRecorder();   // 결과는 버림
  }
  reciteBlob = null;
  pendingVoicePath = null;
  updateReciteUI('');
}

function stopReciteRecorder() {
  return new Promise((resolve) => {
    if (!reciteRecorder || reciteRecorder.state === 'inactive') { resolve(null); return; }
    reciteRecorder.onstop = () => {
      const blob = new Blob(reciteChunks, { type: reciteRecorder.mimeType || 'audio/webm' });
      try { reciteStream.getTracks().forEach(t => t.stop()); } catch { }
      resolve(blob);
    };
    try { reciteRecorder.stop(); } catch { resolve(null); }
  });
}

async function uploadVoice(blob) {
  if (SUPA.url === 'YOUR_SUPABASE_URL') return '(저장소 미설정)';
  const title = ((currentPoem.lines[0] || '').trim() || '제목없음').replace(/[^0-9A-Za-z가-힣]/g, '');
  const ext = (blob.type || '').includes('mp4') ? 'm4a' : 'webm';
  const name = `${new Date().toISOString().slice(0, 10)}_${title}_${Date.now()}.${ext}`;
  for (let attempt = 0; attempt < 2; attempt++) {   // 한 번 재시도
    try {
      const res = await fetch(`${SUPA.url}/storage/v1/object/${SUPA.bucket}/${name}`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + SUPA.anonKey,
          apikey: SUPA.anonKey,
          'Content-Type': blob.type || 'audio/webm',
        },
        body: blob,
      });
      if (res.ok) return `${SUPA.bucket}/${name}`;
    } catch (e) { }
  }
  return '(녹음 업로드 실패)';
}

/* [낭독 하기] ↔ [낭독 종료] 토글 */
document.getElementById('btn-read').onclick = async () => {
  if (!reciting) {
    // 낭독 시작 = 녹음 시작. 받아쓰기가 마이크를 잡고 있으면 확실히 끔
    try { if (recognition) recognition.abort(); } catch { }
    recording = false;
    try {
      reciteStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      document.getElementById('preview-status').textContent = '마이크를 사용할 수 없어요';
      return;
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
    reciteChunks = [];
    reciteRecorder = mime ? new MediaRecorder(reciteStream, { mimeType: mime }) : new MediaRecorder(reciteStream);
    reciteRecorder.ondataavailable = (e) => { if (e.data && e.data.size) reciteChunks.push(e.data); };
    reciteBlob = null;
    pendingVoicePath = null;      // 새로 녹음하면 이전 업로드는 무효
    reciting = true;
    updateReciteUI();
    reciteRecorder.start(1000);   // 1초 단위 조각 저장
  } else {
    // 낭독 종료 = 녹음 종료, 파일은 보관
    reciting = false;
    const blob = await stopReciteRecorder();
    if (blob && blob.size > 0) reciteBlob = blob;
    updateReciteUI(reciteBlob ? '녹음됐어요 — [완료]를 누르면 함께 보내요' : '');
  }
};

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
  resetRecite();
  renderPreview();
  showScreen('screen-preview');
};

document.getElementById('btn-back').onclick = () => {
  resetRecite();               // 편집하러 가면 이전 녹음은 버림
  renderEditor();
  showScreen('screen-editor');
};

/* [완료] — 녹음 파일 업로드 + 시와 함께 메일 전송 */
document.getElementById('btn-done').onclick = async () => {
  const btn = document.getElementById('btn-done');
  if (reciting) {              // 낭독 중에 완료를 누르면 녹음을 끝내고 그걸 사용
    reciting = false;
    const blob = await stopReciteRecorder();
    if (blob && blob.size > 0) reciteBlob = blob;
    updateReciteUI('');
  }
  let voicePath = pendingVoicePath;   // 업로드까지 됐는데 메일만 실패했던 경우
  if (!voicePath) {
    if (reciteBlob) {
      btn.disabled = true;
      btn.innerHTML = '보내는 중...';
      voicePath = await uploadVoice(reciteBlob);
    } else {
      voicePath = '(녹음 없음)';
    }
  }
  const ok = await sendMail(voicePath, btn, '완료<br><small>(메일 보내기)</small>');
  if (ok) {
    reciteBlob = null;
    pendingVoicePath = null;
    document.getElementById('preview-status').textContent = '';
  } else {
    if (voicePath && voicePath.indexOf('(') !== 0) pendingVoicePath = voicePath;
    document.getElementById('preview-status').textContent = '전송 실패 — [완료]를 다시 눌러 주세요';
  }
};

document.getElementById('btn-to-list').onclick = () => {
  resetRecite();               // 목록으로 가면 이전 녹음은 버림
  renderList();
  showScreen('screen-list');
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
