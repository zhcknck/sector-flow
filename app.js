/* 台股板塊資金流向觀測 — 前端（純靜態，讀 sector_stats.json）
   軸口徑 v1.0（Tide 規格）：X=近5日累計、Y=加速度(億/天)、泡泡大小=近20日累計
   部署鏈:web/** push → CI → 樹比對 gate → 孤兒單 commit(2026-06-12 canary 驗證) */
"use strict";

/* Tide 規格 §3.2 精確色票（台股語境保留 退潮=綠松,規格 §7.2-1 的批評不採） */
const QUADRANT_COLOR = {
  "主力": "#D85A30",
  "輪動": "#E4B125",
  "觀望": "#777777",
  "退潮": "#1D9E75",
};
const QUADRANT_DESC = {
  "主力": "資金加速流入",
  "輪動": "資金流入但放緩",
  "觀望": "資金沉寂",
  "退潮": "資金流出",
};
const QUADRANT_ORDER = ["主力", "輪動", "觀望", "退潮"];
const BUBBLE_OPACITY = 0.55;   // 平常半透明,hover 變實(0.95)+ 放大 1.15x
const LABEL_GUARANTEE = 6;     // 面積前 N 大的泡泡標籤保證顯示,防重疊只擠小泡

let DATA = null;
let ARCHIVE = null;            // 歷史 archive(lazy fetch;載入失敗 → {records:[]} 安靜退回)
let PENDING_DEEP_DATE = null;  // 網址 d= 指向 20 窗外 → init 後載 archive 還原
let RMAX = 1;                  // 泡泡半徑尺度 = 選取檔位內 |cum_20| 最大值(檔位內一致,切檔 re-fit)
let chartSvg = null, chartZoom = null;
const state = {
  filter: null, search: "",
  sortKey: null, sortDir: "desc",
  histIndex: null,             // null = 最新快照(索引基準=當前檔位的合併史)
  histRange: "20",             // 時間軸檔位 "20" | "60" | "all"
  dualWin: 5,                  // 同買頁窗 5 | 20
  changesPeriod: "day",        // 今日變化頁口徑 "day"(vs 前一交易日) | "week"(vs 5 交易日前)
  dualBuySort: { key: "t", dir: "desc" },
  dualSellSort: { key: "t", dir: "asc" },
};

fetch("sector_stats.json")
  .then(r => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  })
  .then(init)
  .catch(err => {
    document.getElementById("meta").textContent = "資料載入失敗：" + err.message;
  });

/* 資料字串進 HTML 模板一律過 esc(深度防禦;badge 等刻意 HTML 不在此列) */
const esc = v => SFLib.escapeHtml(v);

/* 四個 renderer 共用:點列開所屬板塊抽屜 */
function wireSectorRows(el) {
  el.querySelectorAll("tr[data-sector]").forEach(tr => {
    tr.style.cursor = "pointer";
    tr.addEventListener("click", () => openPanel(currentByName(tr.dataset.sector)));
  });
}

/* tooltip 唯一關閉出口。mouseleave 蓋不到的路徑都走這裡:hover 中切頁籤
   (display:none 不觸發 mouseleave)、快照/檔位變更(殘留即舊日資料誤導)、
   點泡泡開抽屜、點圖表空白處(觸控裝置沒有 mouseleave 可依賴)。 */
function hideTip() {
  document.getElementById("tooltip").classList.add("hidden");
}

