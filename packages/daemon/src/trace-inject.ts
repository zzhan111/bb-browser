/**
 * trace-inject.js — DOM event listener injection script for trace recording.
 *
 * Injected via CDP Runtime.evaluate into the page context on trace start.
 * Sends events back to the daemon via CDP Runtime.addBinding.
 *
 * Ported from packages/extension/src/content/trace.ts (commit f02b081).
 * Key change: chrome.runtime.sendMessage → window.__bbBrowserTraceBinding()
 */

export const TRACE_PREFIX = "__BB_BROWSER_TRACE_8fd3__:";

export const TRACE_INJECTION_SCRIPT = `
(function() {
  if (window.__bbBrowserTraceInjected) return;
  window.__bbBrowserTraceInjected = true;

  // ---- Helpers ----

  function getXPath(element) {
    if (element.id) return '//*[@id="' + element.id + '"]';
    if (element === document.body) return '/html/body';
    var idx = 1;
    var siblings = element.parentNode && element.parentNode.children;
    if (siblings) {
      for (var i = 0; i < siblings.length; i++) {
        var sib = siblings[i];
        if (sib === element) {
          var parentPath = element.parentElement ? getXPath(element.parentElement) : '';
          return parentPath + '/' + element.tagName.toLowerCase() + '[' + idx + ']';
        }
        if (sib.nodeType === 1 && sib.tagName === element.tagName) idx++;
      }
    }
    return element.tagName.toLowerCase();
  }

  function getHighlightIndex(element) {
    var cur = element;
    while (cur) {
      var attr = cur.getAttribute('data-highlight-index');
      if (attr !== null) { var n = parseInt(attr, 10); if (!isNaN(n)) return n; }
      cur = cur.parentElement;
    }
  }

  function getCssSelector(element) {
    var parts = [];
    var cur = element;
    while (cur && cur !== document.body) {
      var sel = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift('#' + cur.id); break; }
      if (cur.className) {
        var cls = cur.className.split(/\\s+/).filter(function(c) { return c && /^[a-zA-Z_]/.test(c); });
        if (cls.length > 0) sel += '.' + cls.slice(0, 2).join('.');
      }
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function extractInfo(element) {
    var tag = element.tagName.toLowerCase();
    var role = element.getAttribute('role') || '';
    if (!role) {
      if (tag === 'button') role = 'button';
      else if (tag === 'a') role = 'link';
      else if (tag === 'input') {
        var t = (element.type || 'text').toLowerCase();
        if (t === 'checkbox') role = 'checkbox';
        else if (t === 'radio') role = 'radio';
        else if (t === 'submit' || t === 'button') role = 'button';
        else role = 'textbox';
      } else if (tag === 'textarea') role = 'textbox';
      else if (tag === 'select') role = 'combobox';
      else if (tag === 'img') role = 'img';
      else if (tag === 'label') role = 'label';
      else role = tag;
    }
    var name = element.getAttribute('aria-label') || '';
    if (!name) {
      var lb = element.getAttribute('aria-labelledby');
      if (lb) { var le = document.getElementById(lb); if (le) name = (le.textContent || '').trim(); }
    }
    if (!name && element.id) {
      var l = document.querySelector('label[for="' + element.id + '"]');
      if (l) name = (l.textContent || '').trim();
    }
    if (!name) name = element.getAttribute('title') || element.getAttribute('alt') || (element.placeholder) || (element.textContent || '').trim().slice(0, 50) || '';
    return { role: role || tag, name: name || '', tag: tag };
  }

  function emit(eventObj) {
    console.log('__BB_BROWSER_TRACE_8fd3__:' + JSON.stringify(eventObj));
  }

  // ---- Click handler ----
  document.addEventListener('click', function(e) {
    if (!window.__bbBrowserTraceRecording) return;
    var target = e.target;
    if (!target) return;
    var info = extractInfo(target);
    var isCheckbox = target.tagName === 'INPUT' && (target.type || '').toLowerCase() === 'checkbox';
    emit({
      type: isCheckbox ? 'check' : 'click',
      timestamp: Date.now(),
      url: location.href,
      ref: getHighlightIndex(target),
      xpath: getXPath(target),
      cssSelector: getCssSelector(target),
      elementRole: info.role,
      elementName: info.name,
      elementTag: info.tag,
      checked: isCheckbox ? target.checked : undefined
    });
  }, true);

  // ---- Input handler (debounced 500ms) ----
  var _inputTimer = null, _lastEl = null, _lastInfo = null;
  document.addEventListener('input', function(e) {
    if (!window.__bbBrowserTraceRecording) return;
    var target = e.target;
    if (!target || !('value' in target)) return;
    if (_inputTimer) clearTimeout(_inputTimer);
    _lastEl = target;
    _lastInfo = extractInfo(target);
    _inputTimer = setTimeout(function() {
      if (!_lastEl) return;
      var isPw = (_lastEl.type || '').toLowerCase() === 'password';
      emit({
        type: 'fill',
        timestamp: Date.now(),
        url: location.href,
        ref: getHighlightIndex(_lastEl),
        xpath: getXPath(_lastEl),
        cssSelector: getCssSelector(_lastEl),
        value: isPw ? '********' : (_lastEl.value || ''),
        elementRole: _lastInfo.role,
        elementName: _lastInfo.name,
        elementTag: _lastInfo.tag
      });
      _inputTimer = null; _lastEl = null; _lastInfo = null;
    }, 500);
  }, true);

  // ---- Change handler (select) ----
  document.addEventListener('change', function(e) {
    if (!window.__bbBrowserTraceRecording) return;
    var target = e.target;
    if (!target || target.tagName !== 'SELECT') return;
    var info = extractInfo(target);
    emit({
      type: 'select',
      timestamp: Date.now(),
      url: location.href,
      ref: getHighlightIndex(target),
      xpath: getXPath(target),
      cssSelector: getCssSelector(target),
      value: target.options[target.selectedIndex] ? target.options[target.selectedIndex].text : target.value,
      elementRole: info.role,
      elementName: info.name,
      elementTag: info.tag
    });
  }, true);

  // ---- Keydown handler (special keys only) ----
  var _capturedKeys = new Set(['Enter','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Backspace','Delete']);
  document.addEventListener('keydown', function(e) {
    if (!window.__bbBrowserTraceRecording) return;
    var key = e.key, keyLog = '';
    if (_capturedKeys.has(key)) keyLog = key;
    else if ((e.ctrlKey || e.metaKey) && key.length === 1 && /[a-zA-Z0-9]/.test(key)) keyLog = (e.metaKey ? 'Meta' : 'Control') + '+' + key.toLowerCase();
    if (!keyLog) return;
    var target = e.target;
    var info = target ? extractInfo(target) : { role: '', name: '', tag: 'document' };
    emit({
      type: 'press',
      timestamp: Date.now(),
      url: location.href,
      ref: target ? getHighlightIndex(target) : undefined,
      xpath: target ? getXPath(target) : undefined,
      cssSelector: target ? getCssSelector(target) : undefined,
      key: keyLog,
      elementRole: info.role,
      elementName: info.name,
      elementTag: info.tag
    });
  }, true);

  // ---- Scroll handler (debounced 300ms) ----
  var _scrollTimer = null, _scrollStartY = 0;
  window.addEventListener('scroll', function() {
    if (!window.__bbBrowserTraceRecording) return;
    if (!_scrollTimer) _scrollStartY = window.scrollY;
    else clearTimeout(_scrollTimer);
    _scrollTimer = setTimeout(function() {
      var deltaY = window.scrollY - _scrollStartY;
      if (Math.abs(deltaY) < 50) { _scrollTimer = null; return; }
      emit({
        type: 'scroll',
        timestamp: Date.now(),
        url: location.href,
        direction: deltaY > 0 ? 'down' : 'up',
        pixels: Math.abs(deltaY)
      });
      _scrollTimer = null;
    }, 300);
  }, { passive: true });
})();
`;
