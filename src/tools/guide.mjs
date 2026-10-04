/**
 * `tts_guide` — the on-demand reference for everything this plugin can do.
 *
 * Why a tool rather than more prose in each schema: every sentence in a tool schema is paid for on
 * every turn, so the resident surface can only carry what the choice itself needs. The long tail —
 * every argument with its meaning and default, return shapes, cost, the pitfalls that keep
 * repeating, runnable examples, the rules that decide what a result is worth — is worth much more
 * when it is read once, on purpose, than when it is resident and skimmed.
 *
 * Everything here is rendered from `registry.mjs` (the same source the schemas are built from) and
 * from the core constants themselves, so the reference cannot describe an action that no longer
 * exists, and a default quoted here cannot drift from the default the code applies. The live
 * parameter schemas are used too when the caller wires them in, which is what lets `tool` print
 * which argument belongs to which action.
 *
 * @module dsh-tts/tools/guide
 */
import { TtsPluginError, CWD_PROPERTY, defineFamilyTool } from './shared.mjs'
import { REGISTRY, TOOL_ORDER, lookupAction, lookupTool, toolOfAction } from './registry.mjs'
import { DEFAULT_VOICE, EDGE_DEFAULTS, TRUSTED_CLIENT_TOKEN, voicesUrl } from '../core/providers/edge.mjs'
import { PROVIDER_IDS } from '../core/providers/index.mjs'
import { DEFAULT_AUDIO_NAME, DEFAULT_OUT_DIR } from '../core/output.mjs'
import { PLUGIN_ROOT, SIBLINGS_ROOT, ffprobeCandidates, findFfprobe } from '../core/probe.mjs'

export const GUIDE_TOOL_NAME = 'tts_guide'

/**
 * The tail silence this plugin measured with `tts_setup {action:"check"}` and `tts_speak` on its
 * development machine. It is a report, not a constant the code depends on: nothing in this plugin
 * trims silence by a fixed number, and `clips[].until` uses the duration the engine actually
 * reported. The value is the largest of the samples, because the number is used for planning.
 */
const EDGE_TAIL_SILENCE_SECONDS = 0.877

/** Every action this family exposes, in dispatch order. */
export const GUIDE_ACTIONS = ['overview', 'tool', 'action', 'rules']

/** The reference takes one argument naming a tool, and one naming an action. */
const GUIDE_PROPERTIES = {
  tool: {
    type: 'string',
    enum: TOOL_ORDER,
    description:
      'tool / action: which tool to describe. For "action" this is the family the action belongs to; it may be omitted when the action name exists in only one tool.',
  },
  actionName: {
    type: 'string',
    description:
      'action: the action to describe in full, for example "dialogue" or "voices". It goes here, not in "action" — "action" selects this reference action.',
  },
  cwd: CWD_PROPERTY,
}

/**
 * The rules that decide what a synthesis result is worth.
 *
 * These are consequences of the implementation, not taste: each one exists because the code makes
 * it true, and each one is written as a rule with the reason that makes it one.
 *
 * @returns {{id: string, rule: string, why: string}[]} the rules.
 */
