// バックエンドWorkersの公開URL
const API_ENDPOINT = "https://vtuber-backend.0120tomesuke.workers.dev/";

document.addEventListener("DOMContentLoaded", async () => {
  const container = document.getElementById("stream-container");
  
  if (!container) {
    console.error("表示用の要素が見つかりません。");
    return;
  }

  try {
    const response = await fetch(API_ENDPOINT);
    
    if (!response.ok) {
      throw new Error(`サーバーレスポンスエラー: ${response.status}`);
    }

    const streams = await response.json();

    if (!streams || streams.length === 0) {
      container.innerHTML = "現在、表示可能な配信データはありません。";
      return;
    }

    container.innerHTML = ""; // 読み込み中表示をクリア

    streams.forEach(stream => {
      const card = document.createElement("div");
      card.className = "stream-card";
      
      card.innerHTML = `
        <h3 style="color: #ff007f; margin: 0 0 8px 0; font-size: 16px;">${stream.title || "無題のライブ配信"}</h3>
        <p style="margin: 4px 0; color: #ffffff;">チャンネル: ${stream.channel_name || "不明"}</p>
        <p style="margin: 4px 0; color: #00ff00;">ステータス: ${stream.status || "N/A"}</p>
        <p style="margin: 4px 0; color: #888888; font-size: 12px;">開始時刻: ${stream.start_time || "未定"}</p>
      `;
      
      container.appendChild(card);
    });

  } catch (error) {
    console.error("データの取得に失敗しました:", error);
    container.innerHTML = "データの取得に失敗しました。";
  }
});
