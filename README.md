# dsh-tts

DSH Host 插件：**把文字变成声音，引擎留在插件之外**。

它只做能写成「同一次请求必得同一次调用」的事，并且**只产出文件与数字、不出判断**——哪条 take 好听、
该用哪个音色、间隔多长合适，都是调用方的决定。

| 工具 | action | 覆盖 |
| --- | --- | --- |
| `tts_speak` | `speak` `dialogue` | 一段文字 → 音频 + 逐词时间戳侧车；多人脚本 → 每行一个文件 + 一条采样级时间线（clips + 全局词级时间戳） |
| `tts_setup` | `status` `voices` `check` | 每个引擎现在能不能用、有什么音色、真的合成一句看看回来的是什么 |
| `tts_guide` | `overview` `tool` `action` `rules` | 按需读取的完整参考：参数、返回、耗时、陷阱、实测数据、边界 |

共 **3 工具 / 9 action**。常驻 schema 约 9.9 KB（`npm run surface` 可复现，预算 24 KB）。

## 两种 provider

| provider | 是什么 | 需要 Key | 需要网络 | 逐词时间戳 | 音色 |
| --- | --- | --- | --- | --- | --- |
| `edge`（默认） | 微软 Edge「大声朗读」端点 | 否 | 是 | **有**（服务端 `WordBoundary`） | 服务端目录，本机实测 322 个，其中 zh 开头 14 个 |
| `command` | 任意本地 TTS 命令行（Piper / Kokoro / GPT-SoVITS / 自写脚本） | 否 | 否 | 模板里有 `{timings}` 才有，否则 `timings:"none"` | `config.command.voices` 的回显 |

`command` 只认**模板 + 占位符**，不认任何具体引擎，所以引擎换代不用改插件：

```yaml
command:
  path: 'C:/tools/piper/piper.exe'
  args: ['--model', 'C:/tools/piper/zh_CN-huayan-medium.onnx', '--output_file', '{out}']
  textMode: 'stdin'        # stdin | arg | file
  outFormat: 'wav'         # wav | mp3
  voice: null
  voices: ['zh_CN-huayan-medium']
```

占位符：`{out}`（必填）、`{text}`、`{textFile}`、`{voice}`、`{rate}`、`{timings}`。

## 安装

profile 里以 `link:` 挂载即可，无需构建步骤（纯 ESM，无第三方运行时依赖）：

```yaml
- insert:
    - id: dsh-tts
      name: 'dsh-tts'
      config: { provider: null, outDir: null, ffprobePath: null, edge: { voice: null }, command: null }
```

出厂默认见 [`cordis.patch.yml`](cordis.patch.yml)：`edge` 可用即用，`command` 留空表示"没有配置本地引擎"，
`tts_setup {action:"status"}` 会把这句如实报告出来。

本机已经挂进 `desktop` profile（以 `link:` 指向本目录，并在 profile 的 `dsh.profile.bundles` 里登记），
所以 `tts_*` 工具在本会话里可用。**注意默认输出目录**：调用方既没给 `outDir` 也没给 `cwd` 时，
文件落在 DSH 进程的工作目录（挂载态下就是 profile 目录），放项目里请显式给 `outDir`。

## 输出契约

一次合成落两个文件：音频 + 同名 `.words.json` 侧车。

```json
{
  "audio": "…/voiceover.mp3",
  "provider": "edge",
  "voice": "zh-CN-XiaoxiaoNeural",
  "duration": 4.887,
  "durationSource": "word-boundaries",
  "audioSeconds": 5.448,
  "tailSilenceSeconds": 0.561,
  "timings": "word-boundaries",
  "wordCount": 16,
  "words": [{ "text": "开源", "start": 0.1, "end": 0.42 }]
}
```

字段的含义与来源见 [`docs/输出契约.md`](docs/输出契约.md)。**`words` 数组就是下游读的那份**：
`video_narrate {action:"to_cues"}` 既接受裸数组也接受 `{words:[...]}`，所以本插件的产物可以直接进字幕流程。

`dialogue` 另外写两个文件：`dialogue.json`（manifest，含 `clips` 与 `verification`）与 `dialogue.words.json`（全局词级时间戳）。
`clips` 就是 `audio_build {action:"assemble"}` 的参数形状。

**`verification` 是三值的**：每行在合成时都量过文件长度，所以 `dialogue` 顺手核对"要截的片段是否落在该行文件之内"——
`true` 是每段都量过且都在文件内，`false` 是有片段超出，**`null` 是一行都没量过**（`measure:false` 或没有 ffprobe），不是"没问题"。

## 与兄弟插件的分工

- **合成**在这里：文字 → 音频 + 时间戳，引擎可换。
- **拼接**在 `dsh-video-audio` 的 `audio_build {action:"assemble"}`：采样级落点、可解码核对。本插件不写第二个拼接器。
  ⚠️ 截至 2026-10-04，那个模块在那次 PowerShell 转码事故中被毁、尚未重建（见 `dsh-video-audio/docs/事故记录.md`），
  所以这条交接今天还跑不通；`clips` 的形状以它的 registry 与冻结测试为准。