function rules() {
  return [
    {
      id: 'one-contract',
      rule: '每次合成只落两种文件：音频 + 同名 .words.json 侧车；侧车的 words 数组就是下游读的那份。',
      why:
        'video_narrate {action:"to_cues"} 既能读裸数组也能读 {words:[...]}，所以本插件产出的音频可以直接进字幕流程，' +
        '不需要转换步骤。侧车里其余字段（provider / voice / durationSource / audioSeconds / tailSilenceSeconds）都是溯源，' +
        '下游不认识就忽略，不会因此失败。',
    },
    {
      id: 'duration-has-a-source',
      rule: 'durationSource 说明时长是怎么来的：word-boundaries / engine-json / ffprobe / timeline / unavailable。',
      why:
        '引擎报的时长（edge：最后一个词的结束时刻）说的是"话说到哪"；ffprobe 报的时长说的是"文件有多长"，' +
        '两者之差就是引擎追加的尾部静音。把 ffprobe 的时长当成话说完的时刻，会让每一句字幕都多出这段静音。',
    },
    {
      id: 'missing-timings-are-named',
      rule: 'timings:"none" 意味着这个引擎没有给逐词时间；本插件不会估算一个出来。',
      why:
        '没有词级时间的音频仍然可以听、可以拼，但字级字幕只能靠强制对齐（WhisperX、Montreal Forced Aligner）' +
        '从音频反推。给一个看起来合理的猜测会让整条字幕链悄悄错位，而不是以一个明确的缺失被发现。',
    },
    {
      id: 'determinism',
      rule: '同样的文本 + 同样的参数 + 同样的引擎 = 同样的请求；返回的音频字节是否一致由引擎决定，不由本插件保证。',
      why:
        'edge 是服务端生成，换一次调用可能得到不同字节；本地引擎通常是确定性的。' +
        '所以结果里回显 provider / voice / rate / pitch / volume，让"同一个脚本两次听起来不一样"可追。',
    },
    {
      id: 'network-is-explicit',
      rule: 'provider "edge" 需要网络，provider "command" 不需要；status 只读配置，check 才真的联网。',
      why:
        'status 报 available:true 的含义是"本插件知道怎么调用它"，不是"这台机器现在通"。' +
        '只有 check 会真的合成一句并给出字节数、词数与耗时——把"配置过"读成"可用"是这类插件最常见的误判。',
    },
    {
      id: 'dialogue-needs-durations',
      rule: '对话排版要求每一行都有可用时长：引擎报，或者 ffprobe 量；两者都没有时拒绝运行。',
      why:
        '每一行的起点等于前一行起点 + 时长 + 间隔。时长缺失时任何一种"猜一个"的做法都会让后半段整体错位，' +
        '而错位在成品里听起来像"字幕和声音对不上"，很难回溯到原因。这条拒绝在合成任何一行之前发生。',
    },
    {
      id: 'tail-silence-is-trimmed-not-stacked',
      rule: '对话拼接用 clips[].until 切掉每行尾部的静音，只保留 tailPadSeconds。',
      why:
        'edge 每段都会带约 0.8–0.9 s 尾部静音。逐段拼接却不切的话，二十行就多出十几秒，' +
        '听感是"每一句后面都有一段长停顿"。until 是采样级裁剪，不重新编码，也不改变词级时间轴。',
    },
    {
      id: 'no-verdicts',
      rule: '结果里没有"好听 / 适合播客 / 够自然"这类判断：插件只产出文件与数字，DSH 决定。',
      why:
        '同一个结果既要能用于交付、也要能用于否掉一条音轨，所以给出的是字节数、词数、时长、尾部静音、' +
        '每行耗时与共享音色清单，判断留在调用方。',
    },
    {
      id: 'licensing-boundary',
      rule: 'provider "edge" 是微软 Edge「大声朗读」端点，商用再分发的授权未明确；要商用请换有明确许可的引擎。',
      why:
        '这条是事实而不是偏好：服务本身没有给出可用于商业再分发的条款。provider "command" 就是为这种替换而存在的——' +
        '换成自建/自托管的引擎（Piper、Kokoro、GPT-SoVITS、云厂商的持牌 API）只需要一条命令行模板。',
    },
  ]
}

/**
 * The environment traps: each one produces a plausible wrong result rather than an error.
 * @returns {{id: string, trap: string, consequence: string}[]} the traps.
 */
