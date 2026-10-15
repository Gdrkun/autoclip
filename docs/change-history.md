## 2026-10-14 12:01

- 类型：新增。
- 涉及功能：说话人识别与多色字幕二次开发的第一阶段调用链调查、独立 CPU POC。
- 原功能：语音识别输出 SRT/词时间戳；Studio 使用统一字幕或包装模板，未有逐句声纹 speaker 数据链路。
- 本次变更：新增毫秒级 speaker 字幕 schema、FSMN-VAD/CAM++ 离线 worker、保守聚类与字幕归属、可选本地 SenseVoice 或已有字幕复用、独立输出 CLI；支持视频/音频起点对齐、未知归属、超时终止、失败留证和内存不可观测时输出 null；补调用链、后续接入计划及隔离依赖说明。全部为新增文件，未接入原高光/剪辑/渲染主流程，未迁移项目数据或更改配置。
- 影响范围：`backend/services/speaker_subtitles.py`、`backend/services/speaker_worker.py`、`scripts/speaker_poc.py`、`requirements-speaker.txt`、`backend/tests/test_speaker_subtitles.py`、`docs/SPEAKER_SUBTITLES_PHASE1.md`。
- 验证方式：Python 3.12.7 定向 pytest 42 passed，无 skip；包含合成声纹/模拟 worker 协议、schema、未知及重叠归属、网络阻断、数据保留、真实 FFmpeg 延迟音轨对齐和受限 Windows 超时终止。`quality_gate.py --group contracts` 的 versions/readmes/82 项 release-gate 测试通过；首次默认 GBK 下两项既有测试解码失败，启用 Python UTF-8 模式后通过，保留首次失败报告。新增文本 UTF-8 无 BOM、Python 语法检查通过，已有 tracked 文件无差异，API health 仍正常。backend 全组因测试依赖未齐未运行，frontend 未修改且本次未运行检查；尚未下载或加载 CAM++ 权重，用户明确后续提供 3:57 素材，真实识别质量/性能、双色 MP4、UI 和安装包验收未完成。


## 2026-10-14 14:17

- 类型：修改、安装。
- 涉及功能：独立 CPU 说话人原型环境准备、本地模型加载与命令行试测。
- 原功能：原型代码已完成，但未安装推理依赖、下载权重或执行实际模型；模型目录校验错误地只接受 model.pt。
- 本次变更：经用户授权，在独立 venv 安装 FunASR 1.3.14、Torch/TorchAudio 2.8.0+cpu、NumPy 2.2.6 及依赖；从 ModelScope 官方仓库下载 CAM++、FSMN-VAD、SenseVoiceSmall，校验配置/词表/权重 SHA-256 并保存 receipt。支持 configuration.json 中的官方 checkpoint 文件名，拒绝缺失/目录外权重；保留 CAM++ 原始 bin 文件名。可选 requirements 补入 psutil/pysrt，新增本地 PowerShell 试测入口和私有 setup-report。项目原 .venv、已有数据和配置未修改，源码没有接入新的 UI/高光/导出主流程。
- 影响范围：backend/services/speaker_worker.py、backend/tests/test_speaker_subtitles.py、requirements-speaker.txt、docs/SPEAKER_SUBTITLES_PHASE1.md，以及独立本地 speaker-runtime 目录中的运行时、模型、启动脚本和验证记录。模型卡声明 Apache License 2.0；用户素材/模型权重/完整 freeze/运行日志不加入公开源码仓库。
- 验证方式：checkpoint 回归修复前失败、修复后通过；原项目环境和独立运行环境定向测试均 46 passed，无 skip；pip check 无冲突，原型 Ruff 正确性规则通过，统一 contracts 门禁 82 项测试通过。实际 CPU 4 线程、本机离线 TTS 合成素材：18.24s 双人片段输出 2 speaker/5 cue；237s 双人片段本地转写+识别 37.219s、3232.75 MiB 采样峰值，复用 SRT 后 17.766s、581.48 MiB；单人输出 1 speaker，静音输出 0 speaker。推理网络被阻断，无付费调用，API health 仍正常。合成测试不等于真实虚拟主播准确率或性能验收；用户 3:57 视频、重叠语音分离、双色渲染/UI、完整 backend/frontend 门禁与安装包产品验收仍未完成。


