// TuneDeck renderer — LP 위젯 + YouTube IFrame 플레이어
(() => {
  'use strict';

  const api = window.api;
  const $ = (id) => document.getElementById(id);
  const appEl = $('app');

  const els = {
    lp: $('lp'), labelImg: $('labelImg'), bgA: $('bgA'), bgB: $('bgB'),
    title: $('title'), artist: $('artist'), cur: $('cur'), dur: $('dur'), seek: $('seek'),
    play: $('playBtn'), prev: $('prevBtn'), next: $('nextBtn'),
    shuffle: $('shuffleBtn'), repeat: $('repeatBtn'), volume: $('volume'),
    form: $('addForm'), input: $('linkInput'), msg: $('addMsg'),
    queue: $('queue'), count: $('count'), collapse: $('collapseBtn'), panel: document.querySelector('.panel'),
  };

  // ---------------- 상태 ----------------
  const state = {
    items: [],      // { id, title, author, broken? }
    index: -1,
    shuffle: false,
    repeat: 'all',  // all | one | off
    volume: 80,
  };
  let player = null;
  let playerReady = false;
  let isPlaying = false;
  let expanded = false;
  let busy = false;
  let lpStartTop = 6;
  let seeking = false;
  let errorStreak = 0;
  let history = [];
  let pendingAutoplay = false;

  // 10초 안에 YouTube 플레이어가 안 뜨면 알려주기
  setTimeout(() => {
    if (playerReady) return;
    const loaded = !!(window.YT && YT.Player);
    say(loaded
      ? '유튜브 플레이어가 응답하지 않아요. 트레이 아이콘 우클릭 → 종료 후 다시 실행해 보세요.'
      : 'youtube.com에 연결하지 못했어요. 인터넷 연결이나 방화벽·백신의 차단 여부를 확인해 주세요.', true);
    document.querySelector('.video-empty').textContent = '유튜브 플레이어를 불러오지 못했어요';
    appEl.classList.remove('has-track');
  }, 10000);

  const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  const current = () => state.items[state.index] || null;

  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api?.saveState({
        items: state.items, index: state.index,
        shuffle: state.shuffle, repeat: state.repeat, volume: state.volume,
      });
    }, 250);
  }

  // ---------------- 링크 해석 ----------------
  function parseLink(text) {
    const s = (text || '').trim();
    if (!s) return null;
    if (/^[\w-]{11}$/.test(s)) return { videoId: s };
    let u;
    try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let videoId = null;
    if (host === 'youtu.be') {
      videoId = u.pathname.slice(1).split('/')[0];
    } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      videoId = u.searchParams.get('v');
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      if (!videoId && m) videoId = m[1];
    } else {
      return null;
    }
    const listId = u.searchParams.get('list');
    if (videoId && /^[\w-]{11}$/.test(videoId)) return { videoId, listId };
    if (listId && /^[\w-]+$/.test(listId)) return { listId };
    return null;
  }

  // ---------------- 메시지 ----------------
  let msgTimer;
  function say(text, isError = false) {
    els.msg.textContent = text;
    els.msg.classList.toggle('error', isError);
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { els.msg.textContent = ''; }, 5000);
  }

  // ---------------- 곡 추가 ----------------
  async function fillMeta(item) {
    const meta = await api?.oembed(item.id).catch(() => null);
    if (meta) {
      item.title = meta.title;
      item.author = meta.author;
    } else if (item.title === '불러오는 중…') {
      item.title = 'YouTube 영상';
      item.author = '';
    }
    renderQueue();
    if (item === current()) renderNow();
    save();
  }

  function addVideo(id, { silent = false } = {}) {
    if (state.items.some((it) => it.id === id)) {
      if (!silent) say('이미 재생목록에 있는 곡이에요.');
      return null;
    }
    const item = { id, title: '불러오는 중…', author: '' };
    state.items.push(item);
    renderQueue();
    save();
    return item;
  }

  async function addFromText(text) {
    const parsed = parseLink(text);
    if (!parsed) {
      say('유튜브 링크가 아니에요. youtube.com 이나 youtu.be 주소를 넣어주세요.', true);
      return false;
    }
    if (parsed.videoId) {
      const item = addVideo(parsed.videoId);
      if (!item) return true;
      const startNow = state.index < 0 || !isPlaying;
      if (startNow) playAt(state.items.length - 1);
      await fillMeta(item);
      say(startNow ? `재생해요: ${item.title}` : `추가했어요: ${item.title}`);
      return true;
    }
    // 재생목록 링크
    say('재생목록을 불러오는 중…');
    const ids = await resolvePlaylist(parsed.listId);
    if (!ids || !ids.length) {
      say('재생목록을 불러오지 못했어요. 공개 또는 일부 공개 재생목록인지 확인해 주세요.', true);
      return true;
    }
    const firstNew = state.items.length;
    const added = ids.map((id) => addVideo(id, { silent: true })).filter(Boolean);
    if (!added.length) { say('재생목록의 곡이 모두 이미 들어 있어요.'); return true; }
    if (state.index < 0 || !isPlaying) playAt(firstNew);
    say(`재생목록에서 ${added.length}곡을 추가했어요.`);
    // 곡 정보는 4개씩 나눠 조회
    for (let i = 0; i < added.length; i += 4) {
      await Promise.all(added.slice(i, i + 4).map(fillMeta));
    }
    return true;
  }

  let resolver = null;
  function resolvePlaylist(listId) {
    return new Promise((resolve) => {
      if (!window.YT || !YT.Player) return resolve(null);
      const done = (ids) => { clearTimeout(timer); resolve(ids); };
      const timer = setTimeout(() => done(null), 12000);
      const onState = (e) => {
        if (e.data === YT.PlayerState.CUED) {
          const ids = e.target.getPlaylist();
          if (ids && ids.length) done(ids);
        }
      };
      if (resolver) {
        resolver._onState = onState;
        resolver.cuePlaylist({ listType: 'playlist', list: listId });
        return;
      }
      resolver = new YT.Player('resolver', {
        width: 200, height: 200,
        playerVars: { listType: 'playlist', list: listId, origin: location.origin },
        events: {
          onReady: (e) => e.target.cuePlaylist({ listType: 'playlist', list: listId }),
          onStateChange: (e) => resolver._onState && resolver._onState(e),
          onError: () => done(null),
        },
      });
      resolver._onState = onState;
    });
  }

  // ---------------- 재생 ----------------
  function playAt(i, { autoplay = true } = {}) {
    if (i < 0 || i >= state.items.length) return;
    if (state.index !== i && state.index >= 0) history.push(state.index);
    state.index = i;
    const item = current();
    if (playerReady) {
      if (autoplay) player.loadVideoById(item.id);
      else player.cueVideoById(item.id);
    } else {
      // 플레이어가 아직 준비 안 됨 → 준비되면 바로 재생
      pendingAutoplay = autoplay;
      if (!window.YT || !YT.Player) say('유튜브 플레이어를 불러오는 중이에요… 준비되면 바로 재생돼요.');
    }
    renderNow();
    renderQueue();
    save();
  }

  function nextIndex() {
    const n = state.items.length;
    if (!n) return -1;
    if (state.shuffle && n > 1) {
      let r;
      do { r = Math.floor(Math.random() * n); } while (r === state.index);
      return r;
    }
    if (state.index + 1 < n) return state.index + 1;
    return state.repeat === 'all' ? 0 : -1;
  }

  function next(auto = false) {
    if (auto && state.repeat === 'one' && playerReady) {
      player.seekTo(0, true);
      player.playVideo();
      return;
    }
    const i = nextIndex();
    if (i >= 0) playAt(i);
    else if (playerReady) player.stopVideo();
  }

  function prev() {
    if (playerReady && player.getCurrentTime() > 3) { player.seekTo(0, true); return; }
    if (state.shuffle && history.length) {
      const i = history.pop();
      state.index = -1; // history 에 다시 쌓이지 않도록
      playAt(i);
      return;
    }
    const n = state.items.length;
    if (!n) return;
    playAt(state.index > 0 ? state.index - 1 : (state.repeat === 'all' ? n - 1 : 0));
  }

  function togglePlay() {
    if (!playerReady) return;
    if (state.index < 0 && state.items.length) return playAt(0);
    if (isPlaying) player.pauseVideo();
    else player.playVideo();
  }

  function setPlaying(v) {
    isPlaying = v;
    appEl.classList.toggle('playing', v);
    els.play.setAttribute('aria-label', v ? '일시정지' : '재생');
    els.play.title = v ? '일시정지 (Space)' : '재생 (Space)';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = v ? 'playing' : 'paused';
  }

  // YouTube IFrame API 진입점
  window.onYouTubeIframeAPIReady = () => {
    player = new YT.Player('player', {
      width: '100%', height: '100%',
      playerVars: { playsinline: 1, rel: 0, origin: location.origin, enablejsapi: 1 },
      events: {
        onReady: () => {
          playerReady = true;
          player.setVolume(state.volume);
          if (current()) {
            if (pendingAutoplay) player.loadVideoById(current().id);
            else player.cueVideoById(current().id);
          }
          pendingAutoplay = false;
        },
        onStateChange: (e) => {
          const S = YT.PlayerState;
          if (e.data === S.PLAYING) {
            setPlaying(true);
            errorStreak = 0;
            const it = current();
            if (it && it.broken) { delete it.broken; renderQueue(); save(); }
          } else if (e.data === S.PAUSED || e.data === S.CUED || e.data === S.UNSTARTED) {
            setPlaying(false);
          } else if (e.data === S.ENDED) {
            setPlaying(false);
            next(true);
          }
        },
        onError: (e) => {
          const it = current();
          if (it) { it.broken = true; renderQueue(); save(); }
          const code = e.data;
          const reasons = {
            2: '링크의 영상 ID가 올바르지 않아요',
            5: '이 영상은 이 플레이어에서 재생할 수 없어요',
            100: '삭제됐거나 비공개인 영상이에요',
            101: '업로더가 외부 재생을 막아 둔 영상이에요',
            150: '업로더가 외부 재생을 막아 둔 영상이에요',
            152: '유튜브 플레이어 설정 오류예요',
            153: '유튜브 플레이어 설정 오류예요',
          };
          say(`${reasons[code] || '이 영상을 재생할 수 없어요'} (오류 ${code}). 다음 곡으로 넘어갈게요.`, true);
          setPlaying(false);
          errorStreak++;
          if (errorStreak < state.items.length) setTimeout(() => next(false), 900);
        },
      },
    });
  };

  // ---------------- 화면 그리기 ----------------
  let bgFront = els.bgA;
  let lastCover = '';
  function setCover(id) {
    const src = id ? thumb(id) : '';
    if (src === lastCover) return;
    lastCover = src;

    els.labelImg.classList.remove('show');
    if (src) {
      els.labelImg.onload = () => els.labelImg.classList.add('show');
      els.labelImg.src = src;
    } else {
      els.labelImg.removeAttribute('src');
    }

    const back = bgFront === els.bgA ? els.bgB : els.bgA;
    if (src) {
      back.onload = () => { back.classList.add('show'); bgFront.classList.remove('show'); bgFront = back; };
      back.src = src;
    } else {
      bgFront.classList.remove('show');
    }
  }

  function renderNow() {
    const it = current();
    appEl.classList.toggle('has-track', !!it);
    if (it) {
      els.title.textContent = it.title;
      els.artist.textContent = it.author || ' ';
      els.lp.setAttribute('aria-label', `${expanded ? '' : '펼치기 — '}${it.title}`);
      els.lp.title = it.title;
      document.title = `${it.title} — TuneDeck`;
      api?.nowPlaying(it.title);
      if ('mediaSession' in navigator && window.MediaMetadata) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: it.title, artist: it.author || '',
          artwork: [{ src: thumb(it.id), sizes: '320x180', type: 'image/jpeg' }],
        });
      }
    } else {
      els.title.textContent = '아직 재생 중인 곡이 없어요';
      els.artist.textContent = '아래 칸에 유튜브 링크를 붙여넣어 보세요';
      els.lp.title = 'TuneDeck';
      document.title = 'TuneDeck';
      api?.nowPlaying('');
    }
    setCover(it && it.id);
  }

  const X_ICON = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8"/></svg>';

  function renderQueue() {
    const q = els.queue;
    q.textContent = '';
    els.count.textContent = state.items.length ? `${state.items.length}곡` : '';
    if (!state.items.length) {
      const li = document.createElement('li');
      li.className = 'empty-list';
      li.textContent = '재생목록이 비어 있어요. 링크를 추가하거나 창에 끌어다 놓으세요.';
      q.appendChild(li);
      return;
    }
    state.items.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = 'item' + (i === state.index ? ' current' : '') + (it.broken ? ' broken' : '');
      li.tabIndex = 0;
      li.draggable = true;
      li.dataset.i = i;
      li.title = it.broken ? '재생할 수 없는 영상' : it.title;

      const th = document.createElement('span');
      th.className = 'thumb';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = thumb(it.id);
      th.appendChild(img);

      const text = document.createElement('span');
      text.className = 'text';
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = it.title;
      const a = document.createElement('div');
      a.className = 'a';
      a.textContent = it.author || ' ';
      text.append(t, a);

      const rm = document.createElement('button');
      rm.className = 'rm';
      rm.type = 'button';
      rm.title = '재생목록에서 빼기';
      rm.setAttribute('aria-label', `${it.title} 빼기`);
      rm.innerHTML = X_ICON;

      li.append(th, text, rm);
      q.appendChild(li);
    });
    const cur = q.querySelector('.current');
    if (cur && expanded) cur.scrollIntoView({ block: 'nearest' });
  }

  function removeAt(i) {
    const wasCurrent = i === state.index;
    state.items.splice(i, 1);
    history = [];
    if (i < state.index) state.index--;
    else if (wasCurrent) {
      if (!state.items.length) {
        state.index = -1;
        if (playerReady) player.stopVideo();
        setPlaying(false);
      } else {
        const ni = Math.min(i, state.items.length - 1);
        state.index = -1;
        playAt(ni, { autoplay: isPlaying });
        return;
      }
    }
    renderNow();
    renderQueue();
    save();
  }

  function move(from, to) {
    if (from === to) return;
    const curItem = current();
    const [it] = state.items.splice(from, 1);
    state.items.splice(to, 0, it);
    state.index = curItem ? state.items.indexOf(curItem) : -1;
    history = [];
    renderQueue();
    save();
  }

  // ---------------- 재생목록 이벤트 ----------------
  els.queue.addEventListener('click', (e) => {
    const li = e.target.closest('.item');
    if (!li) return;
    const i = +li.dataset.i;
    if (e.target.closest('.rm')) return removeAt(i);
    if (i === state.index) togglePlay();
    else playAt(i);
  });
  els.queue.addEventListener('keydown', (e) => {
    const li = e.target.closest('.item');
    if (!li) return;
    const i = +li.dataset.i;
    if (e.key === 'Enter') { e.preventDefault(); playAt(i); }
    if (e.key === 'Delete') { e.preventDefault(); removeAt(i); }
  });

  // 끌어서 순서 바꾸기
  const DND = 'application/x-tunedeck-index';
  let dragFrom = -1;
  els.queue.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.item');
    if (!li) return;
    dragFrom = +li.dataset.i;
    e.dataTransfer.setData(DND, String(dragFrom));
    e.dataTransfer.effectAllowed = 'move';
    li.classList.add('dragging');
  });
  els.queue.addEventListener('dragend', () => {
    dragFrom = -1;
    els.queue.querySelectorAll('.dragging,.drop-above,.drop-below')
      .forEach((n) => n.classList.remove('dragging', 'drop-above', 'drop-below'));
  });
  els.queue.addEventListener('dragover', (e) => {
    if (dragFrom < 0) return;
    const li = e.target.closest('.item');
    if (!li) return;
    e.preventDefault();
    e.stopPropagation();
    const r = li.getBoundingClientRect();
    const below = e.clientY > r.top + r.height / 2;
    els.queue.querySelectorAll('.drop-above,.drop-below').forEach((n) => n.classList.remove('drop-above', 'drop-below'));
    li.classList.add(below ? 'drop-below' : 'drop-above');
  });
  els.queue.addEventListener('drop', (e) => {
    if (dragFrom < 0) return;
    const li = e.target.closest('.item');
    e.preventDefault();
    e.stopPropagation();
    if (!li) return;
    const r = li.getBoundingClientRect();
    let to = +li.dataset.i + (e.clientY > r.top + r.height / 2 ? 1 : 0);
    if (to > dragFrom) to--;
    move(dragFrom, to);
  });

  // 다른 곳(브라우저 주소창 등)에서 링크를 끌어다 놓기
  document.addEventListener('dragover', (e) => {
    if (dragFrom >= 0) return;
    e.preventDefault();
    appEl.classList.add('drop-hint');
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) appEl.classList.remove('drop-hint');
  });
  document.addEventListener('drop', async (e) => {
    if (dragFrom >= 0) return;
    e.preventDefault();
    appEl.classList.remove('drop-hint');
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (!text) return;
    if (!expanded) await expand();
    addFromText(text.split('\n')[0]);
  });

  // ---------------- 추가 폼 ----------------
  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = els.input.value;
    if (!v.trim()) { els.input.focus(); return; }
    const ok = await addFromText(v);
    if (ok) els.input.value = '';
  });

  // 입력칸 밖에서 Ctrl+V 해도 바로 추가
  document.addEventListener('paste', (e) => {
    if (e.target === els.input) return;
    const text = e.clipboardData.getData('text');
    if (text) { e.preventDefault(); addFromText(text); }
  });

  // ---------------- 컨트롤 ----------------
  els.play.addEventListener('click', togglePlay);
  els.next.addEventListener('click', () => next(false));
  els.prev.addEventListener('click', prev);

  function renderModes() {
    els.shuffle.setAttribute('aria-pressed', String(state.shuffle));
    els.shuffle.title = state.shuffle ? '셔플 켜짐' : '셔플';
    const labels = { all: '반복: 전체', one: '반복: 한 곡', off: '반복 안 함' };
    els.repeat.dataset.mode = state.repeat;
    els.repeat.setAttribute('aria-pressed', String(state.repeat !== 'off'));
    els.repeat.title = labels[state.repeat];
    els.repeat.setAttribute('aria-label', labels[state.repeat]);
  }
  els.shuffle.addEventListener('click', () => { state.shuffle = !state.shuffle; history = []; renderModes(); save(); });
  els.repeat.addEventListener('click', () => {
    state.repeat = { all: 'one', one: 'off', off: 'all' }[state.repeat];
    renderModes();
    save();
  });

  function paintRange(input) {
    const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--pct', pct + '%');
  }
  els.volume.addEventListener('input', () => {
    state.volume = +els.volume.value;
    paintRange(els.volume);
    if (playerReady) { player.setVolume(state.volume); if (state.volume > 0) player.unMute(); }
    save();
  });

  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };
  els.seek.addEventListener('input', () => {
    seeking = true;
    paintRange(els.seek);
    if (playerReady) els.cur.textContent = fmt((els.seek.value / 1000) * player.getDuration());
  });
  els.seek.addEventListener('change', () => {
    if (playerReady) player.seekTo((els.seek.value / 1000) * player.getDuration(), true);
    seeking = false;
  });
  setInterval(() => {
    if (!playerReady || seeking || !expanded) return;
    const d = player.getDuration() || 0;
    const t = player.getCurrentTime() || 0;
    els.cur.textContent = fmt(t);
    els.dur.textContent = fmt(d);
    els.seek.value = d ? Math.round((t / d) * 1000) : 0;
    paintRange(els.seek);
  }, 400);

  // ---------------- 접기 / 펼치기 ----------------
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

  async function expand() {
    if (expanded || busy) return;
    busy = true;
    lpStartTop = api ? await api.prepareExpand() : 6;
    appEl.classList.add('no-anim');
    appEl.style.setProperty('--lp-top', lpStartTop + 'px');
    await api?.expand();
    await frame();
    appEl.classList.remove('no-anim');
    await frame();
    appEl.classList.remove('collapsed');
    appEl.classList.add('expanded');
    els.panel.setAttribute('aria-hidden', 'false');
    expanded = true;
    els.lp.setAttribute('aria-label', '지금 재생 중인 LP');
    renderQueue();
    await wait(560);
    busy = false;
  }

  async function collapse() {
    if (!expanded || busy) return;
    busy = true;
    expanded = false;
    appEl.classList.remove('expanded');
    appEl.classList.add('collapsed');
    els.panel.setAttribute('aria-hidden', 'true');
    document.activeElement?.blur();
    await wait(560);
    appEl.classList.add('no-anim');
    appEl.style.setProperty('--lp-top', '6px');
    await api?.collapse();
    await frame();
    appEl.classList.remove('no-anim');
    renderNow();
    busy = false;
  }

  const toggle = () => (expanded ? collapse() : expand());
  els.collapse.addEventListener('click', collapse);
  $('quitBtn').addEventListener('click', () => api?.quit());

  // 자동 업데이트 알림
  api?.onUpdateReady((v) => {
    $('updateText').textContent = `새 버전 ${v}이 준비됐어요`;
    $('updateBar').hidden = false;
  });
  $('updateBtn').addEventListener('click', () => api?.applyUpdate());

  // LP: 접힌 상태에서는 클릭=펼치기, 위아래로 끌기=위치 옮기기
  let press = null;
  els.lp.addEventListener('pointerdown', (e) => {
    if (expanded || e.button !== 0) return;
    press = { y: e.screenY, dragging: false };
    els.lp.setPointerCapture(e.pointerId);
  });
  els.lp.addEventListener('pointermove', (e) => {
    if (!press) return;
    if (!press.dragging && Math.abs(e.screenY - press.y) > 4) {
      press.dragging = true;
      api?.dragStart(press.y);
    }
    if (press.dragging) api?.dragMove(e.screenY);
  });
  els.lp.addEventListener('pointerup', () => {
    if (!press) return;
    const wasDrag = press.dragging;
    press = null;
    if (wasDrag) api?.dragEnd();
    else expand();
  });
  els.lp.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !expanded) { e.preventDefault(); expand(); }
  });
  els.lp.addEventListener('click', (e) => e.preventDefault());

  // 키보드
  document.addEventListener('keydown', (e) => {
    const typing = e.target === els.input;
    if (e.key === 'Escape') { if (typing) els.input.blur(); else collapse(); return; }
    if (typing || !expanded) return;
    if (e.key === ' ' && !e.target.closest('button, .item')) { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight' && e.altKey) next(false);
    else if (e.key === 'ArrowLeft' && e.altKey) prev();
  });

  // 트레이·전역 단축키·미디어 키
  api?.onToggle(toggle);
  api?.onMedia((a) => ({ playPause: togglePlay, next: () => next(false), prev }[a]?.()));
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => playerReady && player.playVideo());
    ms.setActionHandler('pause', () => playerReady && player.pauseVideo());
    ms.setActionHandler('nexttrack', () => next(false));
    ms.setActionHandler('previoustrack', prev);
  }

  // ---------------- 시작 ----------------
  (async () => {
    const saved = api ? await api.loadState() : null;
    if (saved && Array.isArray(saved.items)) {
      state.items = saved.items.filter((it) => it && /^[\w-]{11}$/.test(it.id));
      state.index = Math.min(saved.index ?? -1, state.items.length - 1);
      state.shuffle = !!saved.shuffle;
      state.repeat = ['all', 'one', 'off'].includes(saved.repeat) ? saved.repeat : 'all';
      state.volume = Number.isFinite(saved.volume) ? saved.volume : 80;
    }
    els.volume.value = state.volume;
    paintRange(els.volume);
    paintRange(els.seek);
    renderModes();
    renderNow();
    renderQueue();
    if (playerReady && current()) player.cueVideoById(current().id);
  })();

  // 미리보기/테스트용
  window.__tunedeck = { state, expand, collapse, renderNow, renderQueue, setPlaying, parseLink };
})();
