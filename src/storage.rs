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

        // 连接 5s 快失败(端点/凭证坏了别拖到首个请求才发现),操作 300s 放宽(大对象)。
        let timeouts = aws_sdk_s3::config::timeout::TimeoutConfig::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .operation_timeout(std::time::Duration::from_secs(300))
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
}