function traps() {
  return [
    {
      id: 'edge-tail-silence',
      trap: 'edge 返回的每段音频尾部都带一段静音，而且它不是一个常数：本机三次实测 0.561 s、0.581 s、0.877 s（随文本与音色变化）。上游 edge-tts 用固定的 8,750,000 ticks ≈ 0.875 s 补偿，恰好落在区间里。',
      consequence:
        '不切掉就拼，段与段之间会多出这段静音，整条音轨比时码长。' +
        'speak 用 tailSilenceSeconds 报出它实际是多少（需要 ffprobe）；dialogue 用 clips[].until 切掉它。' +
        '把它当常量写死会在别的句子上出错——所以这里量，不猜。',
    },
    {
      id: 'mp3-frame-gaps',
      trap: '读出声服务的分帧曾经把 2 字节 CRLF 留在音频流里：每 720 字节（5 个 MP3 帧）一个缺口，解码器每个缺口报废一帧。',
      consequence:
        '听感是"生涩、不连贯"，整段比词级时码短约 20%，最后一句没有声音——而合成本身"成功"了。' +
        '本插件在取音频体时按 MPEG 同步字定位（audioBodyOffset），不再信任声明的头长度；' +
        '要独立验证一份文件，用 audio_measure {action:"integrity"} 走一遍帧链。',
    },
    {
      id: 'gec-window',
      trap: 'Sec-MS-GEC 是按 300 秒窗口计算的签名，服务端拒绝过期签名。',
      consequence:
        '长时间运行、或系统时钟偏差较大时，握手会被拒（表现为 403 / 连接被关闭）。' +
        '签名每次调用现算，所以这不是本插件的缓存问题；出现它请先核对系统时钟。',
    },
    {
      id: 'ssml-escaping',
      trap: '文本里的 < > & \' " 必须转义后才进 SSML，否则整段 SSML 语法错误。',
      consequence:
        '把脚本原文直接拼进 SSML 会让合成失败或吞掉一段文字。本插件统一转义；' +
        '但被转义后的 &lt; 是"念出来"的尖括号，如果文本里真有标签，先自己删掉。',
    },
    {
      id: 'voice-list-throttling',
      trap: '音色列表端点会重置短时间内的密集请求（ECONNRESET），而不是返回 429。',
      consequence:
        '本机实测：连发 5 次只有第 1 次成功（200 / 170998 字节），其后 4 次全部 ECONNRESET；' +
        '安静之后 t=+120 s 再次成功，而 +30 s、+60 s 两次仍然被重置。' +
        '所以在几秒内重试是没有意义的——voices 只试两次（第二次覆盖普通传输抖动），' +
        '失败时明确告诉你等一分钟再调，而不是空转。合成不受影响：同一时间 speak 一直正常。',
    },
    {
      id: 'voice-names-change',
      trap: '音色短名是服务端的目录，会新增、会停用。',
      consequence:
        '硬编码一个音色名可能在几个月后开始报错，而代码没变。用 tts_setup {action:"voices"} 现查，' +
        '并在音色失效时把错误原样带回来——不做白名单校验，因为白名单一定会过期。',
    },
    {
      id: 'proxy-silence',
      trap: '只有系统代理可达外网时，裸 tls.connect 会在 TLS 握手前被重置（ECONNRESET）。',
      consequence:
        '其它联网动作都正常、只有合成失败，很容易被读成"服务坏了"。' +
        'ws.mjs 与音色列表请求都先问 systemProxy()，有代理就走 CONNECT 隧道；' +
        '如果仍然失败，结果里的错误会带上代理地址。',
    },
    {
      id: 'command-provider-silent-failure',
      trap: '本地引擎写出文件但退出码为 0，或者退出码为 0 却什么都没写。',
      consequence:
        '前者会得到一个空的或损坏的音频，后者会被本插件拒绝（找不到 {out} 指向的文件）。' +
        '引擎的 stderr 前几行会出现在结果的 engine.stderr 里——先看那里，再看音频。',
    },
  ]
}

/**
 * Real numbers, each labelled with what it is and where it came from.
 *
 * A value measured on one machine is not a promise about another, so provenance is part of every
 * entry: some of these were measured by this plugin on the machine it was developed on, and some
 * are carried over from the incident record of the sibling video plugin, which is stated as such.
 *
 * @returns {Record<string, {value: number|number[]|string, what: string}>} the measurements.
 */
