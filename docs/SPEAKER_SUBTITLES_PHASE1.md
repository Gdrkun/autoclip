# 说话人字幕：第一阶段调查与 CPU 原型

日期：2026-10-14。调查基线：`feature/speaker-subtitles`，提交 `af1c6a0552c32ee8f876b23c6abcbfaa8ef15744`，开始调查时工作树无代码改动。

仓库未包含 `docs/AutoClip_Speaker_Subtitles_Development_Plan.md`，本次读取用户提供的同名下载附件。用户已授权先调查、输出方案再实现独立 POC；附件内的示例工作指令不替代本次请求。真实 3:57 双人视频由用户后续提供，当前不进行真实素材验收。

## 已核对的调用链

1. `backend/main.py` → `backend/app_factory.py:create_app` → `backend/api/v1/__init__.py` 注册 `/api/v1` 路由。本地导入 `POST /api/v1/projects/upload` → `backend/api/v1/projects.py:upload_files`：保存 `raw/input.mp4`、可选 `raw/input.srt` → `process_import_task.delay`。已有项目的 `/process`、`/retry` 入口提交 `process_video_pipeline.delay`。`backend/api/v1/upload.py` 处理对外上传，不作为本地导入的接入点。
2. `backend/tasks/import_processing.py:_generate_import_subtitle` → `backend/utils/speech_recognizer.py:generate_subtitle_for_video`。已有 SRT 时尽量复用。分发依据现有 transcription 配置：SenseVoice、Whisper 或云 ASR。原 `enable_speaker_diarization` 参数不能证明现有本地路线已产出逐句 speaker 数据；SenseVoice 分支直接调用 `transcribe`。
3. SenseVoice：`backend/services/sensevoice_runtime.py:transcribe` 用 FFmpeg 抽取 16kHz、单声道 PCM WAV → `sensevoice_worker.py` 独立子进程加载可选运行时 → `sensevoice_alignment.py:aligned_cues` 校验真实词时间戳 → SRT + `backend/utils/word_timing.py` sidecar。Torch/NumPy 不进入 API 进程。
4. 主处理：`backend/tasks/processing.py:process_video_pipeline` → `backend/services/simple_pipeline_adapter.py:process_project_sync`。复用 SRT 或自动转写后执行 step1–step6；`clips_only` 使用 `clip_finder` 分支。`backend/pipeline/step6_video.py:run_step6_video` → `backend/utils/video_processor.py` 生成切片/合集。此 POC 不触发任何上述任务或 LLM。
5. 持久化：`backend/models/project.py:Project.subtitle_path` 保存文件路径，Project/Clip 有 JSON 元数据；没有逐句字幕 ORM 或 `speaker_id` 列。主要读取约定是项目 `raw/input.srt` 和 metadata SRT/分块。`backend/services/publish_export.py:_load_srt_entries` 优先 metadata 分块，随后 `find_source_srt` 回退到 SRT，交给 `TextProcessor.parse_srt`。`OptimizedStorageService.save_project_file` 另有 `input_subtitle.*` 命名，后续接入必须核对真实导入路径，不能只新增固定文件查找。
6. Studio：`frontend/src/features/studio/api.ts:subtitles` → `backend/api/v1/studio.py:subtitles` → `_load_srt_entries`，返回原片秒级 `start/end/text`。`StudioEditor.tsx` 用 `cues.find(...)` 显示单条预览。Draft 保存经 `PUT .../drafts/{draft_id}` → `studio/store.py:save_draft`，存项目 `metadata/studio.json`。Draft/Packaging 使用 `extra='forbid'`；新增字段需同步后端与 TS，不能先塞入旧 payload。
7. 原字幕编辑：`backend/api/v1/subtitle_editor.py` → `SubtitleProcessor.parse_srt_to_word_level` → `VideoEditor.edit_video_by_subtitle_deletion` → FFmpeg 重剪 + 导出编辑 SRT。它处理删除字幕片段并剪视频，不是文本/时间/说话人编辑存储接口。解析时 UUID 会重新生成，不能直接作为持久字幕身份。
8. Studio 渲染：`studio/jobs.py` → `studio/render.py:render_draft`。普通字幕走 `_load_srt_entries` → `slice_srt` → `_build_filter`；ASS 包装走 `packaging_render.scene_ass/scene_video_graph`；HTML 包装走 `packaging_html`。每个 Scene 单独渲染、再 concat。`packaging_render.timeline` 使用 `audio.scene_duration` 计算逐段输出偏移。`PackagingSpeaker` 是名牌显示数据，不是声纹 speaker。`draft.language != 'source'` 可能触发翻译 LLM，纠错重渲染接入时必须明确缓存和费用边界。

## 环境证据与未确认项

