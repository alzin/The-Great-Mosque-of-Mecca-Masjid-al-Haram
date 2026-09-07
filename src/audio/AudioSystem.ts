/**
 * AudioSystem.ts — optional, muted-by-default ambience.
 *
 * WHAT THIS IS
 *   Filtered noise. A broad low-frequency bed for the movement of a large
 *   crowd in a stone courtyard, plus a very quiet high band that rises and
 *   falls with the number of people actually walking. It is generated in the
 *   Web Audio graph at run time; nothing is downloaded, so the asset manifest
 *   stays empty and the build works offline.
 *
 * WHAT THIS DELIBERATELY IS NOT
 *   There is no adhan, no iqamah, no takbir and no recitation — not sampled,
 *   not synthesised, not approximated. Producing an artificial imitation of
 *   the call to prayer or of Qur'anic recitation would be disrespectful and
 *   would also misrepresent the simulation as a recording of a real event.
 *   The prayer events are signalled visually and in the event log only.
 *
 * AUTOPLAY
 *   Browsers suspend an AudioContext created without a user gesture. The
 *   context is therefore created lazily on the first unmute, and the class
 *   reports honestly if the browser refuses.
 */

export type AudioState = 'off' | 'starting' | 'on' | 'unavailable';

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bedGain: GainNode | null = null;
  private activityGain: GainNode | null = null;
  private sources: AudioBufferSourceNode[] = [];

  state: AudioState = 'off';
  /** Populated when the browser refuses to give us audio. */
  error: string | null = null;

  private targetActivity = 0;
  private currentActivity = 0;
  private volume = 0.35;

  get isOn(): boolean {
    return this.state === 'on';
  }

  /** Toggle. Returns the new state. Safe to call before any user gesture. */
  async toggle(): Promise<AudioState> {
    if (this.state === 'on' || this.state === 'starting') {
      this.stop();
      return this.state;
    }
    return this.start();
  }

  async start(): Promise<AudioState> {
    if (this.state === 'unavailable') return this.state;
    this.state = 'starting';
    try {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error('Web Audio is not available in this browser.');

      if (!this.ctx) {
        this.ctx = new Ctor();
        this.build();
      }
      await this.ctx.resume();
      if (this.ctx.state !== 'running') {
        throw new Error('The browser kept the audio context suspended.');
      }
      if (this.master) {
        this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.6);
      }
      this.state = 'on';
      this.error = null;
    } catch (err) {
      this.state = 'unavailable';
      this.error = err instanceof Error ? err.message : String(err);
    }
    return this.state;
  }

  stop(): void {
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.25);
    }
    this.state = 'off';
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.ctx && this.master && this.state === 'on') {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.2);
    }
  }

  /**
   * @param movingFraction 0..1, how much of the crowd is actually in motion.
   *        During prayer this falls to nearly zero and the bed thins out,
   *        which is the one acoustic thing the simulation can honestly say.
   */
  setActivity(movingFraction: number): void {
    this.targetActivity = Math.min(1, Math.max(0, movingFraction));
  }

  update(dt: number): void {
    if (!this.ctx || this.state !== 'on') return;
    this.currentActivity += (this.targetActivity - this.currentActivity) * Math.min(1, dt * 0.6);
    if (this.activityGain) {
      this.activityGain.gain.setTargetAtTime(
        0.08 + this.currentActivity * 0.5,
        this.ctx.currentTime,
        0.4,
      );
    }
    if (this.bedGain) {
      this.bedGain.gain.setTargetAtTime(
        0.35 + this.currentActivity * 0.2,
        this.ctx.currentTime,
        0.8,
      );
    }
  }

  private build(): void {
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // Six seconds of pink-ish noise, looped. Two independent buffers at
    // slightly different rates avoid an audible loop period.
    const bed = this.noiseSource(6.0, 0.86);
    const bedFilter = ctx.createBiquadFilter();
    bedFilter.type = 'lowpass';
    bedFilter.frequency.value = 420;
    bedFilter.Q.value = 0.4;
    this.bedGain = ctx.createGain();
    this.bedGain.gain.value = 0.35;
    bed.connect(bedFilter).connect(this.bedGain).connect(this.master);

    const air = this.noiseSource(5.13, 0.55);
    const airFilter = ctx.createBiquadFilter();
    airFilter.type = 'bandpass';
    airFilter.frequency.value = 1350;
    airFilter.Q.value = 0.5;
    this.activityGain = ctx.createGain();
    this.activityGain.gain.value = 0.1;
    air.connect(airFilter).connect(this.activityGain).connect(this.master);

    // A slow amplitude wander so the bed does not sit perfectly still.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.06;
    lfo.connect(lfoGain).connect(this.bedGain.gain);
    lfo.start();

    this.sources = [bed, air];
  }

  private noiseSource(seconds: number, decay: number): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    let seed = 0x2f6e2b1;
    for (let i = 0; i < length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      const white = (seed / 2147483648) - 1;
      last = last * decay + white * (1 - decay);
      data[i] = last * 3.2;
    }
    // Cross-fade the seam so the loop point is inaudible.
    const fade = Math.min(2000, Math.floor(length * 0.02));
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      data[i] = data[i] * t + data[length - fade + i] * (1 - t);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.start();
    return src;
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources = [];
    void this.ctx?.close();
    this.ctx = null;
    this.state = 'off';
  }
}
