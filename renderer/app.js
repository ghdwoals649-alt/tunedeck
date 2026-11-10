// TuneDeck renderer — 카세트 위젯 + YouTube IFrame 플레이어 + 검색
(() => {
  'use strict';

  const api = window.api;
  const $ = (id) => document.getElementById(id);
  const appEl = $('app');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const els = {
    tape: $('tape'), deck: document.querySelector('.deck'),
    labelImg: $('labelImg'), labelTitle: $('labelTitle'), labelArtist: $('labelArtist'),
    bgA: $('bgA'), bgB: $('bgB'),
    title: $('title'), artist: $('artist'), cur: $('cur'), dur: $('dur'), seek: $('seek'),
    play: $('playBtn'), prev: $('prevBtn'), next: $('nextBtn'),
    shuffle: $('shuffleBtn'), repeat: $('repeatBtn'), volume: $('volume'), opacity: $('opacity'), viz: $('viz'),
    searchForm: $('searchForm'), searchInput: $('searchInput'), msg: $('msg'),
    tabQueue: $('tabQueue'), tabResults: $('tabResults'),
    queue: $('queue'), count: $('count'), resultsPane: $('resultsPane'), results: $('results'),
    keyCard: $('keyCard'), keyForm: $('keyForm'), keyInput: $('keyInput'),
    collapse: $('collapseBtn'), panel: document.querySelector('.panel'),
  };

  // ---------------- 상태 ----------------
  const state = {
    items: [],      // { id, title, author, duration?, broken? }
    index: -1,
    shuffle: false,
    repeat: 'all',  // all | one | off
    volume: 80,
    opacity: 100,
    secrets: false, // 숨은 테마를 찾았는지
    showVideo: false, // '영상도 보기'
  };
  // 지금 테마의 본체 요소 — 교체 애니메이션은 이 요소에 적용
  let skin = 'cassette';
  const BODY = {
    cassette: '.tape-body', lp: '.lp-body', cd: '.cd-body',
    washer: '.washer-body', tire: '.tire-body', magic: '.magic-body', // 숨은 테마
  };
  const SECRET = ['washer', 'tire', 'magic'];
  const activeBody = () => document.querySelector(BODY[skin] || '.tape-body');
  let player = null;
  let playerReady = false;
  let isPlaying = false;
  let expanded = false;
  let busy = false;
  let seeking = false;
  let errorStreak = 0;
  let history = [];
  let pendingAutoplay = false;
  let results = [];
  let pendingQuery = '';

  // 10초 안에 YouTube 플레이어가 안 뜨면 알려주기
  setTimeout(() => {
    if (playerReady) return;
    const loaded = !!(window.YT && YT.Player);
    say(loaded
      ? '유튜브 플레이어가 응답하지 않아요. 종료 후 다시 실행해 보세요.'
      : 'youtube.com에 연결하지 못했어요. 인터넷 연결이나 방화벽·백신의 차단 여부를 확인해 주세요.', true);
  }, 10000);

  const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  const current = () => state.items[state.index] || null;

  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api?.saveState({
        items: state.items, index: state.index,
        shuffle: state.shuffle, repeat: state.repeat, volume: state.volume, opacity: state.opacity, secrets: state.secrets, showVideo: state.showVideo,
      });
    }, 250);
  }

  // ---------------- 링크 해석 ----------------
  function parseLink(text) {
    const s = (text || '').trim();
    if (!s) return null;
    if (/^[\w-]{11}$/.test(s) && /[0-9_-]/.test(s)) return { videoId: s };
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
    msgTimer = setTimeout(() => { els.msg.textContent = ''; }, 6000);
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

  function addVideo(id, { silent = false, meta = null } = {}) {
    if (state.items.some((it) => it.id === id)) {
      if (!silent) say('이미 재생목록에 있는 곡이에요.');
      return null;
    }
    const item = meta
      ? { id, title: meta.title, author: meta.author || '', duration: meta.duration || '' }
      : { id, title: '불러오는 중…', author: '' };
    state.items.push(item);
    renderQueue();
    renderResults();
    save();
    return item;
  }

  async function addFromText(text) {
    const parsed = parseLink(text);
    if (!parsed) return false;
    if (parsed.videoId) {
      const item = addVideo(parsed.videoId);
      if (!item) return true;
      const startNow = state.index < 0 || !isPlaying;
      if (startNow) playAt(state.items.length - 1);
      await fillMeta(item);
      say(startNow ? `재생해요: ${item.title}` : `재생목록에 추가했어요: ${item.title}`);
      return true;
    }
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

  // ---------------- 검색 ----------------
  function showTab(name) {
    const isResults = name === 'results';
    els.tabQueue.setAttribute('aria-selected', String(!isResults));
    els.tabResults.setAttribute('aria-selected', String(isResults));
    els.queue.hidden = isResults;
    els.resultsPane.hidden = !isResults;
  }
  els.tabQueue.addEventListener('click', () => showTab('queue'));
  els.tabResults.addEventListener('click', () => showTab('results'));

  function showKeyCard(show) {
    els.keyCard.hidden = !show;
    if (show) setTimeout(() => els.keyInput.focus(), 50);
  }

  const SEARCH_ERRORS = {
    badkey: 'API 키가 올바르지 않아요. 키를 다시 확인해 주세요.',
    notenabled: 'Google Cloud에서 "YouTube Data API v3"를 사용 설정해 주세요.',
    quota: '오늘 검색 한도를 다 썼어요. 내일 다시 검색할 수 있어요. 링크 붙여넣기는 계속 돼요.',
    network: '검색 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.',
    fail: '검색하지 못했어요. 잠시 뒤 다시 해 보세요.',
    format: 'API 키 형식이 아니에요. AIza로 시작하는 키를 그대로 붙여넣어 주세요.',
  };

  async function doSearch(q) {
    showTab('results');
    if (!api) return;
    if (!(await api.hasKey())) {
      pendingQuery = q;
      showKeyCard(true);
      say('검색하려면 API 키를 한 번 입력해 주세요.');
      return;
    }
    els.searchForm.classList.add('loading');
    say(`"${q}" 검색 중…`);
    const r = await api.search(q).catch(() => ({ error: 'network' }));
    els.searchForm.classList.remove('loading');
    if (r.error) {
      if (r.error === 'nokey' || r.error === 'badkey' || r.error === 'notenabled') {
        pendingQuery = q;
        showKeyCard(true);
      }
      say(SEARCH_ERRORS[r.error] || SEARCH_ERRORS.fail, true);
      return;
    }
    showKeyCard(false);
    results = r.items || [];
    renderResults();
    els.resultsPane.scrollTop = 0;
    say(results.length ? `"${q}" 검색 결과 ${results.length}개` : `"${q}" 검색 결과가 없어요.`);
  }

  els.keyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = els.keyInput.value.trim();
    if (!key) return els.keyInput.focus();
    say('키를 확인하는 중…');
    const r = await api.setKey(key);
    if (!r.ok) { say(SEARCH_ERRORS[r.error] || SEARCH_ERRORS.fail, true); return; }
    els.keyInput.value = '';
    showKeyCard(false);
    say('API 키를 저장했어요. 이제 검색할 수 있어요.');
    if (pendingQuery) { const q = pendingQuery; pendingQuery = ''; doSearch(q); }
  });
  $('keyHelpBtn').addEventListener('click', () =>
    api?.openExternal('https://console.cloud.google.com/apis/library/youtube.googleapis.com'));

  function playNow(r) {
    let idx = state.items.findIndex((it) => it.id === r.id);
    if (idx < 0) {
      const at = state.index >= 0 ? state.index + 1 : state.items.length;
      state.items.splice(at, 0, { id: r.id, title: r.title, author: r.author || '', duration: r.duration || '' });
      history = [];
      idx = at;
    }
    playAt(idx);
    renderResults();
  }

  // 링크 전용판(친구용): 검색 없이 유튜브 링크로만 추가
  let searchEnabled = true;
  function applyEdition(ed) {
    searchEnabled = !ed || ed.search !== false;
    appEl.classList.toggle('no-search', !searchEnabled);
    if (!searchEnabled) {
      els.searchInput.placeholder = '유튜브 링크 붙여넣기';
      els.searchInput.setAttribute('aria-label', '유튜브 링크');
      els.searchForm.querySelector('button').textContent = '추가';
      showTab('queue');
    }
  }

  els.searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = els.searchInput.value.trim();
    if (!v) { els.searchInput.focus(); return; }
    if (!searchEnabled && !parseLink(v)) {
      say('유튜브 링크를 붙여넣어 주세요. (youtube.com 또는 youtu.be 주소)', true);
      return;
    }
    if (parseLink(v)) {
      await addFromText(v);
      els.searchInput.value = '';
      showTab('queue');
    } else {
      doSearch(v);
    }
  });

  // 창 어디서든 유튜브 링크를 Ctrl+V 하면 바로 추가
  document.addEventListener('paste', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const text = e.clipboardData.getData('text');
    if (text && parseLink(text)) { e.preventDefault(); addFromText(text); }
  });

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
      state.index = -1;
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
            // 제목을 못 가져온 곡이면 플레이어가 아는 제목·채널로 채움
            if (it && (it.title === 'YouTube 영상' || it.title === '불러오는 중…')) {
              try {
                const d = player.getVideoData();
                if (d && d.video_id === it.id && d.title) {
                  it.title = d.title;
                  if (d.author) it.author = d.author;
                  renderNow(); renderQueue(); save();
                }
              } catch {}
            }
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
            2: '영상 ID가 올바르지 않아요',
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

  // ---------------- 카세트 ----------------
  function setSpools(p) {
    p = Math.max(0, Math.min(1, p || 0));
    els.tape.style.setProperty('--sl', (0.47 + 0.53 * (1 - p)).toFixed(3));
    els.tape.style.setProperty('--sr', (0.47 + 0.53 * p).toFixed(3));
  }

  let labelId;
  function setCassetteLabel(it) {
    els.labelTitle.textContent = it ? it.title : 'TuneDeck';
    els.labelArtist.textContent = it ? (it.author || '') : '빈 테이프';
    const id = it ? it.id : null;
    if (id === labelId) return;
    labelId = id;
    setSpools(0);
    // 카세트 사진 스티커, LP 라벨, CD 인쇄면 모두 같은 표지로
    document.querySelectorAll('.cover-img').forEach((img) => {
      img.classList.remove('show');
      if (id) {
        img.onload = () => img.classList.add('show');
        img.src = thumb(id);
      } else {
        img.removeAttribute('src');
      }
    });
  }

  // 곡이 바뀌면: 테이프를 꺼내고 → 라벨 교체 → 새 테이프를 넣는다
  // 애니메이션이 어떤 이유로 끝 신호를 못 받아도 정해진 시간 뒤엔 반드시 다음으로 넘어감
  const run = (el, frames, opts) => {
    let anim;
    try { anim = el.animate(frames, { fill: 'forwards', ...opts }); } catch { return Promise.resolve(); }
    return Promise.race([
      anim.finished.catch(() => {}),
      new Promise((r) => setTimeout(r, (opts.duration || 0) + 200)),
    ]);
  };
  // 카세트를 확실히 보이는 원래 상태로 되돌림 + 화면 다시 그리기
  function resetTape() {
    document.querySelectorAll('.tape-body, .disc-body').forEach((b) => {
      b.getAnimations().forEach((a) => a.cancel());
      b.style.top = '0px';
      b.style.visibility = 'visible';
    });
    els.tape.style.display = 'none';
    void els.tape.offsetHeight; // 강제로 다시 배치
    els.tape.style.display = '';
    api?.repaint?.();
  }
  let swapping = false;
  let swapAgain = false;
  let labelApplied = false;

  // 위/아래로만 움직임(top). 투명도·회전은 쓰지 않음.
  async function animOut() {
    if (expanded) {
      await run(activeBody(), [
        { top: '0%' },
        { top: '-14%', offset: 0.3 },
        { top: '-175%' },
      ], { duration: 420, easing: 'cubic-bezier(.5,0,.75,0)' });
    } else {
      await run(activeBody(), [{ top: '0%' }, { top: '-140%' }], { duration: 300, easing: 'ease-in' });
    }
    activeBody().style.visibility = 'hidden';
  }

  async function animIn() {
    activeBody().style.visibility = 'visible';
    if (expanded) {
      await run(activeBody(), [
        { top: '-175%' },
        { top: '-45%', offset: 0.42 },
        { top: '3%', offset: 0.78 },
        { top: '-1.2%', offset: 0.9 },
        { top: '0%' },
      ], { duration: 640, easing: 'cubic-bezier(.3,.7,.4,1)' });
      // 딸깍 — 데크가 살짝 눌림
      run(els.deck, [{ top: '4px' }, { top: '6px' }, { top: '4px' }], { duration: 180, easing: 'ease-out' })
        .then(() => els.deck.getAnimations().forEach((a) => a.cancel()));
    } else {
      await run(activeBody(), [
        { top: '-140%' },
        { top: '5%', offset: 0.75 },
        { top: '0%' },
      ], { duration: 420, easing: 'cubic-bezier(.3,.7,.4,1)' });
    }
    resetTape();
  }

  async function swapCassette() {
    if (swapping) { if (labelApplied) swapAgain = true; return; }
    swapping = true;
    appEl.classList.add('swapping');
    try {
      do {
        swapAgain = false;
        labelApplied = false;
        await animOut();
        setCassetteLabel(current()); // 꺼낸 사이에 최신 곡으로 라벨 교체
        labelApplied = true;
        await animIn();
      } while (swapAgain && current() && current().id !== labelId);
    } finally {
      resetTape();
      swapping = false;
      appEl.classList.remove('swapping');
    }
  }

  function updateCassette() {
    const it = current();
    const id = it ? it.id : null;
    if (labelId === undefined || reduceMotion || id === labelId) {
      if (!swapping) setCassetteLabel(it);
      return;
    }
    swapCassette();
  }

  // ---------------- 화면 그리기 ----------------
  let bgFront = els.bgA;
  let lastBg = '';
  function setBackdrop(id) {
    const src = id ? thumb(id) : '';
    if (src === lastBg) return;
    lastBg = src;
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
      els.tape.title = it.title;
      if (!expanded) els.tape.setAttribute('aria-label', `펼치기 — ${it.title}`);
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
      els.artist.textContent = '아래에서 듣고 싶은 곡을 검색해 보세요';
      els.tape.title = 'TuneDeck';
      document.title = 'TuneDeck';
      api?.nowPlaying('');
    }
    setBackdrop(it && it.id);
    updateCassette();
  }

  const ICON_X = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8"/></svg>';
  const ICON_PLUS = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2v10M2 7h10"/></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7"/></svg>';

  function makeItem(it, { cls = '', actIcon, actLabel, actClass = '' }) {
    const li = document.createElement('li');
    li.className = 'item' + cls;
    li.tabIndex = 0;

    const th = document.createElement('span');
    th.className = 'thumb';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = thumb(it.id);
    th.appendChild(img);
    if (it.duration) {
      const d = document.createElement('span');
      d.className = 'dur';
      d.textContent = it.duration;
      th.appendChild(d);
    }

    const text = document.createElement('span');
    text.className = 'text';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = it.title;
    const a = document.createElement('div');
    a.className = 'a';
    a.textContent = it.author || ' ';
    text.append(t, a);

    const act = document.createElement('button');
    act.className = 'act ' + actClass;
    act.type = 'button';
    act.title = actLabel;
    act.setAttribute('aria-label', `${it.title} ${actLabel}`);
    act.innerHTML = actIcon;

    li.append(th, text, act);
    return li;
  }

  function renderQueue() {
    const q = els.queue;
    q.textContent = '';
    els.count.textContent = state.items.length ? String(state.items.length) : '';
    if (!state.items.length) {
      const li = document.createElement('li');
      li.className = 'empty-list';
      li.textContent = searchEnabled ? '재생목록이 비어 있어요. 위에서 곡을 검색해 추가해 보세요.' : '재생목록이 비어 있어요. 위 칸에 유튜브 링크를 붙여넣어 보세요.';
      q.appendChild(li);
      return;
    }
    state.items.forEach((it, i) => {
      const li = makeItem(it, {
        cls: (i === state.index ? ' current' : '') + (it.broken ? ' broken' : ''),
        actIcon: ICON_X, actLabel: '재생목록에서 빼기',
      });
      li.draggable = true;
      li.dataset.i = i;
      if (it.broken) li.title = '재생할 수 없는 영상';
      q.appendChild(li);
    });
    const cur = q.querySelector('.current');
    if (cur && expanded && !q.hidden) cur.scrollIntoView({ block: 'nearest' });
  }

  function renderResults() {
    const box = els.results;
    box.textContent = '';
    if (!results.length) {
      const li = document.createElement('li');
      li.className = 'empty-list';
      li.textContent = '검색어를 입력하면 결과가 여기에 나와요.';
      box.appendChild(li);
      return;
    }
    results.forEach((r, i) => {
      const inQueue = state.items.some((it) => it.id === r.id);
      const playingNow = current() && current().id === r.id;
      const li = makeItem(r, {
        cls: playingNow ? ' current' : '',
        actIcon: inQueue ? ICON_CHECK : ICON_PLUS,
        actLabel: inQueue ? '재생목록에 있음' : '재생목록에 추가',
        actClass: inQueue ? 'done' : '',
      });
      li.dataset.r = i;
      li.title = '클릭하면 바로 재생';
      box.appendChild(li);
    });
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
        renderResults();
        return;
      }
    }
    renderNow();
    renderQueue();
    renderResults();
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

  // ---------------- 목록 이벤트 ----------------
  els.queue.addEventListener('click', (e) => {
    const li = e.target.closest('.item');
    if (!li) return;
    const i = +li.dataset.i;
    if (e.target.closest('.act')) return removeAt(i);
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

  els.results.addEventListener('click', (e) => {
    const li = e.target.closest('.item');
    if (!li) return;
    const r = results[+li.dataset.r];
    if (!r) return;
    if (e.target.closest('.act')) {
      if (state.items.some((it) => it.id === r.id)) return;
      addVideo(r.id, { meta: r });
      say(`재생목록에 추가했어요: ${r.title}`);
      if (state.index < 0) playAt(state.items.length - 1);
      return;
    }
    if (current() && current().id === r.id) togglePlay();
    else playNow(r);
  });
  els.results.addEventListener('keydown', (e) => {
    const li = e.target.closest('.item');
    if (!li || e.key !== 'Enter') return;
    e.preventDefault();
    const r = results[+li.dataset.r];
    if (r) playNow(r);
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

  // 브라우저에서 유튜브 링크를 끌어다 놓기
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
    if (!text || !parseLink(text.split('\n')[0])) return;
    if (!expanded) await expand();
    addFromText(text.split('\n')[0]);
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
  // 위젯 전체 투명도 (30~100%)
  function applyOpacity() {
    // 위젯 전체(패널·카세트·글자)를 흐리게 함. 창 자체의 투명도 기능(setOpacity)은 쓰지 않음.
    document.documentElement.style.setProperty('--fade', (state.opacity / 100).toFixed(2));
    api?.repaint?.();
    els.opacity.value = state.opacity;
    paintRange(els.opacity);
  }
  els.opacity.addEventListener('input', () => {
    state.opacity = Math.max(30, Math.min(100, +els.opacity.value));
    applyOpacity();
    save();
  });

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
    // 안전장치: 교체 중이 아닌데 카세트가 안 보이면 원래대로 되돌림
    if (!swapping && !busy) {
      const cs = getComputedStyle(activeBody());
      if (cs.visibility !== 'visible' || Math.abs(parseFloat(cs.top) || 0) > 1) resetTape();
    }
    if (!playerReady || !current()) return;
    const d = player.getDuration() || 0;
    const t = player.getCurrentTime() || 0;
    if (!swapping && player.getVideoData && player.getVideoData().video_id === current().id) {
      setSpools(d ? t / d : 0); // 감긴 테이프 양이 진행에 따라 바뀜
    }
    if (!expanded || seeking) return;
    els.cur.textContent = fmt(t);
    els.dur.textContent = fmt(d);
    els.seek.value = d ? Math.round((t / d) * 1000) : 0;
    paintRange(els.seek);
  }, 400);


  // ---------------- 음량 막대 (사운드클라우드 느낌) ----------------
  // YouTube 플레이어 소리는 직접 읽을 수 없어서 PC 출력 소리(루프백)를 분석한다.
  // 실패하면 재생 중일 때만 자연스럽게 움직이는 가짜 막대로 대신한다.
  const BARS = 26;
  const levels = new Float32Array(BARS);
  let analyser = null;
  let freq = null;
  let vizTried = false;

  async function startViz() {
    if (analyser || vizTried) return;
    vizTried = true;
    try {
      // 맥에서는 화면 녹화 권한 창이 뜨므로 시도하지 않고 장식용 막대를 씀
      if (/Mac/i.test(navigator.platform || '')) throw new Error('mac');
      // 폰(웹·APK)에서는 화면 공유 창이 뜨면 터치가 막히므로 시도하지 않음
      if (window.TUNEDECK_NO_CAPTURE) throw new Error('no capture');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw new Error('unsupported');
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      stream.getVideoTracks().forEach((t) => t.stop()); // 화면은 쓰지 않음
      if (!stream.getAudioTracks().length) throw new Error('no audio');
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.72;
      src.connect(analyser); // 스피커로는 다시 내보내지 않음 (소리 두 번 나는 것 방지)
      freq = new Uint8Array(analyser.frequencyBinCount);
      if (ctx.state === 'suspended') document.addEventListener('pointerdown', () => ctx.resume(), { once: true });
    } catch {
      analyser = null; // 가짜 막대 사용
    }
  }

  // 막대마다 담당할 주파수 구간 (낮은 음은 촘촘하게, 높은 음은 넓게)
  const bandEdges = [];
  for (let i = 0; i <= BARS; i++) bandEdges.push(Math.round(2 * Math.pow(220, i / BARS)));

  let fakePhase = 0;
  function sampleLevels() {
    if (analyser && freq) {
      analyser.getByteFrequencyData(freq);
      for (let i = 0; i < BARS; i++) {
        const a = bandEdges[i], b = Math.max(bandEdges[i + 1], a + 1);
        let sum = 0;
        for (let k = a; k < b && k < freq.length; k++) sum += freq[k];
        const v = Math.pow(sum / (b - a) / 255, 1.4) * (1 + i / BARS * 0.8);
        levels[i] += (Math.min(1, v) - levels[i]) * (v > levels[i] ? 0.6 : 0.18);
      }
      return;
    }
    fakePhase += 0.06;
    for (let i = 0; i < BARS; i++) {
      const target = isPlaying
        ? 0.25 + 0.5 * Math.abs(Math.sin(fakePhase * (1 + i * 0.13) + i)) * (1 - i / BARS * 0.5) + Math.random() * 0.15
        : 0;
      levels[i] += (target - levels[i]) * 0.15;
    }
  }

  // 막대는 일반 요소로 그림 (캔버스는 Windows 투명 창에서 다른 요소까지 안 보이게 만드는 문제가 있음)
  const barEls = [];
  for (let i = 0; i < BARS; i++) {
    const b = document.createElement('i');
    els.viz.appendChild(b);
    barEls.push(b);
  }
  const shown = new Float32Array(BARS);
  let lastDraw = 0;
  function drawViz(ts) {
    if (ts - lastDraw >= 33) { // 약 30fps면 충분
      lastDraw = ts;
      sampleLevels();
      for (let i = 0; i < BARS; i++) {
        const v = Math.max(0.06, Math.min(1, levels[i]));
        if (Math.abs(v - shown[i]) > 0.01) {
          shown[i] = v;
          barEls[i].style.height = (v * 100).toFixed(1) + '%';
        }
      }
    }
    requestAnimationFrame(drawViz);
  }
  requestAnimationFrame(drawViz);

  // ---------------- 테마 선택 ----------------
  const skinBtn = $('skinBtn');
  const skinMenu = $('skinMenu');
  function applySkin(name) {
    if (!BODY[name]) name = 'cassette';
    skin = name;
    Object.keys(BODY).forEach((k) => appEl.classList.remove('skin-' + k));
    appEl.classList.add('skin-' + name);
    skinMenu.querySelectorAll('.skin-opt').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.skin === name)));
    resetTape();
  }
  function toggleSkinMenu(show) {
    skinMenu.hidden = !show;
    skinBtn.setAttribute('aria-expanded', String(show));
  }
  skinBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleSkinMenu(skinMenu.hidden); });

  // '영상도 보기' 스위치: 켜면 카세트 아래에 YouTube 영상이 보임
  const videoToggle = $('videoToggle');
  function applyVideo() {
    appEl.classList.toggle('show-video', state.showVideo);
    videoToggle.checked = state.showVideo;
    $('playerHost').setAttribute('aria-hidden', String(!state.showVideo));
    api?.repaint?.();
  }
  videoToggle.addEventListener('change', () => {
    state.showVideo = videoToggle.checked;
    applyVideo();
    save();
  });

  // 이스터에그: "테마" 글자를 5번 연속(2.5초 안에) 누르면 숨은 테마 3개가 나타남
  function applySecrets() { skinMenu.classList.toggle('secrets-on', state.secrets); }
  let titleClicks = [];
  $('skinTitle').addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.secrets) return;
    const now = Date.now();
    titleClicks = titleClicks.filter((t) => now - t < 2500);
    titleClicks.push(now);
    if (titleClicks.length >= 5) {
      titleClicks = [];
      state.secrets = true;
      applySecrets();
      save();
      say('숨겨진 테마 3개를 찾았어요! 세탁기 · 타이어 · 마법진');
    }
  });
  skinMenu.addEventListener('click', async (e) => {
    const opt = e.target.closest('.skin-opt');
    if (!opt || opt.dataset.skin === skin || swapping || busy) return;
    e.stopPropagation();
    const name = opt.dataset.skin;
    // 접혀 있을 때 창 크기가 바뀌므로, 먼저 메인에 알리고 테마를 바꿈
    if (api?.setSkin) await api.setSkin(name);
    appEl.classList.add('no-anim');
    applySkin(name);
    await frame();
    appEl.classList.remove('no-anim');
    api?.repaint?.();
  });
  document.addEventListener('click', (e) => {
    if (!skinMenu.hidden && !e.target.closest('#skinMenu, #skinBtn')) toggleSkinMenu(false);
  });

  // ---------------- 접기 / 펼치기 ----------------
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const setStart = (p) => {
    appEl.style.setProperty('--start-left', p.left + 'px');
    appEl.style.setProperty('--start-top', p.top + 'px');
  };

  async function expand() {
    if (expanded || busy) return;
    busy = true;
    const start = api ? await api.prepareExpand() : { left: 12, top: 12 };
    appEl.classList.add('no-anim');
    setStart(start);
    await api?.expand();
    await frame();
    appEl.classList.remove('no-anim');
    await frame();
    appEl.classList.remove('collapsed');
    appEl.classList.add('expanded');
    els.panel.setAttribute('aria-hidden', 'false');
    expanded = true;
    els.tape.setAttribute('aria-label', '데크에 꽂힌 카세트');
    renderQueue();
    await wait(560);
    api?.repaint?.();
    busy = false;
  }

  async function collapse() {
    if (!expanded || busy) return;
    busy = true;
    toggleSkinMenu(false);
    const back = api ? await api.prepareCollapse() : { left: 12, top: 12 };
    setStart(back);
    expanded = false;
    appEl.classList.remove('expanded');
    appEl.classList.add('collapsed');
    els.panel.setAttribute('aria-hidden', 'true');
    document.activeElement?.blur();
    await wait(560);
    appEl.classList.add('no-anim');
    setStart({ left: 12, top: 12 });
    await api?.collapse();
    await frame();
    appEl.classList.remove('no-anim');
    renderNow();
    resetTape();
    busy = false;
  }

  const toggle = () => (expanded ? collapse() : expand());
  els.collapse.addEventListener('click', collapse);
  $('quitBtn').addEventListener('click', () => api?.quit());

  api?.onUpdateReady((v) => {
    $('updateText').textContent = `새 버전 ${v}이 준비됐어요`;
    $('updateBar').hidden = false;
  });
  $('updateBtn').addEventListener('click', () => api?.applyUpdate());

  // 끌어서 옮기기: 접힌 카세트는 어디든, 펼친 상태에선 위쪽 빈 곳이나 카세트를 잡고
  let press = null;
  function startPress(e, el, clickAction) {
    if (e.button !== 0 || busy) return;
    press = { x: e.screenX, y: e.screenY, dragging: false, clickAction };
    el.setPointerCapture(e.pointerId);
  }
  function movePress(e) {
    if (!press) return;
    if (!press.dragging && Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
      press.dragging = true;
      document.body.style.cursor = 'grabbing';
      api?.dragStart(press.x, press.y);
    }
    if (press.dragging) api?.dragMove(e.screenX, e.screenY);
  }
  function endPress() {
    if (!press) return;
    const { dragging, clickAction } = press;
    press = null;
    document.body.style.cursor = '';
    if (dragging) api?.dragEnd();
    else if (clickAction) clickAction();
  }

  els.tape.addEventListener('pointerdown', (e) => startPress(e, els.tape, expanded ? null : expand));
  els.tape.addEventListener('pointermove', movePress);
  els.tape.addEventListener('pointerup', endPress);
  els.tape.addEventListener('pointercancel', endPress);
  els.tape.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !expanded) { e.preventDefault(); expand(); }
  });
  els.tape.addEventListener('click', (e) => e.preventDefault());

  const topbar = document.querySelector('.topbar');
  topbar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, input, label')) return;
    startPress(e, topbar, null);
  });
  topbar.addEventListener('pointermove', movePress);
  topbar.addEventListener('pointerup', endPress);
  topbar.addEventListener('pointercancel', endPress);

  // 키보드
  document.addEventListener('keydown', (e) => {
    const typing = e.target.tagName === 'INPUT' && e.target.type !== 'range';
    if (e.key === 'Escape') { if (typing) e.target.blur(); else collapse(); return; }
    if (typing || !expanded) return;
    if (e.key === ' ' && !e.target.closest('button, .item')) { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight' && e.altKey) next(false);
    else if (e.key === 'ArrowLeft' && e.altKey) prev();
    else if (e.key === '/' || (e.ctrlKey && e.key.toLowerCase() === 'f')) { e.preventDefault(); els.searchInput.focus(); }
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
    applyEdition(api?.getEdition ? await api.getEdition().catch(() => null) : null);
    applySkin(api?.getSkin ? await api.getSkin().catch(() => 'cassette') : 'cassette');
    const saved = api ? await api.loadState() : null;
    if (saved && Array.isArray(saved.items)) {
      state.items = saved.items.filter((it) => it && /^[\w-]{11}$/.test(it.id));
      state.index = Math.min(saved.index ?? -1, state.items.length - 1);
      state.shuffle = !!saved.shuffle;
      state.repeat = ['all', 'one', 'off'].includes(saved.repeat) ? saved.repeat : 'all';
      state.volume = Number.isFinite(saved.volume) ? saved.volume : 80;
      state.opacity = Number.isFinite(saved.opacity) ? Math.max(30, Math.min(100, saved.opacity)) : 100;
      state.secrets = !!saved.secrets;
      state.showVideo = !!saved.showVideo;
    }
    if (SECRET.includes(skin)) state.secrets = true; // 숨은 테마를 쓰고 있으면 메뉴에도 보이게
    applySecrets();
    applyVideo();
    els.volume.value = state.volume;
    paintRange(els.volume);
    applyOpacity();
    paintRange(els.seek);
    startViz();
    renderModes();
    renderNow();
    renderQueue();
    renderResults();
    if (playerReady && current()) player.cueVideoById(current().id);
  })();

  // 미리보기/테스트용
  window.__tunedeck = {
    state, expand, collapse, renderNow, renderQueue, setPlaying, parseLink, playAt, setSpools,
    setResults: (r) => { results = r; renderResults(); }, showTab, levels, applySkin, unlock: () => { state.secrets = true; applySecrets(); },
  };
})();
