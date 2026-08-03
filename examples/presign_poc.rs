//! 预签名直传 PoC(DESIGN.md §8-1 检查单的可执行版)。跑法:
//!   source <凭证env> && S3_PUBLIC_ENDPOINT=https://s3api.ruciah.com \
//!   POC_INSECURE_TLS=1 cargo run --example presign_poc
//! 验五件事(结论回写 DESIGN.md §8-1):
//!   1 签出的 URL 无 x-amz-checksum-* 且额外 headers 为空(否则 <video src> 场景带不了);
//!   2 预签名 PUT 直传成功,且带 Origin 时响应有 CORS 头 + ETag 可读(ExposeHeaders 生效);
//!   3 OPTIONS preflight 过(浏览器跨源 PUT 的前置);
//!   4 预签名 GET + Range → 206(视频拖动/Safari 命门);
//!   5 multipart 全链路:服务端 create → 逐 part 预签 PUT → 服务端 complete(P2 正式路径)。
//! POC_INSECURE_TLS=1 只放行**传输层**证书(跑 PoC 的机器多半没装内网 CA);签名对错在应用层,不受影响。
//! 真实用户浏览器的 TLS 信任(装/没装 CA × 内网/公网 四象限)要用浏览器实测,本工具管不到。

use aws_sdk_s3::config::{Region, RequestChecksumCalculation, ResponseChecksumValidation};
use aws_sdk_s3::presigning::PresigningConfig;
use std::time::Duration;