function fmt(v, digits = 2) {
  return v === null || v === undefined ? "—" : v.toLocaleString("zh-TW", {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
}
function fmtSigned(v, digits = 1) {
  if (v === null || v === undefined) return "—";
  return (v > 0 ? "+" : "") + fmt(v, digits);
}
function signClass(v) { return v > 0 ? "pos" : v < 0 ? "neg" : ""; }

function nameFontSize(rr) { return Math.max(10, Math.min(16, rr * 0.42)); }
function truncateName(name, rr, fs) {
  const maxChars = Math.max(4, Math.floor((rr * 2) / fs) + 1);
  return name.length > maxChars ? name.slice(0, maxChars - 1) + "…" : name;
}

/* ---------- hash 視圖狀態(分享連結還原快照日+象限過濾) ---------- */

/* 無 hash 落地時的預設分頁:手機先天難用泡泡圖(77 顆擠一團、難點選)→ 改落地
   「今日變化」文字摘要(手機單欄好讀);桌機維持泡泡圖主視圖。分享連結一旦帶
   hash(#bubble?d=… 等)就走 currentHashView 的實際值,不會被此預設覆寫。 */
function defaultView() {
  const mobile = typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 768px)").matches;
  return mobile ? "changes" : "bubble";
}

function currentHashView() {
  return location.hash.slice(1).split("?")[0] || defaultView();
}

function applyHashParams() {
  const q = location.hash.split("?")[1];
  if (!q) return;
  const p = new URLSearchParams(q);
  const d = p.get("d");
  if (d) {
    const i = DATA.history.findIndex(h => h.date === d);
    if (i >= 0) state.histIndex = i;
    else PENDING_DEEP_DATE = d;  // 20 窗外 → init 完成後載 archive 還原
  }
  const f = p.get("q");
  if (f && QUADRANT_ORDER.includes(f)) state.filter = f;
  if (p.get("w") === "20") state.dualWin = 20;
}

function writeHash() {
  const view = currentHashView();
  let h = view;
  if (view === "bubble") {
    const ps = [];
    if (!isLatestView()) ps.push("d=" + effHistory()[state.histIndex].date);
    if (state.filter) ps.push("q=" + encodeURIComponent(state.filter));
    if (ps.length) h += "?" + ps.join("&");
  }
  if (view === "dual" && state.dualWin === 20) h += "?w=20";
  history.replaceState(null, "", "#" + h);  // 不觸發 hashchange、不塞瀏覽歷史
}

/* ---------- 合併歷史(主檔 20 窗 + archive 凍結段) ---------- */

function mainHistRecords() {
  return DATA.history.map(h => ({
    date: h.date, s: h.s,
    taiex_pct: (DATA.taiex_pct_by_day || [])[(DATA.days || []).indexOf(h.date)] ?? null,
  }));
}

/* 當前檔位的有效歷史(升冪)。重疊尾 20 以主檔為準(活動窗=現行組成重算) */
function effHistory() {
  const main = mainHistRecords();
  if (state.histRange === "20" || !ARCHIVE || !ARCHIVE.records) return main;
  const by = new Map();
  for (const r of ARCHIVE.records) by.set(r.date, r);
  for (const r of main) by.set(r.date, r);
  const all = [...by.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  return state.histRange === "60" ? all.slice(-60) : all;
}

function loadArchive() {
  if (ARCHIVE) return Promise.resolve();
  return fetch("history_archive.json")
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null)
    .then(j => { ARCHIVE = (j && j.records) ? j : { records: [] }; });
}

function latestHistIndex() { return effHistory().length - 1; }
function isLatestView() {
  return state.histIndex === null || state.histIndex === latestHistIndex();
}

/* 顯示用板塊集：歷史回溯以「快照」為準渲染——凍結段可能含現行映射查無的
   板塊(更名/移除,長回放裡呈現為出現/消失是誠實事實);查無者帶空 stocks,
   tooltip 自動省略代表股行 */
function displaySectors() {
  if (isLatestView()) return DATA.sectors;
  const snap = effHistory()[state.histIndex].s;
  return Object.entries(snap).map(([name, h]) => {
    const cur = currentByName(name);
    return Object.assign(
      {},
      cur || { name, stocks: [], daily: [], inst: null, day_net: null,
               accel_desc: "", price_change_5_pct: null, stock_count: null },
      { name, cum_5: h[0], acceleration: h[1], quadrant: h[2], cum_20: h[3] });
  });
}
function visibleSectors() {
  const base = displaySectors();
  return state.filter ? base.filter(s => s.quadrant === state.filter) : base;
}
function currentByName(name) {
  return DATA.sectors.find(s => s.name === name);
}

/* 搜尋：板塊名 or 成分股號/名（datalist 選項是「代號 名稱」,逐 token 比對） */
function sectorMatches(sec, q) {
  if (!q) return true;
  const tokens = q.split(/\s+/).filter(Boolean);
  return tokens.some(t =>
    sec.name.includes(t) ||
    sec.stocks.some(s => s.id.startsWith(t) || s.name.includes(t)));
}

function init(data) {
  DATA = data;

  const taiex = data.taiex_change_pct;
  const taiexTxt = taiex === null ? "" :
    ` · 大盤 ${taiex > 0 ? "+" : ""}${fmt(taiex)}%`;
  // 大盤潮位:看板塊之前先看潮水(全市場法人合計,含未映射個股)
  const mkt = data.market_net;
  const mktTxt = mkt ?
    ` ｜ 全市場法人 當日${fmtSigned(mkt.day)}億 · 近5日${fmtSigned(mkt.cum_5)}億` : "";
  const gen = data.generated_at.replace("T", " ").slice(0, 16).replaceAll("-", "/");
  // 主資訊(日期/大盤/潮位)與次資訊(更新時間/板塊數)分層,降低一行字的密度
  document.getElementById("meta").innerHTML =
    `資料日期：${data.trading_date}${taiexTxt}${mktTxt}` +
    `<span class="meta-dim"> ｜ 更新 ${gen} ｜ ${data.sectors.length} 板塊</span>`;

  if ((data.schema_version || 1) > 3) {
    const b = document.getElementById("stale-banner");
    b.textContent = "⚠ 資料格式較新，請強制重新整理（Ctrl+Shift+R）載入新版頁面";
    b.classList.remove("hidden");
  }

  if (typeof data.coverage_pct === "number") {
    // 警戒線讀資料 meta(coverage_warn_pct):ETL 改門檻時 footer 同步,零硬編碼
    const warn = typeof data.coverage_warn_pct === "number"
      ? `（警戒線 ${data.coverage_warn_pct}%）` : "";
    const ex = typeof data.coverage_ex_etf_pct === "number"
      ? `不含 ETF ${fmt(data.coverage_ex_etf_pct, 1)}%${warn}／` : "";
    document.getElementById("coverage-note").textContent =
      `${data.sectors.length} 板塊約涵蓋本日法人買賣超估算總額:${ex}含 ETF ${fmt(data.coverage_pct, 1)}%。` +
      `另:資金加速度分級採絕對閾值（億/天），小型板塊多落於「動能持平」屬口徑特性。`;
    document.getElementById("coverage-note").classList.remove("hidden");
  }

  if (data.data_stale) {
    const b = document.getElementById("stale-banner");
    b.textContent = "⚠ 資料未完整更新：" + (data.stale_note || "沿用前一交易日快照");
    b.classList.remove("hidden");
  }

  // 表頭 sticky 偏移=頂部標題列「實際」高度(會隨換行/縮放變,寫死會卡錯位)
  const headerEl = document.querySelector("header");
  const setHeaderH = () => document.documentElement.style
    .setProperty("--header-h", headerEl.offsetHeight + "px");
  setHeaderH();
  new ResizeObserver(setHeaderH).observe(headerEl);

  initSearchSuggest();
  applyHashParams();   // 先還原網址帶的快照日/象限,再初始化滑桿與渲染
  initHistSlider();
  initTheme();
  renderQuadCards();
  drawBubbles();
  renderChanges();
  renderRank();
  renderCP();
  renderDip();
  renderAbnormal();
  renderDual();

  document.getElementById("hist-range").addEventListener("change", e =>
    setHistRange(e.target.value));
  document.getElementById("hist-play").addEventListener("click", togglePlayback);
  document.getElementById("hist-latest").addEventListener("click", jumpToLatest);
  document.getElementById("export-png").addEventListener("click", exportChartPNG);
  document.querySelectorAll(".csv-btn").forEach(btn => {
    btn.addEventListener("click", () =>
      exportViewCSV(btn.dataset.view, btn.dataset.name));
  });
  document.querySelectorAll("#dual-win-toggle button").forEach(btn => {
    btn.addEventListener("click", () => {
      state.dualWin = Number(btn.dataset.w);
      document.querySelectorAll("#dual-win-toggle button").forEach(b =>
        b.classList.toggle("active", b === btn));
      renderDual();
      writeHash();
    });
  });
  document.querySelectorAll("#changes-period-toggle button").forEach(btn => {
    btn.addEventListener("click", () => {
      state.changesPeriod = btn.dataset.p;
      document.querySelectorAll("#changes-period-toggle button").forEach(b =>
        b.classList.toggle("active", b === btn));
      renderChanges();
    });
  });
  if (state.dualWin === 20) {  // 網址帶 w=20 → 同步按鈕狀態
    document.querySelectorAll("#dual-win-toggle button").forEach(b =>
      b.classList.toggle("active", b.dataset.w === "20"));
  }
  if (PENDING_DEEP_DATE) restoreDeepDate(PENDING_DEEP_DATE);

  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => { location.hash = btn.dataset.view; });
  });
  window.addEventListener("hashchange", () => {
    activateTab(currentHashView());
    writeHash();  // 回到 bubble 分頁時把保留中的快照日/過濾重新寫回網址
  });
  activateTab(currentHashView());
  writeHash();

  document.getElementById("search").addEventListener("input", e => {
    state.search = e.target.value.trim();
    d3.selectAll(".bubble-node").classed("dim", d => !sectorMatches(d, state.search));
  });

  document.querySelectorAll("#rank-table th[data-key]").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.key;
      if (state.sortKey === k) {
        state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
      } else {
        state.sortKey = k;
        state.sortDir = "desc";
      }
      renderRank();
    });
  });
  const dipTh = document.getElementById("dip-threshold");
  dipTh.addEventListener("input", renderDip);
  // 打完正值(blur/Enter)回寫邊界 0:不在 input 即時改寫(會跟手上的鍵入互搶,
  // 例如打「0.5」想要負值時被吞),只在 commit 收尾,免得欄位與結果各說各話
  dipTh.addEventListener("change", () => {
    if (parseFloat(dipTh.value) > 0) { dipTh.value = "0"; renderDip(); }
  });
  document.getElementById("fit-view").addEventListener("click", fitView);
  document.getElementById("reset-view").addEventListener("click", () => {
    // 重置=回初始視圖:縮放平移與搜尋高亮一起歸位(只回縮放、留著聚焦不符直覺)
    state.search = "";
    document.getElementById("search").value = "";
    document.getElementById("search-dropdown").classList.add("hidden");
    d3.selectAll(".bubble-node").classed("dim", false);
    if (chartSvg && chartZoom) {
      chartSvg.transition().duration(300).call(chartZoom.transform, d3.zoomIdentity);
    }
  });

  document.getElementById("panel-close").addEventListener("click", closePanel);
  document.getElementById("panel-overlay").addEventListener("click", closePanel);
  let resizeTimer = null;  // 拖視窗時連發 resize,debounce 後只重繪一次
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => drawBubbles(), 150);
  });
}

