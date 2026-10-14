# AutoClip 本地 Whisper 与说话人字幕接入

日期：2026-10-14；分支 `feature/speaker-subtitles`。此次接入现有设置、转写入口、Studio 草稿及导出，不新增独立试测页面。

## 使用

1. 在当前开发版网页打开“设置 → AI 模型 → 字幕转写”，选择“Whisper · 本地”，开启“说话人字幕”。本地模型已准备时显示 Whisper medium / CPU int8；可填写人名、固定用语提示，再保存设置。现有分析模型和密钥保持原配置，原高光分析仍遵循其供应商配置。
2. 正常导入无字幕视频时，原 `generate_subtitle_for_video` 入口会使用独立 CPU worker 转写与提取声纹，保存原片时间轴 SRT 和项目 speaker sidecar。新草稿自动继承 speaker 数据。
3. 已有项目在 Studio 打开“说话人字幕”，选择模型并识别。需要重新转写文字时取消“复用已有字幕”；有校对好的原片 SRT 时保留该选项。后台完成后可“应用识别结果”，然后确认匿名 speaker 对应的人物。
4. 编辑人物名称和颜色、逐句文本/起止/归属，必要时补充第二行；保存草稿后可下载 ASS，或使用原“导出成片”生成双色 MP4。刷新后保留编辑内容，旧成片不被覆盖。

本机正常开发页面改用 `http://127.0.0.1:13001/`，连接原 `18765` API；`3000/3001` 已由其他项目占用，未改变那些服务。独立验收页面/数据库仅用于测试，不是正常开发数据。API/Worker 依然使用原开发配置和 Redis。

使用上述 `13001` 前端端口时，必须在启动后端的同一 PowerShell 会话追加来源白名单，再运行原 uvicorn 启动命令（若后端已运行，需要重启）：

```powershell
$speakerDevOrigins = @($env:AUTOCLIP_ALLOWED_ORIGINS -split ',' | Where-Object { $_ }) + @('http://127.0.0.1:13001', 'http://localhost:13001')
$env:AUTOCLIP_ALLOWED_ORIGINS = ($speakerDevOrigins | Select-Object -Unique) -join ','
```

Vite 代理的 `changeOrigin: true` 会把请求 Host 改成后端地址，浏览器 Origin 仍是 `13001`；默认来源仅包含开发端口 `3000`，漏配会令模型列表刷新、保存设置和 Studio 写请求返回 `403 origin_not_allowed`。仅追加当前本机前端来源，保留其他已配置来源，不关闭来源守卫或修改现有 `.env`。2026-10-14 已验证本机两种来源能通过，其他网页来源仍被拒绝。

## 接入与兼容

- `ai_model_settings.Transcription` 增加可选 speaker 开关与 prompt，默认关闭/为空且默认值不增加旧序列化字段。云端和未开启功能的旧转写分支保持原行为。
- `speaker_integration.py` 在 API/Worker 进程中只负责配置、文件和子进程；模型在独立环境运行，推理阻断网络，不调用付费 ASR/LLM。Whisper 本地目录、CPU、int8、关闭远程模型下载；CAM++/SenseVoice 继续可选。
- Whisper 根据真实词时间戳、说话人切换及字幕长度拆句，不把一个长 segment 强贴成单个 speaker；旧 SRT 可复用。不将词语提示当作自动纠错事实。
- 项目 `metadata/speaker_subtitles.json` 保存源片相对时间；Studio Draft 保存可编辑快照，受原草稿 revision/冲突机制保护。识别失败、中断时保留旧结果，损坏的 sidecar 不阻断旧字幕模式；不做数据库迁移。
- `studio.store/jobs` 为新生成/导出的草稿继承 source sidecar；`studio.render` 在已开启的数据分支生成按 scene 裁切、重排映射的 ASS，保持原音轨/画幅/剪辑时间轴。颜色关闭时继续使用已校对文本，统一白色；没有 speaker 数据时走原渲染。
- 颜色通过 ASS BGR 编码，重叠 cue 自动分配上下两行，人工指定 layer 可以保留。此模式使用普通字幕样式和既有标题路径，替代包装模板的字幕层，避免重复字幕；未开启的数据保持原包装路径。
- 新路由使用原 Studio 项目校验和来源守卫：模型状态、项目识别任务/结果、草稿 ASS 下载。只改字幕或颜色不会重新执行高光分析或翻译 LLM。
- 设置及 Studio 新文案覆盖现有八种语言。质量 runner 在 Windows 通过 npm.cmd 执行前端门禁，避免找不到 npm。

## 验证证据

- 新功能定向后端测试 58 项通过，无 skip；涵盖旧模型序列化、项目继承、纠错保存/刷新、未知/重叠、场景重排时间映射、离线 CPU 参数、进程中断保留结果，以及真实 FFmpeg 两色像素/音视频轨验证。全 backend 正确性 lint 通过。
- 统一 contracts 门禁通过（含新增 Windows npm launcher 回归，83 项 release-gate 测试）。
- 在隔离 checkout 运行完整 frontend 门禁：lint、TypeScript、290 项测试、生产 build 全部通过，关闭 sourcemap 上传。原仓库无关文件的换行未改变。
- 真实本地模型对用户授权的 33.13s FLV 执行 Whisper：输出 2 speaker、10 cue；当次总耗时 88.282s，采样 RSS 峰值 2096.26 MiB。分段可读性改善但人名、歌声和重叠准确率仍未评分，不宣称 Whisper 一定优于 SenseVoice。
- 使用真实 AutoClip `generate_subtitle_for_video` 入口、独立项目/配置、已有本地模型验证：生成非空 SRT、保存 project sidecar、新 Draft 自动继承 2 speaker；Whisper 词时间戳避免一条字幕跨两人。分析占位服务没有被调用。
- Edge 实际界面操作：设置保存/刷新后保留开关及提示词；Studio 修改人物名称与文本，保存/刷新保留；补充重叠字幕，通过原导出弹窗生成可下载的 MP4。ffprobe 验证音视频轨、320×180、18s；全文件解码成功；首/中/尾抽帧已检查，首段两行两色清晰可辨。ASS 下载成功。全部使用本机 TTS 合成验收项目，没有付费调用。
- 完整 all 门禁未通过：backend 在本机 Windows 出现既有 POSIX 权限断言失败、平台不适用的 skip，且全组超过 1800s 超时；首份 sandbox 中的 npm 启动失败已通过 Windows launcher 修复并由独立 frontend 门禁通过验证。完整安装包、真实高光供应商链路、双平台与发布验收未完成，不能把局部通过写成发布 GO。

原始字幕、视频、模型、完整依赖 freeze、浏览器截图和详细失败报告只在私有本地目录保存。未提交、未推送或发布，原 `.venv`、正式版数据与用户配置没有被替换。

## 当前边界

- 支持本地十分钟以内的源视频；较长直播需先取短片段，或后续扩展分批处理。
- 当前是匿名双人识别与可编辑原语言字幕；颜色模式暂不自动翻译。人工确认身份与错字仍必要。
- 可手工补充并渲染重叠双行，不执行两路人声源分离，不能承诺同时发言都准确转写。
- 更新的是开发分支网页与后端，未重新打包已有桌面安装程序。首次刷新开发网页以加载新代码；若多次热更新造成旧 React context，完整刷新即可恢复。
