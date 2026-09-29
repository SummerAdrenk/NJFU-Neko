# 第三方声明

## mindcraft

`src/knowledge/mcKnowledge.js` 中的合成规划、物品来源、需手动采集方块等思路参考了 mindcraft 项目的 `src/utils/mcdata.js`，并按新版本物品名重写：

- 项目：https://github.com/mindcraft-bots/mindcraft
- 许可：MIT License

```
MIT License

Copyright (c) 2024 Kolby Nottingham

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 运行时依赖

- mineflayer 及其插件、minecraft-data、prismarine-*（PrismarineJS，MIT）；minecraft-protocol（PrismarineJS，BSD-3-Clause）
- @anthropic-ai/sdk（Anthropic，MIT）
- smol-toml（BSD-3-Clause）
- ViaProxy（ViaVersion 团队，GPL-3.0）：由 `npm run setup` 从官方 GitHub Releases 下载，单独作为子进程运行，不随本项目分发。

## 数据来源

- Minecraft 中文 Wiki（zh.minecraft.wiki）：运行时通过官方 MediaWiki 接口查询，内容版权归 Wiki 贡献者（CC BY-NC-SA 3.0）。
- 默认皮肤 `assets/skins/neko-maid.png` 为本项目原创。
