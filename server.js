// LINEの中だけで動くYouTubeアプリ - サーバー
//  - /api/search, /api/videos : YouTube Data API v3 のプロキシ (APIキーをブラウザに出さない)
//  - /api/config              : フロントに LIFF ID を渡す
//  - /webhook                 : Messaging API。トークに送ったキーワードで検索し、
//                               Flexメッセージで結果を返す (タップでLIFF内再生)
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- .env の簡易読み込み (依存を増やさないため) ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const {
  YOUTUBE_API_KEY,
  LIFF_ID,
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  PORT = 3000,
} = process.env;

if (!YOUTUBE_API_KEY) console.warn("[warn] YOUTUBE_API_KEY が未設定です");
if (!LIFF_ID) console.warn("[warn] LIFF_ID が未設定です");

const YT = "https://www.googleapis.com/youtube/v3";
const app = express();

// ---------- YouTube API ----------
const cache = new Map(); // 簡易キャッシュ (クォータ節約)
const CACHE_MS = 10 * 60 * 1000;

async function yt(endpoint, params) {
  const url = new URL(`${YT}/${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, key: YOUTUBE_API_KEY })) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  const cacheKey = url.toString();
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.data;

  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    throw Object.assign(new Error(msg), { status: res.status });
  }
  cache.set(cacheKey, { t: Date.now(), data });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return data;
}

function toItem(v) {
  const id = typeof v.id === "string" ? v.id : v.id?.videoId;
  const s = v.snippet || {};
  return {
    id,
    title: s.title,
    channel: s.channelTitle,
    channelId: s.channelId,
    publishedAt: s.publishedAt,
    thumbnail: s.thumbnails?.medium?.url || s.thumbnails?.default?.url,
    duration: v.contentDetails?.duration,
    views: v.statistics?.viewCount,
    description: s.description,
  };
}

async function searchVideos(q, pageToken) {
  const data = await yt("search", {
    part: "snippet",
    type: "video",
    videoEmbeddable: "true", // 埋め込み可能な動画だけ = LINE内で再生できる動画だけ
    maxResults: 20,
    regionCode: "JP",
    relevanceLanguage: "ja",
    q,
    pageToken,
  });
  const ids = data.items.map((i) => i.id.videoId).filter(Boolean);
  const details = ids.length ? await getVideos(ids) : [];
  return { items: details, nextPageToken: data.nextPageToken || null };
}

async function getVideos(ids) {
  const data = await yt("videos", {
    part: "snippet,contentDetails,statistics",
    id: ids.join(","),
  });
  return data.items.map(toItem);
}

async function popular(pageToken) {
  const data = await yt("videos", {
    part: "snippet,contentDetails,statistics",
    chart: "mostPopular",
    regionCode: "JP",
    maxResults: 20,
    pageToken,
  });
  return { items: data.items.map(toItem), nextPageToken: data.nextPageToken || null };
}

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message });
  }
};

app.get("/api/config", (_req, res) => res.json({ liffId: LIFF_ID || "" }));

app.get(
  "/api/search",
  wrap((req) => {
    const q = String(req.query.q || "").slice(0, 100);
    return q ? searchVideos(q, req.query.pageToken) : popular(req.query.pageToken);
  })
);

app.get(
  "/api/videos",
  wrap(async (req) => {
    const ids = String(req.query.ids || "")
      .split(",")
      .filter((s) => /^[\w-]{11}$/.test(s))
      .slice(0, 50);
    return { items: ids.length ? await getVideos(ids) : [] };
  })
);

// ---------- LINE Messaging API (任意) ----------
app.post("/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  if (!LINE_CHANNEL_SECRET || !LINE_CHANNEL_ACCESS_TOKEN) return res.sendStatus(404);

  const sig = crypto.createHmac("sha256", LINE_CHANNEL_SECRET).update(req.body).digest("base64");
  const given = req.get("x-line-signature") || "";
  if (sig.length !== given.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(given))) {
    return res.sendStatus(401);
  }
  res.sendStatus(200);

  const { events = [] } = JSON.parse(req.body.toString("utf8"));
  for (const ev of events) {
    if (ev.type !== "message" || ev.message.type !== "text" || !ev.replyToken) continue;
    try {
      await reply(ev.replyToken, await buildReply(ev.message.text.trim()));
    } catch (e) {
      console.error(e);
      await reply(ev.replyToken, [{ type: "text", text: "検索中にエラーが発生しました🙏" }]).catch(() => {});
    }
  }
});

const liffUrl = (query = "") => `https://liff.line.me/${LIFF_ID}${query}`;

async function buildReply(text) {
  if (!text || /^(ヘルプ|help|使い方)$/i.test(text)) {
    return [
      {
        type: "text",
        text: "見たい動画のキーワードを送ってね🎬\nタップするとLINEの中でそのまま再生できます。",
        quickReply: {
          items: [
            { type: "action", action: { type: "uri", label: "アプリを開く", uri: liffUrl() } },
          ],
        },
      },
    ];
  }

  const { items } = await searchVideos(text);
  if (!items.length) return [{ type: "text", text: `「${text}」の動画が見つかりませんでした` }];

  const bubbles = items.slice(0, 10).map((v) => ({
    type: "bubble",
    size: "kilo",
    hero: {
      type: "image",
      url: v.thumbnail,
      size: "full",
      aspectRatio: "16:9",
      aspectMode: "cover",
      action: { type: "uri", uri: liffUrl(`?v=${v.id}`) },
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "text", text: v.title || "(無題)", weight: "bold", size: "sm", wrap: true, maxLines: 2 },
        { type: "text", text: v.channel || "", size: "xs", color: "#888888", wrap: true, maxLines: 1 },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "button",
          style: "primary",
          color: "#FF0033",
          height: "sm",
          action: { type: "uri", label: "▶ LINEで再生", uri: liffUrl(`?v=${v.id}`) },
        },
      ],
    },
  }));

  return [
    {
      type: "flex",
      altText: `「${text}」の検索結果`,
      contents: { type: "carousel", contents: bubbles },
    },
  ];
}

async function reply(replyToken, messages) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) throw new Error(`LINE reply failed: ${res.status} ${await res.text()}`);
}

// ---------- 静的ファイル (LIFF本体) ----------
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`));
