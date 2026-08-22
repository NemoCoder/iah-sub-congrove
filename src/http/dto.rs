//! 跨模块共享的小响应体。
//!
//! ★为什么单开一个模块★:`{"ok":true}` 和 `{"id":N}` 这两种响应遍布全树,
//! 各模块各定义一个的话,契约里就会出现 `OkOut` / `OkOut2` / `ProjectOkOut` 一堆
//! 长得一样的类型 —— 使用者要逐个点开才知道它们其实是同一个东西。
//!
//! ⚠ 只放**真正通用**的:一旦某个响应带了业务字段(比如 `{ok, restorable_days}`),
//!   它就该回自己模块里定义,别在这儿加可选字段把它揉进来。

/// 只表示「做成了」。★失败走 HTTP 状态码,不靠这个字段★——
/// 所以它恒为 `true`,存在的意义只是给成功响应一个合法的 JSON body。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct OkOut {
    pub ok: bool,
}
impl OkOut {
    pub fn yes() -> Self { Self { ok: true } }
}

/// 新建成功后回它的 id。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct IdOut {
    pub id: i64,
}
