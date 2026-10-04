import os from "node:os";
import { KokoroTTS } from "kokoro-js";

const EN = `The sky above the port was the color of television, tuned to a dead channel. It was a Sprawl voice and a Sprawl joke. The Chatsubo was a bar for professional expatriates; you could drink there for a week and never hear two words in Japanese. These were to have an enormous impact, not only because they were associated with Constantine, but also because the decisions taken by Constantine were to have great significance for centuries to come.`;

const ZH = `天空是电视的颜色，调到一个死频道。那是一个斯普罗尔的声音，也是一个斯普罗尔的笑话。查特苏博是一家为专业侨民开设的酒吧；你可以在那里喝上一个星期，也听不到两句日语。这些将产生巨大的影响，不仅因为它们与康斯坦丁有关，而且因为在许多其他领域，康斯坦丁做出的决定将对未来的几个世纪产生重大意义。`;

const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
  dtype: "q8",
  device: "cpu",
});

const voices = Object.keys(tts.voices).length;

async function run(label, text, voice, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const audio = await tts.generate(text, { voice });
    const compute = (performance.now() - t0) / 1000;
    const dur = audio.audio.length / audio.sampling_rate;
    out.push({ compute, dur, ratio: dur / compute });
    console.log(
      `${label} run${i + 1}: audio ${dur.toFixed(3)}s | compute ${compute.toFixed(3)}s | ratio x${(dur / compute).toFixed(3)} | s-compute-per-s-audio ${(compute / dur).toFixed(3)}`
    );
  }
  const best = out.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  const worst = out.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  console.log(`${label} SUMMARY ratio x${worst.ratio.toFixed(3)} .. x${best.ratio.toFixed(3)}`);
}

// warm-up (model graph + espeak wasm + voice fetch)
await tts.generate("Warm up.", { voice: "af_heart" });

console.log(`node ${process.version} | cpus ${os.cpus().length} | ${os.cpus()[0].model}`);
console.log(`voices known to kokoro-js: ${voices}`);

await run("EN af_heart", EN, "af_heart", 3);
await run("ZH-text zf_xiaoxiao", ZH, "zf_xiaoxiao", 3);