function measured() {
  return {
    edgeTailSilenceSeconds: {
      value: EDGE_TAIL_SILENCE_SECONDS,
      what:
        'edge 每段尾部静音的实测值（audioSeconds − 最后一个词的结束时刻），开发机上三次：' +
        '5.448 − 4.887 = 0.561（Xiaoxiao，26 字）、2.256 − 1.675 = 0.581（Xiaoxiao，9 字）、' +
        '6.552 − 5.675 = 0.877（Yunxi，20 字）。三次的 audioSeconds 都被 ffprobe 量过，后两次另外被 ' +
        'audio_measure {action:"levels"} 解码核对。取最大值只用于规划。**它随文本与音色变化，所以是量出来的，' +
        '不是写死的**——写死某一个值会在别的句子上出错。',
    },
    edgeTailSilenceCompensationTicks: {
      value: 8_750_000,
      what:
        '上游 edge-tts 用这个固定 ticks 数（≈0.875 s）补偿尾部静音。它落在本机实测的 0.56–0.88 s 区间里，' +
        '但本插件不照抄这个数：切除用的是引擎这次报的 duration。',
    },
    edgeSynthesisHandshakeMs: { value: [986, 1120, 1199], what: '三次真实合成的墙钟耗时（22 字 / 26 字 / 9 字），几乎全是握手成本：一次合成的成本约等于固定 1 秒。' },
    edgeVoicesTotal: { value: 322, what: '开发机上 tts_setup {action:"voices"} 从服务端取到的音色总数。' },
    voicesCooldownSeconds: {
      value: 60,
      what:
        '音色列表被重置后需要安静多久：实测 t=0 成功、t=+30 s 与 +60 s 仍被重置、t=+120 s 再次成功。' +
        '这就是 voices 只重试两次、并让你等一分钟再来的依据。',
    },
    edgeVoicesZh: { value: 14, what: '其中 locale 以 zh 开头的数量（zh-CN 8 个、zh-HK 3 个、zh-TW 3 个）。' },
    edgeChineseVoices: {
      value: [
        'zh-CN-XiaoxiaoNeural',
        'zh-CN-XiaoyiNeural',
        'zh-CN-YunjianNeural',
        'zh-CN-YunxiaNeural',
        'zh-CN-YunxiNeural',
        'zh-CN-YunyangNeural',
        'zh-CN-liaoning-XiaobeiNeural',
        'zh-CN-shaanxi-XiaoniNeural',
        'zh-HK-HiuGaaiNeural',
        'zh-HK-HiuMaanNeural',
        'zh-HK-WanLungNeural',
        'zh-TW-HsiaoChenNeural',
        'zh-TW-HsiaoYuNeural',
        'zh-TW-YunJheNeural',
      ],
      what: '开发机上那一批中文音色的短名，给"两个主播选哪两个声音"提供一个起点。这是当时目录的快照，会变。',
    },
    mp3GapIntervalFrames: { value: 5, what: '读出声服务分帧缺陷：每 5 个 MP3 帧插入一个 2 字节 0d0a 缺口（video-factory 的事故记录，非本插件复测）。' },
    mp3GapBytes: { value: 2, what: '缺口大小（同上）。' },
    mp3LostPercent: { value: 20, what: '每个缺口报废一帧，约 20% 音频消失（同上）。' },
    edgeBandwidthHz: { value: 11_000, what: '48 kbps / 24 kHz 单声道 MP3 的有效带宽约在 11 kHz 截断（video-factory 的记录）。' },
    gecWindowSeconds: { value: 300, what: 'Sec-MS-GEC 签名有效的窗口。' },
    checkPhraseChars: { value: 20, what: 'check 默认自检短句的字数；换更长的句子只会让自检变慢。' },
  }
}

/**
 * The defaults this plugin applies, read from the core constants rather than retyped.
 * @returns {object} the defaults, grouped by where they come from.
 */
function defaults() {
  return {
    edge: { ...EDGE_DEFAULTS },
    output: { outDir: `<cwd>/${DEFAULT_OUT_DIR}`, audioName: DEFAULT_AUDIO_NAME, sidecar: '<stem>.words.json' },
    dialogue: { gapSeconds: 0.35, tailPadSeconds: 0.12, tailSeconds: 0.5 },
    provider: 'edge（config.provider，可被 DSH_TTS_PROVIDER 覆盖）',
    ffprobe: ffprobeCandidates(null).map((candidate) => candidate.source),
  }
}

/**
 * Where a neighbouring capability takes over. Named as facts, because each one is a real
 * boundary and not a preference.
 * @returns {{id: string, need: string, owner: string, fact: string}[]} the boundaries.
 */
