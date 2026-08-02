//! S3(Garage)封装 —— 双 client 结构(DESIGN.md §7.4b):
//! - `s3`:集群内端点(garage.data.svc:3900),pod 自己的读写/multipart 管理走它。
//! - `presign`:外部端点(https://s3api.ruciah.com)专用于**签预签名 URL**——
//!   SigV4 把 Host 算进签名,给浏览器的 URL 必须用浏览器可达的域名签。
//!   未配 S3_PUBLIC_ENDPOINT 时为 None,media 层走后端流式代理回退。
//!
//! ★ checksum 闸(对抗核查 §7.4b-3)★:aws-sdk-s3 ≥1.69.0 默认给 Put 类操作加
//! CRC32 校验头,两个 client 统一 WhenRequired 压掉;预签名请求上**永远别**显式配
//! checksum(awslabs/aws-sdk-rust#1103:会签进空 body 的 checksum,URL 直接不可用)。
//! 凭证走标准 provider chain(AWS_ACCESS_KEY_ID/SECRET,平台注入的就是这套),别自造名。

use aws_sdk_s3::config::{Region, RequestChecksumCalculation, ResponseChecksumValidation};
use aws_sdk_s3::Client;

use crate::config::Config;

pub struct Storage {
    pub s3: Client,
    pub presign: Option<Client>,
    pub bucket: String,
}

impl Storage {
    pub async fn build(cfg: &Config) -> Storage {
        let base = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(Region::new(cfg.s3_region.clone()))
            .load()
            .await;

        // 连接 5s 快失败(端点/凭证坏了别拖到首个请求才发现);操作 1h——单文件不限大小后
        // (2026-08-02),大对象的 GetObject 流式读体可能被算进 operation 周期,300s 会掐断
        // 几百 MB 的下载;multipart 的每个 part 是独立 operation,不受大文件总时长影响。
        let timeouts = aws_sdk_s3::config::timeout::TimeoutConfig::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .operation_timeout(std::time::Duration::from_secs(3600))
            .build();

        let mk = |endpoint: &str| {
            aws_sdk_s3::config::Builder::from(&base)
                .endpoint_url(endpoint) // 显式设,别依赖 AWS_ENDPOINT_URL env(SDK 曾忽略它,#932)
                .force_path_style(true) // Garage 必须 path-style
                .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
                .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
                .timeout_config(timeouts.clone())
                .build()
        };

        let s3 = Client::from_conf(mk(&cfg.s3_endpoint));
        let presign = cfg.s3_public_endpoint.as_deref().map(|ep| Client::from_conf(mk(ep)));
        if presign.is_none() {
            tracing::warn!("S3_PUBLIC_ENDPOINT 未配 — 预签名不可用,大文件将走后端流式代理回退");
        }

        Storage { s3, presign, bucket: cfg.s3_bucket.clone() }
    }

    /// readyz 探活:head_bucket(权限+连通一次验掉)。
    pub async fn healthcheck(&self) -> anyhow::Result<()> {
        self.s3.head_bucket().bucket(&self.bucket).send().await?;
        Ok(())
    }

    /// 写对象(小文件/文档正文走这;GB 级录屏 P2 走预签名直传,不进 pod)。
    pub async fn put_bytes(&self, key: &str, bytes: Vec<u8>, mime: &str) -> anyhow::Result<()> {
        self.s3
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .content_type(mime)
            .body(aws_sdk_s3::primitives::ByteStream::from(bytes))
            .send()
            .await?;
        Ok(())
    }

    /// 整读对象(文档正文,小)。大文件下载用 get_stream,别把 GB 读进内存。
    pub async fn get_bytes(&self, key: &str) -> anyhow::Result<Vec<u8>> {
        let obj = self.s3.get_object().bucket(&self.bucket).key(key).send().await?;
        Ok(obj.body.collect().await?.into_bytes().to_vec())
    }

    /// 流式读对象(下载转发用):返回 ByteStream,调用方转成 axum Body,不落内存。
    pub async fn get_stream(&self, key: &str) -> anyhow::Result<(aws_sdk_s3::primitives::ByteStream, Option<i64>)> {
        let obj = self.s3.get_object().bucket(&self.bucket).key(key).send().await?;
        Ok((obj.body, obj.content_length))
    }

    /// 删对象。⚠ 调用方必须先做引用计数(items.s3_key + item_versions.s3_key 都不再引用
    /// 才能删——citeroot delete_fulltext 的教训),这里只管执行。
    pub async fn delete(&self, key: &str) -> anyhow::Result<()> {
        self.s3.delete_object().bucket(&self.bucket).key(key).send().await?;
        Ok(())
    }

    // ── S3 multipart(流式上传用,items.rs::upload 驱动)────────────────────────
    // 单文件不限大小(2026-08-02)后 pod 不能整读进内存(资源档 512Mi),浏览器 → pod 边收边按
    // 8MiB part 转推 S3。P2 预签名直传上线后 GB 级录屏改走浏览器直传,这条 pod 通道仍保留
    // (预签名 PoC 不通时的回退,DESIGN.md §6)。

    pub async fn multipart_begin(&self, key: &str, mime: &str) -> anyhow::Result<String> {
        let out = self.s3.create_multipart_upload().bucket(&self.bucket).key(key).content_type(mime).send().await?;
        out.upload_id().map(str::to_string).ok_or_else(|| anyhow::anyhow!("S3 未返回 upload_id"))
    }

    pub async fn multipart_part(
        &self,
        key: &str,
        upload_id: &str,
        part_number: i32,
        bytes: Vec<u8>,
    ) -> anyhow::Result<aws_sdk_s3::types::CompletedPart> {
        let out = self
            .s3
            .upload_part()
            .bucket(&self.bucket)
            .key(key)
            .upload_id(upload_id)
            .part_number(part_number)
            .body(aws_sdk_s3::primitives::ByteStream::from(bytes))
            .send()
            .await?;
        Ok(aws_sdk_s3::types::CompletedPart::builder()
            .part_number(part_number)
            .set_e_tag(out.e_tag)
            .build())
    }

    pub async fn multipart_complete(
        &self,
        key: &str,
        upload_id: &str,
        parts: Vec<aws_sdk_s3::types::CompletedPart>,
    ) -> anyhow::Result<()> {
        self.s3
            .complete_multipart_upload()
            .bucket(&self.bucket)
            .key(key)
            .upload_id(upload_id)
            .multipart_upload(aws_sdk_s3::types::CompletedMultipartUpload::builder().set_parts(Some(parts)).build())
            .send()
            .await?;
        Ok(())
    }

    /// 失败清理:abort 掉半截 multipart,别让它永久占存储(S3 的半截上传不 abort 不消失)。
    pub async fn multipart_abort(&self, key: &str, upload_id: &str) {
        if let Err(e) = self.s3.abort_multipart_upload().bucket(&self.bucket).key(key).upload_id(upload_id).send().await {
            tracing::warn!(error = %e, key, "abort multipart failed — 半截上传可能残留,待清理任务兜底");
        }
    }
}