## 2026-10-14 14:56

- 类型：修复。
- 涉及功能：独立说话人原型的混合歌声/配乐长段漏字幕、孤立标点字幕与试测输出。
- 原功能：SenseVoice ASR 单段上限 30s；实际约 16s 混合音频段在原始模型输出中漏掉后半段词句，迟到的标点生成 60ms 单独字幕；仅输出 speaker JSON，原始转写随临时目录清理。
- 本次变更：ASR 单段上限改为 6s，CAM++ 声纹链路不变；纯标点附回正文且不延长正文真实时间，保留单字发言；新增本地 SRT 导出和私有原始 ASR/VAD 诊断，便于用户核对遗漏。只修改本次原型，不改变 AutoClip 原 SenseVoice 主流程、已有项目或配置。
- 影响范围：backend/services/speaker_worker.py、backend/services/speaker_subtitles.py、scripts/speaker_poc.py、backend/tests/test_speaker_subtitles.py、docs/SPEAKER_SUBTITLES_PHASE1.md，以及本地运行说明和独立测试产物。真实素材、原始词句、诊断文件与日志只保存本地，不提交公开仓库。
- 验证方式：用户 33.13s FLV 隔离 CPU 复现及 6/8/12s 分段对照，确认模型原始 text 已漏字；6s 后 20–28s 区间从无正文 cue 恢复为 1 条正文 cue，输出全部 58 个模型词字符、时长/speaker/turns 与旧结果一致；修复后实际总耗时 17.890s。原 18.24s 合成双人回归实际输出 2 speaker，合法 JSON/SRT/诊断。定向 49 passed 无 skip、正确性 lint 通过、统一 contracts 82 项测试通过。未有人工转写基准，剩余歌词错字/重叠遗漏和 speaker 准确率仍需人工核对；未运行完整 backend/frontend 门禁或安装包验收，不宣称全部歌词已恢复。


## 2026-10-14 16:51

- 类型：新增、修改。
- 涉及功能：AutoClip 正常转写设置、Whisper CPU 与说话人字幕、Studio 校对与双色成片。
- 原功能：说话人识别仅能通过命令行原型输出 JSON/SRT，没有在正常导入、编辑和渲染流程使用；较长 Whisper segment 可能跨多个 speaker。
- 本次变更：在现有字幕转写设置加入本地说话人开关和词语提示，正常 generate_subtitle_for_video 路由接入独立 Whisper medium CPU int8/CAM++；项目保存 speaker sidecar，Studio 草稿自动继承并保存可编辑快照。现有编辑器增加识别/重新转写、结果应用、人物名/颜色、逐句文本/时间/归属和双行补句；原导出路径生成按 scene 映射的双色 ASS/MP4。真实词时间戳按说话人切换拆句；失败保留旧结果，颜色关闭保留校对文本，旧数据无新增默认字段；八语文案同步。Windows 门禁使用 npm.cmd。免费模型/依赖独立安装，不替换原 .venv、配置或正式版数据；未创建独立试测页面。
- 影响范围：backend/api/v1/studio.py、ai_model_settings/speech_recognizer、studio/models/store/jobs/render、新 speaker_integration/speaker_whisper/speaker_ass；现有 AIModelSettings/StudioEditor 及新子组件、类型、八语目录和对应测试；可选依赖、质量 runner 和开发说明。新增模型来自官方 Systran Whisper medium（MIT），本地校验 LFS SHA-256，推理阻断网络。
- 验证方式：定向后端 58 passed 无 skip，全 backend 正确性 lint 通过；统一 contracts 83 项 release-gate 测试通过；独立 checkout 的完整 frontend lint/类型/290 测试/build 通过（关闭 sourcemap 上传）。用户 FLV 实际 Whisper 输出 2 speaker/10 cue，当次 88.282s、2096.26 MiB 采样 RSS，不作准确率承诺；原正常转写入口的本地合成链路验证 SRT、项目 sidecar、新 Draft 继承 2 speaker。Edge 在隔离正常设置/Studio 页实际保存刷新、校对、改名、补重叠和原导出弹窗生成 18s 音视频 MP4，首中尾抽帧及全解码通过，ASS 下载及后台识别任务完成。完整 all 后端门禁在 Windows 的既有权限/平台 skip 条件及 1800s 超时下未通过，失败报告保留，不能称发布验收通过；安装包、付费高光真实渠道与双平台未验收。本地开发 API/Worker 恢复，正常前端使用空闲 13001，其他项目 3000/3001 服务保留。未提交/推送/发布。


