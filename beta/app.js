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
let readingAll = false;       // 전체 낭독 중인가
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

/* ============================================================
   목소리 녹음 (테스트 중) — STT와 동시에 원본 오디오 저장
   ============================================================ */
let voiceStream = null, voiceRecorder = null, voiceChunks = [], lastVoiceBlob = null;

async function startVoiceCapture() {
  try {
    if (!voiceStream || !voiceStream.active) {
      voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
    voiceChunks = [];
    voiceRecorder = mime ? new MediaRecorder(voiceStream, { mimeType: mime }) : new MediaRecorder(voiceStream);
    voiceRecorder.ondataavailable = (e) => { if (e.data && e.data.size) voiceChunks.push(e.data); };
    voiceRecorder.onstop = () => {
      lastVoiceBlob = new Blob(voiceChunks, { type: voiceRecorder.mimeType || 'audio/webm' });
      showVoiceDebug();
    };
    voiceRecorder.start(1000);   // 1초 단위 조각 저장
  } catch (e) {
    showVoiceDebug('녹음 실패: ' + (e.name || e));
  }
}

function stopVoiceCapture() {
  try { if (voiceRecorder && voiceRecorder.state !== 'inactive') voiceRecorder.stop(); } catch { }
}

/* 테스트용 배너: 녹음 크기 표시, 누르면 마지막 녹음 재생 */
function showVoiceDebug(msg) {
  let el = document.getElementById('voice-debug');
  if (!el) {
    el = document.createElement('div');
    el.id = 'voice-debug';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#1d5c2e;color:#fff;'
      + 'font-size:15px;font-family:monospace;padding:6px 10px;z-index:98;text-align:center;';
    el.onclick = () => {
      if (lastVoiceBlob) new Audio(URL.createObjectURL(lastVoiceBlob)).play();
    };
    document.body.appendChild(el);
  }
  el.textContent = msg
    || ('목소리 녹음 ' + Math.round((lastVoiceBlob ? lastVoiceBlob.size : 0) / 1024) + 'KB — 누르면 재생');
}

function startSpeaking() {
  if (recording) return;
  if (!recognition) recognition = setupRecognition();
  if (!recognition) {
    document.getElementById('rec-status').textContent = '이 폰에서는 음성 인식이 안 돼요';
    return;
  }
  startVoiceCapture();   // 목소리 원본도 같이 녹음 (실패해도 받아쓰기는 계속)
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
  stopVoiceCapture();
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
  // 어떤 경우에도 호출한 쪽(버튼 동작)을 막으면 안 됨
  try {
    readingAll = false;
    speechSynthesis.cancel();
    document.getElementById('btn-read').textContent = '전체 낭독';
  } catch (e) { }
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

  readingAll = true;
  const btn = document.getElementById('btn-read');
  btn.textContent = '낭독 멈추기';
  const koVoice = speechSynthesis.getVoices().find(v => v.lang && v.lang.replace('_', '-').startsWith('ko'));
  const startReading = () => {
    if (!readingAll) return;   // 그 사이 멈췄으면 취소
    // 행마다 따로 읽어서 시 낭독처럼 사이가 살짝 벌어지게
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p);
      u.lang = 'ko-KR';
      u.rate = 0.85;
      if (koVoice) u.voice = koVoice;
      if (i === parts.length - 1) u.onend = stopReading;
      speechSynthesis.speak(u);
    });
  };
  if (speechSynthesis.speaking || speechSynthesis.pending) {
    speechSynthesis.cancel();
    setTimeout(startReading, 80);  // 안드로이드: cancel 직후 speak 무시 버그 회피
  } else {
    startReading();
  }
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
