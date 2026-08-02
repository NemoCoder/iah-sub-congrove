-- 0003_viewer_no_download:D4 拍板(docs/PERMISSIONS.md):每空间「viewer 禁下载原件」开关。
-- 语义边界(有意为之):只拦 download 端点(原件获取);文档在线阅读、视频在线播放**不拦**——
-- 能播放就能被工具抓流,拦播放只会把 viewer 变成「什么都看不了」,与三档语义冲突
-- (钉钉「仅可查看」同样允许在线预览)。editor/admin/超管不受此开关影响。
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS viewer_no_download boolean NOT NULL DEFAULT false;