## 2026-10-14 17:06

- 类型：修复、文档。
- 涉及功能：开发网页的模型列表刷新、设置保存和 Studio 写请求来源校验。
- 原功能：正常前端已改用 13001，但本次启动后端时未追加来源；Vite 代理更改 Host 后导致网页写请求被来源守卫以 403 origin_not_allowed 拒绝。
- 本次变更：重启本次开发 API，追加 http://127.0.0.1:13001 和 http://localhost:13001；补充同会话启动配置及代理原因说明，保留默认守卫和其他来源配置。
- 影响范围：本地开发 API 进程环境、docs/SPEAKER_SUBTITLES_INTEGRATION.md；应用代码、既有 .env、用户数据、Redis/Worker 和其他项目前端未修改。
- 验证方式：修复前带 13001 Origin 的隔离不存在项目 POST 为 403、无 Origin 为 404；修复后本机两种来源均进入项目校验返回预期 404 且 CORS 来源头正确，无 Origin 保持 404，其他网页仍 403。实际设置 discover 路由使用 connection=null 验证本机来源进入 Pydantic 校验返回 422、其他来源 403；没有创建项目、写设置或调用外部/付费服务。原 .env SHA-256 前后相同。私有 origin-guard-report.json 保留证据；本次只调整启动环境及文档，未重跑全套源码门禁或安装包验收，不宣称外部供应商已连通。


## 2026-10-14 17:28

- 类型：修复。
- 涉及功能：AutoClip 本地 FLV 视频导入、源文件定位与兼容预览/成片。
- 原功能：前端选择器与 Studio/旧上传/命令行格式白名单未列入 FLV；旧上传统一使用 input.mp4 文件名，源视频匹配也未明确优先 FLV。
- 本次变更：前端 accept 与格式提示加入 FLV，三处导入校验放行大小写 FLV，旧上传保留 FLV 扩展名；源视频优先定位已支持的 AVI/FLV，避免字幕文件被当作视频。继续使用原 FFmpeg 音频、兼容预览和 MP4 输出链路，补充定向回归与使用说明。
- 影响范围：frontend/src/features/studio/CreativeImport.tsx、frontend/tests/quick-output-import.test.cjs、backend/api/v1/studio.py、backend/api/v1/projects.py、backend/services/quick_output_runner.py、backend/services/publish_export.py、backend/tests/test_flv_import.py、docs/SPEAKER_SUBTITLES_INTEGRATION.md；未改模型、现有 .env、用户项目、Redis/Worker 或其他服务。
- 验证方式：修复前前端 FLV 选取回归失败，Studio 两种扩展名上传均返回 422 格式不支持；修复后 FLV/原兼容预览共 12 passed，无 skip。用户此前 FLV 隔离实测 2 passed，包含上传原样保存、音轨、H.264/AAC 兼容预览、16kHz 音频提取、MP4 导出全解码；Edge 实际选择成功，阻断所有 API POST 防止自动模型调用；正常 API 的空 FLV 已进入空文件校验。后端正确性 lint、完整 frontend 门禁（lint/types/291 tests/build）通过，构建未上传 sourcemap；.env 哈希未变。旧命令行相关测试 20 passed/2 failed，Windows 路径断言与跨盘 ZIP 在未修改 HEAD 基线同样失败，私有证据保留；全量后端及桌面安装包验收未通过/未重跑，不作发布验收声明。未调用外部付费服务、未提交或发布。


## 2026-10-14 17:39

