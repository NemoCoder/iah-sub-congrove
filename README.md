# iah-sub-congrove · 汇流(Congrove)

团队自建的知识库 / 资料共享平台 —— **会议记录、会议录屏、论文资料**按**小组**共享,分组授予**读 / 编辑**权限。
对标 **Confluence**(Space + Group + 读写权限就是它的模型),外加会议录屏与论文资料。

> **给接手的开发者:先读 [`DESIGN.md`](DESIGN.md)** —— 完整需求、平台集成契约(确切的 PG/S3/OIDC 环境变量)、
> 架构决策、数据模型、权限模型、录屏方案(§7.4b 预签名工程六条)、分阶段计划。
> 技术栈已定案并落地 P0:**Rust(axum + sqlx)+ React 19/AntD 6/Vite 8**,主范本 `../citeroot/`。

## slug / 命名(平台按 slug 推导,别手写)

- slug:`congrove`;仓库名:`iah-sub-congrove`;OIDC client:`sub-congrove`
- 域名:dev `congrove-dev.sub.ruciah.com` / prod `congrove.sub.ruciah.com`
- PG 库:`sub_congrove_dev` / `sub_congrove`;S3 桶:`sub-congrove-dev` / `sub-congrove`

## 本地运行

```bash
cp .env.example .env      # 必须:缺 DATABASE_URL / S3_* 硬失败(config.rs)
cargo run                 # :8030;不配 OIDC_ISSUER = 鉴权关闭 + WARN(dev 超管假身份)
curl localhost:8030/healthz   # 存活;readyz 查 PG + S3

cd web && pnpm install && pnpm dev   # vite :5180,/api /auth 代理到 :8030
cd web && pnpm build                 # 产物 dist/,线上由后端 ServeDir 同源托管
cd web && pnpm typecheck             # ⚠ 平台构建管道零类型检查,改完 TS 必须手跑

cargo test                # perm.rs 纯函数单测(权限合并/角色偏序)
```

## 部署(声明式,DESIGN.md §2.2b)

配置在根 [`iah.yaml`](iah.yaml)(port 8030 / want_db / want_oss / 超管白名单 / S3_PUBLIC_ENDPOINT)。

```bash
# 首次部署 + 挂 push 自动构建(个人令牌在门户「日志」页):
curl -X POST -H "Authorization: Bearer <令牌>" \
  -d '{"repo":"<owner>/iah-sub-congrove","ref":"dev","channel":"dev","autobuild":true}' \
  https://registry.ruciah.com/api/subsystems/congrove/deploy
# 构建失败唯一入口:
curl -H "Authorization: Bearer <令牌>" "https://registry.ruciah.com/api/subsystems/congrove/build-log?channel=dev"
```

⚠ 录屏预签名直传上线前:先让平台给桶配 CORS(`ExposeHeaders:[ETag]`,pod 的 key 无 owner 位配不了),
再跑 DESIGN.md §8-1 的预签名 PoC 四象限;不通走后端流式代理回退(media 层可切换)。

## 仓库

双远端 Gitea(内网,主)+ Gitee(外部备份):`./setup-remotes.sh congrove` 配好后 `git push origin main` 一次推两端。
**push 由仓库所有者做**;密钥绝不入库,提交前 `git diff --staged` 扫明文密钥。
