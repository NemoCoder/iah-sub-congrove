# 会议录屏解析与总结:选型方案(2026-08-03,三路联网深调研)

> 起因:用户问「有没有能本地部署、效果好的视频解析总结模型;我们有 7×H20 + 8×5090,给个方案」。
> 三路并行调研:①开源视频理解大模型 ②中文会议 ASR + 说话人分离 ③H20/5090 部署与管线工程。
> 本文是交叉综合与落地方案。**动手前必读;推翻任一「定论」须先有新证据。**

## 一、最重要的结论:不要用视频大模型直接总结会议录屏

三条独立证据同向,而且都不是"感觉":

1. **视频模型的长视频得分本来就大半来自字幕**。Video-MME 官方数据:同一模型加字幕后,短视频 +2.4%、
   **长视频(30–60min)+8.8%**;Video-MME-v2 里 Gemini-3-Pro 无字幕 38.2 → 有字幕 49.4(**+11.2**)。
   论文原话:人类不看字幕几乎不掉分,模型掉很多——**它们对文本线索的依赖远超对画面的理解**。
2. **通用多模态模型的中文语音能力差一个数量级**。WenetSpeech `test_meeting`(会议自由对话)字错率:
   FireRedASR2-LLM **4.32%**、Qwen3-ASR-1.7B **5.88%**,而 Whisper-large-v3 **18.9~19.1%**、
   Gemini-2.5-Pro 13.5%、GPT-4o-Transcribe 32.3%。**专用 ASR 完胜通用大模型。**
3. **成本差 50–80 倍**。1 小时视频按 1fps 直喂 ≈ **108 万 token**;同一小时的中文转写只有 **1.3–2 万 token**。

★ **但纯转写会丢事实**(也有实测):VISTA(18,599 个会议演讲录像)对比——纯转写与视频模型的
ROUGE 相当,但**事实一致性 FactVC:视频 71.94 vs 转写 63.38(+8.6)**。讲者说「这里这个数」「这样改」时,
转写必然丢信息。另有《Do Slides Help?》:把幻灯片作为视觉上下文注入 ASR,**整体字错率相对降 34%、
专有名词降 35%**——正对应"中文术语/人名/变量名必错"的痛点。

→ **定论:走「ASR 转写为主干 + 关键帧 VLM 旁路」的混合管线**,不是二选一。
生态旁证:所有开源会议纪要产品(Meetily/Whishper/WhisperX/NVIDIA 参考架构/通义听悟/飞书妙记)
**零例外全走 ASR 管线**;AMI/ICSI/QMSum/MeetingBank 四大会议摘要 benchmark 也一律只用转写文本评测。

## 二、硬件的硬约束(决定方案形状,不是偏好)

**5090(32GB,Blackwell sm_120)**——长视频推理**物理上不可行**,只能干别的:
- 1 小时视频 ≈ 224K 视觉 token,**KV cache 就要 28GB(FP8)~57GB(BF16)**,权重还没算。
- `INT8 在 SM120 直接抛异常`;**FP8 反而比 BF16 慢 17%**;只有 **AWQ/GPTQ-Int4 + Marlin** 是快路(140–197 tok/s)。
- **`--enforce-eager` 会慢 8 倍**(17 vs 140 tok/s),必须开 CUDA graph。FA-3 不支持 SM120,用 FA-2/FlashInfer。
- **无 NVLink 且驱动锁 P2P**,跨卡走 PCIe(~128GB/s,H20 NVLink 的 1/7),TP 损失 10–30% →
  **8 张 5090 做 8 个独立实例,不做张量并行**。

**H20(96GB,Hopper)**——"带宽显存旗舰、算力砍到 1/7"的畸形卡:
- BF16 仅 **148 TFLOPS(≈H100 的 15%)**,但带宽 **4.0TB/s**、显存 96GB、**7 路 NVDEC**(5090 只有 2 路)。
- **MoE 上能吃到峰值的 90–95%**(实测 131–138 TFLOPS)——访存密集正中强项;
  **ViT 视觉编码与长 prompt prefill 是它最弱项**(纯算力活)。
- ⚠ **7 是质数**:vLLM 要求注意力头数被 TP 整除,绝大多数模型(32/40/64 头)**TP=7 起不来**。
  切法用 **4+2+1**,或对能单卡整装的模型直接 7×TP=1 多实例(96GB 足够,免 all-reduce)。

⚠ **反直觉的第一堵墙是 CPU**:实测视频输入时 CPU 100%、GPU 仅 20%,7B 模型从 132 tok/s 掉到 10 tok/s——
**解帧才是瓶颈**。必须用 GPU 硬件解码(PyNvVideoCodec 走 NVDEC),ffmpeg 只留场景切分与抽音轨。

