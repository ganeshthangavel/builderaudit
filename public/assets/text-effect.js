/* ────────────────────────────────────────────────────────────────────────
   BuilderAudit text-effect.js
   Blur-in word-by-word reveal for every <h1>, <h2>, .sp-title, .sec-title
   — Auto-runs on DOMContentLoaded
   — Uses IntersectionObserver so items only animate when they enter view
   — Respects prefers-reduced-motion
   — Skips elements inside .te-skip (escape hatch)
   — Skips elements whose text is empty / contains only whitespace
   ──────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  /* Don't animate elements that users have opted out of via OS preference */
  var reduced =
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Selector for eligible headings — tweak here to change global behaviour */
  var SEL = 'h1, h2, .sp-title, .sec-title, .cta-band h2, .hero-h1, .sec-title';

  function wrapWords(el) {
    /* Guard: skip if already wrapped, inside .te-skip, or empty */
    if (el.dataset.teDone === '1') return;
    if (el.closest('.te-skip')) return;
    var text = el.textContent;
    if (!text || !text.trim()) return;

    /* Skip if the element contains block-level children (e.g. wrapping is unsafe).
       We only want to split "leaf" headings that contain inline text / inline elements. */
    var hasBlockChild = false;
    for (var i = 0; i < el.children.length; i++) {
      var t = getComputedStyle(el.children[i]).display;
      if (t === 'block' || t === 'flex' || t === 'grid') {
        hasBlockChild = true;
        break;
      }
    }
    if (hasBlockChild) return;

    /* Grab the raw HTML so inline formatting like <em>, <span>, <br> is preserved.
       We tokenize on whitespace but keep tags intact. */
    var html = el.innerHTML;

    /* Parse tokens: either an HTML tag (<...>) OR a chunk of non-whitespace OR whitespace.
       We wrap each non-whitespace chunk in a .te-word span; tags and whitespace pass through. */
    var out = '';
    var idx = 0;
    var wordCount = 0;
    var re = /(<[^>]+>)|(\s+)|([^\s<]+)/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      if (m[1]) {
        /* HTML tag — pass through */
        out += m[1];
      } else if (m[2]) {
        /* Whitespace — preserve as-is */
        out += m[2];
      } else if (m[3]) {
        /* Word — wrap it */
        out += '<span class="te-word" style="--te-i:' + wordCount + '">' + m[3] + '</span>';
        wordCount++;
      }
    }

    el.innerHTML = out;
    el.dataset.teDone = '1';
    el.classList.add('te-pending');

    /* Promote to ready immediately (for the visible class swap) */
    requestAnimationFrame(function () {
      el.classList.remove('te-pending');
      el.classList.add('te-ready');
    });
  }

  function reveal(el) {
    el.classList.add('te-in');
  }

  function init() {
    var els = document.querySelectorAll(SEL);
    if (!els.length) return;

    /* If reduced motion: wrap but reveal immediately */
    if (reduced) {
      els.forEach(function (el) {
        wrapWords(el);
        reveal(el);
      });
      return;
    }

    /* Wrap all now so there's no FOUC */
    els.forEach(wrapWords);

    /* Observe and reveal on enter — fire once, then unobserve */
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              reveal(entry.target);
              io.unobserve(entry.target);
            }
          });
        },
        { rootMargin: '0px 0px -10% 0px', threshold: 0.1 }
      );
      els.forEach(function (el) {
        /* If already in view at load (hero), reveal now; otherwise observe */
        var rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight && rect.bottom > 0) {
          /* In view — reveal on next frame (so the initial state paints first) */
          requestAnimationFrame(function () { requestAnimationFrame(function () { reveal(el); }); });
        } else {
          io.observe(el);
        }
      });
    } else {
      /* No IO support — just reveal everything */
      els.forEach(reveal);
    }
  }

  /* Run after DOM is ready */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* Expose a rescan function for pages that render content dynamically (e.g. report.html).
     Call window.rescanTextEffect() after injecting new HTML that contains h1/h2/.sp-title/.sec-title. */
  window.rescanTextEffect = init;
})();
