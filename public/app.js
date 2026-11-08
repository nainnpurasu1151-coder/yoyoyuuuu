// LINE Tube - LIFFフロントエンド
// LINEアプリ内ブラウザ(LIFF)の中で、検索〜再生まで完結させる。
(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const state = {
    liffId: "",
    tab: "home",
    query: "",
    items: [],
    nextPageToken: null,
    current: null,
    player: null,
    playerReady: null,
  };

  // ---------- storage ----------
  const store = {
    get(k, d) {
      try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
    },
  };
  const favs = () => store.get("favs", []);
  const history = () => store.get("history", []);
  const slim = (v) => ({ id: v.id, title: v.title, channel: v.channel, thumbnail: v.thumbnail, duration: v.duration, views: v.views, publishedAt: v.publishedAt });

  // ---------- format ----------
  function fmtDuration(iso) {
    const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
    if (!m) return "";
    const [h, mi, s] = [m[1], m[2], m[3]].map((x) => +x || 0);
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(mi)}:${pad(s)}` : `${mi}:${pad(s)}`;
  }
  function fmtViews(n) {
    if (n == null) return "";
    n = +n;
    if (n >= 1e8) return `${(n / 1e8).toFixed(1).replace(/\.0$/, "")}億回`;
    if (n >= 1e4) return `${(n / 1e4).toFixed(1).replace(/\.0$/, "")}万回`;
    return `${n}回`;
  }
  function fmtAgo(iso) {
    if (!iso) return "";
    const sec = (Date.now() - new Date(iso)) / 1000;
    const units = [[31536000, "年"], [2592000, "か月"], [604800, "週間"], [86400, "日"], [3600, "時間"], [60, "分"]];
    for (const [u, l] of units) if (sec >= u) return `${Math.floor(sec / u)}${l}前`;
    return "たった今";
  }
  // YouTube APIのタイトルはHTMLエスケープ済みなので一度デコードする
  function decode(s) {
    const t = document.createElement("textarea");
    t.innerHTML = s || "";
    return t.value;
  }
  const metaLine = (v) => [v.channel, fmtViews(v.views), fmtAgo(v.publishedAt)].filter(Boolean).join(" ・ ");

  // ---------- api ----------
  async function api(path) {
    const res = await fetch(path);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  // ---------- list ----------
  function render() {
    const list = $("#list");
    list.textContent = "";
    for (const v of state.items) {
      const li = document.createElement("li");
      li.className = "item" + (state.current?.id === v.id ? " playing" : "");
      li.dataset.id = v.id;

      const thumb = document.createElement("div");
      thumb.className = "thumb";
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = "";
      img.src = v.thumbnail || "";
      thumb.append(img);
      const d = fmtDuration(v.duration);
      if (d) {
        const span = document.createElement("span");
        span.className = "dur";
        span.textContent = d;
        thumb.append(span);
      }

      const info = document.createElement("div");
      info.className = "info";
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = decode(v.title);
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = metaLine(v);
      info.append(title, meta);

      li.append(thumb, info);
      li.addEventListener("click", () => play(v));
      list.append(li);
    }
    $("#more").hidden = !state.nextPageToken;
  }

  function setStatus(t) { $("#status").textContent = t; }

  async function load({ append = false } = {}) {
    const tab = state.tab;
    if (tab === "favs" || tab === "history") {
      state.items = tab === "favs" ? favs() : history();
      state.nextPageToken = null;
      render();
      setStatus(state.items.length ? "" : tab === "favs" ? "☆ でお気に入りに追加できます" : "まだ再生履歴はありません");
      return;
    }
    if (tab === "search" && !state.query) {
      state.items = [];
      state.nextPageToken = null;
      render();
      setStatus("キーワードを入力して検索");
      $("#q").focus();
      return;
    }

    setStatus("読み込み中…");
    if (!append) { state.items = []; render(); }
    try {
      const params = new URLSearchParams();
      if (tab === "search") params.set("q", state.query);
      if (append && state.nextPageToken) params.set("pageToken", state.nextPageToken);
      const data = await api(`/api/search?${params}`);
      if (tab !== state.tab) return; // タブ切り替え済み
      const seen = new Set(state.items.map((i) => i.id));
      state.items = append ? state.items.concat(data.items.filter((i) => !seen.has(i.id))) : data.items;
      state.nextPageToken = data.nextPageToken;
      render();
      setStatus(state.items.length ? "" : "動画が見つかりませんでした");
    } catch (e) {
      setStatus(`エラー: ${e.message}`);
    }
  }

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    load();
  }

  // ---------- player (YouTube IFrame Player API) ----------
  function ensurePlayer() {
    if (state.playerReady) return state.playerReady;
    state.playerReady = new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = () => {
        state.player = new YT.Player("player", {
          playerVars: {
            playsinline: 1,     // iOSでも全画面に飛ばずLINE内のページで再生
            rel: 0,
            modestbranding: 1,
            fs: 1,
          },
          events: {
            onReady: () => resolve(state.player),
            onStateChange: (e) => { if (e.data === YT.PlayerState.ENDED) playNext(); },
            onError: () => { setTimeout(playNext, 1500); },
          },
        });
      };
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      document.head.append(s);
    });
    return state.playerReady;
  }

  async function play(v) {
    state.current = v;
    $("#player-wrap").hidden = false;
    $("#now-title").textContent = decode(v.title);
    $("#now-meta").textContent = metaLine(v);
    updateFav();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });

    // 履歴に追加 (先頭・最大100件)
    store.set("history", [slim(v), ...history().filter((h) => h.id !== v.id)].slice(0, 100));

    const p = await ensurePlayer();
    p.loadVideoById(v.id);
  }

  function playNext() {
    if (!$("#autoplay").checked || !state.current) return;
    const i = state.items.findIndex((x) => x.id === state.current.id);
    const next = state.items[i + 1];
    if (next) play(next);
  }

  function closePlayer() {
    state.player?.stopVideo?.();
    state.current = null;
    $("#player-wrap").hidden = true;
    render();
  }

  // ---------- favorites / share ----------
  function updateFav() {
    const on = !!state.current && favs().some((f) => f.id === state.current.id);
    const b = $("#btn-fav");
    b.textContent = on ? "★" : "☆";
    b.classList.toggle("on", on);
  }
  function toggleFav() {
    const v = state.current;
    if (!v) return;
    const list = favs();
    const exists = list.some((f) => f.id === v.id);
    store.set("favs", exists ? list.filter((f) => f.id !== v.id) : [slim(v), ...list]);
    updateFav();
    if (state.tab === "favs") load();
  }

  // トークに動画を送る。リンク先は LIFF URL なので、受け取った人もLINE内で再生される。
  async function share() {
    const v = state.current;
    if (!v || !state.liffId) return;
    const url = `https://liff.line.me/${state.liffId}?v=${v.id}`;
    const msg = {
      type: "flex",
      altText: decode(v.title),
      contents: {
        type: "bubble",
        size: "kilo",
        hero: { type: "image", url: v.thumbnail, size: "full", aspectRatio: "16:9", aspectMode: "cover", action: { type: "uri", uri: url } },
        body: {
          type: "box", layout: "vertical", spacing: "sm",
          contents: [
            { type: "text", text: decode(v.title) || "(無題)", weight: "bold", size: "sm", wrap: true, maxLines: 2 },
            { type: "text", text: v.channel || "", size: "xs", color: "#888888" },
          ],
        },
        footer: {
          type: "box", layout: "vertical",
          contents: [{ type: "button", style: "primary", color: "#FF0033", height: "sm", action: { type: "uri", label: "▶ LINEで再生", uri: url } }],
        },
      },
    };
    try {
      if (liff.isApiAvailable("shareTargetPicker")) {
        await liff.shareTargetPicker([msg]);
      } else {
        alert("この環境ではトークへの共有が使えません");
      }
    } catch (e) {
      alert(`共有に失敗しました: ${e.message}`);
    }
  }

  // ---------- init ----------
  async function main() {
    const { liffId } = await api("/api/config").catch(() => ({ liffId: "" }));
    state.liffId = liffId;

    const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    if (liffId && window.liff) {
      try {
        await liff.init({ liffId });
      } catch (e) {
        console.error(e);
      }
    }

    // LINEアプリの外 (普通のブラウザ) で開かれたらLINEへ誘導する。ローカル開発時は許可。
    const inLine = window.liff && liff.isInClient && liff.isInClient();
    if (!inLine && !isLocal) {
      $("#gate").hidden = false;
      $("#gate-link").href = liffId ? `https://liff.line.me/${liffId}${location.search}` : "#";
      return;
    }
    $("#app").hidden = false;

    // events
    $("#search-form").addEventListener("submit", (e) => {
      e.preventDefault();
      state.query = $("#q").value.trim();
      $("#q").blur();
      switchTab("search");
    });
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
    $("#more").addEventListener("click", () => load({ append: true }));
    $("#btn-close").addEventListener("click", closePlayer);
    $("#btn-fav").addEventListener("click", toggleFav);
    $("#btn-share").addEventListener("click", share);
    $("#btn-share").hidden = !state.liffId;
    $("#autoplay").checked = store.get("autoplay", true);
    $("#autoplay").addEventListener("change", (e) => store.set("autoplay", e.target.checked));

    // 共有リンク / Botから ?v=動画ID で開かれた場合はすぐ再生
    const params = new URLSearchParams(location.search);
    const vid = params.get("v");
    const q = params.get("q");
    if (q) { state.query = q; $("#q").value = q; switchTab("search"); } else { switchTab("home"); }
    if (vid && /^[\w-]{11}$/.test(vid)) {
      try {
        const { items } = await api(`/api/videos?ids=${vid}`);
        if (items[0]) play(items[0]);
      } catch (e) {
        setStatus(`エラー: ${e.message}`);
      }
    }
  }

  main();
})();