## 三、选型定案

| 环节 | 选型 | 理由(关键数字) |
|---|---|---|
| **ASR(主干)** | `Qwen/Qwen3-ASR-1.7B` | test_meeting CER 5.88%(Whisper 19%);★**唯一好用的术语注入通道**:可把术语表/人名/上次纪要整段塞进 context prompt 做偏置——研究组场景里这比那 1.5 个点的 CER 差距更致命★;中英混合是其训练重点;Apache-2.0;vLLM 原生支持 |
| 备选 ASR | `FireRedTeam/FireRedASR2-AED`(1B) | CER 更低(普通话均值 3.05%)但**无热词机制**;RTF 0.087,2h 音频约 10 分钟 |
| **时间戳** | `Qwen/Qwen3-ForcedAligner-0.6B` | 官方平均对齐误差 **42.9ms**(唯一有官方精度数字的方案) |
| **说话人分离** | **3D-Speaker**(CAM++/ERes2Net) | AISHELL-4 DER **10.30**(pyannote 11.7)、AliMeeting 19.73;**Apache-2.0 + ModelScope 无门禁**——GFW 后内网的硬优势(pyannote 要 HF token + 人工点同意)。⚠ NVIDIA Sortformer 排除:**硬上限 4 人**,组会超了就崩 |
| **VLM(旁路+汇总)** | `Qwen/Qwen3.6-27B-FP8` | ★2026 年 Qwen 取消了 `-VL` 分支,全系原生多模态★;VideoMME(w/sub) **87.7**、MLVU 86.6,**27B 稠密超上一代 235B MoE**;中文 OCR 是唯一在 CC-OCR/OCRBench_v2-zh/OmniDocBench-zh 三项都有公开数字的家族(C-Eval 91.4、CC-OCR 81.2);★**混合线性注意力(GatedDeltaNet 3:1)把 KV 砍 4 倍**:224K 视频 token 只要 14.3GiB,而 Qwen3-VL-32B 要 57.3GiB——这是"27B 单卡吃满长视频、32B 老架构不能"的原因★ |
| **检索** | `Qwen3-VL-Embedding-8B` + `Qwen3-VL-Reranker-8B` | MMEB-V2 77.8;text/image/screenshot/**video** 同一向量空间;Matryoshka 可变维度;平台已有同族模型 |

**别选**:Whisper 系(中文会议 19% 字错,微调版也只到 11%)、Ovis2.5/2.6(视频=抽 8 帧当多图,长视频无证据,
vLLM 无 LoRA/PP)、GLM-4.5V(**视频上下文仅 32K**,2h 会议要切窗)、InternVL3.5(**官方零量化件**)、
Fun-ASR-Nano(官方自陈**时间戳不可靠**)。

## 四、管线设计

```
mp4
 ├─ ffmpeg 抽音轨(16k/mono/wav) → VAD 切段(fsmn-vad,ASR 单次输入有 40~60s 硬上限)
 │    → Qwen3-ASR-1.7B(context prompt 注入术语表/人名/上次纪要)
 │    → Qwen3-ForcedAligner 出词级时间戳 → 3D-Speaker 出说话人时间轴
 │    → 按时间区间对齐 → [时间][说话人] 逐字稿
 └─ GPU 解码(PyNvVideoCodec/NVDEC)+ HSV 直方图差分切镜头 → 关键帧(PPT 每页恰好一帧)
      → Qwen3.6-27B 图文模式:中文 OCR + 图表/代码理解 → [时间] 画面描述
      ↘ 关键帧 OCR 出的术语/变量名**回灌**给 ASR 做热词(两条修复路径叠加)

汇总:同一个 Qwen3.6-27B 吃「带时间轴的转写 + 画面描述」(约 3 万 token,秒级)
      → 摘要 / 分段大纲 / 关键决议 / 待办
入库:转写段落 + 关键帧 + 幻灯片图 一起进 Qwen3-VL-Embedding 向量库,供语义检索
```

**为什么关键帧要用镜头切分而不是均匀抽帧**:帧数预算的算术判了均匀抽帧的死刑——
1 视觉 token=32×32 像素,一帧 1280×720(中文 PPT 可读的最低分辨率)≈900 token,
224K 上限 ÷ 900 ≈ **249 帧**;2 小时视频 = 每 29 秒才 1 帧。反过来若坚持 1fps,每帧只剩 31 token
(≈176×176 像素)中文 PPT 完全不可读。**"帧多"与"字看得清"在 256K 上下文里二选一。**
而 PPT 翻页本来就是一次直方图突变,镜头切分抽出的正好是每页幻灯片,帧数从 7200 降到几十。

## 五、7×H20 + 8×5090 分工

| 负载 | 放哪 | 配置要点 |
|---|---|---|
| Qwen3.6-27B-FP8(旁路 VLM + 汇总) | **H20 ×1~2** | 单卡整装(28GB 权重 + 14GB KV),`--kv-cache-dtype fp8 --enable-chunked-prefill --enable-prefix-caching --max-model-len 128000 --mm-encoder-tp-mode data` |
| GPU 解码 + 关键帧抽取 | **H20**(7 路 NVDEC,5090 只有 2 路) | PyNvVideoCodec batched 模式 |
| Qwen3-ASR / ForcedAligner / 3D-Speaker | **5090 ×N,一卡一实例** | 1.7B 小模型高并发,放 96GB 卡上是浪费;AWQ/GPTQ-Int4 + CUDA graph,**别开 enforce-eager** |
| Embedding / Reranker | H20 剩余卡 或 5090 | 平台已有同族服务,可复用 |
| 长视频"直喂"兜底 | H20 | 仅用于无语音的纯演示片段,或用户点某时间段问"这里画面上是什么" |

任务编排:各 stage 独立缩零(KEDA `minReplicaCount: 0`,**触发器用 `vllm:num_requests_waiting` 而非 CPU**——
已加载的 vLLM 实例 CPU 近乎空闲而队列在堆积);权重放 PVC 预热缓存(冷启 1–3 分钟)。
视频理解本就是离线批处理(提交 → 排队 → 分钟级返回),天然适配。

## 六、成本预估(粗算,落地前须实测)

- ASR 路线:2 小时音频 ≈ **1–2 分钟**(Qwen3-ASR RTF 0.064@并发128;FireRedASR2-AED RTF 0.087),
  文本汇总 3 万 token 几秒。
- 纯视频路线:Qwen3.6-27B 处理 224K 视觉 token 的一次 prefill ≈ 29 PFLOPs,H20 单卡按 40% MFU
  约 **8 分钟**,TP=4 约 2–3 分钟。**差 5–20 倍,且中文准确率更低。**

## 七、存疑与未验证(落地前要自己测)

1. **没有任何针对"中文会议录屏"的 video-LLM vs ASR 管线头对头实测**——上面是三条间接证据链合成的判断。
2. Qwen3.5/3.6 **未公布 Charades-STA**,时序定位(输出时间戳)能力无数字支撑,只能推定继承自 Qwen3-VL。
   若"跳到第几分钟"是硬需求,有证据的是 Qwen3-VL-32B/235B(mIoU 61.2/64.8)或 VideoChat3-4B(56.1)。
3. H20 的 prefill 耗时是按 FLOPs 粗估,**未实测**;落地前先跑一场真实组会做基准。
4. H20 的 NVLink 带宽中文源说 900GB/s、另一源说 600GB/s,上机 `nvidia-smi nvlink -s` 核实。
5. vLLM 的抽帧逻辑与 `qwen_vl_utils` 不同 → **建议客户端自己抽帧、以图片列表送进去**,把策略握在自己手里。
6. 已知 bug:`num_frames` 超过 profiling 预算会**静默挂死**(vLLM #26223),必须显式设上限。

## 八、分期建议

- **P1(一周内可跑通)**:ffmpeg 抽音轨 → FunASR 一条龙(`paraformer-zh` + `fsmn-vad` + `ct-punc` + `cam++`)
  → 现有 Qwen3.6/Qwen3.5 出摘要。**一行代码拿到 `[start,end,spk,text]`,转写与说话人天然对齐**
  (自己拼 pyannote 时间轴是最烦的一段)。代价:Paraformer CER 6.97%,先打通链路与评估脚本。
- **P2**:ASR 换 Qwen3-ASR-1.7B + 术语热词表 + ForcedAligner;说话人换 3D-Speaker。
- **P3**:接关键帧 VLM 旁路(镜头切分 + Qwen3.6-27B OCR),术语回灌 ASR。
- **P4**:转写段落与关键帧入向量库,做"按内容检索会议片段"。

## 九、来源(节选)

Video-MME(arXiv 2405.21075)/ Video-MME-v2(2604.05015)/ VISTA(2502.08279)/ Do Slides Help?(2510.13979)/
Qwen3-VL 技术报告(2511.21631)/ Qwen3-ASR(2601.21337)/ FireRedASR(2501.14350)/ FireRedASR2(2603.10420)/
Qwen3.6-27B 与 Qwen3.5 系模型卡 / vLLM supported_models.md 与 Qwen3-VL recipe /
vLLM issues #24728(视频输入 CPU 瓶颈)#22695(长视频显存)#37242 #28234 #47749 #24921(5090 量化坑)/
3D-Speaker 与 pyannote community-1 模型卡(DER)/ MoE-Inference-Bench(2508.17467,H20 MoE 利用率)。