function boundaries() {
  return [
    {
      id: 'assembly',
      need: '把多段音频拼成一条音轨（采样级、可验证）',
      owner: 'audio_build {action:"assemble"}（dsh-video-audio）',
      fact:
        'dialogue 返回的 clips 就是它的参数形状；本插件不写自己的拼接器，因为采样级拼接与回测已经在那里，' +
        '而且它还会解码核对落点。' +
        '⚠️ 截至 2026-10-04，dsh-video-audio 的 audio-build 模块在那次转码事故中被毁、尚未重建' +
        '（见该仓库 docs/事故记录.md），所以这条交接今天还跑不通；clips 的形状以它的 registry 与冻结测试为准。' +
        '在那之前，dialogue 自己的 verification 会核对每个 clips 是否落在对应文件之内。',
    },
    {
      id: 'mixing-and-normalisation',
      need: '混音、闪避、响度归一化、烧字幕',
      owner: 'video_render {action:"finalize"}（video-factory）',
      fact: '本插件只产出旁白与时间戳，不动成品音轨。',
    },
    {
      id: 'subtitles',
      need: '把逐词时间戳变成字幕条 / SRT / 烧录样式',
      owner: 'video_narrate {action:"to_cues"} → srt_write → layout（video-factory）',
      fact: '侧车的 words 数组就是它的输入；断句与排版是纯计算，与本插件无关。',
    },
    {
      id: 'measurement',
      need: '量这段音频的响度、电平、削波、帧链完整性、噪声底',
      owner: 'audio_measure（dsh-video-audio）',
      fact: '本插件只报合成侧的字节数、词数与时长；成品的客观测量属于那里，包括验证 MP3 帧链没有缺口。',
    },
    {
      id: 'transcription',
      need: '把已有音频转成文字',
      owner: 'video_narrate {action:"transcribe"}（video-factory）',
      fact: '这是反向过程，且是整句级、没有词级时间；本插件不做语音识别。',
    },
    {
      id: 'voice-cloning-training',
      need: '训练/微调一个音色（几十分钟素材训一个声音）',
      owner: '本插件不做：它只调用已经能合成的引擎',
      fact:
        '克隆训练属于具体引擎的领域（GPT-SoVITS、CosyVoice 等）。本插件接进来的是"已经训好的引擎的命令行"，' +
        '所以训练流程换代不影响这里。',
    },
  ]
}

/**
 * The provider table, rendered from the registry so a provider cannot exist undocumented.
 * @returns {object[]} one entry per provider.
 */
function providers() {
  return [
    {
      id: PROVIDER_IDS[0],
      kind: 'network',
      requiresKey: false,
      requiresNetwork: true,
      timings: 'word-boundaries',
      voices: '服务端目录，用 tts_setup {action:"voices"} 现查',
      endpoint: voicesUrl(),
      token: TRUSTED_CLIENT_TOKEN,
      defaultVoice: DEFAULT_VOICE,
      note: '不需要 Key；逐词时间是服务端 WordBoundary 元数据。商用授权未明确，见 rules 里的 licensing-boundary。',
    },
    {
      id: PROVIDER_IDS[1],
      kind: 'local',
      requiresKey: false,
      requiresNetwork: false,
      timings: 'none（模板里有 {timings} 时是 engine-json）',
      voices: 'config.command.voices 的回显；命令行引擎无法自报音色',
      endpoint: 'config.command.path + config.command.args（{out} 必填）',
      defaultVoice: 'config.command.voice',
      note: '占位符：{out} {text} {textFile} {voice} {rate} {timings}。文本默认走 stdin（textMode:"stdin"）。',
    },
  ]
}

/**
 * The cost model, as measured facts rather than promises.
 * @returns {object} the cost notes.
 */
function cost() {
  return {
    status: 'instant：读配置 + stat 几个路径。',
    voices: '一次 HTTPS 请求（edge）；command 是本地回显。',
    check: '一次真实合成：edge 约 1 秒上下（含握手），本地引擎取决于它自己。',
    speak: '一次合成 + 一次 ffprobe（measure:false 可省）。',
    dialogue: '每行一次合成，串行；二十行就是二十次往返。',
  }
}

/**
 * Build the `tts_guide` action table.
 * @param {() => object[]} definitions - a thunk returning the live tool definitions.
 * @returns {Record<string, Function>} action handlers.
 */
