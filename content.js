/* =============================================================================
 * Wolt Unit Price Sorter — rank badges (no reordering)
 * -----------------------------------------------------------------------------
 * Wolt virtualizes its grid (only ~9 cards in the DOM at once), so reordering
 * the whole category isn't possible. Instead we leave Wolt's order untouched
 * and just annotate each card's badge:
 *   • the price per unit (Kč/kg, €/l, £/kg, …),
 *   • 🥇🥈🥉 for the 3 cheapest of that unit, and
 *   • "rank/total" (e.g. 15/30) for the rest.
 * Nothing is moved or cloned, so add-to-cart and the info modal keep working.
 * A one-time scroll-through ("scan") on each category learns the full ranking.
 * Only runs on category pages (URL contains "/items/").
 * ===========================================================================*/

(() => {
  "use strict";

  const NS = "wups";
  const ATTR_PPU = `data-${NS}-ppu`;
  const ATTR_BASE = `data-${NS}-base`;
  const ATTR_CUR = `data-${NS}-cur`;
  const ATTR_ID = `data-${NS}-id`;
  const ATTR_NAME = `data-${NS}-name`;
  const BADGE_CLASS = `${NS}-badge`;
  const STATUS_ID = `${NS}-status`;

  const REFRESH_IDLE_MS = 300;
  const NO_UNIT_PPU = Number.POSITIVE_INFINITY;
  const MEDALS = { 1: "🥇", 2: "🥈", 3: "🥉" };
  const UNIT_LABEL = { kg: "per kg", l: "per litre", ks: "per piece" };
  const HILITE_N = 10; // ring the top-N best value per unit
  const RING_CLASSES = ["wups-top--gold", "wups-top--silver", "wups-top--bronze", "wups-top--value"];
  const TOP_ID = `${NS}-topstrip`; // top best-value cards (above the list)
  const HINT_ID = `${NS}-hint`;    // "pick a category" tip on the All-items view

  const TOP_N_CHOICES = [4, 8, 12, 16, 20];
  // "All items" section titles (mixed units) — we skip these so they don't
  // auto-scan/scroll. Lowercased; extend as needed for more languages.
  const ALL_ITEMS_TITLES = new Set([
    "všechny položky", "všetky položky", "all items", "alle artikel",
    "alle artikelen", "wszystkie produkty", "alle produkte", "tous les articles",
    "tutti gli articoli", "todos los productos", "kaikki tuotteet", "alle varer",
    "minden termék", "усі товари", "все товары"
  ]);
  let enabled = true;
  let topN = 8;        // how many best-value cards to show on top (configurable)
  let opening = false; // true while we scroll-to/open an item (suppresses refresh)
  let observer = null;
  let idleTimer = null;
  let scanning = false;
  let hasScanned = false;
  let catKey = "";
  let autoScannedKey = "";
  const priceMap = new Map();   // id -> { ppu, base }
  let rankMap = new Map();      // id -> { rank, total } within its unit


  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  const NUM_SRC = "\\d{1,3}(?:[\\s.,]\\d{3})*(?:[.,]\\d{1,2})?";
  const CUR = "€|£|Kč|CZK|EUR|GBP";
  const PRICE_AFTER_RE = new RegExp("(" + NUM_SRC + ")\\s*(" + CUR + ")", "i");
  const PRICE_BEFORE_RE = new RegExp("(" + CUR + ")\\s*(" + NUM_SRC + ")", "i");
  const PER_UNIT_RE = new RegExp(
    "(?:(" + CUR + ")\\s*)?(" + NUM_SRC + ")\\s*(?:(" + CUR + ")\\s*)?\\/\\s*(kg|g|l|ml|cl|dl|kus(?:y|ů|ech)?|ks|pcs?)\\b",
    "i"
  );
  const QTY_RE = /(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|dl|l|kus(?:y|ů|ech)?|ks|pcs?)\b/i;
  const MULTI_RE = /(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|dl|l)\b/i;
  const PRICE_RE = new RegExp("(?:" + CUR + ")\\s*\\d|\\d(?:[\\s.,]?\\d)*\\s*(?:" + CUR + ")", "i");

  function normCur(c) {
    const u = (c || "").toUpperCase();
    if (u === "€" || u === "EUR") return "€";
    if (u === "£" || u === "GBP") return "£";
    if (u === "KČ" || u === "CZK") return "Kč";
    return c || "";
  }

  function parseNumber(raw) {
    if (!raw) return NaN;
    let s = String(raw).replace(/[\s ]/g, "");
    if (s.includes(",") && s.includes(".")) {
      if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
      else s = s.replace(/,/g, "");
    } else {
      s = s.replace(",", ".");
    }
    return parseFloat(s);
  }

  function normalizeUnit(amount, unit) {
    if (!isFinite(amount)) return null;
    const u = unit.toLowerCase();
    if (/^(kus|ks|pcs?|pc)/.test(u)) return { amount, base: "ks" };
    switch (u) {
      case "kg": return { amount, base: "kg" };
      case "g":  return { amount: amount / 1000, base: "kg" };
      case "l":  return { amount, base: "l" };
      case "dl": return { amount: amount / 10, base: "l" };
      case "cl": return { amount: amount / 100, base: "l" };
      case "ml": return { amount: amount / 1000, base: "l" };
      default:   return null;
    }
  }

  function canonicalBase(unit) {
    const u = unit.toLowerCase();
    if (/^(kus|ks|pcs?|pc)/.test(u)) return "ks";
    if (u === "g" || u === "kg") return "kg";
    return "l";
  }

  function extractDisplayedPerUnit(text) {
    const m = text.match(PER_UNIT_RE);
    if (!m) return null;
    const value = parseNumber(m[2]);
    if (!isFinite(value)) return null;
    return { value, currency: normCur(m[1] || m[3]), base: canonicalBase(m[4]) };
  }

  function extractPrice(text) {
    const after = text.match(PRICE_AFTER_RE);
    const before = text.match(PRICE_BEFORE_RE);
    const pick = after && before
      ? (after.index <= before.index ? { m: after, n: 1, c: 2 } : { m: before, n: 2, c: 1 })
      : after ? { m: after, n: 1, c: 2 }
      : before ? { m: before, n: 2, c: 1 }
      : null;
    if (!pick) return null;
    const value = parseNumber(pick.m[pick.n]);
    if (!isFinite(value)) return null;
    return { value, currency: normCur(pick.m[pick.c]) };
  }

  function stripPerUnit(text) {
    return text.replace(new RegExp(PER_UNIT_RE.source, "ig"), " ");
  }

  function extractQuantity(text) {
    const multi = text.match(MULTI_RE);
    if (multi) {
      const count = parseNumber(multi[1]);
      const n = normalizeUnit(parseNumber(multi[2]), multi[3]);
      if (n && isFinite(count)) return { amount: n.amount * count, base: n.base };
    }
    const m = text.match(QTY_RE);
    if (!m) return null;
    return normalizeUnit(parseNumber(m[1]), m[2]);
  }

  function getCardText(card) {
    let out = "";
    (function walk(node) {
      for (const ch of node.childNodes) {
        if (ch.nodeType === 1 && ch.classList && ch.classList.contains(BADGE_CLASS)) continue;
        if (ch.nodeType === 3) out += ch.nodeValue + " ";
        else if (ch.nodeType === 1) walk(ch);
      }
    })(card);
    return out;
  }

  function formatMoney(n) {
    if (!isFinite(n)) return "—";
    return n.toLocaleString("cs-CZ", {
      minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: 2
    });
  }

  function extractName(text) {
    let t = " " + text + " ";
    t = t.replace(new RegExp(PER_UNIT_RE.source, "ig"), " ");
    t = t.replace(new RegExp(NUM_SRC + "\\s*(?:" + CUR + ")", "ig"), " ");
    t = t.replace(new RegExp("(?:" + CUR + ")\\s*" + NUM_SRC, "ig"), " ");
    t = t.replace(/\d+(?:[.,]\d+)?\s*%\s*(?:alc)?/ig, " ");
    t = t.replace(/\d+(?:[.,]\d+)?\s*(kg|g|ml|cl|dl|l|kus(?:y|ů|ech)?|ks|pcs?)\b/ig, " ");
    t = t.replace(/\b18\+/g, " ");
    t = t.replace(/vyprod[aá]no|sold\s*out|\d*\s*zbýv\S*/ig, " ");
    t = t.replace(/\s{2,}/g, " ").replace(/^[\s,–-]+|[\s,–-]+$/g, "").trim();
    return t.slice(0, 80);
  }

  /** Stable id = name + unit + size (distinguishes 2 l vs 500 ml). */
  function extractItemId(text, base) {
    const name = extractName(text).toLowerCase().replace(/[\s.,]+/g, "-").slice(0, 60);
    const q = extractQuantity(text);
    const size = q ? `${q.amount}${q.base}` : "";
    return (name || "?") + "|" + (base || "") + "|" + size;
  }

  // ---------------------------------------------------------------------------
  // Card detection
  // ---------------------------------------------------------------------------

  function findCards() {
    const KNOWN = [
      '[data-test-id="horizontal-item-card"]',
      '[data-test-id="product-card"]',
      '[data-test-id*="ItemCard"]',
      '[data-test-id*="itemCard"]',
      '[data-testid*="ItemCard"]'
    ];
    for (const sel of KNOWN) {
      const found = Array.from(document.querySelectorAll(sel))
        .filter(el => !el.closest(`#${TOP_ID}`)); // never our own cloned cards
      if (found.length >= 3) return found;
    }
    const candidates = new Set();
    for (const el of document.querySelectorAll("div, a, li, article, section")) {
      if (el.childElementCount > 30) continue;
      if (el.closest(`#${TOP_ID}`)) continue; // never our own cloned cards
      const text = el.textContent;
      if (!text || text.length > 400) continue;
      if (PRICE_RE.test(text) && QTY_RE.test(text)) candidates.add(climbToCard(el));
    }
    return Array.from(candidates).filter(Boolean);
  }

  function climbToCard(el) {
    let node = el, best = el;
    for (let i = 0; i < 6 && node && node.parentElement; i++) {
      const parent = node.parentElement;
      const priceySibs = Array.from(parent.children).filter(s => PRICE_RE.test(s.textContent || ""));
      if (priceySibs.length >= 2 && node.textContent.length < 500) { best = node; break; }
      node = parent; best = node;
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Per-card processing — badge with value + medal/rank
  // ---------------------------------------------------------------------------

  function processCard(card) {
    const text = getCardText(card);
    let ppu = NO_UNIT_PPU, base = "", currency = "", value = "—";

    const priceObj = extractPrice(stripPerUnit(text));
    const displayed = extractDisplayedPerUnit(text);
    if (displayed) {
      ppu = displayed.value; base = displayed.base; currency = displayed.currency;
    } else {
      const qty = extractQuantity(text);
      if (priceObj && qty && qty.amount > 0) {
        ppu = priceObj.value / qty.amount; base = qty.base; currency = priceObj.currency || "";
      }
    }
    const hasUnit = ppu !== NO_UNIT_PPU;
    if (hasUnit) value = `${formatMoney(ppu)} ${currency}/${base}`.trim();

    const id = extractItemId(text, base);
    card.setAttribute(ATTR_PPU, String(ppu));
    card.setAttribute(ATTR_BASE, base);
    card.setAttribute(ATTR_CUR, currency);
    card.setAttribute(ATTR_ID, id);
    card.setAttribute(ATTR_NAME, extractName(text));

    // Top-left badge = RANK ONLY (medal for 1-3, "rank/total" otherwise). The
    // price-per-unit is shown once, at the card's bottom-right (recolored blue).
    let label = "", rankClass = 0;
    const r = hasUnit ? rankMap.get(id) : null;
    if (r) {
      if (r.rank <= 3) { label = `${MEDALS[r.rank]} ${r.rank}/${r.total}`; rankClass = r.rank; }
      else { label = `${r.rank}/${r.total}`; }
    }
    injectBadge(card, label, rankClass);
    setCardRing(card, r ? r.rank : 0);
    if (hasUnit) colorPerUnit(card);
    return ppu;
  }

  /** Recolor Wolt's own bottom-right per-unit text (e.g. "63,30 Kč/Kg") blue. */
  function colorPerUnit(card) {
    for (const el of card.querySelectorAll("*")) {
      if (el.children.length) continue; // leaf only
      const t = (el.textContent || "").trim();
      if (t && PER_UNIT_RE.test(t) && t.replace(new RegExp(PER_UNIT_RE.source, "i"), "").trim() === "") {
        el.classList.add("wups-pu");
      }
    }
  }

  /** Ring the card for the top-N: gold/silver/bronze (1-3), teal (4-N), none else. */
  function setCardRing(card, rank) {
    card.classList.remove(...RING_CLASSES);
    if (!rank || rank > HILITE_N) return;
    card.classList.add(
      rank === 1 ? "wups-top--gold" :
      rank === 2 ? "wups-top--silver" :
      rank === 3 ? "wups-top--bronze" : "wups-top--value"
    );
  }

  function removeRings() {
    document.querySelectorAll("." + RING_CLASSES.join(", .")).forEach(c => c.classList.remove(...RING_CLASSES));
  }

  function pickBadgeHost(card) {
    if (getComputedStyle(card).position !== "static") return card;
    const img = card.querySelector("img");
    let el = img ? img.parentElement : null;
    while (el && el !== card) {
      if (getComputedStyle(el).position !== "static") return el;
      el = el.parentElement;
    }
    for (const d of card.querySelectorAll("*")) {
      if (getComputedStyle(d).position !== "static") return d;
    }
    card.style.position = "relative";
    return card;
  }

  function injectBadge(card, label, rank) {
    let badge = card.querySelector(`.${BADGE_CLASS}`);
    if (!label) { if (badge) badge.remove(); return; } // no rank yet → no badge
    if (!badge) {
      badge = document.createElement("div");
      badge.className = BADGE_CLASS;
      pickBadgeHost(card).appendChild(badge);
    }
    badge.textContent = label;
    for (const r of [1, 2, 3]) badge.classList.toggle(`${BADGE_CLASS}--rank${r}`, rank === r);
  }

  function removeBadges() {
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach(b => b.remove());
    document.querySelectorAll(".wups-pu").forEach(e => e.classList.remove("wups-pu"));
  }


  // ---------------------------------------------------------------------------
  // Scan the whole (virtualized) category to learn the full ranking
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function getScroller() {
    const cards = findCards();
    let el = cards[0] ? cards[0].parentElement : null;
    while (el && el !== document.body) {
      const oy = getComputedStyle(el).overflowY;
      if (/(auto|scroll|overlay)/.test(oy) && el.scrollHeight > el.clientHeight + 40) return el;
      el = el.parentElement;
    }
    return null;
  }

  function scState(sc) {
    if (sc) return { top: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight, vh: sc.clientHeight };
    const de = document.documentElement;
    return { top: window.scrollY, max: de.scrollHeight - window.innerHeight, vh: window.innerHeight };
  }
  function scTo(sc, y) { if (sc) sc.scrollTop = y; else window.scrollTo(0, y); }

  function collectVisible(sc) {
    const top = scState(sc).top;
    for (const card of findCards()) {
      processCard(card);
      const id = card.getAttribute(ATTR_ID);
      const base = card.getAttribute(ATTR_BASE) || "";
      const ppu = parseFloat(card.getAttribute(ATTR_PPU));
      if (id && base && isFinite(ppu) && !priceMap.has(id)) {
        priceMap.set(id, {
          id, ppu, base, currency: card.getAttribute(ATTR_CUR) || "",
          name: card.getAttribute(ATTR_NAME) || "",
          html: card.outerHTML, scrollTop: top
        });
      }
    }
  }

  async function scanCategory(onProgress) {
    const sc = getScroller();
    scTo(sc, 0);
    await sleep(250);
    let stable = 0, lastSize = -1;
    for (let i = 0; i < 120 && stable < 3; i++) {
      collectVisible(sc);
      if (onProgress) onProgress(priceMap.size);
      const st = scState(sc);
      if (priceMap.size === lastSize) stable++; else { stable = 0; lastSize = priceMap.size; }
      if (st.top >= st.max - 2) { await sleep(200); collectVisible(sc); break; }
      scTo(sc, st.top + st.vh * 0.8);
      await sleep(220);
    }
    return sc;
  }

  /** Rank every item within its unit: id -> { rank, total }. */
  function buildRanks() {
    rankMap = new Map();
    const byUnit = new Map();
    for (const [id, v] of priceMap) {
      if (!v.base || !isFinite(v.ppu)) continue;
      if (!byUnit.has(v.base)) byUnit.set(v.base, []);
      byUnit.get(v.base).push([id, v.ppu]);
    }
    for (const arr of byUnit.values()) {
      arr.sort((a, b) => a[1] - b[1]);
      arr.forEach(([id], i) => rankMap.set(id, { rank: i + 1, total: arr.length }));
    }
  }

  function showStatus(text) {
    let s = document.getElementById(STATUS_ID);
    if (!s) { s = document.createElement("div"); s.id = STATUS_ID; document.body.appendChild(s); }
    s.textContent = text;
  }
  function hideStatus() { const s = document.getElementById(STATUS_ID); if (s) s.remove(); }

  async function runScan() {
    if (!enabled || scanning) return;
    scanning = true;
    showStatus("Ranking prices…");
    try {
      const sc = await scanCategory(n => showStatus(`Ranking prices… ${n}`));
      buildRanks();
      hasScanned = true;
      scTo(sc, 0);
      findCards().forEach(processCard); // apply ranks to what's on screen
      buildMedalists();                 // 🥇🥈🥉 quick-jump (bar or top strip)
    } finally {
      scanning = false;
      hideStatus();
    }
  }

  // ---------------------------------------------------------------------------
  // Medalist quick-jump bar (scrolls you to the item)
  // ---------------------------------------------------------------------------

  function dominantBase() {
    const counts = new Map();
    for (const v of priceMap.values()) counts.set(v.base, (counts.get(v.base) || 0) + 1);
    let best = "", max = 0;
    for (const [b, n] of counts) if (n > max) { max = n; best = b; }
    return best;
  }

  /** The cheapest N of the category's main unit (+ that unit's total count). */
  function topItems(n) {
    const base = dominantBase();
    const all = Array.from(priceMap.values())
      .filter(v => v.base === base)
      .sort((a, b) => a.ppu - b.ppu);
    return { base, items: all.slice(0, n), total: all.length };
  }

  /**
   * Cheapest N per UNIT type. Returns one group per unit (kg / l / ks …),
   * dominant unit first, each with its own top-N and total count. Single-item
   * units are dropped (no ranking to show) unless that leaves nothing.
   */
  function topGroups(n) {
    const byBase = new Map();
    for (const v of priceMap.values()) {
      if (!v.base || !isFinite(v.ppu)) continue;
      if (!byBase.has(v.base)) byBase.set(v.base, []);
      byBase.get(v.base).push(v);
    }
    const groups = [];
    for (const [base, arr] of byBase) {
      arr.sort((a, b) => a.ppu - b.ppu);
      groups.push({ base, items: arr.slice(0, n), total: arr.length });
    }
    groups.sort((a, b) => b.total - a.total); // dominant unit first
    const multi = groups.filter(g => g.total >= 2);
    return multi.length ? multi : groups;
  }

  /**
   * Open the item's product modal by clicking its REAL, live card (so Wolt
   * shows the modal over the current category). The item may be virtualized
   * away, so we scroll to its scanned position and retry until it mounts.
   */
  async function openItem(it) {
    if (opening) return;
    opening = true; // suppress refresh/rebuild so the strip doesn't flicker
    try {
      const sc = getScroller();
      // The REAL, live product card (NOT our clone in the strip, which shares
      // the id but has no click handler). We tag newly-mounted cards first,
      // since refresh is suppressed while opening.
      const lookup = () => {
        findCards().forEach(processCard); // assign data-wups-id to fresh cards
        return Array.from(document.querySelectorAll(`[${ATTR_ID}]`))
          .find(c => c.getAttribute(ATTR_ID) === it.id &&
                     c.offsetParent !== null && !c.closest(`#${TOP_ID}`));
      };

      // Find it by scanning from the TOP downward (the item can be anywhere,
      // and the saved offset drifts once the strip is added). Stop as soon as
      // it mounts — so we never overshoot to the bottom.
      let card = lookup();
      if (!card) { scTo(sc, 0); await sleep(250); card = lookup(); }
      for (let i = 0; !card && i < 60; i++) {
        const st = scState(sc);
        if (st.top >= st.max - 2) break; // reached the bottom
        scTo(sc, st.top + st.vh * 0.7);
        await sleep(180);
        card = lookup();
      }
      if (!card) return;

      card.scrollIntoView({ block: "center" });
      await sleep(150);
      card.classList.add("wups-flash");
      setTimeout(() => card.classList.remove("wups-flash"), 3300);

      // Click the card's content area (first inner div), NOT the stepper (+/-
      // add button). Clicking it bubbles to the <li>'s open handler → modal.
      const STEPPER = '[data-test-id="ItemCardStepperContainer"]';
      const content = Array.from(card.children).find(el =>
        el.nodeType === 1 && !el.matches(STEPPER) && !el.classList.contains(BADGE_CLASS));
      fireRealClick(content || card);
    } finally {
      setTimeout(() => { opening = false; }, 600);
    }
  }

  function fireRealClick(el) {
    const o = { bubbles: true, cancelable: true, view: window, button: 0 };
    try { el.dispatchEvent(new PointerEvent("pointerover", o)); } catch (e) {}
    try { el.dispatchEvent(new PointerEvent("pointerdown", o)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mousedown", o));
    try { el.dispatchEvent(new PointerEvent("pointerup", o)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.dispatchEvent(new MouseEvent("click", o));
  }

  /**
   * A real-card clone whose badge + ring reflect its rank IN THE TOP-8 (not
   * whatever the cloned card happened to show at scan time): 1=🥇 gold,
   * 2=🥈 silver, 3=🥉 bronze, 4-8=blue. Click opens the product modal.
   */
  function makeCloneCard(it, i, total) {
    const wrap = document.createElement("div");
    wrap.className = "wups-clone";
    wrap.innerHTML = it.html || "";

    // Remove the clone's own badge(s) and ring artifacts entirely, then add a
    // single fresh RANK-ONLY badge we control (price stays bottom-right, blue).
    wrap.querySelectorAll(`.${BADGE_CLASS}`).forEach(b => b.remove());
    wrap.querySelectorAll("." + RING_CLASSES.join(",.")).forEach(el => el.classList.remove(...RING_CLASSES));

    const badge = document.createElement("div");
    badge.className = BADGE_CLASS + (i < 3 ? ` ${BADGE_CLASS}--rank${i + 1}` : "");
    badge.textContent = i < 3 ? `${MEDALS[i + 1]} ${i + 1}/${total}` : `${i + 1}/${total}`;
    wrap.appendChild(badge);

    // Ring by position: gold / silver / bronze / blue.
    wrap.classList.add(
      i === 0 ? "wups-top--gold" : i === 1 ? "wups-top--silver" :
      i === 2 ? "wups-top--bronze" : "wups-top--value"
    );

    wrap.title = "Open this item";
    wrap.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openItem(it); });
    return wrap;
  }

  /**
   * The section wrapper that clips its content (Wolt's ExpandableWrapper has a
   * computed max-height). We insert our strip BEFORE it, so the added height
   * doesn't push the grid past that max-height and clip the last row.
   */
  function findSectionWrapper(grid) {
    let el = grid;
    for (let i = 0; i < 6 && el && el.parentElement; i++) {
      const tid = (el.getAttribute && el.getAttribute("data-test-id")) || "";
      const cs = getComputedStyle(el);
      if (/ExpandableWrapper/i.test(tid) || cs.overflow === "hidden" ||
          (cs.maxHeight && cs.maxHeight !== "none")) {
        return el;
      }
      el = el.parentElement;
    }
    return grid.parentElement;
  }

  /** The ancestor holding the most cards = the product grid. */
  function getGridContainer(cards) {
    const byA = new Map();
    for (const card of cards) {
      let child = card, a = card.parentElement, depth = 0;
      while (a && a !== document.body && depth < 8) {
        let s = byA.get(a); if (!s) { s = new Set(); byA.set(a, s); }
        s.add(child); child = a; a = a.parentElement; depth++;
      }
    }
    let best = null, max = 0;
    for (const [a, s] of byA) if (s.size > max) { max = s.size; best = a; }
    return max >= 2 ? best : null;
  }

  /**
   * True only if the page TITLE (the short header block directly above the
   * grid) is an "All items" label. We walk up the grid's own ancestor chain and
   * inspect its previous siblings, skipping long blocks like the sidebar — so
   * the sidebar's "Všechny položky" menu item never triggers it.
   */
  function isAllItemsPage(grid) {
    if (!grid) return false;
    let node = grid;
    for (let up = 0; up < 8 && node; up++) {
      let sib = node.previousElementSibling;
      while (sib) {
        const whole = (sib.textContent || "").trim();
        if (whole && whole.length < 120) { // a header block, not the sidebar
          if (ALL_ITEMS_TITLES.has(whole.toLowerCase())) return true;
          for (const el of sib.querySelectorAll("*")) {
            if (ALL_ITEMS_TITLES.has((el.textContent || "").trim().toLowerCase())) return true;
          }
        }
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return false;
  }

  function removeMedalists() {
    const b = document.getElementById(TOP_ID); if (b) b.remove();
  }

  function removeHint() {
    const h = document.getElementById(HINT_ID); if (h) h.remove();
  }

  /** On the mixed "All items" view we can't rank by unit, so show a tip telling
   *  the user to pick a specific category. */
  function showHint() {
    if (document.getElementById(HINT_ID)) return;
    const grid = getGridContainer(findCards());
    if (!grid) return;
    const anchor = findSectionWrapper(grid);
    if (!anchor || !anchor.parentNode) return;

    const hint = document.createElement("div");
    hint.id = HINT_ID;
    hint.innerHTML =
      `<span class="wups-hint-ico">💡</span>` +
      `<span>Open a specific product <b>category</b> to rank items by best price / value.</span>`;
    anchor.parentNode.insertBefore(hint, anchor);
  }

  /** Match our row's columns to Wolt's current grid (so it follows resizes). */
  function applyTopColumns(row) {
    const grid = getGridContainer(findCards());
    const gs = grid && getComputedStyle(grid);
    if (gs && gs.display.includes("grid") && gs.gridTemplateColumns && gs.gridTemplateColumns !== "none") {
      row.style.gridTemplateColumns = gs.gridTemplateColumns;
      if (gs.columnGap && gs.columnGap !== "normal") { row.style.columnGap = gs.columnGap; row.style.rowGap = gs.columnGap; }
    } else {
      row.style.gridTemplateColumns = `repeat(${Math.min(4, row.children.length || 4)}, minmax(0, 1fr))`;
    }
  }

  /** Re-sync the strip's columns to Wolt's grid (called on window resize). */
  function syncTopColumns() {
    const strip = document.getElementById(TOP_ID);
    if (!strip) return;
    strip.querySelectorAll(".wups-top-grid").forEach(applyTopColumns);
  }

  /** Show the Top-N cheapest as cloned real cards above the list — one section
   *  per unit type when the category mixes kg / l / ks. */
  function buildMedalists() {
    removeMedalists();
    const groups = topGroups(topN);
    if (!groups.length || !groups.some(g => g.items.length)) return;
    const grid = getGridContainer(findCards());
    if (!grid) return;
    // Insert above the clipping section wrapper so the last row isn't cut off.
    const anchor = findSectionWrapper(grid);
    if (!anchor || !anchor.parentNode) return;

    const strip = document.createElement("div");
    strip.id = TOP_ID;
    const multi = groups.length > 1;

    groups.forEach((g) => {
      const head = document.createElement("div");
      head.className = "wups-top-head";
      const label = UNIT_LABEL[g.base] || (g.base ? `per ${g.base}` : "");
      head.textContent = multi
        ? `🏆 Top ${g.items.length} best value · ${label}`
        : `🏆 Top ${g.items.length} best value`;
      strip.appendChild(head);

      const row = document.createElement("div");
      row.className = "wups-top-grid";
      g.items.forEach((it, i) => row.appendChild(makeCloneCard(it, i, g.total)));
      // Align to Wolt's real grid columns + gap so our cards line up exactly with
      // the list below, and follow Wolt's responsive column count (4 → 3 → …).
      applyTopColumns(row);
      strip.appendChild(row);
    });

    anchor.parentNode.insertBefore(strip, anchor);
  }

  // ---------------------------------------------------------------------------
  // Refresh + observer
  // ---------------------------------------------------------------------------

  function refresh() {
    if (!enabled || scanning || opening) return;
    const path = location.pathname;

    // A product modal (URL contains "itemid") is open OVER the category — keep
    // all our state so closing it doesn't wipe the ranking.
    if (/itemid/i.test(path)) return;

    // Not a category listing → tear down and forget everything.
    if (!path.includes("/items/")) {
      removeBadges(); removeRings(); removeMedalists(); removeHint(); hideStatus();
      catKey = ""; priceMap.clear(); rankMap = new Map();
      hasScanned = false; autoScannedKey = "";
      return;
    }

    // A genuinely different category → reset and re-scan.
    if (path !== catKey) {
      catKey = path;
      priceMap.clear();
      rankMap = new Map();
      hasScanned = false;
      removeMedalists();
    }

    const cards = findCards();
    if (cards.length < 2) return;

    // Skip the mixed "All items" view — don't scan/scroll or badge it; instead
    // nudge the user to open a specific category where ranking makes sense.
    if (isAllItemsPage(getGridContainer(cards))) {
      removeBadges(); removeRings(); removeMedalists();
      showHint();
      autoScannedKey = catKey; // don't auto-scan this view
      return;
    }
    removeHint();

    cards.forEach(processCard); // re-applies medals/ranks from rankMap as cards mount

    if (!hasScanned && autoScannedKey !== catKey) {
      autoScannedKey = catKey;
      runScan();
    } else if (hasScanned && !document.getElementById(TOP_ID)) {
      buildMedalists(); // re-inject the top cards if Wolt removed them
    }
  }

  function scheduleRefresh() {
    if (!enabled || scanning || opening) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(refresh, REFRESH_IDLE_MS);
  }

  function isOwnNode(n) {
    return (n.classList && n.classList.contains(BADGE_CLASS)) ||
           n.id === STATUS_ID || n.id === TOP_ID || n.id === HINT_ID;
  }

  let resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(syncTopColumns, 120);
  }

  function startObserver() {
    if (observer) return;
    window.addEventListener("resize", onResize);
    observer = new MutationObserver((mutations) => {
      if (scanning || opening) return;
      const meaningful = mutations.some(m =>
        m.type === "childList" && m.addedNodes.length > 0 &&
        Array.from(m.addedNodes).some(n => n.nodeType === 1 && !isOwnNode(n))
      );
      if (meaningful) scheduleRefresh();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    window.removeEventListener("resize", onResize);
    clearTimeout(idleTimer);
    clearTimeout(resizeTimer);
    idleTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function enable() { enabled = true; startObserver(); refresh(); }

  function disable() {
    enabled = false;
    stopObserver();
    removeBadges();
    removeRings();
    removeMedalists();
    removeHint();
    hideStatus();
    priceMap.clear();
    rankMap = new Map();
    hasScanned = false;
    autoScannedKey = "";
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("enabled" in changes) {
      changes.enabled.newValue ? enable() : disable();
      return;
    }
    if ("topN" in changes) {
      const n = parseInt(changes.topN.newValue, 10);
      topN = TOP_N_CHOICES.includes(n) ? n : 8;
      if (enabled && hasScanned) buildMedalists(); // rebuild with new count
    }
  });

  chrome.storage.local.get({ enabled: true, topN: 8 }, (cfg) => {
    enabled = cfg.enabled !== false;
    const n = parseInt(cfg.topN, 10);
    topN = TOP_N_CHOICES.includes(n) ? n : 8;
    if (enabled) enable();
  });
})();