function activateTab(view) {
  const valid = ["bubble", "changes", "rank", "cp", "dip", "abnormal", "dual"];
  if (!valid.includes(view)) view = "bubble";
  document.querySelectorAll(".tab").forEach(b =>
    b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach(v =>
    v.classList.toggle("hidden", v.id !== "view-" + view));
  if (typeof stopPlayback === "function" && playTimer) stopPlayback();
  hideTip();
  closePanel();
}

/* ---------- 搜尋建議（自製下拉,輸入即出候選） ---------- */

let SUGGEST_POOL = [];  // {label, value, hint}

function initSearchSuggest() {
  const seen = new Set();
  for (const s of DATA.sectors) {
    SUGGEST_POOL.push({ label: s.name, value: s.name, hint: "板塊" });
    for (const st of s.stocks) {
      if (seen.has(st.id)) continue;
      seen.add(st.id);
      SUGGEST_POOL.push({
        label: `${st.id} ${st.name}`,
        value: `${st.id} ${st.name}`,
        hint: DATA.sectors.filter(x => x.stocks.some(y => y.id === st.id))
          .map(x => x.name).join("、"),
      });
    }
  }

  const input = document.getElementById("search");
  const dd = document.getElementById("search-dropdown");

  const hide = () => dd.classList.add("hidden");
  const show = q => {
    if (!q) { hide(); return; }
    const hits = SUGGEST_POOL.filter(p => p.label.includes(q)).slice(0, 8);
    if (!hits.length) {
      // 查無結果要明示:沒這行只剩全場泡泡變淡,讀不出「沒中」還是「壞了」
      dd.innerHTML = `<div class="suggest-item suggest-empty">查無符合的板塊或個股</div>`;
      dd.classList.remove("hidden");
      return;
    }
    dd.innerHTML = hits.map(p =>
      `<div class="suggest-item" data-value="${esc(p.value)}">` +
      `<span>${esc(p.label)}</span><span class="suggest-hint">${esc(p.hint)}</span></div>`).join("");
    dd.classList.remove("hidden");
    dd.querySelectorAll(".suggest-item[data-value]").forEach(el => {
      el.addEventListener("mousedown", ev => {
        ev.preventDefault();          // 比 input blur 先吃到
        input.value = el.dataset.value;
        state.search = el.dataset.value;
        d3.selectAll(".bubble-node").classed("dim", d => !sectorMatches(d, state.search));
        hide();
      });
    });
  };

  input.addEventListener("input", e => show(e.target.value.trim()));
  input.addEventListener("focus", e => show(e.target.value.trim()));
  input.addEventListener("blur", () => setTimeout(hide, 150));
  input.addEventListener("keydown", e => { if (e.key === "Escape") hide(); });
}

/* ---------- 時間軸滑桿(檔位 20/60/全部) ---------- */

function fmtHistLabel(i, eff) {
  const r = eff[i];
  const pct = r.taiex_pct;
  return r.date.slice(5).replace("-", "/") +
    (i === eff.length - 1 ? "（最新）" : "") +
    (pct !== null && pct !== undefined && pct <= -1 ? `　⚠ 大盤 ${fmtSigned(pct)}%` : "");
}

/* 只畫軌道與標籤,不碰 slider 的 max/value(拖曳中改寫 value 會跟手上的
   拖曳互搶)。軌道三層(上→下):大跌日刻度點/走過進度上色/底色——自繪
   slider 後原生 datalist 刻度不顯示,全部用 backgroundImage 畫,
   size/position 由 CSS 統一管。 */
function paintSlider(eff, idx) {
  const slider = document.getElementById("hist-slider");
  const n = Math.max(eff.length - 1, 1);
  const dots = eff.map((r, i) =>
    r.taiex_pct !== null && r.taiex_pct !== undefined && r.taiex_pct <= -1 ? i : -1)
    .filter(i => i >= 0)
    .map(i => {
      const p = ((i / n) * 100).toFixed(1);
      // 大跌日刻度=綠(台股慣例跌=綠,與全站負值同語系)
      return `radial-gradient(circle 3.5px at ${p}% 50%, #1D9E75 0 3px, transparent 3.5px)`;
    });
  const prog = ((idx / n) * 100).toFixed(1);
  // 進度=中性藍灰(時間軸是 chrome 不是資料,不佔用四象限任何語意色),
  // 由淡入深到 thumb 位置後切回軌道底色
  const progress = `linear-gradient(to right, rgba(125,150,180,.22) 0%, ` +
    `rgba(125,150,180,.85) ${prog}%, var(--border-primary, #2A313D) ${prog}%)`;
  slider.style.backgroundImage = [...dots, progress].join(",");
  slider.setAttribute("aria-valuetext", fmtHistLabel(idx, eff));  // 讀屏念日期不念索引
  document.getElementById("hist-date").textContent = fmtHistLabel(idx, eff);
}

/* 依當前檔位重建滑桿(max/位置+重繪);init/切檔/播放用,拖曳中不要呼叫 */
function renderHistSlider() {
  const slider = document.getElementById("hist-slider");
  const eff = effHistory();
  const last = eff.length - 1;
  slider.max = String(last);
  const idx = state.histIndex === null ? last : Math.min(state.histIndex, last);
  slider.value = String(idx);
  paintSlider(eff, idx);
}

let sliderRaf = 0;

function initHistSlider() {
  document.getElementById("hist-slider").addEventListener("input", e => {
    stopPlayback();  // 手動拖曳優先,不跟播放打架
    state.histIndex = Number(e.target.value);
    if (sliderRaf) return;  // rAF 節流:一個畫格只處理一次,拖快不閃
    sliderRaf = requestAnimationFrame(() => {
      sliderRaf = 0;
      paintSlider(effHistory(), state.histIndex);  // 只畫進度/標籤,不回寫 slider 值
      renderQuadCards();
      updateBubbles(false);  // 拖曳=即時跟手;450ms 動畫只留給播放(連發會打架)
      writeHash();
    });
  });
  renderHistSlider();
}

/* 切檔位:保留所選快照日(新檔位查無 → 回最新);60/全部首次 lazy 載 archive */
function setHistRange(range) {
  stopPlayback();
  const curDate = isLatestView() ? null : effHistory()[state.histIndex].date;
  const apply = () => {
    state.histRange = range;
    const eff = effHistory();
    const idx = curDate ? eff.findIndex(r => r.date === curDate) : -1;
    state.histIndex = idx >= 0 ? idx : null;
    renderHistSlider();
    renderQuadCards();
    drawBubbles();
    writeHash();
  };
  if (range !== "20" && !ARCHIVE) loadArchive().then(apply);
  else apply();
}

/* 網址 d= 指向 20 窗外 → 載 archive、自動切到足夠檔位;查無安靜回最新 */
function restoreDeepDate(d) {
  loadArchive().then(() => {
    state.histRange = "all";
    let eff = effHistory();
    let idx = eff.findIndex(r => r.date === d);
    if (idx < 0) {
      state.histRange = "20";
      state.histIndex = null;
      writeHash();
      return;
    }
    if (eff.slice(-60).some(r => r.date === d)) {
      state.histRange = "60";
      eff = effHistory();
      idx = eff.findIndex(r => r.date === d);
    }
    state.histIndex = idx;
    document.getElementById("hist-range").value = state.histRange;
    renderHistSlider();
    renderQuadCards();
    drawBubbles();
    writeHash();
  });
}

/* ---------- 深/淺色主題 ---------- */

function initTheme() {
  const btn = document.getElementById("theme-toggle");
  const apply = light => {
    document.body.classList.toggle("light", light);
    btn.textContent = light ? "☀️" : "🌙";
    try { localStorage.setItem("sf-theme", light ? "light" : "dark"); } catch (e) { /* ignore */ }
  };
  let saved = null;
  try { saved = localStorage.getItem("sf-theme"); } catch (e) { /* ignore */ }
  apply(saved === "light");
  btn.addEventListener("click", () =>
    apply(!document.body.classList.contains("light")));
}

/* ---------- 象限計數卡（點擊過濾） ---------- */

let lastQuadKey = "";  // 內容沒變就不重繪(拖滑桿時整排卡片閃爍的元兇)

function renderQuadCards() {
  const holder = document.getElementById("quad-cards");
  const base = displaySectors();
  const byQ = {};
  for (const q of QUADRANT_ORDER) {
    byQ[q] = base.filter(s => s.quadrant === q)
      .sort((a, b) => Math.abs(b.cum_5) - Math.abs(a.cum_5));
  }
  const key = QUADRANT_ORDER.map(q =>
    byQ[q].length + ":" + byQ[q].slice(0, 2).map(s => s.name).join(",")).join("|") +
    "|" + (state.filter || "");
  if (key === lastQuadKey) return;
  lastQuadKey = key;
  holder.innerHTML = "";
  for (const q of QUADRANT_ORDER) {
    const n = byQ[q].length;
    // 卡片底行=該象限當前 |近5日| 前兩大板塊(掃一眼知道誰領頭)
    const tops = byQ[q].slice(0, 2).map(s => s.name).join("、");
    const card = document.createElement("div");
    card.className = "quad-card" + (state.filter === q ? " active" : "");
    card.title = "點擊過濾此類板塊";
    card.style.borderLeftColor = QUADRANT_COLOR[q];
    card.innerHTML =
      `<div class="q-name">${QUADRANT_DESC[q]}</div>` +
      `<div class="q-main"><span class="q-count" style="color:${QUADRANT_COLOR[q]}">${n}</span>` +
      `<span class="q-label">${q}</span></div>` +
      `<div class="q-desc">${esc(tops) || "—"}</div>`;
    card.addEventListener("click", () => {
      state.filter = state.filter === q ? null : q;
      renderQuadCards();
      updateBubbles();
      closePanel();
      writeHash();
    });
    holder.appendChild(card);
  }
}

/* ---------- 泡泡圖 ---------- */

/* 快照/過濾變更走這條:不重建 SVG,data join+transition 平滑移動
   (重建會砍掉節點,新節點沒有舊位置可滑,也會重置 zoom) */
let chartUpdate = null;
let chartGeom = null;  // 聚焦鈕用:基準比例尺與繪圖區界

/* ⌖ 聚焦:一鍵 zoom 到目前資料的包圍框。座標域為回放穩定跨檔位固定,
   代價是單日視圖偏擠——聚焦補回可讀性,⌂ 回全域 */
function fitView() {
  if (!chartGeom || !chartSvg || !chartZoom) return;
  const ds = visibleSectors();
  if (!ds.length) return;
  const { x0, y0, r, L, R, T, B } = chartGeom;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const d of ds) {
    const rr = r(Math.abs(d.cum_20));
    minX = Math.min(minX, x0(d.cum_5) - rr);
    maxX = Math.max(maxX, x0(d.cum_5) + rr);
    minY = Math.min(minY, y0(d.acceleration) - rr);
    maxY = Math.max(maxY, y0(d.acceleration) + rr);
  }
  const k = Math.max(0.5, Math.min(8,
    0.85 * Math.min((R - L) / Math.max(maxX - minX, 1),
                    (B - T) / Math.max(maxY - minY, 1))));
  const tx = (L + R) / 2 - k * (minX + maxX) / 2;
  const ty = (T + B) / 2 - k * (minY + maxY) / 2;
  chartSvg.transition().duration(350)
    .call(chartZoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
}

function updateBubbles(animate = true) {
  hideTip();  // 快照/過濾已變,殘留 tooltip 是舊日資料(回放/拖曳尤其誤導)
  if (chartUpdate) chartUpdate(animate);
  else drawBubbles();
}

function drawBubbles() {
  // 全量重建:init/resize/切檔(尺寸與座標域 re-fit)。快照切換請走 updateBubbles()
  hideTip();  // hover 中的節點即將被砍,mouseleave 不會再來
  const container = document.getElementById("chart");
  // Bug2:重建前保存 zoom/pan 狀態,重建後套回
  const prevT = chartSvg ? d3.zoomTransform(chartSvg.node()) : null;
  container.innerHTML = "";
  const width = container.clientWidth || 960;
  // 滿版:吃掉視窗剩餘高度(footer 摺到首屏外,免責仍可捲動到)
  const chartTop = container.getBoundingClientRect().top;
  const height = Math.max(480, window.innerHeight - chartTop - 26);
  const m = { top: 28, right: 24, bottom: 44, left: 96 };
  // 窄幅手機(<480):標籤只留板塊名一行(金額/漲跌進 tooltip/抽屜),碰撞框同步縮——
  // 三行標籤在小圖密叢區疊成一團(SPEC §5.1「<480 避讓」待辦);一行高度避讓排得開
  const NARROW = width < 480;

  // 泡泡尺度=選取檔位內 |cum_20| 最大值:檔位內拖滑桿尺度一致、切檔 re-fit
  // (跨「全歷史」同尺度會讓未來某個極端日永久壓扁所有泡泡)
  RMAX = d3.max(DATA.sectors, d => Math.abs(d.cum_20)) || 1;
  for (const rec of effHistory()) {
    for (const v of Object.values(rec.s)) RMAX = Math.max(RMAX, Math.abs(v[3] ?? 0));
  }

  // 帶號平方根刻度:巨型板塊不把其他板塊壓扁在原點帶。
  // Bug1:座標域跨「選取檔位」固定(同泡泡尺度拍板)——逐快照 re-fit 會讓
  // 回放時整個座標系跳動,泡泡看起來亂飛而非移動
  const xs = DATA.sectors.map(d => d.cum_5);
  const ys = DATA.sectors.map(d => d.acceleration);
  for (const rec of effHistory()) {
    for (const v of Object.values(rec.s)) { xs.push(v[0]); ys.push(v[1]); }
  }
  const xPad = (d3.max(xs.map(Math.abs)) || 1) * 0.25;
  const yPad = (d3.max(ys.map(Math.abs)) || 1) * 0.3;
  const x0 = d3.scalePow().exponent(0.5)
    .domain([Math.min(0, d3.min(xs)) - xPad, Math.max(0, d3.max(xs)) + xPad])
    .range([m.left, width - m.right]);
  const y0 = d3.scalePow().exponent(0.5)
    .domain([Math.min(0, d3.min(ys)) - yPad, Math.max(0, d3.max(ys)) + yPad])
    .range([height - m.bottom, m.top]);
  const r = d3.scaleSqrt().domain([0, RMAX]).range([7, 46]);
  chartGeom = { x0, y0, r, L: m.left, R: width - m.right, T: m.top, B: height - m.bottom };

  const svg = d3.select(container).append("svg")
    .attr("width", width).attr("height", height);

  const gx = svg.append("g").attr("class", "axis")
    .attr("transform", `translate(0,${height - m.bottom})`);
  const gy = svg.append("g").attr("class", "axis")
    .attr("transform", `translate(${m.left},0)`);
  const zeroLayer = svg.append("g");
  const plot = svg.append("g");

  const L = m.left, R = width - m.right, T = m.top, B = height - m.bottom;

  svg.append("text").attr("class", "chart-note")
    .attr("x", L + 4).attr("y", T - 2)
    .text("圈圈位置 = 近5日 · 圈圈大小 = 近20日累計　｜　滾輪縮放 · 拖曳移動");
  const corners = [
    { x: R - 8, y: T + 18, anchor: "end", text: "主力加速流入 ⭐", strong: true },
    { x: R - 8, y: B - 10, anchor: "end", text: "流入但放緩" },
    { x: L + 8, y: B - 10, anchor: "start", text: "低迷流出" },
    { x: L + 8, y: T + 18, anchor: "start", text: "加速流出" },
  ];
  for (const c of corners) {
    svg.append("text").attr("class", "quad-label" + (c.strong ? " strong" : ""))
      .attr("x", c.x).attr("y", c.y).attr("text-anchor", c.anchor).text(c.text);
  }
  svg.append("text").attr("class", "axis-hint").attr("text-anchor", "start")
    .attr("x", L + 4).attr("y", height - 8).text("← 近5日資金流出（億）");
  svg.append("text").attr("class", "axis-hint").attr("text-anchor", "end")
    .attr("x", R).attr("y", height - 8).text("近5日資金流入（億）→");

  const fmtX = v => (v > 0 ? "+" : "") + d3.format(",")(v);
  const fmtY = v => (v > 0 ? "+" : "") + d3.format(",.1f")(v) + "億/天";

  const tooltip = document.getElementById("tooltip");

  function showTip(ev, d) {
    const latest = isLatestView();  // 持久化後快照會變,逐次計算
    const histNote = latest ? "" :
      `<span class="tip-hist">快照日：${effHistory()[state.histIndex].date}</span><br>`;
    tooltip.classList.remove("hidden");
    const reps = d.stocks.slice(0, 4).map(s => `${s.id} ${s.name}`).join("、");
    const row = (k, v) => `<div class="tt-row"><span>${k}</span><strong>${v}</strong></div>`;
    tooltip.innerHTML =
      `<div class="tt-name">${esc(d.name)}　<span class="tt-status" style="background:${QUADRANT_COLOR[d.quadrant]}">${d.quadrant}</span></div>` +
      histNote +
      (latest ? row("當日法人淨買超", `${fmtSigned(d.day_net)} 億`) : "") +
      row("近5日法人淨買超", `${fmtSigned(d.cum_5)} 億`) +
      row("近20日累計", `${fmtSigned(d.cum_20)} 億`) +
      row("資金加速度", `${fmtSigned(d.acceleration)} 億/天` + (latest ? `（${d.accel_desc}）` : "")) +
      (latest ? row("近5日漲跌", `${fmtSigned(d.price_change_5_pct)}%`) : "") +
      (latest && d.inst ? row("近5日拆分",
        `外資 ${fmtSigned(d.inst.f5)}｜投信 ${fmtSigned(d.inst.t5)}｜自營 ${fmtSigned(d.inst.d5)}`) : "") +
      (latest && SFLib.streakOf(d.daily) ?
        row("連續", SFLib.streakText(SFLib.streakOf(d.daily), (DATA.days || []).length)) : "") +
      (latest && SFLib.prevQuadrant(DATA.history, d.name, 5) ?
        row("5 日前", SFLib.prevQuadrant(DATA.history, d.name, 5)) : "") +
      (d.stocks.length ? `<div class="tt-stocks">代表股：${esc(reps)}</div>` : "");
    // 內容塞好才量得到尺寸;貼右/下緣的泡泡把 tooltip 夾回視窗內
    tooltip.style.left = Math.min(ev.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8) + "px";
    tooltip.style.top = Math.min(ev.clientY + 14, window.innerHeight - tooltip.offsetHeight - 8) + "px";
  }

  let curX = x0, curY = y0;  // 目前(含 zoom)的比例尺,快照更新沿用 → zoom 不被重置

  function redraw(animate) {
    const x = curX, y = curY;
    const sectors = visibleSectors();   // 快照/過濾逐次取
    const latest = isLatestView();
    // Bug4:快照切換帶 transition 平滑移動;zoom/pan 連發事件不帶(會橡皮筋)
    const tween = sel => animate
      ? sel.transition().duration(450).ease(d3.easeCubicOut)
      : sel;
    gx.call(d3.axisBottom(x).ticks(9).tickFormat(fmtX).tickSize(0).tickPadding(10));
    gy.call(d3.axisLeft(y).ticks(7).tickFormat(fmtY).tickSize(0).tickPadding(8));
    gx.select(".domain").remove();
    gy.select(".domain").remove();

    const xz = x(0), yz = y(0);

    zeroLayer.selectAll("line.h").data([0]).join("line").attr("class", "zero-line h")
      .attr("x1", L).attr("x2", R).attr("y1", yz).attr("y2", yz);
    zeroLayer.selectAll("line.v").data([0]).join("line").attr("class", "zero-line v")
      .attr("x1", xz).attr("x2", xz).attr("y1", T).attr("y2", B);

    // 標籤防重疊:置中 → 泡上 → 泡下 依序找空位(大泡標籤不再疊羅漢);
    // 面積前 N 大三個位置都撞滿仍保證顯示(回置中),其餘藏
    const placedBoxes = [];
    const bySize = [...sectors].sort((a, b) => Math.abs(b.cum_20) - Math.abs(a.cum_20));
    bySize.forEach((d, idx) => {
      const rr = r(Math.abs(d.cum_20));
      const fs = nameFontSize(rr);
      const w = (truncateName(d.name, rr, fs).length + 1) * fs;
      const h = fs * (NARROW ? 1.35 : 3.2);   // 窄幅=名稱一行,框矮 → 避讓不過度佔位
      const cx0 = x(d.cum_5), cy0 = y(d.acceleration);
      const boxAt = off => ({ x1: cx0 - w / 2, x2: cx0 + w / 2,
                              y1: cy0 + off - h / 2, y2: cy0 + off + h / 2 });
      const hits = bx => placedBoxes.some(b =>
        bx.x1 < b.x2 && bx.x2 > b.x1 && bx.y1 < b.y2 && bx.y2 > b.y1);
      let chosen = null;
      for (const off of [0, -(rr + h / 2 + 4), rr + h / 2 + 4]) {
        if (!hits(boxAt(off))) { chosen = off; break; }
      }
      if (chosen === null && idx < LABEL_GUARANTEE) chosen = 0;
      d._labelOff = chosen || 0;
      d._labelShow = chosen !== null;
      if (d._labelShow) placedBoxes.push(boxAt(d._labelOff));
    });

    const node = plot.selectAll("g.bubble-node").data(sectors, d => d.name)
      .join(enter => {
        const g = enter.append("g").attr("class", "bubble-node");
        g.append("circle").attr("class", "bubble");
        g.append("text").attr("class", "bubble-label name-line");
        g.append("text").attr("class", "bubble-label value-line");
        g.append("text").attr("class", "bubble-label chg-line");
        return g;
      })
      .classed("dim", d => !sectorMatches(d, state.search))
      .on("mouseenter", function (ev, d) {
        showTip(ev, d);
        const g = d3.select(this).raise();
        g.select("circle.bubble")
          .transition().duration(120)
          .attr("r", r(Math.abs(d.cum_20)) * 1.15)
          .attr("fill-opacity", 0.95);
        g.selectAll("text.bubble-label").style("opacity", 1);
      })
      .on("mousemove", (ev, d) => showTip(ev, d))
      .on("mouseleave", function (ev, d) {
        hideTip();
        const g = d3.select(this);
        g.select("circle.bubble")
          .transition().duration(120)
          .attr("r", r(Math.abs(d.cum_20)))
          .attr("fill-opacity", BUBBLE_OPACITY);
        g.selectAll("text.bubble-label").style("opacity", d._labelShow ? 1 : 0);
      })
      .on("click", (ev, d) => { hideTip(); openPanel(currentByName(d.name)); });

    tween(node.select("circle.bubble"))
      .attr("cx", d => x(d.cum_5)).attr("cy", d => y(d.acceleration))
      .attr("r", d => r(Math.abs(d.cum_20)))
      .attr("fill", d => QUADRANT_COLOR[d.quadrant])
      .attr("fill-opacity", BUBBLE_OPACITY);

    // 三行標籤:板塊名 / 近5日金額 / 近5日漲跌%(Tide 規格 §5.3.1)
    // 位置走 tween 跟著泡泡滑(含避讓位移);顯隱用 opacity(CSS 過渡,播放不跳)
    node.select("text.name-line")
      .attr("dy", NARROW ? "0.35em" : "-0.75em")
      .attr("font-size", d => nameFontSize(r(Math.abs(d.cum_20))))
      .style("opacity", d => d._labelShow ? 1 : 0)
      .text(d => {
        const rr = r(Math.abs(d.cum_20));
        return truncateName(d.name, rr, nameFontSize(rr));
      });
    tween(node.select("text.name-line"))
      .attr("x", d => x(d.cum_5))
      .attr("y", d => y(d.acceleration) + d._labelOff);

    node.select("text.value-line")
      .attr("dy", "0.35em")
      .attr("font-size", d => Math.max(8.5, Math.min(13, r(Math.abs(d.cum_20)) * 0.3)))
      .style("opacity", d => (d._labelShow && !NARROW) ? 1 : 0)
      .text(d => fmtSigned(d.cum_5) + "億");
    tween(node.select("text.value-line"))
      .attr("x", d => x(d.cum_5))
      .attr("y", d => y(d.acceleration) + d._labelOff);

    node.select("text.chg-line")
      .attr("dy", "1.45em")
      .attr("font-size", d => Math.max(8, Math.min(12, r(Math.abs(d.cum_20)) * 0.27)))
      .style("opacity", d => (d._labelShow && latest && !NARROW && r(Math.abs(d.cum_20)) >= 14) ? 1 : 0)
      .text(d => d.price_change_5_pct === null ? "" : fmtSigned(d.price_change_5_pct) + "%");
    tween(node.select("text.chg-line"))
      .attr("x", d => x(d.cum_5))
      .attr("y", d => y(d.acceleration) + d._labelOff);
  }

  chartUpdate = redraw;
  redraw(false);

  chartZoom = d3.zoom()
    .scaleExtent([0.5, 8])
    .on("zoom", ev => {
      curX = ev.transform.rescaleX(x0);
      curY = ev.transform.rescaleY(y0);
      redraw(false);
    });
  chartSvg = svg;
  svg.call(chartZoom);
  // 點空白處關 tooltip(泡泡點擊各自處理;d3.zoom 拖曳後自帶 click 抑制,不衝突)
  svg.on("click", ev => { if (!ev.target.closest("g.bubble-node")) hideTip(); });
  // Bug2:重建(resize/切檔)後還原使用者的縮放平移
  if (prevT && (prevT.k !== 1 || prevT.x !== 0 || prevT.y !== 0)) {
    svg.call(chartZoom.transform, prevT);
  }
}

/* ---------- 成分股側欄 ---------- */

function openPanel(sec) {
  if (!sec) return;
  document.getElementById("panel-title").innerHTML =
    `${esc(sec.name)}　<span class="panel-badge" style="background:${QUADRANT_COLOR[sec.quadrant]};color:#0E1218">${sec.quadrant}</span>`;
  const nBuy = sec.stocks.filter(s => s.net_buy > 0).length;
  const nSell = sec.stocks.filter(s => s.net_buy < 0).length;
  // Tide 規格 §5.4:五行統計
  const instRow = (label, f, t, d) =>
    `<div class="panel-stat-row"><span>${label}</span><b>` +
    `<span class="${signClass(f)}">外資 ${fmtSigned(f)}</span> · ` +
    `<span class="${signClass(t)}">投信 ${fmtSigned(t)}</span> · ` +
    `<span class="${signClass(d)}">自營 ${fmtSigned(d)}</span></b></div>`;
  // 拆分暫缺要明示(昨天還在今天不見,無聲消失讀起來像 bug;同 data_stale 揭露慣例)
  const instHtml = sec.inst
    ? instRow("近 5 日拆分", sec.inst.f5, sec.inst.t5, sec.inst.d5) +
      instRow("近 20 日拆分", sec.inst.f20, sec.inst.t20, sec.inst.d20)
    : `<div class="panel-stat-row"><span>法人拆分</span><b class="dim-note">資料暫缺</b></div>`;
  const st = SFLib.streakOf(sec.daily);
  document.getElementById("panel-stats").innerHTML = [
    ["當日法人淨買超", `${fmtSigned(sec.day_net)} 億`, signClass(sec.day_net)],
    ["近 5 日法人淨買超", `${fmtSigned(sec.cum_5)} 億`, signClass(sec.cum_5)],
    ["近 20 日累計", `${fmtSigned(sec.cum_20)} 億`, signClass(sec.cum_20)],
    ["資金加速度", `${fmtSigned(sec.acceleration)} 億/天（${sec.accel_desc}）`, signClass(sec.acceleration)],
    ["近 5 日漲跌", `${fmtSigned(sec.price_change_5_pct)}%`, signClass(sec.price_change_5_pct)],
  ].map(([k, v, c]) =>
    `<div class="panel-stat-row"><span>${k}</span><b class="${c}">${v}</b></div>`).join("") +
    instHtml +
    `<div class="panel-stat-row"><span>連續</span><b class="${signClass(st)}">` +
    `${st ? SFLib.streakText(st, (DATA.days || []).length) : "—"}</b></div>` +
    `<div class="panel-stat-row"><span>板塊內分化（近20日）</span>` +
    `<b><span class="pos">${nBuy} 檔被買</span> · <span class="neg">${nSell} 檔被賣</span></b></div>`;
  renderSparkline(sec);
  const tbody = document.getElementById("panel-stocks");
  tbody.innerHTML = "";
  for (const s of sec.stocks) {
    const dchg = s.day_change_pct;
    const badge =
      s.abnormal === "buy" ? ` <span class="abnormal-badge">異常大買</span>` :
      s.abnormal === "sell" ? ` <span class="abnormal-badge sell">異常大賣</span>` : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(s.id)}</td><td>${esc(s.name)}${badge}</td>` +
      `<td class="num ${signClass(dchg)}">${dchg === null ? "—" : fmtSigned(dchg, 1) + "%"}</td>` +
      `<td class="num ${signClass(s.day_net_buy)}">${fmtSigned(s.day_net_buy, 2)}</td>`;
    tbody.appendChild(tr);
  }
  document.getElementById("panel").classList.add("open");
  document.getElementById("panel-overlay").classList.add("open");
}
function closePanel() {
  document.getElementById("panel").classList.remove("open");
  document.getElementById("panel-overlay").classList.remove("open");
}

/* 板塊近20日每日淨買超 mini 長條圖 */
function renderSparkline(sec) {
  const holder = document.getElementById("panel-spark");
  holder.innerHTML = "";
  const daily = sec.daily || [];
  if (!daily.length) return;
  const W = 380, H = 72, pad = 2;  // 填滿 420px 抽屜寬
  const maxAbs = Math.max(...daily.map(Math.abs), 0.01);
  const bw = W / daily.length;
  const zero = H / 2;
  let bars = "";
  daily.forEach((v, i) => {
    const h = Math.max(1, Math.abs(v) / maxAbs * (H / 2 - 2));
    const y = v >= 0 ? zero - h : zero;
    const color = v > 0 ? "#D85A30" : v < 0 ? "#1D9E75" : "#777777";
    bars += `<rect x="${(i * bw + pad / 2).toFixed(1)}" y="${y.toFixed(1)}" ` +
      `width="${(bw - pad).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}"></rect>`;
  });
  const d0 = (DATA.days[0] || "").slice(5).replace("-", "/");
  const d1 = (DATA.days[DATA.days.length - 1] || "").slice(5).replace("-", "/");
  holder.innerHTML =
    `<div class="spark-title">近20日每日淨買超（億）</div>` +
    `<svg width="${W}" height="${H}">` +
    `<line x1="0" x2="${W}" y1="${zero}" y2="${zero}" class="spark-zero"></line>${bars}</svg>` +
    `<div class="spark-dates"><span>${d0}</span><span>${d1}</span></div>`;
}

/* ---------- 排序共用 ---------- */

function sortValue(s, key) {
  if (key === "name") return s.name;
  if (key === "quadrant") return QUADRANT_ORDER.indexOf(s.quadrant);
  if (key === "streak") return SFLib.streakOf(s.daily);  // 買為正、賣為負
  return s[key];
}
function sortRows(rows, key, dirStr) {
  rows.sort(SFLib.cmpBy(sortValue, key, dirStr));
}
function markSortHeaders(tableSel, key, dirStr) {
  document.querySelectorAll(`${tableSel} th[data-key]`).forEach(th => {
    if (!th.dataset.label) th.dataset.label = th.textContent;
    const active = th.dataset.key === key;
    th.textContent = th.dataset.label + (active ? (dirStr === "desc" ? " ▼" : " ▲") : "");
  });
}

/* ---------- 排行榜 ---------- */

/* ---------- 今日變化:資金事實摘要(日=vs前一交易日 / 週=vs 5交易日前 + 多日持續性) ----
   全部由現有 sector_stats.json 衍生(零新抓取);文案僅陳述資金事實,守零評分鐵律。
   口徑切換(state.changesPeriod)只動「變動比較窗」與標籤,不改任何指標定義。 */
function renderChanges() {
  const el = document.getElementById("changes-content");
  if (!el || !DATA) return;
  const esc = SFLib.escapeHtml;
  const winLen = (DATA.days || []).length;
  const hist = DATA.history || [];
  const sectors = DATA.sectors || [];
  const weekly = state.changesPeriod === "week";
  const back = weekly ? 5 : 1;            // 象限變動比較窗:日=1、週=5 個交易日
  const pPrefix = weekly ? "本週" : "今日";
  const fromLabel = weekly ? "5 交易日前" : "前一交易日";

  const dot = q => `<i class="dot q-${esc(q)}"></i>`;
  const numSpan = (v, suf) => `<span class="chg-num ${signClass(v)}">${fmtSigned(v)}${suf || ""}</span>`;
  function block(title, items, emptyMsg) {
    const body = items && items.length
      ? `<ul class="chg-list">${items.join("")}</ul>`
      : `<p class="chg-empty">${esc(emptyMsg)}</p>`;
    return `<div class="chg-block"><h3 class="chg-h">${esc(title)}</h3>${body}</div>`;
  }

  /* 大盤潮位(全市場法人合計 + 大盤漲跌;口徑無關,恆為當前) */
  const mkt = DATA.market_net, taiex = DATA.taiex_change_pct;
  let tideHtml = "";
  if (mkt) {
    tideHtml =
      `<div class="chg-tide"><span class="chg-tide-lab">大盤潮位</span>` +
      (taiex === null || taiex === undefined ? "" :
        `<span class="chg-tide-item">大盤 <b class="${signClass(taiex)}">${fmtSigned(taiex, 2)}%</b></span>`) +
      `<span class="chg-tide-item">全市場法人 當日 ${numSpan(mkt.day, " 億")}</span>` +
      `<span class="chg-tide-item">近5日 ${numSpan(mkt.cum_5, " 億")}</span>` +
      `<span class="chg-tide-item">近20日 ${numSpan(mkt.cum_20, " 億")}</span></div>`;
  }

  /* 象限變動(vs back 個交易日)。依近5日金額取前 MIG_CAP:加速度≈0 的小型板塊
     會逐日跨越象限界線(主力↔輪動 等),金額排序+截斷濾掉這類機械性雜訊;
     截斷必明示,不無聲(同覆蓋率「寧缺勿濫」原則)。 */
  const MIG_CAP = 10;
  const migAll = SFLib.quadrantMigrations(hist, back);
  const migItems = migAll.slice(0, MIG_CAP).map(m =>
    `<li>${dot(m.to)}<b>${esc(m.name)}</b> ${pPrefix}進入<b>${esc(m.to)}</b>象限,近5日 ${numSpan(m.cum_5, " 億")}` +
    `<span class="chg-dim">${fromLabel}:${esc(m.from)}</span></li>`);
  if (migAll.length > MIG_CAP)
    migItems.push(`<li class="chg-empty">另有 ${migAll.length - MIG_CAP} 個較小額象限變動未列（依近5日金額取前 ${MIG_CAP}）</li>`);
  const migBlock = block(pPrefix + "象限變動", migItems,
    hist.length <= back ? "歷史快照不足,無法比較。" : pPrefix + "無板塊象限變動。");

  /* 動能領先 / 退潮(加速度排名;加速度本身是近5日−前5日均,口徑無關) */
  const mom = SFLib.momentumLeaders(sectors, 5);
  const momItem = s =>
    `<li>${dot(s.quadrant)}<b>${esc(s.name)}</b> 加速度 ${numSpan(s.acceleration, " 億/天")}` +
    `<span class="chg-from">（${esc(s.accel_desc)}）</span>` +
    `<span class="chg-dim">當日 ${fmtSigned(s.day_net)} 億</span></li>`;
  const upBlock = block("資金加速領先（加速度最高）", mom.up.map(momItem), "無板塊加速度為正。");
  const downBlock = block("退潮最快（加速度最低）", mom.down.map(momItem), "無板塊加速度為負。");

  /* 連買連賣動向(連續=當前狀態,口徑無關;轉向 flip=日概念,僅日報出) */
  const sb = SFLib.streakBoard(sectors, 5);
  const stItem = x =>
    `<li><b>${esc(x.sec.name)}</b> <span class="${x.st > 0 ? "pos" : "neg"}">${esc(SFLib.streakText(x.st, winLen))}</span>` +
    `<span class="chg-dim">近5日 ${fmtSigned(x.sec.cum_5)} 億</span></li>`;
  const topStreakBlock = block("連買 / 連賣最久",
    sb.topBuy.concat(sb.topSell).map(stItem), "無連續買賣板塊。");
  let flipBlock = "";
  if (!weekly) {
    const flips = sb.flipBuy.concat(sb.flipSell)
      .sort((a, b) => Math.abs(b.sec.cum_5) - Math.abs(a.sec.cum_5)).slice(0, 8);
    flipBlock = block("今日轉買 / 轉賣（方向今日改變）", flips.map(stItem), "今日無板塊買賣方向改變。");
  }

  /* 多日持續性(連續加速 / 連續退潮;本就多日,口徑無關) */
  const runItem = (r, word) =>
    `<li>${dot(r.quadrant)}<b>${esc(r.name)}</b> 連續 <b>${r.days}</b> 日${word}` +
    `<span class="chg-dim">加速度 ${fmtSigned(r.acceleration)} · 近20日 ${fmtSigned(r.cum_20)} 億</span></li>`;
  const accelRunBlock = block("連續加速（多日）",
    SFLib.persistentRuns(hist, "accel", 5, 2).map(r => runItem(r, "加速")),
    "近期無連續 2 日以上加速的板塊。");
  const fadeRunBlock = block("連續退潮（多日）",
    SFLib.persistentRuns(hist, "fade", 5, 2).map(r => runItem(r, "退潮")),
    "近期無連續 2 日以上退潮的板塊。");

  /* 累計流入 / 流出最大:週=近5日(cum_5)、日=近20日(cum_20) */
  const cumKey = weekly ? "cum_5" : "cum_20";
  const priLab = weekly ? "近5日" : "近20日", secLab = weekly ? "近20日" : "近5日";
  const cum = SFLib.cumulativeLeaders(sectors, 5, cumKey);
  const cumItem = s =>
    `<li>${dot(s.quadrant)}<b>${esc(s.name)}</b> ${priLab} ${numSpan(s[cumKey], " 億")}` +
    `<span class="chg-dim">${secLab} ${fmtSigned(weekly ? s.cum_20 : s.cum_5)} 億</span></li>`;
  const inflowBlock = block(priLab + "累計流入最大", cum.inflow.map(cumItem), priLab + "無板塊累計淨流入。");
  const outflowBlock = block(priLab + "累計流出最大", cum.outflow.map(cumItem), priLab + "無板塊累計淨流出。");

  el.innerHTML =
    tideHtml +
    `<h2 class="chg-group-h">${pPrefix}變化</h2>` +
    `<div class="chg-grid">${migBlock}${flipBlock}${upBlock}${downBlock}${topStreakBlock}</div>` +
    `<h2 class="chg-group-h">多日趨勢回顧</h2>` +
    `<div class="chg-grid">${accelRunBlock}${fadeRunBlock}${inflowBlock}${outflowBlock}</div>`;
}

function renderRank() {
  markSortHeaders("#rank-table", state.sortKey, state.sortDir);
  const rows = [...DATA.sectors];
  if (state.sortKey) sortRows(rows, state.sortKey, state.sortDir);

  const tbody = document.querySelector("#rank-table tbody");
  tbody.innerHTML = "";
  for (const s of rows) {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.addEventListener("click", () => openPanel(s));
    tr.innerHTML =
      `<td class="sec-name">${esc(s.name)}</td>` +
      `<td><span class="badge" style="background:${QUADRANT_COLOR[s.quadrant]}">${s.quadrant}</span></td>` +
      `<td class="num ${signClass(s.day_net)}">${fmt(s.day_net)}</td>` +
      `<td class="num em-col ${signClass(s.cum_5)}">${fmt(s.cum_5)}</td>` +
      `<td class="num ${signClass(s.cum_20)}">${fmt(s.cum_20)}</td>` +
      `<td class="num ${signClass(s.acceleration)}">${fmt(s.acceleration)}</td>` +
      (st => `<td class="num ${signClass(st)}">${st ? SFLib.streakText(st, (DATA.days || []).length) : "—"}</td>`)(SFLib.streakOf(s.daily)) +
      `<td class="num ${signClass(s.price_change_5_pct)}">${fmt(s.price_change_5_pct)}</td>` +
      `<td class="num dim-col">${s.stock_count}</td>`;
    tbody.appendChild(tr);
  }
}

/* ---------- 量價背離(事實分組,取代已停產的 cp_score 評分) ---------- */

function renderCP() {
  const g = SFLib.divergenceGroups(DATA.sectors);
  const el = document.getElementById("cp-content");
  const maxCum = Math.max(...[...g.against, ...g.withPrice].map(s => s.cum_5), 0.01);

  const table = rows =>
    `<table class="data-table"><thead><tr>` +
    `<th>板塊</th><th>狀態</th><th class="num">近5日累計(億)</th>` +
    `<th class="num">近5日漲跌(%)</th><th></th></tr></thead><tbody>` +
    rows.map(s => {
      const barW = Math.max(2, Math.round(s.cum_5 / maxCum * 100));
      return `<tr data-sector="${esc(s.name)}">` +
        `<td class="sec-name">${esc(s.name)}</td>` +
        `<td><span class="badge" style="background:${QUADRANT_COLOR[s.quadrant]}">${s.quadrant}</span></td>` +
        `<td class="num em-col pos">${fmt(s.cum_5)}</td>` +
        `<td class="num ${signClass(s.price_change_5_pct)}">${fmt(s.price_change_5_pct)}</td>` +
        `<td><div class="cp-bar" style="width:${barW}%"></div></td></tr>`;
    }).join("") + `</tbody></table>`;

  el.innerHTML =
    (g.against.length
      ? `<h3 class="dual-title"><i class="dot" style="background:var(--main)"></i>逆勢吸金——被淨買進、價格未漲（${g.against.length}）</h3>` + table(g.against)
      : `<p class="view-note dim-note">本日無「被淨買進且價格未漲」的板塊。</p>`) +
    (g.withPrice.length
      ? `<h3 class="dual-title"><i class="dot" style="background:var(--rotation)"></i>上漲吸金——被淨買進、價格同步上漲（${g.withPrice.length}）</h3>` + table(g.withPrice)
      : "");
  wireSectorRows(el);
}

/* ---------- 異常大買賣總覽（當日 abnormal 個股,跨板塊去重） ---------- */

function renderAbnormal() {
  const byStock = new Map();
  for (const s of DATA.sectors) {
    for (const st of s.stocks) {
      if (!st.abnormal) continue;
      if (!byStock.has(st.id)) byStock.set(st.id, { st, sectors: [] });
      byStock.get(st.id).sectors.push(s.name);
    }
  }
  const all = [...byStock.values()];
  const buys = all.filter(x => x.st.abnormal === "buy")
    .sort((a, b) => b.st.day_net_buy - a.st.day_net_buy);
  const sells = all.filter(x => x.st.abnormal === "sell")
    .sort((a, b) => a.st.day_net_buy - b.st.day_net_buy);
  document.getElementById("abnormal-note").textContent =
    all.length ? `本日共 ${all.length} 檔。點列開所屬板塊。` : "本日無符合條件的個股。";

  // 買/賣分段表(方向由段標題表明,表內不再佔一欄)
  const table = rows =>
    `<table class="data-table"><thead><tr>` +
    `<th>股號</th><th>名稱</th><th class="num">當日買賣超(億)</th>` +
    `<th class="num">當日漲跌(%)</th><th>所屬板塊</th></tr></thead><tbody>` +
    rows.map(({ st, sectors }) =>
      `<tr data-sector="${esc(sectors[0])}">` +
      `<td>${esc(st.id)}</td><td class="sec-name">${esc(st.name)}</td>` +
      `<td class="num em-col ${signClass(st.day_net_buy)}">${fmtSigned(st.day_net_buy, 2)}</td>` +
      `<td class="num ${signClass(st.day_change_pct)}">${st.day_change_pct === null ? "—" : fmtSigned(st.day_change_pct, 1)}</td>` +
      `<td class="dim-col">${esc(sectors.join("、"))}</td></tr>`).join("") +
    `</tbody></table>`;

  const el = document.getElementById("abnormal-content");
  el.innerHTML =
    (buys.length ? `<h3 class="dual-title"><i class="dot" style="background:var(--main)"></i>異常大買（${buys.length}）</h3>` + table(buys) : "") +
    (sells.length ? `<h3 class="dual-title"><i class="dot" style="background:var(--recede)"></i>異常大賣（${sells.length}）</h3>` + table(sells) : "");
  wireSectorRows(el);
}

/* ---------- 回放播放鍵 ---------- */

let playTimer = null;

function stopPlayback() {
  if (!playTimer) return;
  clearInterval(playTimer);
  playTimer = null;
  const btn = document.getElementById("hist-play");
  btn.textContent = "▶";
  btn.setAttribute("aria-label", "播放回放");
}

/* 回放暫停/拖曳後停在歷史日,一鍵回最新(實測回饋:不然只能手動拖滑桿到底) */
function jumpToLatest() {
  stopPlayback();
  if (isLatestView()) return;
  state.histIndex = null;
  renderHistSlider();
  renderQuadCards();
  updateBubbles();
  writeHash();
}

function togglePlayback() {
  if (playTimer) { stopPlayback(); return; }
  if (state.histRange !== "20" && !ARCHIVE) return;  // archive 載入中不播
  const eff = effHistory();
  if (eff.length < 2) return;
  if (isLatestView()) state.histIndex = 0;  // 已在最新 → 從頭播
  const btn = document.getElementById("hist-play");
  btn.textContent = "⏸";
  btn.setAttribute("aria-label", "暫停回放");
  playTimer = setInterval(() => {
    const list = effHistory();
    const cur = state.histIndex === null ? list.length - 1 : state.histIndex;
    if (cur + 1 >= list.length) { stopPlayback(); return; }  // 到底自停
    state.histIndex = cur + 1;
    renderHistSlider();
    renderQuadCards();
    updateBubbles();
    writeHash();
  }, 600);
}

/* ---------- 匯出(CSV/PNG) ---------- */

function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* 匯出該分頁畫面上的表格(所見即所得:沿用當前排序/口徑窗);
   dual 頁兩表各帶段落標題列。UTF-8 BOM 防 Excel 亂碼。 */
function exportViewCSV(viewId, name) {
  const rows = [];
  document.querySelectorAll(`#${viewId} table`).forEach((table, i) => {
    if (i) rows.push([]);
    const title = table.previousElementSibling;
    if (title && title.classList.contains("dual-title")) rows.push([title.textContent]);
    table.querySelectorAll("tr").forEach(tr => {
      rows.push([...tr.querySelectorAll("th,td")].map(c => c.textContent.trim()));
    });
  });
  const blob = new Blob(["﻿" + SFLib.toCSV(rows)], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `sector-flow_${name}_${DATA.trading_date}.csv`);
}