- 项目 `.venv` 有 pytest；`pip show` 未发现 funasr、modelscope、torch、numpy、scikit-learn、onnxruntime、ruff。已有 SenseVoice optional runtime 的版本计划为 FunASR 1.3.14 / Torch 2.8.0 CPU，不代表已经安装。
- 本机 ffmpeg/ffprobe 可定位；只读 `/health` 返回 `ok / web / 1.5.7`。
- 当前会话工作区是开发数据目录，实际源码在另一个目录。两者不能混淆。没有启动额外 API、重启 Worker 或读取用户密钥。
- `path_utils.get_data_directory` 尊重 `AUTOCLIP_DATA_DIR`；数据库默认值仍为相对 `./data/autoclip.db`，不自动随该变量迁移。Celery Redis 则来自进程环境。API/Worker 活进程环境没有取得证据，因此二者数据库、上传、日志和队列一致性未验收；POC 完全绕开这些服务。

## 本阶段文件与实现方案

仅新增，不改现有高光/转写分发/数据库/Studio/渲染行为：

| 文件 | 职责 |
|---|---|
| `backend/services/speaker_subtitles.py` | clip 毫秒 schema、严格时长/引用校验、VAD 窗口、余弦平均连接聚类、保守字幕归属 |
| `backend/services/speaker_worker.py` | 离线、本地目录模型、CPU、独立进程；FSMN-VAD → CAM++ embedding；可选本地 SenseVoice 转写 |
| `scripts/speaker_poc.py` | FFmpeg 抽音、已有 SRT/规范 JSON 复用、独立输出目录、超时/失败记录、进程树内存采样 |
| `requirements-speaker.txt` | 独立可选环境依赖，不加入基础服务依赖 |
| `backend/tests/test_speaker_subtitles.py` | 单人/双人合成声纹、未知/静音/重叠归属、schema、离线与 CLI 失败保护 |
| 本文及 `docs/change-history.md` | 可复现说明和实际验证结果 |

`--speakers 2` 是用户指定的人数上限，阈值仍可合并相近声纹，不强行把单人分为两人。聚类阈值是待真实样本校准的启发式，不是置信度或准确率。CAM++ 不生成真实姓名，也不负责将重叠混合音频拆成两份转写。

## 后续接入点与兼容性

- 第二阶段新增版本化 sidecar（候选 `metadata/speaker_subtitles.json`），保留原 SRT 与字时间戳。旧项目缺少 sidecar 时继续原模式；需要稳定 cue ID、revision、原子写与冲突校验。暂不做数据库迁移。
- 为 `backend/api/v1/studio.py` 增加独立读取/更新/识别接口，再由 `studio/jobs.py` 接入独立任务。任务需取消、重试、缓存键和失败回退，不重新启动高光分析。功能开关默认关闭。
- 后续涉及 `studio/models.py`、`store.py`、`frontend/src/features/studio/{types.ts,api.ts,StudioEditor.tsx}`：逐句文本、起止、speaker，人物名称与色值映射。八种语言同批更新。预览需显示同时生效的多条 cue；允许两个 layer，但 layer 本身不等于渲染位置。
- 后续涉及 `studio/render.py`、`packaging_render.py`、HTML 字幕路径、`publish_export.py`：按 speaker 渲染 ASS（RGB 转 ASS BGR），定义上下两行位置与安全区。所有包装路线显式处理开关，不能因模板覆盖而漏色。
- clip POC 的 0 是输入切片起点。已有原片字幕不可直接当切片字幕使用；单段需显式偏移，多段拼接/重排/变速需要映射表，并沿用帧对齐 scene duration。旧字段的秒/时间字符串不改。
- music/VAD 误检、短句、变声/配乐、窗口跨 speaker、SenseVoice 不完整 CTC、Windows 原生 DLL 及权重许可都需要真实 CPU 验证。没有可靠归属时输出 null，不编造置信度。

## 原型运行与验收

在源码根目录使用项目 `.venv` 运行 CLI，或使用准备好的独立运行时。可选模型依赖单独安装；CLI 的 `--python` 指向该隔离环境。首次调查时尚未安装或下载；用户后续授权免费联网下载，环境准备及实际模型验证已完成，见文末记录。

