# 品牌资产

「汇流 Congrove」的图形:三股溪流自下汇聚成主干,上方长成三冠树丛(取「汇流成川、聚木成林」)。
配色是 `#0d9488 → #16a34a` 的对角渐变。

| 文件 | 用途 |
|---|---|
| `logo.svg` | 源图形(64 视口,可缩放到任意尺寸) |
| `logo-256.png` | 平台门户「子系统图标」上传用 |
| `logo-512.png` | 同上,高分屏 / 需要更大尺寸时 |

## ★同一份图形在三处,改要一起改★

PNG 是从 `logo.svg` 导出的**生成物**,而 SVG 本身也不是唯一真相 —— 同一份图形在代码里还有两份手写实现:

- `brand/logo.svg` —— 本目录,导出 PNG 的来源
- `web/src/logo.tsx` —— 站内页眉用的 React 组件
- `web/index.html` —— favicon 的内联 SVG

改图形要三处同步,漏一处就是「页眉和标签页图标不一样」。
重新导出 PNG(任选其一):

```bash
rsvg-convert -w 256 -h 256 brand/logo.svg -o brand/logo-256.png
# 或
inkscape brand/logo.svg -w 256 -h 256 -o brand/logo-256.png
```