- 类型：修复。
- 涉及功能：说话人字幕的导入前转写就绪检查、设置页模型状态。
- 原功能：实际启用的转写走独立 speaker runtime，但导入就绪检查仍查询旧 Whisper/SenseVoice 环境；设置页只判断公共组件 ready，未核实所选 ASR，因此出现设置已就绪、导入被拦截的不一致。
- 本次变更：启用说话人字幕的本地转写按实际所选后端检查公共组件及 ASR，返回 speaker_ready/speaker_not_ready；缺少模型时仍拦截并指向转写设置。设置页按所选 SenseVoice/Whisper 状态显示结果，切换模型立即采用相应状态；导入页复用已有八语缺模型文案。未开启功能和云端路线保持原校验。
- 影响范围：backend/services/studio/readiness.py、backend/tests/test_studio_readiness.py、frontend/src/features/settings/SpeakerTranscription.tsx、AIModelSettings.tsx、studio/CreativeImport.tsx、frontend/tests/speaker-transcription-readiness.test.cjs 及开发说明；未修改用户转写选择、密钥、.env、项目数据或原推理链路。
- 验证方式：修复前当前 API 返回 sensevoice_not_ready，而独立模型状态与保存的 SenseVoice+speaker 开关均就绪；新增后端 5 个反例及前端 2 个反例失败。修复后就绪检查 26 passed、说话人相关 58 passed（独立进程），后端正确性 lint 通过；完整前端门禁 lint/types/294 tests/build 通过。当前 API 返回 speaker_ready，Edge 首页误报消失且设置保持开启；用户此前 FLV 在独立数据/配置下实际 SenseVoice CPU 正常转写入口生成非空 SRT 和 2 speaker/7 cue sidecar，不作准确率结论。首次混跑存在既有假的 FFmpeg 路径跨模块引用导致 WinError 193，失败报告保留，分组复验通过；未宣称全量后端或安装包通过。没有外部/付费模型调用，未提交或发布。


## 2026-10-14 18:04

- 类型：新增、修改。
- 涉及功能：Studio 说话人字幕字号/位置、补句插入与排序、ASS 和 MP4 布局。
- 原功能：字号位置硬编码，补句只能追加到列表底部，没有逐行移动或按时间排序；原片预览未复用实际双行分配，ASS 下载默认使用固定画幅。
- 本次变更：新增可选草稿 speaker_subtitle_layout（缩放、横纵比例），默认缺省保持旧序列化和导出布局；编辑器增加字号/位置滑杆与恢复默认，补句按时间插入、行后补句、上下移动、一键时间排序。提取前端编辑/预览职责，按实际画幅和同一稳定双行规则预览；布局用于 ASS 与 MP4，ASS 下载按实际输出尺寸并遵循关闭颜色。列表顺序保留 ID/文本/时间，播放按源时间轴；八语文案同步。
- 影响范围：backend/services/speaker_subtitles.py、speaker_ass.py、studio/models.py、studio/render.py、api/v1/studio.py；frontend/features/studio 的 SpeakerSubtitles、StudioEditor、types 及新 speakerSubtitleEditing/SpeakerCaptionPreview；八语 locale、相应前后端回归和开发说明。未修改用户项目/模型/配置，没有数据库迁移或高光重分析。
- 验证方式：隔离定向后端 70 passed 无 skip、正确性 lint 通过；完整 frontend lint/类型/298 tests/build 通过，未上传 sourcemap。参数无穷/越界拒绝、默认形状、HTTP 保存刷新/手动排序、实际横竖画幅 ASS、颜色关闭、FFmpeg 像素字号/位置对照及全解码覆盖。Edge 隔离合成草稿实际 150%/40%/60% 布局、行后补句/上移/排序、保存刷新、实时预览与 ASS 保留；原导出弹窗生成 6s 音视频 MP4，全解码及抽帧确认通过。初次新像素测试秒数参数 .8 被 FFmpeg 拒绝，改为 0.8 后同组 70 项全部通过，首份失败报告保留。全量后端和桌面/双平台安装包验收未完成，不作发布声明；无外部/付费模型调用，未提交、推送或发布。


## 2026-10-14 18:14