/* 泡泡圖 PNG:複製 SVG → 行內化 computed style(class 樣式序列化會遺失)
   → canvas 2x → 角落浮水印(站 URL · 資料日;歷史模式標快照日)。 */
function exportChartPNG() {
  const svg = document.querySelector("#chart svg");
  if (!svg) return;
  const clone = svg.cloneNode(true);
  const PROPS = ["fill", "stroke", "stroke-width", "opacity", "fill-opacity",
                 "font-size", "font-family", "font-weight",
                 "paint-order", "stroke-linejoin"];  // 文字描邊屬性留列:halo 時期漏內聯曾變描邊字,防回歸
  const src = svg.querySelectorAll("*"), dst = clone.querySelectorAll("*");
  src.forEach((el, i) => {
    const cs = getComputedStyle(el);
    PROPS.forEach(p => dst[i].style.setProperty(p, cs.getPropertyValue(p)));
  });
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const w = svg.clientWidth, h = svg.clientHeight;
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(clone)],
             { type: "image/svg+xml;charset=utf-8" }));
  const img = new Image();
  img.onload = () => {
    const STRIP = 22;  // 浮水印獨佔下方加高帶,不壓到圖內的軸標文字
    const canvas = document.createElement("canvas");
    canvas.width = w * 2;
    canvas.height = (h + STRIP) * 2;
    const ctx = canvas.getContext("2d");
    ctx.scale(2, 2);
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
    ctx.fillRect(0, 0, w, h + STRIP);
    ctx.drawImage(img, 0, 0, w, h);
    const dateLabel = isLatestView()
      ? DATA.trading_date
      : "快照 " + effHistory()[state.histIndex].date;
    ctx.fillStyle = "rgba(136,136,136,0.9)";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`zhcknck.github.io/sector-flow · ${dateLabel}`, w - 8, h + STRIP - 8);
    URL.revokeObjectURL(url);
    canvas.toBlob(b =>
      downloadBlob(b, `sector-flow_bubble_${dateLabel.replace("快照 ", "")}.png`));
  };
  img.src = url;
}

