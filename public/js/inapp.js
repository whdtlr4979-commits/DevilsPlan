/* ================================================================
   카카오톡 인앱 브라우저에서 열리면 외부 브라우저로 넘긴다.
   - kakaotalk://web/openExternal 은 카카오톡이 지원하는 공식 스킴으로,
     안드로이드는 기본 브라우저(보통 크롬), iOS 는 사파리로 페이지를 연다.
   - 방 코드(?room=XXXX) 등 현재 주소를 그대로 넘긴다.
   - 넘어가지 않았을 때를 위해 다시 열기 / 여기서 계속하기 화면을 띄운다.
   - ?inapp=1 을 붙이면 넘기지 않는다 (테스트·예외용).
   ================================================================ */
(function () {
  var ua = navigator.userAgent || '';
  if (!/KAKAOTALK/i.test(ua)) return;

  var STAY_KEY = 'plan-stay-inapp';
  var params = new URLSearchParams(location.search);
  if (params.get('inapp') === '1') return;
  try { if (sessionStorage.getItem(STAY_KEY) === '1') return; } catch (e) { /* 저장소 막힘 */ }

  var target = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href);
  var isIOS = /iPhone|iPad|iPod/i.test(ua);
  var browserName = isIOS ? '사파리' : '크롬';

  // 이 창(카카오톡 안)에는 안내 화면을 띄우고, 외부 브라우저로 넘긴다.
  // (문서를 다 읽은 뒤에 넘겨야 페이지 로딩이 중간에 멈추지 않는다)
  function showGuide() {
    if (document.getElementById('inappGuide')) return;
    var style = document.createElement('style');
    style.textContent =
      '#inappGuide{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:24px;' +
      'background:rgba(7,7,10,.97);color:#f4f3f8;text-align:center;' +
      "font-family:'Pretendard Variable','Pretendard',system-ui,-apple-system,'Apple SD Gothic Neo',sans-serif}" +
      '#inappGuide .ig-box{width:100%;max-width:340px;display:flex;flex-direction:column;gap:12px}' +
      '#inappGuide .ig-icon{font-size:44px;line-height:1}' +
      '#inappGuide h2{margin:4px 0 0;font-size:20px;font-weight:800}' +
      '#inappGuide p{margin:0 0 8px;color:#b4b2c4;font-size:14px;line-height:1.6}' +
      '#inappGuide .ig-btn{display:flex;align-items:center;justify-content:center;min-height:52px;border-radius:14px;' +
      'font-size:16px;font-weight:800;text-decoration:none;border:0;cursor:pointer;font-family:inherit}' +
      '#inappGuide .ig-open{color:#fff;background:linear-gradient(180deg,#ff4560,#e01535);box-shadow:0 8px 24px -6px rgba(255,46,77,.45)}' +
      '#inappGuide .ig-stay{color:#b4b2c4;background:transparent;border:1px solid rgba(255,255,255,.16)}' +
      '#inappGuide .ig-close{color:#75738a;font-size:13px;text-decoration:underline;margin-top:4px}';
    document.head.appendChild(style);

    var el = document.createElement('div');
    el.id = 'inappGuide';
    el.setAttribute('role', 'dialog');
    el.innerHTML =
      '<div class="ig-box">' +
      '<div class="ig-icon">🌐</div>' +
      '<h2>' + browserName + '에서 열었어요</h2>' +
      '<p>카카오톡 브라우저에서는 연결이 끊기기 쉬워서<br>' + browserName + ' 등 외부 브라우저로 열어요.<br>열리지 않았다면 아래 버튼을 눌러주세요.</p>' +
      '<a class="ig-btn ig-open" id="inappOpen" href="' + target.replace(/"/g, '&quot;') + '">' + browserName + '로 열기</a>' +
      '<button class="ig-btn ig-stay" id="inappStay" type="button">카카오톡에서 계속하기</button>' +
      '<a class="ig-close" href="kakaotalk://inappbrowser/close">이 창 닫기</a>' +
      '</div>';
    document.body.appendChild(el);
    document.getElementById('inappStay').onclick = function () {
      try { sessionStorage.setItem(STAY_KEY, '1'); } catch (e) { /* 무시 */ }
      el.remove();
    };
  }

  function run() {
    showGuide();
    try { location.href = target; } catch (e) { /* 버튼으로 대신 */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
