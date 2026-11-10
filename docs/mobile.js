// 폰 화면 맞춤 + 재생 중 화면 꺼짐 방지 + 홈 화면 설치
(() => {
  'use strict';
  const appEl = document.getElementById('app');

  // 데스크톱 펼친 화면(가로 280)을 폰 가로 폭에 꽉 차게 키움
  const BASE_W = 280;
  function fit() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const s = Math.min(vw / BASE_W, 1.8); // 태블릿에서는 너무 커지지 않게
    appEl.style.width = BASE_W + 'px';
    appEl.style.height = vh / s + 'px';
    appEl.style.left = Math.max(0, (vw - BASE_W * s) / 2) + 'px';
    appEl.style.transform = `scale(${s})`;
  }
  fit();
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', () => setTimeout(fit, 200));

  // 폰에서는 늘 펼친 상태로 시작
  window.addEventListener('load', () => {
    setTimeout(() => window.__tunedeck && window.__tunedeck.expand(), 60);
  });
  // 접기 단축키(Esc) 막기 — 폰에는 접힌 위젯이 없음
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.tagName !== 'INPUT') e.stopImmediatePropagation();
  }, true);

  // 재생 중에는 화면이 저절로 꺼지지 않게 (화면이 꺼지면 YouTube가 재생을 멈추기 때문)
  let lock = null;
  async function keepAwake() {
    const playing = appEl.classList.contains('playing');
    if (playing && !lock && document.visibilityState === 'visible' && navigator.wakeLock) {
      try {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      } catch {}
    } else if (!playing && lock) {
      try { await lock.release(); } catch {}
      lock = null;
    }
  }
  new MutationObserver(keepAwake).observe(appEl, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', keepAwake);

  // 홈 화면 설치(앱처럼 실행)용
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