/* ---------- 同買頁（外資、投信皆淨買超/賣超;純前端,口徑=inst 輸出值嚴格判定） ---------- */

function dualVal(s, key, win) {
  if (key === "name") return s.name;
  if (key === "quadrant") return QUADRANT_ORDER.indexOf(s.quadrant);
  if (key === "f" || key === "t" || key === "d") return s.inst[key + win];
  if (key === "cum") return win === 5 ? s.cum_5 : s.cum_20;
  if (key === "pch") return win === 5 ? s.price_change_5_pct : s.price_change_20_pct;
  if (key === "streak") return SFLib.streakOf(s.daily);
  return s[key];
}

function dualTable(title, rows, sortState, tableId) {
  const win = state.dualWin;
  const sorted = [...rows].sort(
    SFLib.cmpBy((s, k) => dualVal(s, k, win), sortState.key, sortState.dir));
  const cols = [["name", "板塊"], ["quadrant", "狀態"], ["f", "外資"], ["t", "投信"],
                ["d", "自營(參考)"], ["cum", "合計"], ["pch", `近${win}日漲跌(%)`],
                ["streak", "連續"]];
  const ths = cols.map(([k, label]) =>
    `<th class="${k === "name" || k === "quadrant" ? "" : "num"}" data-key="${k}">` +
    `${label}${sortState.key === k ? (sortState.dir === "desc" ? " ▼" : " ▲") : ""}</th>`).join("");
  const trs = sorted.map(s => {
    const st = SFLib.streakOf(s.daily);
    const f = dualVal(s, "f", win), t = dualVal(s, "t", win), d = dualVal(s, "d", win);
    const cum = dualVal(s, "cum", win), pch = dualVal(s, "pch", win);
    return `<tr data-sector="${esc(s.name)}">` +
      `<td>${esc(s.name)}</td>` +
      `<td><span class="badge" style="background:${QUADRANT_COLOR[s.quadrant]}">${s.quadrant}</span></td>` +
      `<td class="num ${signClass(f)}">${fmtSigned(f)}</td>` +
      `<td class="num ${signClass(t)}">${fmtSigned(t)}</td>` +
      `<td class="num ref-col ${signClass(d)}">${fmtSigned(d)}</td>` +
      `<td class="num ${signClass(cum)}">${fmtSigned(cum)}</td>` +
      `<td class="num ${signClass(pch)}">${pch === null ? "—" : fmt(pch)}</td>` +
      `<td class="num ${signClass(st)}">${st ? SFLib.streakText(st, (DATA.days || []).length) : "—"}</td></tr>`;
  }).join("");
  return `<h3 class="dual-title">${title}（${rows.length}）</h3>` +
    `<table class="data-table dual-table" id="${tableId}"><thead><tr>${ths}</tr></thead>` +
    `<tbody>${trs || `<tr><td colspan="8" class="dim-note">無</td></tr>`}</tbody></table>`;
}