- 类型：工作流、文档。
- 涉及功能：说话人字幕开发分支按功能提交及 GitHub 交付。
- 原功能：本次开发修改已验证并留痕，尚未形成按功能划分的 Git 提交。
- 本次变更：将说话人字幕接入、Windows 开发门禁、FLV 导入、转写就绪检查及字幕布局/排序划分为独立中文提交，目标为个人 fork 的 feature/speaker-subtitles；保留原作者 upstream 和主分支。
- 影响范围：本次授权源码、回归、八语文案和开发说明的 Git 历史；模型、媒体、用户数据配置与原始证据不入库。
- 验证方式：逐提交检查暂存差异与功能依赖，完整源码快照比对原工作树；既有完整 frontend lint/types/298 tests/build、70 项 speaker/布局及 26 项 readiness 定向验证、FLV/兼容预览和真实 CPU/GUI/MP4 证据保留，最新 contracts 83 项通过。全量 backend 的既有失败/超时和安装包验收缺口不改写为通过；推送是否成功以本地私有交付回执及远端 SHA 核对为准。


## 2026-10-14 18:37

- 类型：界面优化。
- 涉及功能：Studio 说话人字幕面板的人物、样式和逐句校对。
- 原功能：原生控件、紧密表格与大量文字操作按钮混排；窄屏横向滚动，识别设置与常用校对缺少层级。
- 本次变更：按现有 AutoClip 设计配色改为带标题/数量的面板、人物名称颜色卡片、统一字号位置滑杆、逐句字幕卡片和图标排序/补句/删除操作；识别设置折叠，时间/正文/归属分区，播放中的字幕高亮，加入空字幕提示。保留原识别/保存/字幕时间与导出数据契约，同步七条新文案的八语翻译。
- 影响范围：frontend/src/features/studio/SpeakerSubtitles.tsx、新 speaker-subtitles.css、八语 locale、现有 speaker-caption-editing 测试的样式模块 mock；后端、视频、模型、用户配置和项目数据未修改。
- 验证方式：原字幕编辑定向 4 项通过；完整 frontend 门禁 lint/types/298 tests/build 通过，无 sourcemap 上传。独立 Edge 合成草稿亲验桌面/深色/390px 窄屏，测量无横向溢出并查看截图；实际改名、文本、归属、上下行、字号、行后补句、移动/排序/删除和颜色关闭，保存/刷新保留，原始数据仅在私有验证目录。未执行识别、高光分析或付费调用；此次仅前端外观，未重跑全量 backend 或桌面安装包验收，不作发布验收声明。


## 2026-10-14 22:56

- 类型：新增、修复。
- 涉及功能：AI 选片内容偏好、娱乐类优先选择、导入要求传递。
- 原功能：导入页可以写制作要求，但字幕内容选片未向实际 task/模型传递，导致要求主要影响快速判断或文案；一次选片和回退大纲/时间/评分使用通用标准。
- 本次变更：添加唱歌/搞笑/网络流行梗/迷因快捷项及可编辑要求框；保留原 instruction 字段，贯通 Studio 自动/确认制作、task、适配器、一次选片和回退的大纲/时间定位/LLM 评分。明确兴趣匹配与完整上下文，保留真实时间/ID/schema，尊重排除项且不编造梗；常规重试读取保存要求，显式空要求不会恢复旧偏好。偏好哈希区分时间线缓存，保留旧诊断，默认空偏好保留原行为；八语文案同步。
- 影响范围：backend/services/studio/jobs.py、tasks/processing.py、simple_pipeline_adapter.py、pipeline/clip_finder/step1_outline/step2_timeline/step3_scoring/scoring_backend 及新 selection_preferences；frontend 的 CreativeImport、新 SelectionPreferences/selectionPreferencePresets/CSS、八语目录、前后端回归及使用说明。没有迁移数据库、修改用户配置/供应商或开启额外模型路线。
- 验证方式：修复前两项偏好传递回归失败；修复后模型边界/缓存/旧失败路线等 145 passed、Studio 导入 74 passed，最后语义说明更新后偏好 14 项复验通过；全 backend 正确性 lint 通过。完整 frontend lint/types/300 tests/build 通过，新增表单断言再定向 5 passed。独立 Edge 四类组合+自由文本，并捕获真实生成按钮 multipart，要求完整到达 instruction 字段；所有写请求拦截，不下载素材或调用外部模型。初次检查暴露旧时间线构造默认缓存属性及 Windows 模块大小写相撞，修复后原失败组和构建通过，首次报告保留。未调用用户配置的真实模型评分、不作唱歌/梗命中准确率保证；全量 backend 既有失败/超时与桌面双平台验收未通过/未完成，.env 哈希未变。未提交或推送本次修改。