```powershell
# pocRoot 请设为独立本地目录，不能是正式版数据目录。
$pocRoot = Join-Path $env:TEMP 'autoclip-speaker-poc'
.\.venv\Scripts\python.exe -m venv "$pocRoot\venv"
# 以下 pip 命令需要联网许可；不要安装进项目 .venv。
& "$pocRoot\venv\Scripts\python.exe" -m pip install -r requirements-speaker.txt

# 先从模型发布方获取/核对本地权重与许可。POC 不下载模型。
# 模型目录须有 config.yaml；权重从 configuration.json 的
# file_path_metas.init_param 读取，没有该元数据时使用 model.pt。
# 官方 CAM++ 的 campplus_cn_common.bin 文件名保持不变。
.\.venv\Scripts\python.exe scripts/speaker_poc.py `
  --video 'path/to/authorized-clip.mp4' `
  --subtitles 'path/to/clip-relative.srt' `
  --cam-model "$pocRoot\models\campplus" `
  --vad-model "$pocRoot\models\fsmn-vad" `
  --python "$pocRoot\venv\Scripts\python.exe" `
  --output-dir "$pocRoot\runs\run-001" --speakers 2 --threads 4
```

没有字幕时，可用 `--asr-model` 指定本地 SenseVoiceSmall（与 `--subtitles` 二选一）；其词时间戳必须通过既有严格 CTC 适配器。两项都不提供时仅输出 turns，`subtitles=[]`，metrics 明确标记 `transcript_source=none`。输入 JSON 只接受显式 `schema_version=1/time_base=clip/duration_ms` 的规范文档，不猜测原 ASR 的时间单位。

输出：`speaker_subtitles.json`（严格 schema）、`metrics.json`（设备、版本、耗时、50ms 采样的进程树 RSS 峰值及归属未知数量）、私有 `ffmpeg.log/worker.log`。读取内存被 Windows 拒绝或进程过快没有取得采样时，峰值为 null，不是 0。现有输出目录一律拒绝，抽取音频结束后清理；失败记录不会冒充识别成功。日志和运行结果包含用户素材信息，只保存在本地，不提交。

时间轴采用 ffprobe 的首视频流起点/时长。FFmpeg 保留输入 PTS，再将首音轨对齐视频起点，通过重采样补前段静音或裁掉视频开始前的音频，并限制到视频时长。第一阶段只使用首音轨；多音轨选择在后续 UI/任务接入时显式设计。

定向验证覆盖合成 embedding / mock worker 协议 / schema / 网络阻断 / 输入输出保护，以及真实 FFmpeg 生成的延迟音频片段和受限 Windows 下的超时终止。首次调查未加载实际权重；后续已在 Windows/Python 3.12 的独立 CPU 环境完成 CAM++ `spk_embedding` 与 SenseVoice 词时间戳组合实测，见文末。真实用户视频识别质量仍未验收。

首次仓库验证：Python 3.12.7，`pytest backend/tests/test_speaker_subtitles.py -q` **42 passed**，无 skip。新增 Python 文件语法、全部新增文本 UTF-8 无 BOM 检查通过；既有 tracked 文件无差异。写入后 `/health` 仍返回 ok/web/1.5.7，但此健康检查不证明原视频处理/渲染流程已回归。

统一门禁：`python scripts/quality_gate.py --group contracts --report <absolute-private-path>`。首次运行的既有 `test_bump_version` 两例因为默认 GBK 解码失败；设置 `PYTHONUTF8=1/PYTHONIOENCODING=utf-8` 后 versions、readmes、82 项 release-gate 测试全部通过，首份失败报告保留。backend 全组尚未运行：Ruff/NumPy/OpenCV/desktop 测试依赖没有准备齐；frontend 未改动，本次未运行其检查。不会将 contracts 局部通过写成全组源码验收。

第一阶段检查时新增文件尚未提交，统一门禁的 `tracked_changes` 只统计 tracked 文件；本地另存新增文件 SHA-256 快照，把当次测试与实际新增源码关联。后续 Git 提交与集成验证状态见 SPEAKER_SUBTITLES_INTEGRATION.md。

真实用户素材的识别质量与性能、双色 MP4、人工编辑与旧链路端到端均未验收。下面的合成素材性能不能当成用户素材结果。源码局部测试不代替 `docs/TESTING_ACCEPTANCE.md` 的全组门禁或安装包验收。

## 2026-10-14：独立 CPU 环境与实际模型准备完成