- **字幕**在 `video-factory` 的 `video_narrate {action:"to_cues"}` → `srt_write` → `layout`；断句与排版是纯计算。
- **成品混音与响度归一**在 `video_render {action:"finalize"}`。
- **客观测量**（响度、电平、削波、帧链完整性）在 `audio_measure`：本插件只报合成侧的字节数、词数、时长、尾部静音。
- **训练/克隆音色**不在这里：本插件接进来的是"已经能合成的引擎的命令行"。

## 下一步：本地开源引擎走哪条路

核查结论写在 [`docs/research/本地引擎可行性-2026-10-04.md`](docs/research/本地引擎可行性-2026-10-04.md)（含出处与实测）：

- 要**马上**拿到本地中文语音：走已经实现的 `command` provider，把 Python 侧的 Kokoro / Piper / GPT-SoVITS 包成一条命令。
- 纯 Node 的原生 Kokoro provider **暂时做不了中文**：`kokoro-js@1.2.1` 只注册 28 个英文音色，传 `zf_xiaoxiao` 直接抛
  `Voice not found`；中文前端（misaki[zh]）在 Python 侧。模型与推理都不是障碍，文本前端才是。
- 中文**词级时间戳没有现成方案**（HeadTTS 自述只支持英文），所以本地引擎的 `timings:"none"` 后面接强制对齐，
  这不是临时方案，是规则本身。
- 速度：本机 8 物理核 / 16 线程，q8 量化实测约 **1.1× 实时**（每 1 秒音频约 1.08–1.14 秒计算）；一条 20 分钟的播客要算 20 分钟以上。

## 许可

`edge` 走的是微软 Edge「大声朗读」端点，**商用再分发的授权未明确**：请用于草稿与个人内容，要商用就换
`command` + 有明确许可的引擎（自托管或持牌 API）。这条写在 `tts_guide {action:"rules"}` 的
`licensing-boundary` 里，也是 `command` 存在的理由。

## 实测（本机，2026-10-04）

| 事实 | 值 |
| --- | --- |
| 一次真实合成（22 字 / 26 字 / 9 字 / 20 字） | 986 / 1120 / 1199 / 1221 ms（几乎全是握手） |
| 尾部静音（三次，ffprobe 量；两次另用 `audio_measure levels` 解码核对） | 5.448 − 4.887 = 0.561 s；2.256 − 1.675 = 0.581 s；6.552 − 5.675 = **0.877 s** |
| 上游 edge-tts 的补偿常量 | 8,750,000 ticks ≈ 0.875 s，落在上面的区间里——但本插件量，不照抄 |
| 音色目录 | 322 个，其中 zh 开头 14 个（zh-CN 8 / zh-HK 3 / zh-TW 3） |
| 音色端点限流 | 连发 5 次只成功 1 次（200 / 170998 B），其余 `ECONNRESET`；t=+30 s、+60 s 仍被重置，t=+120 s 恢复。**合成不受影响**，同时刻 `speak` 一直正常 |
| MP3 头 | `ff f3 …`，无 ID3，`0d0a` 对数 0（分帧缺口的旧缺陷未复现） |
| 双人对话（2 行 / 3 行） | 2.0–3.3 s 合成，时间线 3.219 s / 8.646 s，`verification.everyClipWithinItsFile` 为 true |
| 本机 CPU | 2×Xeon 8378C = 8 物理核 / 16 线程（早先只读到一个 socket，别按 4 核估算本地引擎） |

## 命令行

```bash
node src/bin/tts.mjs doctor                    # 每个 provider 能不能用、ffprobe 从哪来
node src/bin/tts.mjs voices --locale zh        # 现取音色目录
node src/bin/tts.mjs say "要念的话" --out a.mp3
node src/bin/tts.mjs check                     # 合成一句自检，报字节/词数/时长/尾部静音
node src/bin/tts.mjs dialogue --script s.txt --voices host-a=zh-CN-XiaoxiaoNeural,host-b=zh-CN-YunxiNeural
node src/bin/tts.mjs rules
```

## 测试

```bash
node --test "tests/*.test.mjs"                        # 43 个用例：纯函数 + 路径 + 侧车契约
$env:DSH_TTS_LIVE='1'; node --test tests/live.test.mjs # 3 个联网用例（真实合成 / 音色目录 / 双人时间线）
node src/bin/surface-report.mjs                       # 常驻 schema 字节预算
```

联网用例默认跳过并说明原因：它们会在第三方服务不可用时失败，那是事实而不是回归。
音色目录那条在**端点限流**时也跳过并写明原因——实测该端点会重置密集请求（几分钟内只放行一次），
这是网络条件，不是插件行为；401、返回结构变化之类的真问题仍然会让它失败。