export function createGuideActions(definitions) {
  /** The live parameter schema of one tool, reduced to what is worth printing. */
  const propertiesOf = (name) => {
    const definition = definitions().find((candidate) => candidate.name === name)
    const properties = definition?.parameters?.properties ?? {}
    return Object.entries(properties)
      .filter(([property]) => property !== 'action')
      .map(([property, schema]) => ({
        name: property,
        type: schema.type ?? (schema.enum === undefined ? 'object' : 'string'),
        ...(schema.enum === undefined ? {} : { enum: schema.enum }),
        description: schema.description ?? null,
      }))
  }

  return {
    /**
     * The whole surface in one page.
     * @returns {Promise<object>} the overview.
     */
    async overview() {
      return {
        tools: TOOL_ORDER.map((tool) => ({
          name: tool,
          purpose: REGISTRY[tool].purpose,
          actions: Object.keys(REGISTRY[tool].actions),
        })),
        actions: TOOL_ORDER.flatMap((tool) =>
          Object.entries(REGISTRY[tool].actions).map(([action, entry]) => ({
            action,
            tool,
            summary: entry.summary,
            required: entry.required,
          })),
        ),
        providers: providers(),
        defaults: defaults(),
        cost: cost(),
        measured: measured(),
        boundaries: boundaries(),
      }
    },

    /**
     * One tool in full.
     * @param {object} args - the arguments; `tool` names it.
     * @returns {Promise<object>} the tool's documentation.
     */
    async tool(args) {
      const name = args?.tool
      if (typeof name !== 'string' || name === '') {
        throw new TtsPluginError(`tts_guide tool: 需要 "tool"，可选：${TOOL_ORDER.join(', ')}`)
      }
      const entry = lookupTool(name)
      if (entry === undefined) {
        throw new TtsPluginError(`tts_guide tool: 未知工具 ${JSON.stringify(name)}；可选：${TOOL_ORDER.join(', ')}`)
      }
      return {
        tool: name,
        purpose: entry.purpose,
        use: entry.use,
        avoid: entry.avoid,
        needs: entry.needs,
        next: entry.next,
        actions: Object.entries(entry.actions).map(([action, actionEntry]) => ({
          name: action,
          summary: actionEntry.summary,
          required: actionEntry.required,
          returns: actionEntry.returns,
          cost: actionEntry.cost,
        })),
        properties: propertiesOf(name),
      }
    },

    /**
     * One action in full.
     * @param {object} args - the arguments; `actionName` names it, `tool` disambiguates.
     * @returns {Promise<object>} the action's documentation.
     */
    async action(args) {
      const actionName = args?.actionName
      if (typeof actionName !== 'string' || actionName === '') {
        throw new TtsPluginError('tts_guide action: 需要 "actionName"，例如 "dialogue"。')
      }
      const toolName =
        typeof args?.tool === 'string' && args.tool !== ''
          ? args.tool
          : toolOfAction(actionName)
      if (toolName === null || toolName === undefined) {
        throw new TtsPluginError(
          `tts_guide action: 无法确定 ${JSON.stringify(actionName)} 属于哪个工具；请显式给 "tool"。`,
        )
      }
      const found = lookupAction(toolName, actionName)
      if (found === undefined) {
        const known = Object.keys(REGISTRY[toolName].actions)
        throw new TtsPluginError(`tts_guide action: ${toolName} 没有动作 ${JSON.stringify(actionName)}；它有：${known.join(', ')}`)
      }
      return {
        action: actionName,
        tool: toolName,
        ...found.entry,
        properties: propertiesOf(toolName),
      }
    },

    /**
     * The rules, the traps, the measurements and the boundaries.
     * @returns {Promise<object>} the rules.
     */
    async rules() {
      return {
        rules: rules(),
        traps: traps(),
        measured: measured(),
        boundaries: boundaries(),
        paths: { pluginRoot: PLUGIN_ROOT, siblingsRoot: SIBLINGS_ROOT, ffprobe: findFfprobe(null) },
      }
    },
  }
}

/**
 * Build the `tts_guide` tool.
 * @param {Record<string, Function>} actions - one handler per action.
 * @returns {object} the tool definition.
 */
export function createGuideTool(actions) {
  return defineFamilyTool({
    name: GUIDE_TOOL_NAME,
    actions: GUIDE_ACTIONS,
    extraProperties: GUIDE_PROPERTIES,
    handlers: actions,
  })
}
