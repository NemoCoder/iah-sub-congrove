//! congrove binary —— 库 crate 的薄壳,逻辑全在 lib.rs(见 congrove::run)。

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    congrove::run().await
}