function renderDual() {
  const el = document.getElementById("dual-content");
  const win = state.dualWin;
  const g = SFLib.dualGroups(DATA.sectors, win);
  if (!g.anyInst) {
    el.innerHTML = `<p class="view-note dim-note">法人拆分 資料暫缺</p>`;
    return;
  }
  el.innerHTML =
    dualTable(`<i class="dot" style="background:var(--main)"></i>近${win}日 外資、投信皆淨買超`,
              g.buy, state.dualBuySort, "dual-buy") +
    dualTable(`<i class="dot" style="background:var(--recede)"></i>近${win}日 外資、投信皆淨賣超`,
              g.sell, state.dualSellSort, "dual-sell");
  wireSectorRows(el);
  el.querySelectorAll("th[data-key]").forEach(th => {
    th.addEventListener("click", () => {
      const inBuy = th.closest("table").id === "dual-buy";
      const ss = inBuy ? state.dualBuySort : state.dualSellSort;
      if (ss.key === th.dataset.key) ss.dir = ss.dir === "desc" ? "asc" : "desc";
      else { ss.key = th.dataset.key; ss.dir = "desc"; }
      renderDual();
    });
  });
}

/* ---------- 大跌日淨買（閾值可調,前端用每日序列即時重算） ---------- */

function renderDip() {
  const el = document.getElementById("dip-content");
  const raw = parseFloat(document.getElementById("dip-threshold").value);
  // 「|| -1」會把合法的 0 吃掉,故走 Number.isFinite。再夾 ≤0:HTML max="0"
  // 只擋上下箭頭與表單驗證,手打 999999 仍能經 .value 讀回 → 正閾值使
  // 「+2.36% ≤ 999999%」恆成立,把上漲日誤判成大跌觸發日(2026-06-13 攻測)。
  // 0 是語意上限(大跌日=非正報酬日);正值無意義,夾到邊界即可。
  const th = Math.min(0, Number.isFinite(raw) ? raw : -1);
  const days = DATA.days || [];
  const pcts = DATA.taiex_pct_by_day || [];

  // 今天觸發狀態標頭(Tide 規格:大盤跌幅超過閾值才啟動)
  const todayPct = DATA.taiex_change_pct;
  let head = "";
  if (todayPct !== null && todayPct !== undefined) {
    const trig = todayPct <= th;
    head =
      `<div class="status-card${trig ? " trig" : ""}">` +
      `<div class="sc-main">資料日大盤 <b class="${signClass(todayPct)}">${fmtSigned(todayPct)}%</b></div>` +
      `<div class="sc-desc">${trig
        ? "📍 跌幅超過閾值,以下為本日被淨買進的板塊"
        : "未超過閾值;以下顯示觀測窗內最近一次觸發"}</div></div>`;
  }

  let idx = -1;
  for (let i = days.length - 1; i >= 0; i--) {
    if (pcts[i] !== null && pcts[i] !== undefined && pcts[i] <= th) { idx = i; break; }
  }
  if (idx < 0) {
    el.innerHTML = head + `<p class="view-note">觀測窗內（近 ${days.length} 個交易日）無大盤跌幅 ≤ ${th}% 的交易日。</p>`;
    return;
  }

  const bought = DATA.sectors
    .map(s => ({ s, net: (s.daily || [])[idx] }))
    .filter(x => x.net !== undefined && x.net > 0)
    .sort((a, b) => b.net - a.net);

  let html = head +
    `<p class="view-note dip-day">最近觸發：<b>${days[idx]}</b>　` +
    `<span class="neg">${fmt(pcts[idx])}%</span>` +
    `<span class="meta-dim">（閾值 ${th}%）</span>　當日仍被法人淨買進的板塊：</p>`;
  if (!bought.length) {
    html += `<p class="view-note">該日無板塊獲淨買超。</p>`;
  } else {
    html += `<table class="data-table" id="dip-table"><thead><tr>` +
      `<th>板塊</th><th>狀態(今)</th><th class="num">當日淨買超(億)</th><th class="num">近5日漲跌(%)</th>` +
      `</tr></thead><tbody>` +
      bought.map(x =>
        `<tr data-sector="${esc(x.s.name)}">` +
        `<td>${esc(x.s.name)}</td>` +
        `<td><span class="badge" style="background:${QUADRANT_COLOR[x.s.quadrant]}">${x.s.quadrant}</span></td>` +
        `<td class="num pos">${fmt(x.net)}</td>` +
        `<td class="num ${signClass(x.s.price_change_5_pct)}">${fmt(x.s.price_change_5_pct)}</td>` +
        `</tr>`).join("") +
      `</tbody></table>`;
  }
  el.innerHTML = html;
  wireSectorRows(el);
}
