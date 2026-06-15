/* 純函式(無 DOM 依賴,node --test 可直接 require):
   連買連賣 streak 與象限遷移。文案僅陳述資金事實。 */
(function (g) {
  "use strict";

  /* daily 自最新一日往回連續計數:>0 連買、<0 連賣、0 中斷。
     回傳帶號天數(買為正、賣為負、最新日為 0 → 0)。 */
  function streakOf(daily) {
    if (!daily || !daily.length) return 0;
    const lastSign = daily[daily.length - 1] > 0 ? 1 : daily[daily.length - 1] < 0 ? -1 : 0;
    if (!lastSign) return 0;
    let n = 0;
    for (let i = daily.length - 1; i >= 0; i--) {
      const s = daily[i] > 0 ? 1 : daily[i] < 0 ? -1 : 0;
      if (s !== lastSign) break;
      n++;
    }
    return lastSign * n;
  }

  /* 「連 N 日買超/賣超」;觸及觀測窗上限顯示「N+」(窗外不可知,誠實揭露) */
  function streakText(v, windowLen) {
    if (!v) return "";
    const n = Math.abs(v);
    const shown = windowLen && n >= windowLen ? windowLen + "+" : String(n);
    return "連 " + shown + " 日" + (v > 0 ? "買超" : "賣超");
  }

  /* 最新快照 vs back 個快照前的象限;相同或查無(新板塊/快照不足)→ null */
  function prevQuadrant(history, name, back) {
    if (!history || history.length <= back) return null;
    const prev = (history[history.length - 1 - back].s || {})[name];
    const cur = (history[history.length - 1].s || {})[name];
    if (!prev || !cur) return null;
    return prev[2] === cur[2] ? null : prev[2];
  }

  /* 外資投信同買/同賣分組:以 inst 輸出值(round 1)嚴格判定 f>0 且 t>0
     (同賣對稱 <0);0.0 不入列。inst=null 板塊跳過;anyInst=false 表示
     整批拆分暫缺(整頁顯示暫缺行)。win: 5|20。 */
  function dualGroups(sectors, win) {
    const buy = [], sell = [];
    let anyInst = false;
    for (const s of sectors || []) {
      if (!s.inst) continue;
      anyInst = true;
      const f = s.inst["f" + win], t = s.inst["t" + win];
      if (f > 0 && t > 0) buy.push(s);
      else if (f < 0 && t < 0) sell.push(s);
    }
    return { buy: buy, sell: sell, anyInst: anyInst };
  }

  /* HTML 插值跳脫(深度防禦:資料源=交易所官方+自家映射,XSS 面屬理論性,
     但免費的縱深不拒絕)。badge 等刻意 HTML 由模板自行負責,資料字串過此。 */
  function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, c => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* 表格排序比較器工廠:null/undefined 一律排尾、字串 zh-Hant locale、數值差。
     rank 表與同買頁原本各刻一套(漂移面),收斂於此。val(row, key) 取值。 */
  function cmpBy(val, key, dirStr) {
    const dir = dirStr === "desc" ? -1 : 1;
    return (a, b) => {
      const va = val(a, key), vb = val(b, key);
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === "string") return va.localeCompare(vb, "zh-Hant") * dir;
      return (va - vb) * dir;
    };
  }

  /* rows(字串二維陣列)→ CSV 字串。含逗號/引號/換行的欄位加引號並雙寫引號。 */
  function toCSV(rows) {
    return (rows || []).map(r => r.map(v => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(",")).join("\r\n");
  }

  /* 量價背離分組(取代已停產的 cp_score 合成分數):cum_5>0 且 pch_5 非缺值
     才入列;pch_5≤0 → 逆勢吸金(against),>0 → 上漲吸金(withPrice);
     各依 cum_5 降冪。事實分組,非評分。 */
  function divergenceGroups(sectors) {
    const against = [], withPrice = [];
    for (const s of sectors || []) {
      if (!(s.cum_5 > 0) || s.price_change_5_pct === null ||
          s.price_change_5_pct === undefined) continue;
      (s.price_change_5_pct <= 0 ? against : withPrice).push(s);
    }
    const desc = (a, b) => b.cum_5 - a.cum_5;
    return { against: against.sort(desc), withPrice: withPrice.sort(desc) };
  }

  /* ===== 「今日變化」摘要衍生(純資金事實,守零評分鐵律) ===== */

  /* 象限遷移清單:最新快照 vs back 個快照前,象限改變的板塊。
     history 為升冪 [{date, s:{name:[cum_5,accel,象限,cum_20]}}],last=最新。
     凍結段/新板塊任一側查無 → 跳過(誠實:回放期出現/消失不偽造遷移)。
     依 |近5日| 降冪(讓資金量大的變動排前)。 */
  function quadrantMigrations(history, back) {
    back = back || 1;
    if (!history || history.length <= back) return [];
    const cur = history[history.length - 1].s || {};
    const prev = history[history.length - 1 - back].s || {};
    const out = [];
    for (const name of Object.keys(cur)) {
      const c = cur[name], p = prev[name];
      if (!c || !p || c[2] === p[2]) continue;
      out.push({ name: name, from: p[2], to: c[2],
                 cum_5: c[0], acceleration: c[1], cum_20: c[3] });
    }
    return out.sort((a, b) => Math.abs(b.cum_5) - Math.abs(a.cum_5));
  }

  /* 今日動能領先:加速度 >0 取最高 n、<0 取最低 n(事實排名,非評分) */
  function momentumLeaders(sectors, n) {
    n = n || 5;
    const arr = sectors || [];
    const up = arr.filter(s => s.acceleration > 0)
      .sort((a, b) => b.acceleration - a.acceleration).slice(0, n);
    const down = arr.filter(s => s.acceleration < 0)
      .sort((a, b) => a.acceleration - b.acceleration).slice(0, n);
    return { up: up, down: down };
  }

  /* 連買連賣動向:flip=今日剛轉向(streak 絕對值=1),top=持續最久 n。
     回傳 {sec, st}(st=帶號 streak),供 streakText 呈現。 */
  function streakBoard(sectors, n) {
    n = n || 5;
    const xs = (sectors || []).map(s => ({ sec: s, st: streakOf(s.daily) }))
      .filter(x => x.st !== 0);
    return {
      flipBuy:  xs.filter(x => x.st === 1),
      flipSell: xs.filter(x => x.st === -1),
      topBuy:   xs.filter(x => x.st > 0).sort((a, b) => b.st - a.st).slice(0, n),
      topSell:  xs.filter(x => x.st < 0).sort((a, b) => a.st - b.st).slice(0, n),
    };
  }

  /* 累計流入/流出最大 n(事實排名)。key:日報用 "cum_20"(近20日)、週報用 "cum_5"(近5日≈一週) */
  function cumulativeLeaders(sectors, n, key) {
    n = n || 5; key = key || "cum_20";
    const arr = sectors || [];
    return {
      inflow:  arr.filter(s => s[key] > 0)
        .sort((a, b) => b[key] - a[key]).slice(0, n),
      outflow: arr.filter(s => s[key] < 0)
        .sort((a, b) => a[key] - b[key]).slice(0, n),
    };
  }

  /* 自最新快照往回連續滿足條件的天數。kind:'accel'(加速度>0)|'fade'(象限=退潮)。
     任一日查無該板塊即中斷(凍結段缺漏不灌水)。 */
  function consecutiveRun(history, name, kind) {
    if (!history || !history.length) return 0;
    let n = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const t = (history[i].s || {})[name];
      if (!t) break;
      const hit = kind === "fade" ? t[2] === "退潮" : t[1] > 0;
      if (!hit) break;
      n++;
    }
    return n;
  }

  /* 多日持續性:連續加速 / 連續退潮達 minRun 日以上的板塊,依天數降冪取 n */
  function persistentRuns(history, kind, n, minRun) {
    n = n || 5; minRun = minRun || 2;
    if (!history || !history.length) return [];
    const latest = history[history.length - 1].s || {};
    const out = [];
    for (const name of Object.keys(latest)) {
      const run = consecutiveRun(history, name, kind);
      if (run < minRun) continue;
      const t = latest[name];
      out.push({ name: name, days: run,
                 cum_5: t[0], acceleration: t[1], quadrant: t[2], cum_20: t[3] });
    }
    return out.sort((a, b) => b.days - a.days).slice(0, n);
  }

  const lib = { streakOf: streakOf, streakText: streakText,
                prevQuadrant: prevQuadrant, dualGroups: dualGroups,
                toCSV: toCSV, divergenceGroups: divergenceGroups,
                escapeHtml: escapeHtml, cmpBy: cmpBy,
                quadrantMigrations: quadrantMigrations,
                momentumLeaders: momentumLeaders, streakBoard: streakBoard,
                cumulativeLeaders: cumulativeLeaders,
                consecutiveRun: consecutiveRun, persistentRuns: persistentRuns };
  if (typeof module !== "undefined" && module.exports) module.exports = lib;
  else g.SFLib = lib;
})(typeof globalThis !== "undefined" ? globalThis : this);
