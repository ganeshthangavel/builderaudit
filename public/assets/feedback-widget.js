/* BuilderAudit feedback widget — self-contained, injected on every page.
   Floating button → panel to flag an audit error or share feedback.
   Honest, improvement-focused messaging. Posts to /api/feedback. */
(function () {
  if (window.__baFeedbackLoaded) return;        // guard against double-inject
  window.__baFeedbackLoaded = true;

  var P = { fill:'#FFD24D', accent:'#5247B8', surface:'#FBF5E1', ink:'#1B1A17',
            muted:'#5C5851', green:'#1F8A5B', red:'#D9534F', white:'#fff' };
  var DISPLAY = '"Hanken Grotesk", -apple-system, system-ui, sans-serif';
  var BODY = '"IBM Plex Sans", -apple-system, system-ui, sans-serif';

  /* ---- styles ---- */
  var css = document.createElement('style');
  css.textContent = [
    '.ba-fb-btn{position:fixed;right:20px;bottom:20px;z-index:99998;display:inline-flex;align-items:center;gap:8px;',
      'background:'+P.fill+';color:'+P.ink+';border:2.5px solid '+P.ink+';border-radius:999px;',
      'padding:11px 18px;font-family:'+BODY+';font-weight:700;font-size:14px;cursor:pointer;',
      'box-shadow:3px 3px 0 '+P.ink+';transition:transform .12s, box-shadow .12s}',
    '.ba-fb-btn:hover{transform:translate(-1px,-1px);box-shadow:4px 4px 0 '+P.ink+'}',
    '.ba-fb-btn:active{transform:translate(1px,1px);box-shadow:1px 1px 0 '+P.ink+'}',
    '.ba-fb-overlay{position:fixed;inset:0;z-index:99999;background:rgba(27,26,23,0.45);',
      'display:none;align-items:flex-end;justify-content:flex-end;padding:20px}',
    '.ba-fb-overlay.open{display:flex}',
    '.ba-fb-panel{background:'+P.white+';border:2.5px solid '+P.ink+';border-radius:16px;',
      'box-shadow:8px 8px 0 '+P.ink+';width:100%;max-width:380px;overflow:hidden;',
      'font-family:'+BODY+';color:'+P.ink+';max-height:calc(100vh - 40px);display:flex;flex-direction:column}',
    '.ba-fb-head{background:'+P.fill+';border-bottom:2.5px solid '+P.ink+';padding:16px 18px;position:relative}',
    '.ba-fb-head h3{font-family:'+DISPLAY+';font-weight:900;font-size:18px;margin:0;text-transform:uppercase;letter-spacing:-0.01em}',
    '.ba-fb-head p{font-family:'+BODY+';font-size:12.5px;color:'+P.muted+';margin:6px 0 0;line-height:1.45}',
    '.ba-fb-x{position:absolute;top:12px;right:14px;background:none;border:none;font-size:20px;cursor:pointer;color:'+P.ink+';line-height:1;padding:2px 6px}',
    '.ba-fb-body{padding:16px 18px;overflow-y:auto}',
    '.ba-fb-types{display:flex;gap:6px;margin-bottom:12px}',
    '.ba-fb-type{flex:1;font-family:'+BODY+';font-size:12px;font-weight:700;text-align:center;cursor:pointer;',
      'border:2px solid '+P.ink+';border-radius:8px;padding:8px 6px;background:'+P.white+';color:'+P.ink+';transition:background .12s}',
    '.ba-fb-type.on{background:'+P.ink+';color:'+P.white+'}',
    '.ba-fb-l{display:block;font-family:'+BODY+';font-size:11px;font-weight:700;color:'+P.muted+';letter-spacing:0.04em;text-transform:uppercase;margin:0 0 6px}',
    '.ba-fb-ta{width:100%;box-sizing:border-box;font-family:'+BODY+';font-size:14px;color:'+P.ink+';',
      'border:2px solid '+P.ink+';border-radius:8px;padding:10px 12px;min-height:90px;resize:vertical;outline:none;background:'+P.white+'}',
    '.ba-fb-in{width:100%;box-sizing:border-box;font-family:'+BODY+';font-size:14px;color:'+P.ink+';',
      'border:2px solid '+P.ink+';border-radius:8px;padding:10px 12px;margin-top:12px;outline:none;background:'+P.white+'}',
    '.ba-fb-ta:focus,.ba-fb-in:focus{border-color:'+P.accent+'}',
    '.ba-fb-submit{width:100%;margin-top:14px;font-family:'+BODY+';font-weight:700;font-size:15px;color:'+P.white+';',
      'background:'+P.accent+';border:2px solid '+P.ink+';border-radius:9px;padding:12px 16px;cursor:pointer;box-shadow:3px 3px 0 '+P.ink+'}',
    '.ba-fb-submit:disabled{opacity:0.6;cursor:default}',
    '.ba-fb-err{font-family:'+BODY+';font-size:13px;color:'+P.red+';margin-top:10px;display:none}',
    '.ba-fb-foot{font-family:'+BODY+';font-size:11px;color:'+P.muted+';margin-top:12px;line-height:1.45}',
    '.ba-fb-done{padding:30px 22px;text-align:center}',
    '.ba-fb-done .big{font-size:34px;line-height:1;margin-bottom:10px}',
    '.ba-fb-done h3{font-family:'+DISPLAY+';font-weight:900;font-size:20px;margin:0 0 6px;text-transform:uppercase}',
    '.ba-fb-done p{font-family:'+BODY+';font-size:13.5px;color:'+P.muted+';margin:0;line-height:1.5}',
    '@media (max-width:480px){.ba-fb-btn span.lbl{display:none}.ba-fb-btn{padding:13px}}'
  ].join('');
  document.head.appendChild(css);

  /* ---- button ---- */
  var btn = document.createElement('button');
  btn.className = 'ba-fb-btn';
  btn.setAttribute('aria-label', 'Give feedback or flag an issue');
  btn.innerHTML = '<span aria-hidden="true">💬</span><span class="lbl">Feedback</span>';

  /* ---- overlay + panel ---- */
  var overlay = document.createElement('div');
  overlay.className = 'ba-fb-overlay';
  overlay.innerHTML =
    '<div class="ba-fb-panel" role="dialog" aria-label="Feedback">' +
      '<div class="ba-fb-head">' +
        '<button class="ba-fb-x" aria-label="Close">×</button>' +
        '<h3>Help us improve</h3>' +
        '<p>BuilderAudit is a work in progress and we\u2019re refining it constantly. The audits are AI-generated, so they won\u2019t always get everything right \u2014 if something looks wrong, or you\u2019ve an idea, tell us. A real person reads every message.</p>' +
      '</div>' +
      '<div class="ba-fb-body" id="ba-fb-body">' +
        '<div class="ba-fb-types">' +
          '<div class="ba-fb-type on" data-kind="error">Something\u2019s wrong</div>' +
          '<div class="ba-fb-type" data-kind="idea">Idea</div>' +
          '<div class="ba-fb-type" data-kind="other">Other</div>' +
        '</div>' +
        '<label class="ba-fb-l" for="ba-fb-name">Your name</label>' +
        '<input id="ba-fb-name" class="ba-fb-in" style="margin-top:0" type="text" autocomplete="name" placeholder="Jane Smith">' +
        '<label class="ba-fb-l" for="ba-fb-msg" style="margin-top:12px">Your message</label>' +
        '<textarea id="ba-fb-msg" class="ba-fb-ta" placeholder="e.g. The audit says my video is broken but it works fine\u2026"></textarea>' +
        '<input id="ba-fb-email" class="ba-fb-in" type="email" placeholder="Email (optional \u2014 if you\u2019d like a reply)">' +
        '<button class="ba-fb-submit" id="ba-fb-send" type="button">Send feedback</button>' +
        '<div class="ba-fb-err" id="ba-fb-err"></div>' +
        '<div class="ba-fb-foot">We use your feedback only to improve BuilderAudit. We won\u2019t add you to any list.</div>' +
      '</div>' +
    '</div>';

  function mount() {
    document.body.appendChild(btn);
    document.body.appendChild(overlay);

    var panel = overlay.querySelector('.ba-fb-panel');
    var body = overlay.querySelector('#ba-fb-body');
    var errBox = overlay.querySelector('#ba-fb-err');
    var sendBtn = overlay.querySelector('#ba-fb-send');
    var kind = 'error';

    function open(){ overlay.classList.add('open'); setTimeout(function(){ var m=overlay.querySelector('#ba-fb-msg'); if(m) m.focus(); }, 50); }
    function close(){ overlay.classList.remove('open'); }

    btn.addEventListener('click', open);
    overlay.querySelector('.ba-fb-x').addEventListener('click', close);
    overlay.addEventListener('click', function(e){ if (e.target === overlay) close(); });
    document.addEventListener('keydown', function(e){ if (e.key === 'Escape') close(); });

    overlay.querySelectorAll('.ba-fb-type').forEach(function(t){
      t.addEventListener('click', function(){
        overlay.querySelectorAll('.ba-fb-type').forEach(function(x){ x.classList.remove('on'); });
        t.classList.add('on'); kind = t.getAttribute('data-kind');
      });
    });

    function showErr(m){ errBox.textContent = m; errBox.style.display = 'block'; }

    sendBtn.addEventListener('click', function(){
      var name = (overlay.querySelector('#ba-fb-name').value || '').trim();
      var msg = (overlay.querySelector('#ba-fb-msg').value || '').trim();
      var email = (overlay.querySelector('#ba-fb-email').value || '').trim();
      if (msg.length < 3) return showErr('Please add a little more detail.');
      errBox.style.display = 'none';
      sendBtn.disabled = true; sendBtn.textContent = 'Sending\u2026';
      fetch('/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ kind: kind, name: name, message: msg, email: email, pageUrl: location.href }),
      })
        .then(function(r){ return r.ok ? r.json() : r.json().then(function(e){ throw new Error(e.error || 'Something went wrong'); }); })
        .then(function(){
          body.innerHTML = '<div class="ba-fb-done"><div class="big">\uD83D\uDE4F</div><h3>Thank you</h3>' +
            '<p>We\u2019ve got it. Every message genuinely helps us make BuilderAudit more accurate and useful.</p></div>';
          setTimeout(close, 2600);
        })
        .catch(function(e){ sendBtn.disabled = false; sendBtn.textContent = 'Send feedback'; showErr(e.message); });
    });
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
