# frontierPJ

PCエンジンの「シュヴァルツシルト」のゲーム性を受け継いだ新作 SF 戦略シミュレーション「辺境星系戦記」と、
それを AI（ローカル LLM など）に遊ばせて配信・録画するための MCP サーバー一式です。

| フォルダ | 中身 |
|---|---|
| `game/` | ゲーム本体（単一 HTML `frontier-war.html`）と画像 `art/`・音 `audio/`。ブラウザで開けば遊べる |
| `mcp/` | MCP サーバー・AI プレイヤー・操作盤・テスト。使い方は [mcp/README.md](mcp/README.md) |

```sh
cd mcp
npm install
npx playwright install chromium
npm test              # LLM なしでゲームを30ターン通しプレイ
npm run test:notes    # にせの LLM で AI プレイヤーと反省メモを確認
```

Windows では `mcp\操作盤を開く.cmd` をダブルクリックすると、初回の準備をしてから操作盤がブラウザで開きます。
