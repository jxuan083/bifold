// 注入到預覽頁的探針：盒模型高亮、點選定位、拖邊界改間距。
// 由 server.js 讀進來包成 <script> 塞進預覽版 HTML，原始檔完全不受影響。
(function () {
  // 兩套配色可切換：
  //   devtools = Chrome 長年的預設值，濃、無位移動畫、content 有外框線
  //   soft     = 調淡版，蓋在文字上時讀得到底下的內容
  var PALETTE = {
    devtools: { mg: "rgba(246,178,107,.66)", bd: "rgba(255,229,153,.66)",
                pd: "rgba(147,196,125,.55)", ct: "rgba(111,168,220,.66)",
                outline: "rgba(255,255,255,.7)", ease: "0s" },
    soft:     { mg: "rgba(246,178,107,.42)", bd: "rgba(255,229,153,.48)",
                pd: "rgba(147,196,125,.38)", ct: "rgba(111,168,220,.20)",
                outline: "transparent", ease: "140ms cubic-bezier(.2,.8,.2,1)" }
  };
  var mode = "devtools";
  var LAYERS = [["mg"], ["bd"], ["pd"], ["ct"]];
  var EASE = PALETTE[mode].ease;
  // 邊界抓取範圍。預覽被父視窗縮放過，這裡要除以縮放比，
  // 否則縮到 45% 時螢幕上只剩 2px 寬，滑鼠根本抓不到。
  var EDGE = 6, scale = 1;

  var on = false, last = null, box = {}, geo = null, drag = null, moved = false;

  // margin / border / padding 畫成「環」（靠 border 撐出中空），只有 content 實心。
  // 四區零重疊，半透明才不會互相疊出混濁的顏色。
  LAYERS.forEach(function (l) {
    var d = document.createElement("div");
    d.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;display:none;" +
      "box-sizing:border-box;border-style:solid;border-width:0";
    document.documentElement.appendChild(d);
    box[l[0]] = d;
  });

  function paint() {
    var P = PALETTE[mode], t = P.ease === "0s" ? "none" :
      "left " + P.ease + ",top " + P.ease + ",width " + P.ease + ",height " + P.ease;
    LAYERS.forEach(function (l) {
      var k = l[0], d = box[k];
      d.style.transition = t;
      if (k === "ct") {
        d.style.background = P.ct;
        d.style.outline = P.outline === "transparent" ? "none" : "1px solid " + P.outline;
        d.style.outlineOffset = "-1px";
      } else {
        d.style.background = "transparent";
        d.style.borderColor = P[k];
      }
    });
  }
  paint();

  var tip = document.createElement("div");
  tip.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483647;display:none;" +
    "background:rgba(18,22,28,.94);color:#fff;padding:5px 9px;border-radius:5px;" +
    "font:11.5px/1.45 ui-monospace,Menlo,monospace;white-space:nowrap;" +
    "box-shadow:0 2px 10px rgba(0,0,0,.3)";
  document.documentElement.appendChild(tip);

  var px = function (v) { return parseFloat(v) || 0; };
  var hit = function (t) { while (t && !t.dataset.l) t = t.parentElement; return t; };

  function put(d, x, y, w, h, ring) {
    if (ring && !(ring[0] || ring[1] || ring[2] || ring[3])) { d.style.display = "none"; return; }
    d.style.display = "block";
    d.style.left = x + "px"; d.style.top = y + "px";
    d.style.width = Math.max(0, w) + "px"; d.style.height = Math.max(0, h) + "px";
    if (ring) d.style.borderWidth = ring.join("px ") + "px";
  }
  function hideAll() {
    LAYERS.forEach(function (l) { box[l[0]].style.display = "none"; });
    tip.style.display = "none";
  }

  function measure(el) {
    var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return {
      r: r,
      m: [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)],
      b: [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)],
      p: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)]
    };
  }

  function draw(el, quiet) {
    if (!el) return hideAll();
    var g = measure(el); geo = g;
    var r = g.r, m = g.m, b = g.b, p = g.p;

    put(box.mg, r.left - m[3], r.top - m[0], r.width + m[1] + m[3], r.height + m[0] + m[2], m);
    put(box.bd, r.left, r.top, r.width, r.height, b);
    put(box.pd, r.left + b[3], r.top + b[0], r.width - b[1] - b[3], r.height - b[0] - b[2], p);
    put(box.ct, r.left + b[3] + p[3], r.top + b[0] + p[0],
        r.width - b[1] - b[3] - p[1] - p[3], r.height - b[0] - b[2] - p[0] - p[2]);

    if (quiet) return;
    var name = el.tagName.toLowerCase() +
      (typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
    tip.innerHTML =
      '<span style="color:#ffb86b">' + name + "</span>" +
      '<span style="color:#8b98a8"> &nbsp;' + Math.round(r.width) + " × " + Math.round(r.height) +
      " &nbsp;·&nbsp; 第 " + el.dataset.l + " 行</span>";
    tip.style.display = "block";
    var ty = r.top - m[0] - 26;
    tip.style.left = Math.max(4, r.left - m[3]) + "px";
    tip.style.top = (ty < 4 ? r.bottom + m[2] + 6 : ty) + "px";
  }

  // 滑鼠落在哪一條邊界上：往外是 margin、往內是 padding
  function zone(x, y) {
    if (!geo) return null;
    var r = geo.r, m = geo.m, b = geo.b, p = geo.p;
    var ct = { t: r.top + b[0] + p[0], b: r.bottom - b[2] - p[2],
               l: r.left + b[3] + p[3], rt: r.right - b[1] - p[1] };
    var tol = EDGE / (scale || 1);
    var near = function (v, t) { return Math.abs(v - t) <= tol; };

    if (p[0] && near(y, ct.t) && x > r.left && x < r.right) return { prop: "paddingTop", axis: "y", sign: 1 };
    if (p[2] && near(y, ct.b) && x > r.left && x < r.right) return { prop: "paddingBottom", axis: "y", sign: -1 };
    if (p[3] && near(x, ct.l) && y > r.top && y < r.bottom) return { prop: "paddingLeft", axis: "x", sign: 1 };
    if (p[1] && near(x, ct.rt) && y > r.top && y < r.bottom) return { prop: "paddingRight", axis: "x", sign: -1 };

    if (near(y, r.top - m[0]) && x > r.left - m[3] && x < r.right + m[1]) return { prop: "marginTop", axis: "y", sign: -1 };
    if (near(y, r.bottom + m[2]) && x > r.left - m[3] && x < r.right + m[1]) return { prop: "marginBottom", axis: "y", sign: 1 };
    if (near(x, r.left - m[3]) && y > r.top - m[0] && y < r.bottom + m[2]) return { prop: "marginLeft", axis: "x", sign: -1 };
    if (near(x, r.right + m[1]) && y > r.top - m[0] && y < r.bottom + m[2]) return { prop: "marginRight", axis: "x", sign: 1 };
    return null;
  }

  // 對齊輔助：拖出來的值優先吸附到同層兄弟的相同屬性，其次吸附到 4 的倍數。
  // 按住 Alt 可暫時停用。吸附到兄弟時，在那個兄弟的對應邊界畫一條參考線。
  var guide = document.createElement("div");
  guide.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;" +
    "display:none;background:#ff2d9b";
  document.documentElement.appendChild(guide);

  function snapTo(d, v, alt) {
    if (alt) return { v: v, note: "", el: null };
    var tol = 3 / (scale || 1);
    var p = d.el.parentElement;
    if (p) {
      var sibs = p.children;
      for (var i = 0; i < sibs.length; i++) {
        var s = sibs[i];
        if (s === d.el || !s.dataset || !s.dataset.l) continue;
        var sv = px(getComputedStyle(s)[d.prop]);
        if (sv > 0 && Math.abs(v - sv) <= tol) return { v: Math.round(sv), note: " · 對齊同層", el: s };
      }
    }
    var g = Math.round(v / 4) * 4;
    if (Math.abs(v - g) <= 1.5 / (scale || 1)) return { v: g, note: " · 4 的倍數", el: null };
    return { v: v, note: "", el: null };
  }

  function showGuide(el, axis) {
    if (!el) { guide.style.display = "none"; return; }
    var r = el.getBoundingClientRect();
    guide.style.display = "block";
    if (axis === "y") {
      guide.style.left = (r.left - 20) + "px"; guide.style.width = (r.width + 40) + "px";
      guide.style.top = r.top + "px"; guide.style.height = "1px";
    } else {
      guide.style.top = (r.top - 20) + "px"; guide.style.height = (r.height + 40) + "px";
      guide.style.left = r.left + "px"; guide.style.width = "1px";
    }
  }

  var CURSOR = { y: "ns-resize", x: "ew-resize" };
  var dashCase = function (s) { return s.replace(/[A-Z]/g, function (c) { return "-" + c.toLowerCase(); }); };

  addEventListener("message", function (e) {
    var d = e.data || {};
    if (d.type === "scale") scale = d.s || 1;
    if (d.type === "hlmode") { mode = d.mode; paint(); if (last) draw(last); }
    if (d.type === "pick") {
      on = d.on; last = null; geo = null;
      document.body.style.cursor = "";
      if (!on) hideAll();
    }
    // 點麵包屑指名選某一層
    if (d.type === "selectIdx") {
      var t = document.querySelector('[data-i="' + d.i + '"]');
      if (t) { last = t; geo = null; draw(t); emitGoto(t); }
    }
    // 屬性面板即時套用（功能二）
    if (d.type === "apply" && d.i != null) {
      var el = document.querySelector('[data-i="' + d.i + '"]');
      if (el) { el.style[d.prop] = d.value; if (el === last) draw(el, true); }
    }
  });

  addEventListener("mousemove", function (e) {
    if (drag) {
      var delta = (drag.axis === "y" ? e.clientY - drag.y0 : e.clientX - drag.x0) * drag.sign;
      var snap = snapTo(drag, Math.max(0, Math.round(drag.base + delta)), e.altKey);
      var v = snap.v;
      drag.value = v;
      drag.el.style[drag.prop] = v + "px";
      draw(drag.el, true);
      showGuide(snap.el, drag.axis);
      tip.style.display = "block";
      tip.innerHTML = '<span style="color:#ffb86b">' + dashCase(drag.prop) + "</span>" +
        '<span style="color:#8b98a8"> &nbsp;' + v + "px</span>" +
        (snap.note ? '<span style="color:#ff2d9b">' + snap.note + "</span>" : "");
      moved = true;
      e.preventDefault();
      return;
    }
    if (!on) return;
    var el = hit(e.target);
    if (el !== last) { last = el; draw(el); }
    if (!el) { document.body.style.cursor = ""; return; }
    var z = zone(e.clientX, e.clientY);
    document.body.style.cursor = z ? CURSOR[z.axis] : "";
  }, true);

  addEventListener("mousedown", function (e) {
    if (!on || !last) return;
    var z = zone(e.clientX, e.clientY);
    if (!z) return;
    var cs = getComputedStyle(last);
    drag = { el: last, prop: z.prop, axis: z.axis, sign: z.sign,
             x0: e.clientX, y0: e.clientY, base: px(cs[z.prop]), value: px(cs[z.prop]) };
    moved = false;
    e.preventDefault(); e.stopPropagation();
  }, true);

  addEventListener("mouseup", function (e) {
    if (!drag) return;
    var d = drag; drag = null;
    document.body.style.cursor = "";
    guide.style.display = "none";
    if (moved) {
      parent.postMessage({ type: "style", i: +d.el.dataset.i, line: +d.el.dataset.l,
                           prop: dashCase(d.prop), value: d.value + "px" }, "*");
      e.preventDefault(); e.stopPropagation();
    }
    draw(d.el);
  }, true);

  addEventListener("scroll", function () { if (on && last && !drag) draw(last); }, true);

  var cls1 = function (el) {
    return typeof el.className === "string" ? el.className.trim() : "";
  };

  // 祖先鏈。點下去選到的是最內層那個元素，但要講「在這個裡面均分」時，
  // 指的通常是裝著它們的容器——沒有這條鏈就選不到上層。
  function chainOf(el) {
    var out = [];
    for (var p = el; p; p = p.parentElement) {
      if (!p.dataset || !p.dataset.l) continue;
      out.unshift({
        i: +p.dataset.i, l: +p.dataset.l,
        tag: p.tagName.toLowerCase(),
        cls: (cls1(p).split(/\s+/)[0] || ""),
        kids: p.children.length
      });
      if (out.length >= 8) break;
    }
    return out;
  }

  function emitGoto(el) {
    var cs = getComputedStyle(el);
    var pick = {};
    ["fontSize", "fontWeight", "lineHeight", "letterSpacing", "color",
     "marginTop", "marginRight", "marginBottom", "marginLeft",
     "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
     "gap", "width", "borderRadius"].forEach(function (k) { pick[k] = cs[k]; });
    parent.postMessage({ type: "goto", line: +el.dataset.l, i: +el.dataset.i,
      tag: el.tagName.toLowerCase(),
      cls: cls1(el),
      inline: el.getAttribute("style") || "",
      css: pick,
      chain: chainOf(el),
      kids: el.children.length,
      text: (el.textContent || "").trim().slice(0, 50) }, "*");
  }

  addEventListener("click", function (e) {
    if (!on) return;
    if (moved) { moved = false; e.preventDefault(); e.stopPropagation(); return; } // 拖完不要順便跳行
    var el = hit(e.target);
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    emitGoto(el);
  }, true);
})();
