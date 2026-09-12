const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ミドルウェア設定
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// お気に入り情報を永続化するためのファイルパス
const FAV_FILE_PATH = path.join(__dirname, 'data', 'favorites.json');

// データディレクトリの確保
if (!fs.existsSync(path.dirname(FAV_FILE_PATH))) {
  fs.mkdirSync(path.dirname(FAV_FILE_PATH), { recursive: true });
}

// お気に入りデータの読み込みヘルパー
function loadFavorites() {
  try {
    if (fs.existsSync(FAV_FILE_PATH)) {
      const data = fs.readFileSync(FAV_FILE_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error("お気に入りファイルの読み込みに失敗しました:", e);
  }
  return {};
}

// お気に入りデータの保存ヘルパー
function saveFavorites(favs) {
  try {
    fs.writeFileSync(FAV_FILE_PATH, JSON.stringify(favs, null, 2), 'utf8');
  } catch (e) {
    console.error("お気に入りファイルの保存に失敗しました:", e);
  }
}

/* ==========================================
   API エンドポイント
   ========================================== */

/**
 * GET /api/streams
 * mode=fav または mode=all に応じて配信データを返す
 */
app.get('/api/streams', async (req, res) => {
  const mode = req.query.mode || 'fav';
  
  try {
    const mockVideos = [
      {
        videoId: "sample_id_1",
        videoUrl: "https://www.youtube.com/watch?v=sample_id_1",
        channelId: "UC_sample_channel",
        channelTitle: "サンプルチャンネル",
        channelIcon: "https://yt3.ggpht.com/a/AATXAJ...",
        title: "【#VTuber】雑談しながら今後の活動について話すよ！【記念配信】",
        startTime: "08/15(土) 明日 20:00",
        startTimeRaw: "2026-08-15T20:00:00+09:00",
        dateKey: "08/15",
        isLive: false,
        isEnded: false,
        isDeleted: false,
        liveViewersFormatted: null,
        durationLabel: null,
        guests: [],
        keyword: "雑談"
      }
    ];

    const mockEnded = [
      {
        videoId: "sample_id_2",
        videoUrl: "https://www.youtube.com/watch?v=sample_id_2",
        channelId: "UC_sample_channel",
        channelTitle: "サンプルチャンネル",
        channelIcon: "https://yt3.ggpht.com/a/AATXAJ...",
        title: "【Minecraft】耐久！エンドラ討伐するまで終われません！",
        startTime: "08/14(金) 18:00",
        startTimeRaw: "2026-08-14T18:00:00+09:00",
        dateKey: "08/14",
        isLive: false,
        isEnded: true,
        isDeleted: false,
        liveViewersFormatted: "12,450",
        durationLabel: "3:45:12",
        guests: [],
        keyword: "Minecraft"
      }
    ];

    const responseData = {
      mode: mode,
      videos: mockVideos,
      ended: mockEnded
    };

    res.json(responseData);
  } catch (error) {
    console.error(`❌ /api/streams (${mode}) エラー:`, error);
    res.status(500).json({ error: "サーバー内部でエラーが発生しました。" });
  }
});

/**
 * POST /api/favorites
 * お気に入り状態の更新を受け付ける
 */
app.post('/api/favorites', (req, res) => {
  const { channelId, isFavorite } = req.body;

  if (!channelId) {
    return res.status(400).json({ error: "channelId は必須です。" });
  }

  const favorites = loadFavorites();
  favorites[channelId] = Boolean(isFavorite);
  saveFavorites(favorites);

  console.log(`⭐ お気に入り更新: チャンネル [${channelId}] -> ${isFavorite ? '登録' : '解除'}`);
  res.json({ success: true, channelId, isFavorite: favorites[channelId] });
});

// サーバー起動
app.listen(PORT, () => {
  console.log(`🚀 バックエンドサーバーがポート ${PORT} で起動しました。`);
});
