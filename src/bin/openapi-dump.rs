//! 把 OpenAPI 契约打到 stdout —— ★不连库、不起服务器、不要凭据★。
//!
//! 用途是接口面门禁：`scripts/api-check.sh` 拿它和 `docs/openapi.json` 基线跑 oasdiff。
//! 服务器上那条 `GET /api/_dev/openapi.json` 仍在（要超管），两者共用同一个纯函数
//! `apidoc::build_openapi()`，所以**不可能漂**。
//!
//! ⚠ 别把它做成「顺便还校验点别的」的工具：它只做一件事，输出必须是确定性的，
//! 否则 oasdiff 每次都报差异。
fn main() {
    let doc = congrove::http::apidoc::build_openapi();
    println!("{}", serde_json::to_string_pretty(&doc).expect("OpenAPI 序列化不该失败"));
}
