// 对局音效：
//   下子 playMove       真实落子采样（黑白共用，懒加载 /audio/place_stone.mp3，轻随机音高）
//   提子 playCapture    清脆爆裂
//   围困 playSiege      低频警示压迫
//   围空 playTerritory  空灵扩散
//   提子/围困/围空 仍为 WebAudio 合成音；下子用外部采样音频。
// 懒初始化 AudioContext：首次调用处于用户手势链内，规避浏览器自动播放限制。
// 采样加载失败/被禁用时静默忽略下子音，不影响对局。

export class SoundFx {
  private static _ctx: AudioContext | null = null;
  private static _master: GainNode | null = null;

  // 下子采样（懒加载，黑白共用）
  private static _placePromise: Promise<AudioBuffer | null> | null = null;
  private static readonly _SOURCE = "/audio/move_chess.wav";

  private static _ensure(): AudioContext | null {
    if (!this._ctx) {
      try {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return null;
        this._ctx = new Ctor();
        this._master = this._ctx.createGain();
        this._master.gain.value = 0.9;
        this._master.connect(this._ctx.destination);
      } catch {
        return null;
      }
    }
    // 自动播放策略下首次可能为 suspended，尝试恢复（须在用户手势链内）
    if (this._ctx.state === "suspended") void this._ctx.resume().catch(() => undefined);
    return this._ctx;
  }

  // 下子：播放落子采样（懒加载，失败静默忽略）。轻随机音高避免机械重复感。
  static playMove(color: number): void {
    const ctx = this._ensure();
    if (!ctx) return;
    void this._loadSample(ctx).then((buf) => {
      if (!buf) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 0.97 + Math.random() * 0.06;
      src.connect(this._master!);
      src.start(ctx.currentTime);
    });
  }

  // 倒计时“嘟”：短促方波低音，干净利落
  static playCountdown(): void {
    const ctx = this._ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    this._tone(ctx, t0, 0.14, "square", 520, 480, 0.4);
  }

  // 懒加载落子采样（fetch → decodeAudioData，仅一次）
  private static _loadSample(ctx: AudioContext): Promise<AudioBuffer | null> {
    if (!this._placePromise) {
      this._placePromise = fetch(new URL(this._SOURCE, window.location.href).href)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((ab) => (ab ? ctx.decodeAudioData(ab) : null))
        .catch(() => null);
    }
    return this._placePromise;
  }

  // 提子：双音下滑脆响 + 高频爆裂噪声
  static playCapture(): void {
    const ctx = this._ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    this._tone(ctx, t0, 0.12, "triangle", 880, 300, 0.32);
    this._tone(ctx, t0 + 0.05, 0.09, "sine", 1240, 520, 0.18);
    this._noise(ctx, t0, 0.1, 0.28, 3200);
  }

  // 围困：低频上滑 + 厚音 + 低通底噪，压迫警示
  static playSiege(): void {
    const ctx = this._ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    this._tone(ctx, t0, 0.3, "triangle", 150, 245, 0.38);
    this._tone(ctx, t0 + 0.08, 0.26, "sawtooth", 112, 165, 0.12);
    this._noise(ctx, t0, 0.26, 0.1, 600);
  }

  // 围空：柔和上扬双音 + 轻微气息噪声，空灵扩散
  static playTerritory(): void {
    const ctx = this._ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    this._tone(ctx, t0, 0.4, "sine", 330, 445, 0.22);
    this._tone(ctx, t0 + 0.15, 0.36, "sine", 445, 560, 0.1);
    this._noise(ctx, t0, 0.32, 0.045, 1200);
  }

  // 振荡器滑音（f0→f1，gain 指数衰减）
  private static _tone(
    ctx: AudioContext,
    t0: number,
    dur: number,
    type: OscillatorType,
    f0: number,
    f1: number,
    peak: number
  ): void {
    if (!this._master) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, f0), t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(peak, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this._master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // 白噪声瞬态（低通滤波，peak 指数衰减）
  private static _noise(ctx: AudioContext, t0: number, dur: number, peak: number, freq: number): void {
    if (!this._master) return;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(g).connect(this._master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }
}
