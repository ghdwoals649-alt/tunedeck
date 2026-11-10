// 폰(웹)용 연결 코드 — 데스크톱 앱의 preload.js(window.api)와 같은 이름의 기능을 브라우저로 구현
// 재생목록·설정·API 키는 이 폰의 브라우저 안에만 저장됨 (localStorage)
(() => {
  'use strict';

  const LS = {
    get(k, d) {
      try {
        const v = localStorage.getItem('tunedeck.' + k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try { localStorage.setItem('tunedeck.' + k, JSON.stringify(v)); } catch {}
    },
  };

  // 테마별로 펼친 화면에서 본체가 놓이는 위치 (style.css 와 같은 값)
  const SLOTS = {
    cassette: { left: 35, top: 55 },
    lp: { left: 62, top: 46 },
    cd: { left: 66, top: 50 },
    washer: { left: 62, top: 46 },
    tire: { left: 62, top: 46 },
    magic: { left: 60, top: 44 },
  };
  const slot = () => SLOTS[LS.get('skin', 'cassette')] || SLOTS.cassette;

  // 검색 결과 제목의 &#39; 같은 표기를 글자로 (textarea는 태그를 만들지 않아 안전)
  const decode = (s) => {
    const t = document.createElement('textarea');
    t.innerHTML = String(s || '');
    return t.value;
  };

  function isoDuration(iso) {
    const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
    if (!m) return '';
    const h = +(m[1] || 0), mi = +(m[2] || 0), s = +(m[3] || 0);
    if (!h && !mi && !s) return '';
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${String(mi).padStart(2, '0')}:${ss}` : `${mi}:${ss}`;
  }

  async function ytSearch(q, key, max = 20) {
    const params = new URLSearchParams({
      part: 'snippet', type: 'video', videoEmbeddable: 'true', videoSyndicated: 'true',
      maxResults: String(max), q, key, regionCode: 'KR', relevanceLanguage: 'ko',
    });
    const res = await fetch('https://www.googleapis.com/youtube/v3/search?' + params);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = json?.error?.errors?.[0]?.reason || '';
      const msg = json?.error?.message || '';
      if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') return { error: 'quota' };
      if (reason === 'accessNotConfigured' || /has not been used|is disabled/i.test(msg)) return { error: 'notenabled' };
      if (reason === 'keyInvalid' || /API key not valid|API_KEY_INVALID/i.test(msg)) return { error: 'badkey' };
      return { error: 'fail', message: msg };
    }
    const items = (json.items || [])
      .filter((i) => i.id && i.id.videoId)
      .map((i) => ({ id: i.id.videoId, title: decode(i.snippet.title), author: decode(i.snippet.channelTitle) }));
    if (items.length) {
      try {
        const r2 = await fetch('https://www.googleapis.com/youtube/v3/videos?' + new URLSearchParams({
          part: 'contentDetails', id: items.map((i) => i.id).join(','), key,
        }));
        if (r2.ok) {
          const j2 = await r2.json();
          const dur = new Map((j2.items || []).map((v) => [v.id, isoDuration(v.contentDetails?.duration)]));
          items.forEach((i) => { i.duration = dur.get(i.id) || ''; });
        }
      } catch {}
    }
    return { items };
  }

  async function oembed(id) {
    if (!/^[\w-]{11}$/.test(id)) return null;
    try {
      const r = await fetch('https://www.youtube.com/oembed?format=json&url=' +
        encodeURIComponent('https://www.youtube.com/watch?v=' + id));
      if (r.ok) {
        const j = await r.json();
        return { title: j.title, author: j.author_name };
      }
    } catch {}
    // 위가 막히면 API 키가 있을 때 공식 API로
    const key = LS.get('apiKey', null);
    if (key) {
      try {
        const r = await fetch('https://www.googleapis.com/youtube/v3/videos?' +
          new URLSearchParams({ part: 'snippet', id, key }));
        if (r.ok) {
          const it = (await r.json()).items?.[0];
          if (it) return { title: it.snippet.title, author: it.snippet.channelTitle };
        }
      } catch {}
    }
    return null; // 재생하면 플레이어가 아는 제목으로 채워짐
  }

  // 음량 막대용 '소리 캡처'(화면 공유 창)를 쓰지 않음 → 재생 중 움직이는 장식 막대
  window.TUNEDECK_NO_CAPTURE = true;

  const noop = () => {};
  window.api = {
    loadState: async () => LS.get('library', null),
    saveState: (d) => LS.set('library', d),
    oembed,

    // 폰에서는 항상 펼친 화면
    prepareExpand: async () => slot(),
    expand: async () => {},
    prepareCollapse: async () => slot(),
    collapse: async () => {},
    dragStart: noop, dragMove: noop, dragEnd: noop,

    openExternal: (u) => { if (/^https:\/\//.test(u)) window.open(u, '_blank', 'noopener'); },
    nowPlaying: noop, onMedia: noop, onToggle: noop, quit: noop, setOpacity: noop, repaint: noop,
    applyUpdate: noop, onUpdateReady: noop, onAppInfo: noop,

    getEdition: async () => ({ search: true, updates: false }),
    getSkin: async () => LS.get('skin', 'cassette'),
    setSkin: async (n) => { LS.set('skin', n); return n; },

    hasKey: async () => !!LS.get('apiKey', null),
    setKey: async (key) => {
      key = String(key || '').trim();
      if (!/^[\w-]{30,60}$/.test(key)) return { ok: false, error: 'format' };
      try {
        const r = await ytSearch('music', key, 1);
        if (r.error) return { ok: false, error: r.error };
      } catch {
        return { ok: false, error: 'network' };
      }
      LS.set('apiKey', key);
      return { ok: true };
    },
    search: async (q) => {
      const key = LS.get('apiKey', null);
      if (!key) return { error: 'nokey' };
      q = String(q || '').trim().slice(0, 200);
      if (!q) return { items: [] };
      try { return await ytSearch(q, key); } catch { return { error: 'network' }; }
    },
  };
})();
