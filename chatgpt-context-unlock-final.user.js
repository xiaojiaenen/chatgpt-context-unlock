// ==UserScript==
// @name         ChatGPT 上下文已满续聊
// @namespace    https://chatgpt.com
// @author       xiaojiaenen
// @version      1.0.0
// @description  上下文满时：点原生发送按钮保存内容；把 GenUI「提交答案」按钮固定到发送按钮旁，手动点它触发生成请求，脚本替换成保存的内容。新聊天按钮固定，提示条与免责声明隐藏。
// @license      MIT
// @match        https://chatgpt.com/*
// @match        https://chatgpt.com/c/*
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  var K_MSG = "zc_msg";
  var win = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
  var contextFull = false;

  function log() {
    try { console.log.apply(console, ["[续聊]"].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }
  function g(k, d) { try { var v = GM_getValue(k, d); return v == null ? d : v; } catch (e) { return d; } }
  function s(k, v) { try { GM_setValue(k, v); } catch (e) {} }
  function setStatus(txt, color) {
    var st = document.getElementById("zc-status");
    if (st) { st.textContent = txt; if (color) st.style.color = color; }
  }

  // ---------- 拦截替换 ----------
  function isConvPost(url) {
    return url.indexOf("/backend-api/f/conversation") >= 0 || url.indexOf("/backend-api/conversation") >= 0;
  }
  function replaceLastUser(body, msg) {
    var msgs = body && body.messages;
    if (!Array.isArray(msgs) || !msgs.length || !msg) return false;
    for (var i = msgs.length - 1; i >= 0; i--) {
      var m = msgs[i];
      if (m && m.author && m.author.role === "user" && m.content && Array.isArray(m.content.parts) && m.content.parts.length) {
        m.content.parts[0] = msg;
        for (var j = 1; j < m.content.parts.length; j++) m.content.parts[j] = "";
        return true;
      }
    }
    return false;
  }
  function tryReplace(bodyStr) {
    var msg = g(K_MSG, "");
    if (!msg || !bodyStr) return bodyStr;
    try {
      var body = JSON.parse(bodyStr);
      if (replaceLastUser(body, msg)) {
        s(K_MSG, "");
        log("✓ 已替换内容:", msg.slice(0, 80));
        setStatus("已发送 ✓", "#81c995");
        return JSON.stringify(body);
      }
    } catch (e) { log("替换失败", e); }
    return bodyStr;
  }
  var origFetch = win.fetch;
  if (typeof origFetch === "function") {
    win.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) ? input.url : "";
      if (isConvPost(url) && init && typeof init.body === "string") init.body = tryReplace(init.body);
      return origFetch.apply(this, arguments);
    };
  }
  try {
    var OX = win.XMLHttpRequest;
    if (OX && OX.prototype && !OX.__zc) {
      function ZX() {
        var x = new OX();
        var open = x.open; x.open = function (m, u) { this.__u = u; return open.apply(this, arguments); };
        var send = x.send;
        x.send = function (b) {
          if (this.__u && isConvPost(this.__u) && typeof b === "string") b = tryReplace(b);
          return send.call(this, b);
        };
        return x;
      }
      ZX.__zc = true; ZX.prototype = OX.prototype;
      win.XMLHttpRequest = ZX;
    }
  } catch (e) {}

  // ---------- 原生输入框 ----------
  function getComposerEl() {
    var els = document.querySelectorAll('[contenteditable="true"][role="textbox"], .ProseMirror, textarea[data-composer-markdown]');
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect && els[i].getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) return els[i];
    }
    return null;
  }
  function getComposerText() {
    var el = getComposerEl();
    return el ? (el.innerText || el.textContent || "").trim() : "";
  }
  function clearComposer() {
    var el = getComposerEl();
    if (!el) return;
    try { el.focus(); el.innerHTML = ""; el.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {}
  }
  function saveFromComposer() {
    var text = getComposerText();
    if (!text) { setStatus("输入框为空", "#f0b429"); return false; }
    s(K_MSG, text);
    clearComposer();
    log("已保存:", text.slice(0, 80));
    setStatus("已保存 ✓ 点提交答案", "#81c995");
    return true;
  }

  // ---------- 拦截原生发送按钮（仅上下文满时，改成保存） ----------
  function isMainComposerButton(btn) {
    try {
      if (btn.getAttribute("data-composer-voice-start") !== null) return true;
      var cls = (typeof btn.className === "string" ? btn.className : "");
      if (/bg-composer-primary/.test(cls)) return true;
      if (btn.closest("[data-composer-trailing-controls]") &&
          !btn.getAttribute("data-dictation-button") &&
          !/思考|听写/.test(btn.textContent || "")) return true;
    } catch (e) {}
    return false;
  }
  document.addEventListener("click", function (e) {
    if (!contextFull) return;
    var btn = e.target;
    try { btn = e.target.closest("button"); } catch (x) {}
    if (!btn || !isMainComposerButton(btn)) return;
    if (!getComposerText()) return;
    e.preventDefault(); e.stopPropagation();
    saveFromComposer();
  }, true);
  document.addEventListener("keydown", function (e) {
    if (!contextFull || e.key !== "Enter" || e.shiftKey) return;
    var t = e.target;
    if (!t || !t.getAttribute || t.getAttribute("role") !== "textbox") return;
    if (!getComposerText()) return;
    e.preventDefault(); e.stopPropagation();
    saveFromComposer();
  }, true);

  // ---------- 固定提交按钮与新聊天按钮（移动原节点，保持原生点击） ----------
  var pinnedSubmit = null;
  var pinnedNewChat = null;
  var hiddenAside = null;

  function pin(el, bottom) {
    el.style.setProperty("position", "fixed", "important");
    el.style.setProperty("right", "18px", "important");
    el.style.setProperty("bottom", bottom, "important");
    el.style.setProperty("z-index", "2147483647", "important");
    el.style.setProperty("margin", "0", "important");
    el.style.setProperty("width", "auto", "important");
    el.style.setProperty("max-width", "none", "important");
    el.style.setProperty("transform", "none", "important");
  }

  function findButtons() {
    var all = document.querySelectorAll("button");
    var submit = null, newChat = null, aside = null;
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      var txt = (b.innerText || b.textContent || "").trim();
      if (/提交答案/.test(txt) && b.getAttribute("data-d-component") === "button" && !b.disabled) submit = b;
    }
    var hs = document.querySelectorAll("h3, h2");
    for (var j = 0; j < hs.length; j++) {
      if ((hs[j].textContent || "").trim() !== "上下文窗口已达上限") continue;
      aside = hs[j].closest ? hs[j].closest("aside") : null;
      if (!aside) continue;
      var bs = aside.querySelectorAll("button");
      for (var k = 0; k < bs.length; k++) {
        if (/新聊天/.test(bs[k].textContent || "")) { newChat = bs[k]; break; }
      }
      break;
    }
    return { submit: submit, newChat: newChat, aside: aside };
  }

  function hideDisclaimer() {
    try {
      var els = document.querySelectorAll("div, span, p");
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.children.length !== 0) continue; // 只隐藏叶子节点，绝不碰父容器
        var t = (el.textContent || "").trim();
        if (/^ChatGPT 可能会(出错|犯错)/.test(t) && t.length < 60) {
          el.style.setProperty("display", "none", "important");
        }
      }
    } catch (e) {}
  }

  function refresh() {
    var f = findButtons();
    if (f.aside) {
      contextFull = true;
      if (f.submit && f.submit !== pinnedSubmit) {
        pin(f.submit, "66px");
        pinnedSubmit = f.submit;
        log("已固定提交答案按钮到发送旁");
      }
      if (f.newChat && f.newChat !== pinnedNewChat) {
        if (pinnedNewChat) { try { pinnedNewChat.remove(); } catch (e) {} }
        // 先把按钮移出 aside，再隐藏 aside，否则按钮随父元素一起不可见
        try { document.body.appendChild(f.newChat); } catch (e) {}
        pin(f.newChat, "112px");
        pinnedNewChat = f.newChat;
        log("已固定新聊天按钮（已移出提示条）");
      }
      if (f.aside !== hiddenAside) {
        f.aside.style.setProperty("display", "none", "important");
        hiddenAside = f.aside;
        log("已隐藏上下文提示条");
      }
      var st = document.getElementById("zc-status");
      if (st && (st.textContent === "就绪" || st.textContent === "请手动点提交按钮")) setStatus("发送即保存", "#8ab4f8");
    } else {
      if (contextFull) {
        contextFull = false;
        pinnedSubmit = null;
        pinnedNewChat = null;
        hiddenAside = null;
        setStatus("就绪", "#8ab4f8");
      }
    }
    hideDisclaimer();
  }

  function start() {
    refresh();
    try {
      var mo = new MutationObserver(function () {
        clearTimeout(win.__zcT);
        win.__zcT = setTimeout(refresh, 250);
      });
      mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
    } catch (e) {}
    setInterval(refresh, 1500);
  }

  function buildUI() {
    if (document.getElementById("zc-status")) return;
    var box = document.createElement("div");
    box.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;background:#1e1e1e;color:#8ab4f8;border:1px solid #444;border-radius:16px;padding:6px 12px;font:12px/1 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.5);";
    box.innerHTML = '续聊 · <span id="zc-status">就绪</span>';
    document.body.appendChild(box);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { buildUI(); start(); }, { once: true });
  else { buildUI(); start(); }
})();