fn env(k: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| panic!("缺环境变量 {k}"))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let public = env("S3_PUBLIC_ENDPOINT");
    let bucket = env("S3_BUCKET");
    let origin = std::env::var("POC_ORIGIN").unwrap_or_else(|_| "https://congrove-dev.sub.ruciah.com".into());
    let mut pass = true;
    let mut check = |name: &str, ok: bool, detail: String| {
        println!("{} {} — {}", if ok { "✅" } else { "❌" }, name, detail);
        pass &= ok;
    };

    let base = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .region(Region::new(std::env::var("S3_REGION").unwrap_or_else(|_| "garage".into())))
        .load()
        .await;
    // 双 client = 生产形态(storage.rs 同款):管理调用(create/complete/head/delete)走内网端点
    // (pod 里是 garage.data.svc:3900;本机跑 PoC 用 kubectl port-forward 模拟),
    // 公网端点 client **只用来签 URL**(presigned() 不发网络请求,不受 TLS 信任影响)。
    let mk = |ep: &str| aws_sdk_s3::Client::from_conf(
        aws_sdk_s3::config::Builder::from(&base)
            .endpoint_url(ep)
            .force_path_style(true)
            .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
            .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
            .build(),
    );
    let s3 = mk(&env("S3_ENDPOINT"));
    let s3pub = mk(&public);
    let mut hb = reqwest::Client::builder();
    if std::env::var("POC_INSECURE_TLS").is_ok() {
        hb = hb.danger_accept_invalid_certs(true);
    }
    let http = hb.build()?;
    let presign15 = || PresigningConfig::expires_in(Duration::from_secs(900)).unwrap();

    // ── 1) 单对象:签 PUT,验 URL 干净 ─────────────────────────────────────────
    let key = "poc/hello.txt";
    let put = s3pub.put_object().bucket(&bucket).key(key).presigned(presign15()).await?;
    let put_url = put.uri().to_string();
    check("1a URL 无 checksum 污染", !put_url.contains("x-amz-checksum") && !put_url.contains("x-amz-sdk-checksum"),
        format!("query={}", put_url.split('?').nth(1).unwrap_or("").split('&').map(|p| p.split('=').next().unwrap_or("")).collect::<Vec<_>>().join(",")));
    let extra: Vec<String> = put.headers().map(|(k, _)| k.to_string()).collect();
    check("1b 额外签名 headers 为空", extra.is_empty(), format!("headers={extra:?}"));

    // ── 2) 预签名 PUT 直传 + CORS 响应头 ─────────────────────────────────────
    let r = http.put(&put_url).header("Origin", &origin).body("hello congrove").send().await?;
    let cors_origin = r.headers().get("access-control-allow-origin").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let expose = r.headers().get("access-control-expose-headers").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let etag_visible = r.headers().get("etag").is_some();
    check("2a 预签名 PUT 直传", r.status().is_success(), format!("status={}", r.status()));
    // ★必须断言「等于请求的 Origin」不能只断言非空(2026-08-03 教训):CORS 规范要求
    // ACAO 是**单个**源,浏览器做字面比较;Garage 会把一条 rule 里的多个 AllowedOrigins
    // 拼成 "a, b" 返回 —— 非空但浏览器必判失败,curl 不做 CORS 判定所以测不出来。
    check("2b CORS Allow-Origin 等于请求 Origin(非仅非空)", cors_origin == origin,
        format!("allow-origin={cors_origin:?} 期望={origin:?}(逗号串=桶 CORS 需按 origin 拆条)"));
    check("2c ExposeHeaders 带 ETag", expose.to_lowercase().contains("etag") && etag_visible, format!("expose={expose}"));

    // ── 3) OPTIONS preflight ────────────────────────────────────────────────
    let pf = http.request(reqwest::Method::OPTIONS, &put_url)
        .header("Origin", &origin)
        .header("Access-Control-Request-Method", "PUT")
        .send().await?;
    check("3  preflight 通过", pf.status().is_success(),
        format!("status={} allow-methods={:?}", pf.status(), pf.headers().get("access-control-allow-methods")));

    // ── 4) 预签名 GET + Range → 206 ─────────────────────────────────────────
    let get = s3pub.get_object().bucket(&bucket).key(key).presigned(presign15()).await?;
    let r = http.get(get.uri()).header("Range", "bytes=0-4").send().await?;
    let is206 = r.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let cr = r.headers().get("content-range").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let body = r.text().await?;
    check("4  Range → 206", is206 && body == "hello", format!("status206={is206} content-range={cr} body={body:?}"));

    // ── 5) multipart 全链路(P2 正式路径)────────────────────────────────────
    let mkey = "poc/multipart.bin";
    let up = s3.create_multipart_upload().bucket(&bucket).key(mkey).send().await?;
    let uid = up.upload_id().unwrap().to_string();
    let mut parts = Vec::new();
    // part1 = 5MiB+1KB(≥5MiB 下限),part2 = 1KB(末 part 豁免)
    for (no, size) in [(1, 5 * 1024 * 1024 + 1024), (2usize, 1024)] {
        let pu = s3pub.upload_part().bucket(&bucket).key(mkey).upload_id(&uid).part_number(no as i32).presigned(presign15()).await?;
        let r = http.put(pu.uri()).header("Origin", &origin).body(vec![0xabu8; size]).send().await?;
        let etag = r.headers().get("etag").and_then(|v| v.to_str().ok()).unwrap_or("").trim_matches('"').to_string();
        if !r.status().is_success() || etag.is_empty() {
            check(&format!("5  part{no} 直传"), false, format!("status={} etag={etag:?}", r.status()));
            break;
        }
        parts.push(aws_sdk_s3::types::CompletedPart::builder().part_number(no as i32).e_tag(etag).build());
    }
    if parts.len() == 2 {
        s3.complete_multipart_upload().bucket(&bucket).key(mkey).upload_id(&uid)
            .multipart_upload(aws_sdk_s3::types::CompletedMultipartUpload::builder().set_parts(Some(parts)).build())
            .send().await?;
        let head = s3.head_object().bucket(&bucket).key(mkey).send().await?;
        let want = (5 * 1024 * 1024 + 2 * 1024) as i64;
        check("5  multipart 预签直传全链路", head.content_length() == Some(want),
            format!("size={:?} want={want}", head.content_length()));
    }

    // 清理
    let _ = s3.delete_object().bucket(&bucket).key(key).send().await;
    let _ = s3.delete_object().bucket(&bucket).key(mkey).send().await;

    println!("\n{}", if pass { "🎉 全部通过 — 预签名直传方案成立(TLS 四象限另用浏览器实测)" } else { "⛔ 有失败项 — 按 DESIGN.md §6 回退流式代理,或修平台侧配置" });
    std::process::exit(if pass { 0 } else { 1 });
}