- 使用独立 Python 3.12.7 venv，不修改 API/Worker 的原 `.venv`、配置、数据库或现有项目文件。Torch/TorchAudio 2.8.0+cpu，FunASR 1.3.14，NumPy 2.2.6；Torch `cuda=None`、`cuda_available=False`。CLI 的 psutil/pysrt 补入可选依赖，实际完整安装版本另存本地 freeze。
- 从官方 ModelScope 下载 [CAM++](https://modelscope.cn/models/iic/speech_campplus_sv_zh-cn_16k-common)、[FSMN-VAD](https://modelscope.cn/models/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch)、[SenseVoiceSmall](https://modelscope.cn/models/iic/SenseVoiceSmall)。三个发布 README 均声明 Apache License 2.0；配置、词表及权重的 SHA-256 与官方文件清单一致，receipt 保存 repo/revision/逐文件哈希。
- 修复首版模型目录假设：CAM++ 官方 checkpoint 是 `campplus_cn_common.bin`，不是 `model.pt`。按 `configuration.json.file_path_metas.init_param` 校验本地 checkpoint，并拒绝目录外或缺失文件；不重命名官方权重。新增回归在修复前失败、修复后通过。
- 用 Windows 本机离线 TTS 两种声音生成样例，没有下载或上传用户媒体。以下都是实际 CPU 模型运行，但不衡量真实虚拟主播识别质量；匿名 speaker 仍需人工确认。

| 合成场景 | 字幕路线 | 输出 speaker / cue | 总耗时 | 模型阶段耗时 | 50ms 采样进程树峰值 RSS |
|---|---|---|---|---|---|
| 双人 18.24s | SenseVoice 本地转写 | 2 / 5 | 32.985s | 12.938s | 3164.02 MiB |
| 双人 237s | SenseVoice 本地转写 | 2 / 57 | 37.219s | 26.859s | 3232.75 MiB |
| 同一双人 237s | 复用上次生成的 SRT | 2 / 57 | 17.766s | 9.250s | 581.48 MiB |
| 单人 10.44s | SenseVoice 本地转写 | 1 / 2 | 11.437s | 3.078s | 3146.87 MiB |
| 静音 3s | 无语音，不生成字幕 | 0 / 0 | 8.281s | 0.047s | 422.41 MiB |

全部使用 4 个 CPU 线程、自动语言检测、人数上限 2。总耗时包含进程启动、模型准备、抽音与 JSON；系统/导入缓存状态不同，不能按时长线性外推或把这些数字写成正式视频性能承诺。`quality=not_evaluated`；未执行重叠语音源分离。

验证：独立环境 `pip check` 无依赖冲突；新增原型模块的 Ruff 正确性规则通过；项目原 `.venv` 与独立环境分别运行定向测试，均 **46 passed**、无 skip；统一 contracts 门禁再次通过（82 项 release-gate 测试）。完整 backend/frontend 门禁与安装包产品验收仍未执行，不宣称完整源码或发布验收通过。

本机独立目录提供 `Test-SpeakerVideo.ps1` 和 README：传视频路径即使用本地 SenseVoice；有对应 SRT 时传 `-SubtitlesPath` 复用。每次在新 `runs/trial-*` 输出 JSON/metrics/私有日志。环境路径、模型、合成媒体、运行 JSON 和完整 freeze 仅本地保存，不提交公开仓库。源码仍没有 UI/颜色编辑/双色渲染入口。

## 2026-10-14：真实素材后半段漏字幕修复

用户试测带歌声/背景音乐的 33.13s FLV 时，报告后半段漏字幕。隔离离线复现发现：原 30s ASR VAD 上限让约 16s 的混合音频一次解码，SenseVoice 原始 text 本身就没有 20–28s 内的词句；旧时间戳/JSON 适配完整保留了原输出，不能把该问题归因于 JSON 丢字。整段不使用 VAD 的对照反而漏更多内容；6/8/12s 对照中，6s VAD 段在同一音频恢复了缺失区间的词句。此证据支持调整分段，不证明所有歌声、配乐或重叠内容都能恢复。

本次仅修改独立原型：

- ASR 的 VAD 单段上限由 30000ms 降为 6000ms，不改变 CAM++ 的 VAD/embedding 窗口，不改原 AutoClip SenseVoice 主流程。
- 纯标点字幕附到邻近正文，保留文字，不因迟到的标点延长正文真实时间戳；单字真实发言继续保留。
- 新运行额外输出 `subtitles.srt`，用于播放器核对；`asr_diagnostics.json` 保存私有原始 text/words/timestamp 和 VAD 区间，便于定位下一次漏字。该文件只留在本机，不能提交公开仓库。

实际修复验证：同一 FLV 20–28s 区间从无正文 cue 恢复为 1 条正文 cue，输出全部 58 个原模型词字符，没有在字幕转换中丢失；时长、speaker 列表和 turns 与旧结果一致。修复后总耗时 17.890s、4 CPU 线程、采样峰值 RSS 3151.06 MiB；缓存状态与首次运行不同，不作为提速对比。仍缺手工转写标注，识别内容和 speaker 准确率未评分；重叠语音没有源分离。

验证：定向测试 **49 passed**，无 skip；新增标点/单字保留与 SRT 重叠 Unicode 回读回归通过，原型正确性 lint 通过；统一 contracts 门禁 82 项测试通过。实际模型的修复前后私有回归断言通过。完整 backend/frontend 门禁与安装包验收仍未执行。
