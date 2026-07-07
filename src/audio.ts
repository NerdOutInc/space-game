/**
 * Game audio: one music bus (looping tracks with crossfade) and one SFX bus
 * (the engine loop whose volume follows thrust). Web Audio contexts start
 * suspended until a user gesture, so everything no-ops gracefully until
 * unlock() succeeds; requested music starts as soon as its buffer arrives.
 */

const audioPath = (file: string): string => `${import.meta.env.BASE_URL}audio/${file}`;

const TRACKS: Record<string, string> = {
  engine: audioPath('rocket-engine.mp3'),
  dunes: audioPath('dunes.mp3'),
  cosmic: audioPath('cosmic-glow.mp3'),
};

const FADE = 1.2; // s, music crossfade

class AudioManager {
  private ctx: AudioContext | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private loading = new Set<string>();
  private music: { name: string; gain: GainNode; src: AudioBufferSourceNode } | null =
    null;
  private wantMusic: string | null = null;
  private engine: { gain: GainNode; src: AudioBufferSourceNode } | null = null;
  private engineLevel = 0;

  musicVolume = 0.3;
  sfxVolume = 0.7;

  constructor() {
    const m = parseFloat(localStorage.getItem('zenith-music-vol') ?? '');
    const s = parseFloat(localStorage.getItem('zenith-sfx-vol') ?? '');
    if (isFinite(m)) this.musicVolume = m;
    if (isFinite(s)) this.sfxVolume = s;
  }

  /** Call from a user-gesture handler; safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = this.musicVolume;
      this.musicBus.connect(this.ctx.destination);
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = this.sfxVolume;
      this.sfxBus.connect(this.ctx.destination);
      for (const name of Object.keys(TRACKS)) void this.load(name);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private async load(name: string): Promise<void> {
    if (this.buffers.has(name) || this.loading.has(name) || !this.ctx) return;
    this.loading.add(name);
    try {
      const res = await fetch(TRACKS[name]);
      const data = await res.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(data);
      this.buffers.set(name, buf);
      if (this.wantMusic === name) this.playMusic(name);
      if (name === 'engine' && this.engineLevel > 0) this.setEngineLevel(this.engineLevel);
    } finally {
      this.loading.delete(name);
    }
  }

  playMusic(name: string): void {
    this.wantMusic = name;
    if (!this.ctx || !this.musicBus) return;
    if (this.music?.name === name) return;
    const buf = this.buffers.get(name);
    if (!buf) return; // will start from load()

    const t = this.ctx.currentTime;
    if (this.music) {
      const old = this.music;
      old.gain.gain.setValueAtTime(old.gain.gain.value, t);
      old.gain.gain.linearRampToValueAtTime(0, t + FADE);
      old.src.stop(t + FADE + 0.05);
      this.music = null;
    }
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(1, t + FADE);
    gain.connect(this.musicBus);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(gain);
    src.start();
    this.music = { name, gain, src };
  }

  /** 0..1 — engine loudness; 0 stops the loop (kept warm for restarts). */
  setEngineLevel(level: number): void {
    this.engineLevel = level;
    if (!this.ctx || !this.sfxBus) return;
    const buf = this.buffers.get('engine');
    if (!buf) return;
    if (!this.engine) {
      if (level <= 0) return;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.sfxBus);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(gain);
      src.start();
      this.engine = { gain, src };
    }
    const t = this.ctx.currentTime;
    this.engine.gain.gain.setTargetAtTime(Math.max(0, Math.min(1, level)), t, 0.08);
  }

  setMusicVolume(v: number): void {
    this.musicVolume = v;
    localStorage.setItem('zenith-music-vol', String(v));
    if (this.musicBus && this.ctx) {
      this.musicBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    }
  }

  setSfxVolume(v: number): void {
    this.sfxVolume = v;
    localStorage.setItem('zenith-sfx-vol', String(v));
    if (this.sfxBus && this.ctx) {
      this.sfxBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    }
  }

  /** Wire a pair of range inputs (0–100) to the two volume buses. */
  bindSliders(musicId: string, sfxId: string): void {
    const music = document.getElementById(musicId) as HTMLInputElement | null;
    const sfx = document.getElementById(sfxId) as HTMLInputElement | null;
    if (music) {
      music.value = String(Math.round(this.musicVolume * 100));
      music.addEventListener('input', () => this.setMusicVolume(Number(music.value) / 100));
    }
    if (sfx) {
      sfx.value = String(Math.round(this.sfxVolume * 100));
      sfx.addEventListener('input', () => this.setSfxVolume(Number(sfx.value) / 100));
    }
  }

  /** Refresh slider positions (e.g. when opening a menu). */
  syncSliders(musicId: string, sfxId: string): void {
    const music = document.getElementById(musicId) as HTMLInputElement | null;
    const sfx = document.getElementById(sfxId) as HTMLInputElement | null;
    if (music) music.value = String(Math.round(this.musicVolume * 100));
    if (sfx) sfx.value = String(Math.round(this.sfxVolume * 100));
  }
}

export const AUDIO = new AudioManager();
