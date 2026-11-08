# LINE Tube 🎬 — LINEの中だけで動くYouTubeアプリ

LINEの **LIFF (LINE Front-end Framework)** で動くYouTubeプレイヤーです。
検索から再生まですべてLINEアプリの中で完結し、Safari、Chrome、YouTubeアプリには切り替わりません。

## できること

| 機能 | 説明 |
| --- | --- |
| 急上昇 | 日本の急上昇動画を表示します |
| 検索 | キーワードで動画を検索します。埋め込み可能な動画、つまりLINE内で再生できる動画だけを表示します |
| 再生 | YouTube公式のIFrameプレイヤーで再生します。`playsinline` を指定しているので、iPhoneでもLINEの画面の中で再生されます |
| 連続再生 | 動画が終わると、リストの次の動画を自動で再生します |
| お気に入り・履歴 | 端末内 (localStorage) に保存します |
| トークに送る | `shareTargetPicker` で友だちやグループに動画カードを送ります。送られた側もタップするとLINE内で再生されます |
| Bot検索 (任意) | 公式アカウントのトークにキーワードを送ると、検索結果をカルーセルで返します |

普通のブラウザでURLを開いた場合は「LINEで開く」画面を表示します。`localhost` だけは開発用に例外にしています。

## 仕組み

```
LINEアプリ
 ├─ トーク ── キーワード ──▶ /webhook ──▶ YouTube Data API
 │            ◀── Flexカルーセル (https://liff.line.me/<LIFF_ID>?v=動画ID)
 └─ LIFF (LINE内ブラウザ)
      public/index.html ──▶ /api/search, /api/videos ──▶ YouTube Data API
      └─ YouTube IFrame Player で再生
```

YouTube APIキーはサーバー (`server.js`) だけが持つので、ブラウザ側には渡りません。

## セットアップ

### 1. YouTube Data API キー
1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成する
2. 「YouTube Data API v3」を有効にする
3. 「認証情報」からAPIキーを作成する

### 2. サーバーを公開する
LIFFにはHTTPSのURLが必要です。Render、Railway、Fly.io、Cloud Runなどにデプロイしてください。
ローカルで試す場合は `ngrok http 3000` などを使います。

```bash
cp .env.example .env   # 値を記入
npm install
npm start
```

### 3. LIFFアプリを作る
1. [LINE Developers](https://developers.line.biz/console/) で **LINEログイン** チャネルを作成する
2. 「LIFF」タブでLIFFアプリを追加する
   - サイズ: **Full**
   - エンドポイントURL: `https://<あなたのドメイン>/`
   - Scope: `profile`、`chat_message.write` (トークへの共有に使います)
   - 「Share Target Picker」をONにする
3. 発行された **LIFF ID** を `.env` の `LIFF_ID` に設定する

これで `https://liff.line.me/<LIFF_ID>` をLINEのトークに貼ってタップすると、アプリがLINEの中で開きます。

### 4. (任意) トークで検索できるBot
1. **Messaging API** チャネルを作成する。LIFFと同じプロバイダーにしてください
2. Webhook URL に `https://<あなたのドメイン>/webhook` を設定し、「Webhookの利用」をONにする
3. 「応答メッセージ」はOFFにする
4. チャネルシークレットとチャネルアクセストークンを `.env` に設定する
5. リッチメニューに `https://liff.line.me/<LIFF_ID>` を設定すると、ワンタップでアプリを開けます

## URLパラメータ
- `?v=動画ID` … その動画をすぐ再生します
- `?q=キーワード` … そのキーワードで検索した状態で開きます

## 注意
- 再生にはYouTube公式の埋め込みプレイヤーを使っています。広告の除去や動画のダウンロードなど、[YouTube利用規約](https://www.youtube.com/t/terms) と [API サービス利用規約](https://developers.google.com/youtube/terms/api-services-terms-of-service) に反する機能はありません。
- 投稿者が埋め込みを禁止している動画は再生できません。その場合は自動で次の動画に進みます。
- YouTube Data APIには1日のクォータがあります。検索1回で約100ユニットを使います。サーバーは同じリクエストの結果を10分間キャッシュします。
