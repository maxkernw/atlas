import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
    registerOnlinePlayer,
    syncOnlinePlayerState,
    subscribeToOnlinePlayers,
    pushPersistedChatMessage,
    subscribeToPersistedChat,
    sendPvPCombatHit,
    subscribeToIncomingCombatHits,
    type OnlinePlayerState
} from './firebase';

// ============================================================================
// SUBTLE 90s VHS / CRT RETRO POST-PROCESSING SHADER PASS (Lightweight & Clean)
// Gentle edge RGB shift, faint CRT scanline & warm 90s analog tint
// ============================================================================
const VHS_RETRO_SHADER = {
    uniforms: {
        tDiffuse: { value: null },
        time: { value: 0.0 },
        enabled: { value: 0.0 }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float time;
        uniform float enabled;
        varying vec2 vUv;

        void main() {
            if (enabled < 0.5) {
                gl_FragColor = texture2D(tDiffuse, vUv);
                return;
            }

            vec2 uv = vUv;
            vec2 centered = uv - 0.5;
            float r2 = dot(centered, centered);

            // Very subtle 90s edge RGB chromatic shift (only noticeable near screen borders)
            float chromaOffset = 0.0006 + r2 * 0.0018;
            float r = texture2D(tDiffuse, uv + vec2(chromaOffset, 0.0)).r;
            float g = texture2D(tDiffuse, uv).g;
            float b = texture2D(tDiffuse, uv - vec2(chromaOffset, 0.0)).b;
            vec3 col = vec3(r, g, b);

            // Faint, non-intrusive CRT scanlines
            col -= sin(uv.y * 640.0) * 0.014;

            // Gentle 90s warm analog shadow tint & soft corner vignette
            float vignette = smoothstep(0.95, 0.25, r2);
            col *= mix(0.82, 1.0, vignette);

            gl_FragColor = vec4(col, 1.0);
        }
    `
};

// ============================================================================
// CPU PERLIN NOISE & FRACTAL BROWNIAN MOTION (FBM)
// ============================================================================
class Vector2D {
    constructor(public x: number, public y: number) {}
    dot(other: Vector2D): number {
        return this.x * other.x + this.y * other.y;
    }
}

const CONSTANT_VECTORS: Vector2D[] = [
    new Vector2D(1.0, 1.0),
    new Vector2D(-1.0, 1.0),
    new Vector2D(-1.0, -1.0),
    new Vector2D(1.0, -1.0)
];

function shuffleArray(arrayToShuffle: number[]) {
    for (let e = arrayToShuffle.length - 1; e > 0; e--) {
        const index = Math.round(Math.random() * (e - 1));
        const temp = arrayToShuffle[e];
        arrayToShuffle[e] = arrayToShuffle[index];
        arrayToShuffle[index] = temp;
    }
}

function makePermutation(): number[] {
    const permutation: number[] = [];
    for (let i = 0; i < 256; i++) {
        permutation.push(i);
    }
    shuffleArray(permutation);
    for (let i = 0; i < 256; i++) {
        permutation.push(permutation[i]);
    }
    return permutation;
}

const Permutation = makePermutation();

function getConstantVector(v: number): Vector2D {
    return CONSTANT_VECTORS[v & 3];
}

function fade(t: number): number {
    return ((6 * t - 15) * t + 10) * t * t * t;
}

function lerp(t: number, a1: number, a2: number): number {
    return a1 + t * (a2 - a1);
}

export function noise2D(x: number, y: number): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;

    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);

    const topRight = new Vector2D(xf - 1.0, yf - 1.0);
    const topLeft = new Vector2D(xf, yf - 1.0);
    const bottomRight = new Vector2D(xf - 1.0, yf);
    const bottomLeft = new Vector2D(xf, yf);

    const valueTopRight = Permutation[Permutation[X + 1] + Y + 1];
    const valueTopLeft = Permutation[Permutation[X] + Y + 1];
    const valueBottomRight = Permutation[Permutation[X + 1] + Y];
    const valueBottomLeft = Permutation[Permutation[X] + Y];

    const dotTopRight = topRight.dot(getConstantVector(valueTopRight));
    const dotTopLeft = topLeft.dot(getConstantVector(valueTopLeft));
    const dotBottomRight = bottomRight.dot(getConstantVector(valueBottomRight));
    const dotBottomLeft = bottomLeft.dot(getConstantVector(valueBottomLeft));

    const u = fade(xf);
    const v = fade(yf);

    return lerp(
        u,
        lerp(v, dotBottomLeft, dotTopLeft),
        lerp(v, dotBottomRight, dotTopRight)
    );
}

export function fractalBrownianMotion(
    x: number,
    y: number,
    numOctaves = 6,
    startFrequency = 0.015
): number {
    let result = 0.0;
    let amplitude = 1.0;
    let frequency = startFrequency;

    for (let octave = 0; octave < numOctaves; octave++) {
        const n = amplitude * noise2D(x * frequency, y * frequency);
        result += n;
        amplitude *= 0.5;
        frequency *= 2.0;
    }

    return result;
}

interface BiomePalette {
    name: string;
    cardinal: string;
    subtitle: string;
    weather: string;
    flora: string;
    skyColor: number;
    fogColor: number;
    nebulaPrimary: number;
    nebulaSecondary: number;
    sunCore: number;
    sunHalo: number;
    planetOcean: number;
    planetLand: number;
    planetAtmo: number;
    ringColor: number;
    crystalColor: number;
}

const BIOMES: BiomePalette[] = [
    {
        name: "VERIDIA-9",
        cardinal: "N",
        subtitle: "OUTRUN SYNTHWAVE WORLD",
        weather: "NEON SOLAR SHIMMER",
        flora: "ORBITAL SYNTH CRYSTALS",
        skyColor: 0x010005,
        fogColor: 0x04010c,
        nebulaPrimary: 0xff007f,
        nebulaSecondary: 0x00f0ff,
        sunCore: 0xfff75e,
        sunHalo: 0xff007f,
        planetOcean: 0x140538,
        planetLand: 0xff007f,
        planetAtmo: 0x00f0ff,
        ringColor: 0x00f0ff,
        crystalColor: 0xff007f
    },
    {
        name: "CYBERIA PRIME",
        cardinal: "E",
        subtitle: "ELECTRIC CYAN SUPER-EARTH",
        weather: "IONIC LASER DRIFT",
        flora: "CHROME VOID SPIRES",
        skyColor: 0x010006,
        fogColor: 0x03010d,
        nebulaPrimary: 0x7209b7,
        nebulaSecondary: 0x00f5d4,
        sunCore: 0xffbe0b,
        sunHalo: 0xf72585,
        planetOcean: 0x0b093b,
        planetLand: 0x00f5d4,
        planetAtmo: 0xffbe0b,
        ringColor: 0xf72585,
        crystalColor: 0x00f0ff
    },
    {
        name: "SOLARIS MIRAGE",
        cardinal: "S",
        subtitle: "SUNSET GOLD & MAGENTA EXOPLANET",
        weather: "RETROWAVE PLASMA BREEZE",
        flora: "ASTRAL MONOLITH FRAGMENTS",
        skyColor: 0x020005,
        fogColor: 0x06010c,
        nebulaPrimary: 0xff0055,
        nebulaSecondary: 0xffbe0b,
        sunCore: 0xfff75e,
        sunHalo: 0xff0055,
        planetOcean: 0x24042e,
        planetLand: 0xffbe0b,
        planetAtmo: 0xff007f,
        ringColor: 0x00f0ff,
        crystalColor: 0xffbe0b
    },
    {
        name: "ASTRAL ELYSIUM",
        cardinal: "W",
        subtitle: "ULTRAVIOLET DREAMWAVE GIANT",
        weather: "VELVET SYNTH WAVES",
        flora: "AMETHYST SPACE CORAL",
        skyColor: 0x010005,
        fogColor: 0x04010b,
        nebulaPrimary: 0x9d4edd,
        nebulaSecondary: 0x00f0ff,
        sunCore: 0xffea79,
        sunHalo: 0xb5179e,
        planetOcean: 0x10002b,
        planetLand: 0xe0aaff,
        planetAtmo: 0x00f5d4,
        ringColor: 0xff007f,
        crystalColor: 0x00f5d4
    }
];

interface CameraPreset {
    name: string;
    localOffset: THREE.Vector3;
    lookAheadDist: number;
    lookUpOffset: number;
    bankFactor: number;
    baseFov: number;
}

const CAMERA_PRESETS: CameraPreset[] = [
    {
        name: "LOW CHASE",
        localOffset: new THREE.Vector3(0, 1.45, 7.4),
        lookAheadDist: 42,
        lookUpOffset: 1.5,
        bankFactor: 0.32,
        baseFov: 68
    },
    {
        name: "WING CAM",
        localOffset: new THREE.Vector3(3.1, 1.25, 5.8),
        lookAheadDist: 38,
        lookUpOffset: 1.1,
        bankFactor: 0.42,
        baseFov: 66
    },
    {
        name: "CLOSE TAIL",
        localOffset: new THREE.Vector3(0, 0.9, 4.8),
        lookAheadDist: 48,
        lookUpOffset: 1.2,
        bankFactor: 0.48,
        baseFov: 74
    },
    {
        name: "WIDE VISTA",
        localOffset: new THREE.Vector3(-2.6, 3.8, 12.0),
        lookAheadDist: 45,
        lookUpOffset: 1.8,
        bankFactor: 0.2,
        baseFov: 62
    }
];

interface PlanetNode {
    group: THREE.Group;
    mesh: THREE.Mesh;
    material: THREE.ShaderMaterial;
    ring: THREE.Mesh;
    moonPivot: THREE.Group;
    moon: THREE.Mesh;
    biomeIdx: number;
    discoveredCount: number;
    discoveredInCurrentPass?: boolean;
    customName?: string;
    customSubtitle?: string;
    customWeather?: string;
    baseScale?: number;
    appearProgress?: number;
}

interface DistantPlanet {
    group: THREE.Group;
    mesh: THREE.Mesh;
    material: THREE.ShaderMaterial;
    offset: THREE.Vector3;
    rotSpeed: number;
}

interface CosmicComet {
    mesh: THREE.Mesh;
    vel: THREE.Vector3;
    colorHex: number;
    life: number;
}

interface AIPlayer {
    group: THREE.Group;
    hullMesh: THREE.Mesh;
    nameSprite: THREE.Sprite;
    callsign: string;
    status: string;
    colorHex: number;
    hull: number;
    hostileTimer: number;
    yaw: number;
    targetYaw: number;
    roll: number;
    pitch: number;
    speed: number;
    targetY: number;
    decisionTimer: number;
    beamCooldown: number;
}

interface RemotePlayerActor {
    id: string;
    group: THREE.Group;
    hullMesh: THREE.Mesh;
    gltfMat?: THREE.MeshStandardMaterial;
    nameSprite: THREE.Sprite;
    callsign: string;
    colorHex: number;
    hull: number;
    isCustomizing: boolean;
    killCooldown: number;
    lastDamagedAt: number;
    targetPos: THREE.Vector3;
    targetYaw: number;
    targetRoll: number;
    targetPitch: number;
}

const DEFAULT_TRAVELLER_PROFILES: { callsign: string; status: string; colorHex: number }[] = [
    { callsign: 'ASTRA_99', status: 'SCANNING', colorHex: 0x00f0ff },
    { callsign: 'VALKYRIE_SE', status: 'WARP DRIFT', colorHex: 0xffbe6b },
    { callsign: 'NOVA_DRIFTER', status: 'EXPLORING', colorHex: 0x00f5d4 },
    { callsign: 'KRONOS_VII', status: 'HARVESTING', colorHex: 0xc77dff },
    { callsign: 'LYRA_SYNTH', status: 'CRUISING', colorHex: 0xff5e7e },
    { callsign: 'ORION_PULSE', status: 'MAPPING', colorHex: 0x72efdd },
    { callsign: 'ZEPHYR_01', status: 'PATROLLING', colorHex: 0xff2a9d },
    { callsign: 'CYBER_KNIGHT', status: 'INTERCEPTING', colorHex: 0x00bbf9 },
    { callsign: 'NEON_VIPER', status: 'HUNTING', colorHex: 0xf72585 },
    { callsign: 'VEGA_OUTRUN', status: 'DRIFTING', colorHex: 0xfee440 },
    { callsign: 'SOLARIS_84', status: 'SURVEYING', colorHex: 0xff9f1c },
    { callsign: 'HYPERION_X', status: 'RAIDING', colorHex: 0x9b5de5 },
    { callsign: 'ANDROMEDA_V', status: 'CHARTING', colorHex: 0x00f5d4 },
    { callsign: 'PHOENIX_VHS', status: 'REWINDING', colorHex: 0xff007f },
    { callsign: 'MIRAGE_ZERO', status: 'CLOAKED', colorHex: 0x4cc9f0 }
];

const HULL_PRESETS: {
    name: string;
    color: number;
    emissive: number;
    hue: number;
    chrome: number;
    glow: number;
    css: string;
}[] = [
    { name: 'CYBER VIOLET', color: 0x3b1278, emissive: 0x6200ea, hue: 268, chrome: 78, glow: 105, css: '#7b2cbf' },
    { name: 'OUTRUN CRIMSON', color: 0xb80038, emissive: 0xff0055, hue: 342, chrome: 72, glow: 125, css: '#ff0055' },
    { name: 'HYPER CYAN', color: 0x006d94, emissive: 0x00b4d8, hue: 194, chrome: 82, glow: 115, css: '#00f0ff' },
    { name: 'SOLAR GOLD', color: 0xc48600, emissive: 0xff9e00, hue: 42, chrome: 92, glow: 110, css: '#ffbe0b' },
    { name: 'LIQUID SILVER', color: 0xc8d8e8, emissive: 0x3a5a78, hue: 210, chrome: 98, glow: 75, css: '#d8e8f8' },
    { name: 'ACID VIPER', color: 0x008562, emissive: 0x00f5d4, hue: 165, chrome: 75, glow: 125, css: '#00f5d4' },
    { name: 'MIAMI MAGENTA', color: 0x99006e, emissive: 0xff00a0, hue: 318, chrome: 80, glow: 130, css: '#ff2a9d' },
    { name: 'STEALTH CARBON', color: 0x140d24, emissive: 0x1e0b36, hue: 270, chrome: 22, glow: 45, css: '#241838' }
];

const TRIM_COLORS: { name: string; hex: number; css: string }[] = [
    { name: 'HOT PINK', hex: 0xff007f, css: '#ff007f' },
    { name: 'ELECTRIC CYAN', hex: 0x00f0ff, css: '#00f0ff' },
    { name: 'OUTRUN GOLD', hex: 0xffbe0b, css: '#ffbe0b' },
    { name: 'ACID MINT', hex: 0x00f5d4, css: '#00f5d4' },
    { name: 'ULTRAVIOLET', hex: 0xc77dff, css: '#c77dff' },
    { name: 'SUNSET CORAL', hex: 0xff5e7e, css: '#ff5e7e' },
    { name: 'LASER LIME', hex: 0x80ff00, css: '#80ff00' },
    { name: 'PURE WHITE', hex: 0xffffff, css: '#ffffff' }
];

const TRAIL_PRESETS: { name: string; colors: [number, number]; css: string }[] = [
    { name: 'DUAL SYNTH', colors: [0x00f0ff, 0xff007f], css: 'linear-gradient(135deg, #00f0ff, #ff007f)' },
    { name: 'PLASMA CYAN', colors: [0x00f0ff, 0x00f5d4], css: '#00f0ff' },
    { name: 'OUTRUN MAGENTA', colors: [0xff007f, 0xff5e7e], css: '#ff007f' },
    { name: 'SOLAR FLARE', colors: [0xffbe0b, 0xff0055], css: 'linear-gradient(135deg, #ffbe0b, #ff0055)' },
    { name: 'CYBER MINT', colors: [0x00f5d4, 0x72efdd], css: '#00f5d4' },
    { name: 'AMETHYST VOID', colors: [0xc77dff, 0x7209b7], css: '#c77dff' }
];

const CHASSIS_PROFILES: { name: string; scale: [number, number, number]; wingspan: number; length: number; bulk: number }[] = [
    { name: 'INTERCEPTOR', scale: [0.12, 0.12, 0.12], wingspan: 100, length: 100, bulk: 100 },
    { name: 'WIDE DELTA', scale: [0.16, 0.105, 0.115], wingspan: 135, length: 95, bulk: 88 },
    { name: 'NEEDLE DART', scale: [0.092, 0.108, 0.155], wingspan: 76, length: 132, bulk: 90 },
    { name: 'HEAVY VANGUARD', scale: [0.145, 0.142, 0.135], wingspan: 122, length: 114, bulk: 120 }
];

const AURA_STYLES: string[] = ['ICOSAHEDRON', 'GYRO RING', 'OCTA CRYSTAL', 'STEALTH OFF'];

class AmbientAudio {
    private ctx: AudioContext | null = null;
    private masterGain: GainNode | null = null;
    private reverbNode: ConvolverNode | null = null;
    private isMuted = false;
    private isRunning = false;
    private chordTimer: number | null = null;
    private arpTimer: number | null = null;
    private bassTimer: number | null = null;
    private chordIndex = 0;
    private bassStep = 0;

    private readonly chords: { root: number; notes: number[] }[] = [
        { root: 55.00, notes: [110.00, 164.81, 220.00, 261.63, 329.63] },
        { root: 43.65, notes: [87.31, 174.61, 220.00, 261.63, 329.63] },
        { root: 65.41, notes: [130.81, 196.00, 246.94, 293.66, 392.00] },
        { root: 49.00, notes: [98.00, 196.00, 246.94, 293.66, 369.99] }
    ];

    private readonly scaleNotes: number[] = [
        440.00, 523.25, 587.33, 659.25, 783.99, 880.00, 987.77, 1046.50, 1174.66
    ];

    public async init() {
        if (this.ctx) {
            if (this.ctx.state === 'suspended') await this.ctx.resume();
            return;
        }
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = new AudioCtx();
        if (this.ctx.state === 'suspended') {
            await this.ctx.resume();
        }

        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.setValueAtTime(0.01, this.ctx.currentTime);
        this.masterGain.gain.linearRampToValueAtTime(0.36, this.ctx.currentTime + 2.0);

        this.reverbNode = this.createReverb(4.5, 2.0);

        const dryGain = this.ctx.createGain();
        dryGain.gain.value = 0.52;
        const wetGain = this.ctx.createGain();
        wetGain.gain.value = 0.72;

        this.masterGain.connect(dryGain);
        this.masterGain.connect(this.reverbNode);
        this.reverbNode.connect(wetGain);

        dryGain.connect(this.ctx.destination);
        wetGain.connect(this.ctx.destination);

        this.isRunning = true;
        this.startPadLoop();
        this.startChillBassPulse();
        this.startDreamArp();
    }

    private createReverb(duration: number, decay: number): ConvolverNode {
        const ctx = this.ctx!;
        const rate = ctx.sampleRate;
        const length = rate * duration;
        const impulse = ctx.createBuffer(2, length, rate);
        for (let ch = 0; ch < 2; ch++) {
            const data = impulse.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
            }
        }
        const convolver = ctx.createConvolver();
        convolver.buffer = impulse;
        return convolver;
    }

    private startPadLoop() {
        const playNextChord = () => {
            if (!this.ctx || !this.masterGain || !this.isRunning) return;
            const current = this.chords[this.chordIndex % this.chords.length];
            this.chordIndex++;

            const now = this.ctx.currentTime;
            const duration = 8.5;

            current.notes.forEach((freq, idx) => {
                if (!this.ctx || !this.masterGain) return;
                const osc1 = this.ctx.createOscillator();
                const osc2 = this.ctx.createOscillator();
                const filter = this.ctx.createBiquadFilter();
                const gain = this.ctx.createGain();

                osc1.type = 'sawtooth';
                osc2.type = 'triangle';

                osc1.frequency.setValueAtTime(freq * 0.997, now);
                osc2.frequency.setValueAtTime(freq * 1.004, now);

                filter.type = 'lowpass';
                filter.Q.value = 1.2;
                filter.frequency.setValueAtTime(280 + idx * 90, now);
                filter.frequency.exponentialRampToValueAtTime(950 + idx * 130, now + duration * 0.48);
                filter.frequency.exponentialRampToValueAtTime(300 + idx * 80, now + duration);

                const peakGain = 0.032 / Math.sqrt(idx + 1);
                gain.gain.setValueAtTime(0.0001, now);
                gain.gain.linearRampToValueAtTime(peakGain, now + duration * 0.3);
                gain.gain.linearRampToValueAtTime(peakGain * 0.85, now + duration * 0.7);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

                osc1.connect(filter);
                osc2.connect(filter);
                filter.connect(gain);
                gain.connect(this.masterGain);

                osc1.start(now);
                osc2.start(now);
                osc1.stop(now + duration + 0.1);
                osc2.stop(now + duration + 0.1);
            });
        };

        playNextChord();
        this.chordTimer = window.setInterval(playNextChord, 7200);
    }

    private startChillBassPulse() {
        const stepMs = 325;
        this.bassTimer = window.setInterval(() => {
            if (!this.ctx || !this.masterGain || !this.isRunning || this.isMuted) return;
            const currentChord = this.chords[(this.chordIndex - 1 + this.chords.length) % this.chords.length];
            const pattern = [1, 1, 2, 1, 1, 1.5, 1, 2];
            const mult = pattern[this.bassStep % pattern.length];
            this.bassStep++;

            const now = this.ctx.currentTime;
            const osc = this.ctx.createOscillator();
            const filter = this.ctx.createBiquadFilter();
            const gain = this.ctx.createGain();

            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(currentChord.root * mult, now);

            filter.type = 'lowpass';
            filter.Q.value = 2.0;
            filter.frequency.setValueAtTime(360, now);
            filter.frequency.exponentialRampToValueAtTime(110, now + 0.26);

            gain.gain.setValueAtTime(0.001, now);
            gain.gain.linearRampToValueAtTime(0.042, now + 0.025);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.29);

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(this.masterGain);

            osc.start(now);
            osc.stop(now + 0.31);
        }, stepMs);
    }

    private startDreamArp() {
        let arpIdx = 0;
        const arpPattern = [0, 2, 4, 7, 4, 2, 5, 4];
        const scheduleArp = () => {
            if (!this.isRunning) return;
            // Classic 80s Outrun rhythmic 16th/8th-note synthwave arpeggiator
            const delay = 325;
            this.arpTimer = window.setTimeout(() => {
                if (this.ctx && this.masterGain && !this.isMuted) {
                    const noteIdx = arpPattern[arpIdx % arpPattern.length];
                    arpIdx++;
                    const note = this.scaleNotes[noteIdx % this.scaleNotes.length];
                    const octaveShift = arpIdx % 16 === 0 ? 1.0 : 0.5;
                    this.playSynthPluck(note * octaveShift, 0.026, 0.95);
                }
                scheduleArp();
            }, delay);
        };
        scheduleArp();
    }

    private playSynthPluck(freq: number, volume: number, duration: number) {
        if (!this.ctx || !this.masterGain) return;
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const filter = this.ctx.createBiquadFilter();
        const gain = this.ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1800, now);
        filter.frequency.exponentialRampToValueAtTime(400, now + duration);

        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(volume, now + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.masterGain);

        osc.start(now);
        osc.stop(now + duration + 0.05);
    }

    public playHarvestChime() {
        if (!this.ctx || !this.masterGain) return;
        const note = this.scaleNotes[Math.floor(Math.random() * this.scaleNotes.length)];
        this.playSynthPluck(note, 0.016, 1.2);
        setTimeout(() => this.playSynthPluck(note * 1.25, 0.011, 1.4), 85);
    }

    public playPortalChord() {
        if (!this.ctx || !this.masterGain) return;
        const base = [440.00, 523.25, 659.25, 783.99, 987.77];
        base.forEach((n, i) => {
            setTimeout(() => this.playSynthPluck(n, 0.055, 2.8), i * 70);
        });
    }

    public playBeamPulse() {
        if (!this.ctx || !this.masterGain) return;
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(659.25, now);
        osc.frequency.exponentialRampToValueAtTime(329.63, now + 0.22);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.045, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 0.28);
    }

    public playScannerWave() {
        if (!this.ctx || !this.masterGain) return;
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 1.0);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.055, now + 0.2);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 1.15);
    }

    public playImpactSound() {
        if (!this.ctx || !this.masterGain) return;
        const now = this.ctx.currentTime;

        // 1. Sub-bass hull thud
        const osc = this.ctx.createOscillator();
        const subGain = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(145, now);
        osc.frequency.exponentialRampToValueAtTime(28, now + 0.42);
        subGain.gain.setValueAtTime(0.18, now);
        subGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
        osc.connect(subGain);
        subGain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 0.48);

        // 2. Metallic shield crunch burst
        const bufferSize = Math.floor(this.ctx.sampleRate * 0.28);
        const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 1.8);
        }
        const noise = this.ctx.createBufferSource();
        noise.buffer = noiseBuffer;
        const bandpass = this.ctx.createBiquadFilter();
        bandpass.type = 'bandpass';
        bandpass.frequency.setValueAtTime(620, now);
        bandpass.Q.value = 1.4;
        const noiseGain = this.ctx.createGain();
        noiseGain.gain.setValueAtTime(0.16, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
        noise.connect(bandpass);
        bandpass.connect(noiseGain);
        noiseGain.connect(this.masterGain);
        noise.start(now);
    }

    public playLaserHitSound(isKill = false) {
        if (!this.ctx || !this.masterGain) return;
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(isKill ? 880 : 520, now);
        osc.frequency.exponentialRampToValueAtTime(isKill ? 110 : 180, now + (isKill ? 0.38 : 0.18));
        gain.gain.setValueAtTime(0.11, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + (isKill ? 0.4 : 0.2));
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + (isKill ? 0.42 : 0.22));
    }

    public toggleMute(): boolean {
        if (!this.ctx || !this.masterGain) {
            this.init();
            return false;
        }
        this.isMuted = !this.isMuted;
        const now = this.ctx.currentTime;
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.linearRampToValueAtTime(this.isMuted ? 0.0 : 0.36, now + 0.35);
        return this.isMuted;
    }

    public destroy() {
        this.isRunning = false;
        if (this.chordTimer) clearInterval(this.chordTimer);
        if (this.arpTimer) clearTimeout(this.arpTimer);
        if (this.bassTimer) clearInterval(this.bassTimer);
        if (this.ctx) {
            this.ctx.close().catch(() => {});
        }
    }
}

// ============================================================================
// AUTHENTIC DEEP-SPACE SKYBOX SHADER
// 95% pitch-black cosmic void, crisp procedural pinpoint starfield layers,
// and a faint, realistic Milky Way stardust band with dark dust rifts (no tie-dye!)
// ============================================================================
const NEBULA_VERTEX_SHADER = `
varying vec3 vWorldDir;
void main() {
    vWorldDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const NEBULA_FRAGMENT_SHADER = `
varying vec3 vWorldDir;
uniform sampler2D uPerlinTex;
uniform vec3 skyColor;
uniform vec3 nebulaPrimary;
uniform vec3 nebulaSecondary;
uniform float time;
uniform vec3 uShipPos;

vec3 hash33(vec3 p) {
    p = fract(p * vec3(443.8975, 397.2973, 491.1871));
    p += dot(p.zxy, p.yxz + 19.27);
    return fract(vec3(p.x * p.y, p.z * p.x, p.y * p.z));
}

// Crisp 3D directional cell stars (renders sharp pinpoint background stars at infinity)
vec3 starFieldLayer(vec3 dir, float scale, float threshold, float timeSec) {
    vec3 p = dir * scale;
    vec3 id = floor(p);
    vec3 f = fract(p) - 0.5;
    vec3 rnd = hash33(id);
    if (rnd.x < threshold) return vec3(0.0);

    vec3 starPos = (rnd - 0.5) * 0.68;
    float d = length(f - starPos);
    float size = mix(0.035, 0.085, fract(rnd.y * 13.7));
    float spark = smoothstep(size, 0.0, d);
    spark = pow(spark, 2.4);

    // Subtle stellar scintillation
    float twinkle = 0.82 + 0.18 * sin(timeSec * (1.5 + rnd.z * 3.0) + rnd.x * 60.0);

    // Realistic stellar color temperatures (blue-white, pure white, warm gold, faint rose)
    vec3 starCol = mix(vec3(0.75, 0.88, 1.0), vec3(1.0, 0.94, 0.82), rnd.y);
    if (rnd.z > 0.86) starCol = vec3(0.55, 0.95, 1.0);
    else if (rnd.z < 0.12) starCol = vec3(1.0, 0.65, 0.85);

    return starCol * spark * twinkle;
}

float sampleDustNoise(vec3 dir, float scale, vec2 offset) {
    float xz = texture2D(uPerlinTex, dir.xz * scale + 0.5 + offset).r;
    float xy = texture2D(uPerlinTex, dir.xy * scale + 0.5 - offset * 0.7).r;
    return mix(xy, xz, abs(dir.y));
}

void main() {
    vec3 dir = normalize(vWorldDir);

    // 1. Deep, pitch-black outer space void
    vec3 col = vec3(0.003, 0.001, 0.009);

    // 2. Subtle Milky Way Galactic Plane (tilted great circle across the vault of space)
    float galCoord = dir.y * 0.78 + dir.x * 0.58 - dir.z * 0.18;
    float galacticBand = exp(-abs(galCoord) * 5.5);
    float galacticCore = exp(-abs(galCoord) * 14.0);

    // High-frequency dark interstellar dust lanes carved out of the faint galactic band
    vec2 slowDrift = uShipPos.xz * 0.00008 + vec2(time * 0.0015, 0.0);
    float n1 = sampleDustNoise(dir, 2.6, slowDrift);
    float n2 = sampleDustNoise(dir + vec3(n1 * 0.18), 5.8, -slowDrift);
    float dustStructure = n1 * 0.55 + n2 * 0.45;

    // Dark rift down the center of the Milky Way (absorbs light like real cosmic dust)
    float darkRift = smoothstep(0.32, 0.62, dustStructure) * (1.0 - 0.65 * galacticCore * smoothstep(0.58, 0.35, n2));

    // Whisper-subtle cosmic starlight haze inside the Milky Way band (max ~0.075 brightness)
    vec3 mwSilverBlue = vec3(0.14, 0.20, 0.34);
    vec3 mwWarmCore = mix(vec3(0.24, 0.12, 0.28), nebulaPrimary * 0.28, 0.35);
    col += mix(mwSilverBlue, mwWarmCore, n1) * galacticBand * darkRift * 0.085;

    // 3. Faint directional glow only toward the North (-Z) Outrun Sun on the horizon
    float sunAlign = max(0.0, -dir.z);
    float sunHorizon = exp(-abs(dir.y - 0.04) * 9.0) * pow(sunAlign, 4.0);
    col += nebulaPrimary * sunHorizon * 0.16;

    // 4. Multi-scale sharp pinpoint stars across the entire 360° sky dome
    // Layer A: Bright primary stars across all of space
    col += starFieldLayer(dir, 85.0, 0.89, time) * 1.25;
    // Layer B: Medium background stars across all of space
    col += starFieldLayer(dir + vec3(0.37), 155.0, 0.84, time) * 0.85;
    // Layer C: Dense unresolved micro-stardust concentrated along the Milky Way band
    if (galacticBand > 0.08) {
        col += starFieldLayer(dir + vec3(0.71), 260.0, 0.72, time) * galacticBand * darkRift * 0.95;
    }

    gl_FragColor = vec4(col, 1.0);
}
`;

// ============================================================================
// INFINITE NON-POPPING 3D STARFIELD SHADER
// Each star wraps individually in a 1600-unit cube around the ship with smooth edge fade
// ============================================================================
const STARFIELD_VERTEX_SHADER = `
attribute vec3 color;
attribute float aSize;
varying vec3 vColor;
varying float vAlpha;
uniform vec3 uShipPos;

void main() {
    vColor = color;
    float boxSize = 1600.0;
    float halfBox = 800.0;

    // Wrap each star smoothly relative to the ship so the starfield never snaps or flickers
    vec3 relPos = mod(position - uShipPos + halfBox, boxSize) - halfBox;
    vec3 worldPos = uShipPos + relPos;

    float dist = length(relPos);
    vAlpha = smoothstep(790.0, 450.0, dist);

    vec4 mvPos = modelViewMatrix * vec4(worldPos, 1.0);
    gl_Position = projectionMatrix * mvPos;
    gl_PointSize = clamp(aSize * (320.0 / max(-mvPos.z, 10.0)), 1.0, 4.5);
}
`;

const STARFIELD_FRAGMENT_SHADER = `
varying vec3 vColor;
varying float vAlpha;

void main() {
    vec2 c = gl_PointCoord - vec2(0.5);
    float r = length(c) * 2.0;
    if (r > 1.0) discard;
    float glow = pow(1.0 - r, 1.8);
    gl_FragColor = vec4(vColor, glow * vAlpha);
}
`;

// ============================================================================
// 3D PLANET SHADER (Uses /perlin.png for displacement, continents, clouds & specular reflection)
// ============================================================================
const PLANET_VERTEX_SHADER = `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewDir;
varying float vHeight;
uniform sampler2D uPerlinTex;
uniform float time;

void main() {
    vUv = uv;
    float h1 = texture2D(uPerlinTex, uv * 1.8 + vec2(time * 0.008, 0.0)).r;
    float h2 = texture2D(uPerlinTex, uv * 4.2 - vec2(time * 0.004, 0.0)).r;
    float height = h1 * 0.7 + h2 * 0.3;
    vHeight = height;

    vec3 displaced = position + normal * (smoothstep(0.45, 0.8, height) * 3.2);
    vec4 mvPos = modelViewMatrix * vec4(displaced, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(-mvPos.xyz);
    gl_Position = projectionMatrix * mvPos;
}
`;

const PLANET_FRAGMENT_SHADER = `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewDir;
varying float vHeight;
uniform sampler2D uPerlinTex;
uniform float time;
uniform vec3 oceanColor;
uniform vec3 landColor;
uniform vec3 atmoColor;
uniform float uOpacity;

void main() {
    float landMask = smoothstep(0.48, 0.54, vHeight);
    float highlandMask = smoothstep(0.62, 0.78, vHeight);
    float coastGlow = smoothstep(0.05, 0.0, abs(vHeight - 0.50));

    float clouds = texture2D(uPerlinTex, vUv * 2.5 + vec2(-time * 0.018, time * 0.005)).r;
    float cloudMask = smoothstep(0.58, 0.82, clouds);

    vec3 surfaceCol = mix(oceanColor, landColor, landMask);
    surfaceCol = mix(surfaceCol, atmoColor, highlandMask * 0.55);
    surfaceCol += atmoColor * coastGlow * 1.15;

    surfaceCol = mix(surfaceCol, vec3(1.0, 0.92, 1.0), cloudMask * 0.42);

    vec3 lightDir = normalize(vec3(0.4, 0.6, 0.7));
    float diff = max(dot(vNormal, lightDir), 0.22);

    vec3 halfVec = normalize(lightDir + vViewDir);
    float spec = pow(max(dot(vNormal, halfVec), 0.0), 28.0) * (1.0 - landMask);

    float fresnel = pow(1.0 - max(dot(vNormal, vViewDir), 0.0), 2.2);

    vec3 finalCol = surfaceCol * diff + atmoColor * spec * 1.1 + atmoColor * fresnel * 1.65;
    gl_FragColor = vec4(finalCol, uOpacity);
}
`;

// Shared geometries so particles & beams NEVER allocate new WebGL buffers per frame!
const SHARED_MOTE_GEO = new THREE.OctahedronGeometry(1.0, 0);
const SHARED_BEAM_GEO = new THREE.SphereGeometry(0.42, 8, 8);
const SHARED_AI_HULL_GEO = new THREE.ConeGeometry(1.15, 3.6, 4);
SHARED_AI_HULL_GEO.rotateX(-Math.PI / 2);
SHARED_AI_HULL_GEO.scale(1.4, 0.42, 1.0);
const SHARED_AI_EDGES_GEO = new THREE.EdgesGeometry(SHARED_AI_HULL_GEO, 15);

class MoteParticle {
    mesh: THREE.Mesh;
    velocity: THREE.Vector3;
    life = 1.0;
    baseSize: number;
    homingTarget: THREE.Object3D | null;

    constructor(pos: THREE.Vector3, color: number, homingTarget: THREE.Object3D | null = null, size = 0.26) {
        this.baseSize = size;
        this.mesh = new THREE.Mesh(
            SHARED_MOTE_GEO,
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 })
        );
        this.mesh.scale.setScalar(size);
        this.mesh.position.copy(pos);
        this.homingTarget = homingTarget;
        this.velocity = new THREE.Vector3(
            (Math.random() - 0.5) * 0.45,
            (Math.random() - 0.5) * 0.45 + 0.12,
            (Math.random() - 0.5) * 0.45
        );
    }

    update(delta: number): boolean {
        if (this.homingTarget) {
            const targetPos = this.homingTarget.position;
            const dir = new THREE.Vector3().subVectors(targetPos, this.mesh.position);
            const dist = dir.length();
            if (dist < 1.8) {
                return false;
            }
            dir.normalize().multiplyScalar(delta * 28.0);
            this.velocity.lerp(dir, 0.18);
        }
        this.mesh.position.add(this.velocity);
        this.life -= delta * (this.homingTarget ? 0.65 : 1.35);
        (this.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, this.life);
        this.mesh.scale.setScalar(Math.max(0.01, this.life * this.baseSize));
        return this.life > 0;
    }

    dispose() {
        (this.mesh.material as THREE.Material).dispose();
    }
}

export class Game {
    private scene: THREE.Scene;
    private camera: THREE.PerspectiveCamera;
    private renderer: THREE.WebGLRenderer;
    private composer!: EffectComposer;
    private bloomPass!: UnrealBloomPass;
    private vhsPass!: ShaderPass;
    private vhsEnabled = false;
    private pmremGenerator!: THREE.PMREMGenerator;
    private envRT: THREE.WebGLRenderTarget | null = null;
    private clock: THREE.Clock;

    private score = 0;
    private mineralsHarvested = 0;
    private worldsExplored = 0;
    private hullIntegrity = 100;
    private damageCooldown = 0;
    private screenShake = 0;
    private isDestroyed = false;

    private baseSpeed = 42.0;
    private speedMultiplier = 1.0;
    private portalBoost = 0.0;

    // 360-degree WASD Navigation State
    private shipYaw = 0;
    private targetYaw = 0;
    private shipRoll = 0;
    private shipPitch = 0.04;
    private targetShipY = 3.6;
    private readonly MODEL_LEVEL_PITCH = 0.08;
    private keysPressed: Record<string, boolean> = {};

    private ship: THREE.Object3D | null = null;
    private rawShipModel: THREE.Object3D | null = null;
    private shipHullMaterials: THREE.MeshStandardMaterial[] = [];
    private shipTrimLines: THREE.LineBasicMaterial[] = [];
    private shipPrimaryLight: THREE.PointLight | null = null;
    private shipRearLight: THREE.PointLight | null = null;
    private shipShowroomLight: THREE.PointLight | null = null;
    private shipThrusterMats: THREE.MeshBasicMaterial[] = [];
    private shipAccentMats: THREE.MeshBasicMaterial[] = [];
    private hangarPlatformGroup: THREE.Group | null = null;
    private hangarRingMats: THREE.MeshBasicMaterial[] = [];
    private shieldMesh: THREE.Mesh | null = null;

    // Spaceship Customizer State & Sliders
    private isCustomizing = true;
    private customOrbitAngle = 0.55;
    private customOrbitPitch = 0.24;
    private customOrbitRadius = 5.4;
    private isDraggingShowroom = false;
    private lastShowroomPointerX = 0;
    private lastShowroomPointerY = 0;
    private showroomDragIdleTimer = 0;
    private pilotCallsign = 'STARLORD_84';
    private hullPresetIdx = 0;
    private useCustomHullHue = false;
    private hullHue = 268;
    private glowPct = 105;
    private chromePct = 78;
    private wingspanPct = 100;
    private lengthPct = 100;
    private bulkPct = 100;
    private auraScalePct = 100;
    private trimColorIdx = 0;
    private trailPresetIdx = 0;
    private chassisIdx = 0;
    private auraStyleIdx = 0;
    private perlinTexture!: THREE.Texture;
    private perlinPixels: Uint8ClampedArray | null = null;
    private perlinSize = 256;
    private perlinEventCooldown = 9.0;
    private comets: CosmicComet[] = [];
    private nebulaDome!: THREE.Mesh;
    private nebulaMaterial!: THREE.ShaderMaterial;
    private starfieldMaterial!: THREE.ShaderMaterial;
    private sunMesh!: THREE.Mesh;
    private sunMaterial!: THREE.ShaderMaterial;

    private planets: PlanetNode[] = [];
    private distantPlanets: DistantPlanet[] = [];
    private aiPlayers: AIPlayer[] = [];
    private remotePlayers: Map<string, RemotePlayerActor> = new Map();
    private botsActive = true;
    private localPlayerId = 'pilot_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
    private rtdbSyncTimer = 0;
    private rtdbCleanups: (() => void)[] = [];
    private seenChatIds: Set<string> = new Set();
    private cleanShipTemplate: THREE.Object3D | null = null;
    private leaderboardPilotNames: string[] = [];
    private mmoFeedTimer = 2.5;
    private pendingReplyTimeout: number | null = null;
    private crystals: THREE.Group[] = [];
    private asteroids: THREE.Mesh[] = [];
    private pulses: {
        mesh: THREE.Mesh;
        dir: THREE.Vector3;
        life: number;
        isPlayerShot: boolean;
        ownerCallsign?: string;
        targetObj?: THREE.Object3D | null;
    }[] = [];
    private particles: MoteParticle[] = [];
    private rings: THREE.Mesh[] = [];
    private stars!: THREE.Points;

    private cameraPresetIdx = 0;
    private lookAtTarget = new THREE.Vector3(0, 3.5, -45);

    private currentBiomeIdx = 0;
    private targetBiome: BiomePalette = BIOMES[0];
    private currentSkyColor = new THREE.Color(BIOMES[0].skyColor);
    private currentFogColor = new THREE.Color(BIOMES[0].fogColor);
    private currentNebulaPrimary = new THREE.Color(BIOMES[0].nebulaPrimary);
    private currentNebulaSecondary = new THREE.Color(BIOMES[0].nebulaSecondary);
    private currentSunCore = new THREE.Color(BIOMES[0].sunCore);
    private currentSunHalo = new THREE.Color(BIOMES[0].sunHalo);

    private audio = new AmbientAudio();
    private onGameOver: (score: number) => void;
    private resizeHandler = () => this.onWindowResize();

    constructor(container: HTMLElement, onGameOver: (score: number) => void) {
        this.onGameOver = onGameOver;
        this.clock = new THREE.Clock();

        container.innerHTML = `
            <div id="damage-flash-overlay"></div>
            <div id="game-ui">
                <div class="hud-top-bar">
                    <div class="hud-stat">
                        <span class="hud-label">DISCOVERY UNITS</span>
                        <span id="game-score" class="hud-value">0</span>
                    </div>
                    <div class="hud-divider"></div>
                    <div class="hud-stat">
                        <span class="hud-label">WORLDS</span>
                        <span id="mineral-count" class="hud-value">0</span>
                    </div>
                    <div class="hud-divider"></div>
                    <div class="hud-stat">
                        <span class="hud-label">HULL</span>
                        <span id="hull-value" class="hud-value">100%</span>
                    </div>
                    <div class="hud-divider"></div>
                    <div class="hud-stat">
                        <span class="hud-label">NEAREST WORLD</span>
                        <span id="system-name" class="hud-value">VERIDIA-9 [N]</span>
                    </div>
                </div>
                <div class="compass-bar">
                    <span id="compass-readout" class="compass-heading">HDG: N 000°</span>
                    <span class="compass-hint">WASD: TURN & THRUST  •  CLICK / [F]: SHOOT LASERS</span>
                    <span id="mmo-online-count" class="mmo-online-badge">● ${DEFAULT_TRAVELLER_PROFILES.length + 1} TRAVELLERS IN SECTOR</span>
                </div>
                <div class="harmony-bar-wrap" title="Starship Hull & Shield Integrity">
                    <div id="shield-bar" style="width: 100%;"></div>
                </div>
            </div>

            <div id="vhs-osd-overlay" style="display: none;">
                <div class="vhs-osd-row">PLAY ► <span class="vhs-sp">SP</span></div>
                <div id="vhs-tape-timer" class="vhs-osd-sub">T-120  00:00:00</div>
                <div class="vhs-osd-date">OCT 29 1994</div>
            </div>

            <div id="mmo-chat-panel">
                <div class="mmo-chat-header">
                    <span>SUBSPACE COMMS // SECTOR CHAT</span>
                    <span class="chat-live-dot">● LIVE</span>
                </div>
                <div id="mmo-chat-messages" class="mmo-chat-messages">
                    <div class="chat-msg system-event">✦ Connected to Synthwave Relay [Sector 84-A]</div>
                </div>
                <div class="mmo-chat-input-row">
                    <input id="mmo-chat-input" type="text" maxlength="110" placeholder="Transmit to sector [ENTER]..." autocomplete="off" />
                    <button id="mmo-chat-send" type="button">SEND</button>
                </div>
            </div>

            <div id="discovery-banner">
                <div class="discovery-tag">ATLAS // PLANET DISCOVERED</div>
                <div id="banner-planet" class="discovery-planet">VERIDIA-9</div>
                <div id="banner-meta" class="discovery-meta">SYNTHWAVE BIOLUMINESCENT WORLD // WEATHER: ZERO-G SOLAR SHIMMER</div>
            </div>

            <div id="ship-customizer-panel" class="customizer-visible">
                <div class="customizer-header">
                    <div class="customizer-tag">ORBITAL HANGAR // BAY 01</div>
                    <h2 class="customizer-title">CUSTOMIZE STARSHIP</h2>
                    <div class="customizer-subhint">DRAG SHIP TO SPIN • SCROLL TO ZOOM</div>
                    <div class="customizer-quick-actions">
                        <button id="btn-custom-random" type="button" class="custom-util-btn">✦ RANDOMIZE</button>
                        <button id="btn-custom-reset" type="button" class="custom-util-btn">↺ RESET</button>
                    </div>
                </div>

                <div class="customizer-section">
                    <label class="customizer-label">PILOT CALLSIGN</label>
                    <input id="custom-callsign-input" type="text" maxlength="12" value="STARLORD_84" autocomplete="off" />
                </div>

                <div class="customizer-section">
                    <label class="customizer-label">HULL PAINT PRESETS</label>
                    <div class="customizer-option-grid" id="custom-hull-options">
                        ${HULL_PRESETS.map((h, i) => `<button type="button" class="custom-chip ${i === 0 ? 'active' : ''}" data-hull="${i}"><span class="chip-dot" style="background: ${h.css}; box-shadow: 0 0 6px ${h.css};"></span>${h.name}</button>`).join('')}
                    </div>
                </div>

                <div class="customizer-section">
                    <div class="slider-header">
                        <label class="customizer-label" for="slider-hull-hue">CUSTOM HULL PAINT HUE</label>
                        <span id="val-hull-hue" class="slider-val">268°</span>
                    </div>
                    <input id="slider-hull-hue" type="range" min="0" max="360" value="268" class="custom-slider hue-rainbow-slider" />

                    <div class="slider-header">
                        <label class="customizer-label" for="slider-glow">NEON OVERDRIVE GLOW</label>
                        <span id="val-glow" class="slider-val">105%</span>
                    </div>
                    <input id="slider-glow" type="range" min="0" max="200" value="105" class="custom-slider" />

                    <div class="slider-header">
                        <label class="customizer-label" for="slider-chrome">METALLIC CHROME POLISH</label>
                        <span id="val-chrome" class="slider-val">78%</span>
                    </div>
                    <input id="slider-chrome" type="range" min="0" max="100" value="78" class="custom-slider" />
                </div>

                <div class="customizer-section">
                    <label class="customizer-label">NEON WIREFRAME & LASER</label>
                    <div class="customizer-swatch-row" id="custom-trim-options">
                        ${TRIM_COLORS.map((t, i) => `<button type="button" class="custom-swatch ${i === 0 ? 'active' : ''}" data-trim="${i}" title="${t.name}" style="background: ${t.css}; box-shadow: 0 0 10px ${t.css};"></button>`).join('')}
                    </div>
                </div>

                <div class="customizer-section">
                    <label class="customizer-label">THRUSTER PLASMA TRAIL</label>
                    <div class="customizer-swatch-row" id="custom-trail-options">
                        ${TRAIL_PRESETS.map((tr, i) => `<button type="button" class="custom-swatch ${i === 0 ? 'active' : ''}" data-trail="${i}" title="${tr.name}" style="background: ${tr.css};"></button>`).join('')}
                    </div>
                </div>

                <div class="customizer-section">
                    <label class="customizer-label">CHASSIS PRESETS & MORPHING</label>
                    <div class="customizer-option-grid" id="custom-chassis-options">
                        ${CHASSIS_PROFILES.map((c, i) => `<button type="button" class="custom-chip ${i === 0 ? 'active' : ''}" data-chassis="${i}">${c.name}</button>`).join('')}
                    </div>

                    <div class="slider-header" style="margin-top: 9px;">
                        <label class="customizer-label" for="slider-wingspan">WINGSPAN WIDTH</label>
                        <span id="val-wingspan" class="slider-val">100%</span>
                    </div>
                    <input id="slider-wingspan" type="range" min="60" max="165" value="100" class="custom-slider" />

                    <div class="slider-header">
                        <label class="customizer-label" for="slider-length">FUSELAGE LENGTH</label>
                        <span id="val-length" class="slider-val">100%</span>
                    </div>
                    <input id="slider-length" type="range" min="60" max="165" value="100" class="custom-slider" />

                    <div class="slider-header">
                        <label class="customizer-label" for="slider-bulk">CHASSIS BULK / PROFILE</label>
                        <span id="val-bulk" class="slider-val">100%</span>
                    </div>
                    <input id="slider-bulk" type="range" min="65" max="155" value="100" class="custom-slider" />
                </div>

                <div class="customizer-section">
                    <label class="customizer-label">HOLOGRAPHIC SHIELD AURA</label>
                    <div class="customizer-option-grid" id="custom-aura-options">
                        ${AURA_STYLES.map((a, i) => `<button type="button" class="custom-chip ${i === 0 ? 'active' : ''}" data-aura="${i}">${a}</button>`).join('')}
                    </div>

                    <div class="slider-header" style="margin-top: 9px;">
                        <label class="customizer-label" for="slider-aura-scale">AURA RADIUS & INTENSITY</label>
                        <span id="val-aura-scale" class="slider-val">100%</span>
                    </div>
                    <input id="slider-aura-scale" type="range" min="40" max="160" value="100" class="custom-slider" />
                </div>

                <button id="btn-launch-ship" type="button" class="launch-expedition-btn">✦ LAUNCH EXPEDITION</button>
            </div>

            <div id="flight-controls-bar" class="hud-hidden-during-custom">
                <button id="btn-toggle-controls" type="button" class="hud-pill-btn controls-toggle-btn" title="Show/Hide Flight Controls">▼ HIDE</button>
                <div class="flight-controls-items">
                    <button id="mode-drift" class="hud-pill-btn" title="Slow meditative flight [1]">DRIFT</button>
                    <button id="mode-cruise" class="hud-pill-btn active" title="Balanced exploration flight [2]">CRUISE</button>
                    <button id="mode-pulse" class="hud-pill-btn" title="Fast low-altitude flight [3]">PULSE</button>
                    <button id="btn-cam" class="hud-pill-btn" title="Cycle Spaceship Camera Angle [C]">CAM: LOW CHASE</button>
                    <button id="btn-scan" class="hud-pill-btn" title="Scan nebula & crystals [SPACE]">SCAN</button>
                    <button id="btn-warp" class="hud-pill-btn" title="Hyperjump forward [SHIFT / H]">HYPERJUMP</button>
                    <button id="btn-garage" class="hud-pill-btn" title="Customize Spaceship [G]">GARAGE</button>
                    <button id="btn-vhs" class="hud-pill-btn" title="Toggle 90s VHS Filter [V]">VHS: OFF</button>
                    <button id="btn-audio" class="hud-pill-btn" title="Toggle Dreamwave Synth">SYNTH: ON</button>
                </div>
            </div>

            <div id="canvas-container" class="game-container-wrapper"></div>
        `;

        this.scene = new THREE.Scene();
        this.scene.background = this.currentSkyColor.clone();
        this.scene.fog = new THREE.FogExp2(this.currentFogColor.getHex(), 0.00025);

        // Increase near plane to 0.5 for 24-bit depth buffer precision (prevents distant Z-fighting flicker!)
        this.camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.5, 2800);
        this.camera.rotation.order = 'YXZ';
        this.camera.position.set(0, 4.9, 7.2);
        this.camera.lookAt(0, 5.2, -45);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        // Cap pixel ratio at 1.25 so post-processing + fragment shaders stay locked at 60 FPS on Retina/mobile
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.25;

        // Half-resolution Bloom + Subtle VHS Post-Processing Pipeline
        this.composer = new EffectComposer(this.renderer);
        const renderPass = new RenderPass(this.scene, this.camera);
        this.composer.addPass(renderPass);

        this.bloomPass = new UnrealBloomPass(
            new THREE.Vector2(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2)),
            0.62,  // strength: clean synthwave neon glow
            0.45,  // radius: tight halation
            0.62   // threshold: only neon highlights, sun, lasers & crystals bloom
        );
        this.composer.addPass(this.bloomPass);

        this.vhsPass = new ShaderPass(VHS_RETRO_SHADER);
        this.composer.addPass(this.vhsPass);
        this.composer.addPass(new OutputPass());

        this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
        this.pmremGenerator.compileCubemapShader();

        document.getElementById('canvas-container')!.appendChild(this.renderer.domElement);

        this.initScene();
        this.updateEnvironmentReflections(BIOMES[0]);
        this.loadModel();
        this.initEvents();
        this.initMultiplayer();
        this.animate();

        window.addEventListener('resize', this.resizeHandler);
    }

    public getScore(): number {
        return this.score;
    }

    public getPilotCallsign(): string {
        return this.pilotCallsign;
    }

    public uploadDiscoveries() {
        this.onGameOver(this.score);
    }

    public toggleVHS() {
        this.vhsEnabled = !this.vhsEnabled;
        this.vhsPass.uniforms.enabled.value = this.vhsEnabled ? 1.0 : 0.0;
        const vhsBtn = document.getElementById('btn-vhs');
        const vhsOsd = document.getElementById('vhs-osd-overlay');
        if (vhsBtn) {
            vhsBtn.textContent = this.vhsEnabled ? 'VHS: ON' : 'VHS: OFF';
            vhsBtn.classList.toggle('active', this.vhsEnabled);
        }
        if (vhsOsd) {
            vhsOsd.style.display = this.vhsEnabled ? 'block' : 'none';
        }
    }

    public cycleCameraPreset() {
        this.cameraPresetIdx = (this.cameraPresetIdx + 1) % CAMERA_PRESETS.length;
        const preset = CAMERA_PRESETS[this.cameraPresetIdx];
        const btn = document.getElementById('btn-cam');
        if (btn) btn.textContent = `CAM: ${preset.name}`;
    }

    private getForwardVector(): THREE.Vector3 {
        return new THREE.Vector3(
            -Math.sin(this.shipYaw) * Math.cos(this.shipPitch),
            Math.sin(this.shipPitch),
            -Math.cos(this.shipYaw) * Math.cos(this.shipPitch)
        ).normalize();
    }

    private formatCompassHeading(yawRad: number): string {
        const deg = (((-yawRad * 180) / Math.PI) % 360 + 360) % 360;
        const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        const idx = Math.round(deg / 45) % 8;
        return `HDG: ${dirs[idx]} ${Math.round(deg).toString().padStart(3, '0')}°`;
    }

    private updateEnvironmentReflections(biome: BiomePalette) {
        const envScene = new THREE.Scene();
        envScene.background = new THREE.Color(biome.skyColor);

        const topGlow = new THREE.Mesh(
            new THREE.SphereGeometry(40, 16, 16),
            new THREE.MeshBasicMaterial({ color: biome.nebulaSecondary, side: THREE.BackSide })
        );
        topGlow.position.set(0, 35, -30);
        envScene.add(topGlow);

        const bottomNebulaGlow = new THREE.Mesh(
            new THREE.SphereGeometry(45, 16, 16),
            new THREE.MeshBasicMaterial({ color: biome.nebulaPrimary, side: THREE.BackSide })
        );
        bottomNebulaGlow.position.set(0, -35, 0);
        envScene.add(bottomNebulaGlow);

        const sunReflectDisc = new THREE.Mesh(
            new THREE.SphereGeometry(25, 16, 16),
            new THREE.MeshBasicMaterial({ color: biome.sunCore })
        );
        sunReflectDisc.position.set(0, 15, -60);
        envScene.add(sunReflectDisc);

        const sideRibbon1 = new THREE.Mesh(
            new THREE.SphereGeometry(22, 12, 12),
            new THREE.MeshBasicMaterial({ color: biome.ringColor })
        );
        sideRibbon1.position.set(-50, 10, 0);
        envScene.add(sideRibbon1);

        const sideRibbon2 = new THREE.Mesh(
            new THREE.SphereGeometry(22, 12, 12),
            new THREE.MeshBasicMaterial({ color: biome.sunHalo })
        );
        sideRibbon2.position.set(50, 10, 0);
        envScene.add(sideRibbon2);

        if (this.envRT) {
            this.envRT.dispose();
        }
        this.envRT = this.pmremGenerator.fromScene(envScene, 0.04);
        this.scene.environment = this.envRT.texture;
    }

    private showDiscoveryBanner(biome: BiomePalette, customName?: string, customSubtitle?: string, customWeather?: string) {
        const banner = document.getElementById('discovery-banner');
        const planetEl = document.getElementById('banner-planet');
        const metaEl = document.getElementById('banner-meta');

        if (planetEl) planetEl.textContent = customName || biome.name;
        if (metaEl) {
            const sub = customSubtitle || biome.subtitle;
            const weath = customWeather || biome.weather;
            metaEl.textContent = `${sub}  •  SECTOR: ${biome.cardinal}  •  WEATHER: ${weath}`;
        }

        if (banner) {
            banner.classList.add('visible');
            setTimeout(() => {
                banner.classList.remove('visible');
            }, 6000);
        }
    }

    public hyperjumpForward() {
        this.portalBoost = 65.0;
        this.audio.playPortalChord();
    }

    private createPlanetNode(biomeIdx: number, worldPos: THREE.Vector3): PlanetNode {
        const biome = BIOMES[biomeIdx % BIOMES.length];
        const group = new THREE.Group();
        group.position.copy(worldPos);

        const planetGeo = new THREE.SphereGeometry(58, 36, 36);
        const material = new THREE.ShaderMaterial({
            uniforms: {
                uPerlinTex: { value: this.perlinTexture },
                time: { value: 0 },
                oceanColor: { value: new THREE.Color(biome.planetOcean) },
                landColor: { value: new THREE.Color(biome.planetLand) },
                atmoColor: { value: new THREE.Color(biome.planetAtmo) },
                uOpacity: { value: 1.0 }
            },
            vertexShader: PLANET_VERTEX_SHADER,
            fragmentShader: PLANET_FRAGMENT_SHADER,
            transparent: true
        });
        const mesh = new THREE.Mesh(planetGeo, material);
        group.add(mesh);

        const ringGeo = new THREE.RingGeometry(76, 132, 72);
        const ringMat = new THREE.MeshBasicMaterial({
            color: biome.ringColor,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.48,
            fog: false
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = Math.PI * (0.36 + (biomeIdx % 3) * 0.06);
        ring.rotation.y = (biomeIdx % 2 === 0 ? -1 : 1) * 0.28;
        group.add(ring);

        const moonPivot = new THREE.Group();
        const moonGeo = new THREE.SphereGeometry(11, 24, 24);
        const posAttr = moonGeo.attributes.position;
        for (let i = 0; i < posAttr.count; i++) {
            const vx = posAttr.getX(i);
            const vy = posAttr.getY(i);
            const vz = posAttr.getZ(i);
            const disp = 1.0 + fractalBrownianMotion(vx + 50, vy + vz + 50, 4, 0.08) * 0.12;
            posAttr.setXYZ(i, vx * disp, vy * disp, vz * disp);
        }
        moonGeo.computeVertexNormals();
        const moonMat = new THREE.MeshStandardMaterial({
            color: 0x1a0836,
            roughness: 0.25,
            metalness: 0.8,
            envMapIntensity: 1.8,
            emissive: biome.planetLand,
            emissiveIntensity: 0.28,
            transparent: true,
            opacity: 1.0
        });
        const moon = new THREE.Mesh(moonGeo, moonMat);
        moon.position.set(148, 18, 0);
        moonPivot.add(moon);
        group.add(moonPivot);

        this.scene.add(group);
        return {
            group,
            mesh,
            material,
            ring,
            moonPivot,
            moon,
            biomeIdx,
            discoveredCount: 0,
            baseScale: 1.0,
            appearProgress: 1.0
        };
    }

    private createDistantBackgroundPlanets() {
        const distantConfigs: {
            offset: [number, number, number];
            radius: number;
            ocean: number;
            land: number;
            atmo: number;
            hasRing: boolean;
            ringColor: number;
            ringTilt: [number, number];
            rotSpeed: number;
        }[] = [
            {
                offset: [-520, 185, -1380],
                radius: 92,
                ocean: 0x0b0326,
                land: 0x7209b7,
                atmo: 0x00f0ff,
                hasRing: true,
                ringColor: 0x00f0ff,
                ringTilt: [1.18, 0.32],
                rotSpeed: 0.04
            },
            {
                offset: [640, 230, -1420],
                radius: 68,
                ocean: 0x1a052e,
                land: 0xff2a9d,
                atmo: 0xffbe6b,
                hasRing: false,
                ringColor: 0xffbe6b,
                ringTilt: [0, 0],
                rotSpeed: 0.06
            },
            {
                offset: [1480, 150, -480],
                radius: 115,
                ocean: 0x06122e,
                land: 0x00bbf9,
                atmo: 0x00f5d4,
                hasRing: true,
                ringColor: 0xf72585,
                ringTilt: [1.28, -0.4],
                rotSpeed: 0.035
            },
            {
                offset: [-1460, 210, -320],
                radius: 84,
                ocean: 0x220638,
                land: 0xc77dff,
                atmo: 0xff5e7e,
                hasRing: true,
                ringColor: 0x72efdd,
                ringTilt: [1.05, 0.25],
                rotSpeed: 0.05
            },
            {
                offset: [980, 275, 1180],
                radius: 105,
                ocean: 0x1f081e,
                land: 0xff9f1c,
                atmo: 0xff007f,
                hasRing: true,
                ringColor: 0xffbe0b,
                ringTilt: [1.22, 0.18],
                rotSpeed: 0.045
            },
            {
                offset: [-1020, 195, 1240],
                radius: 74,
                ocean: 0x080c30,
                land: 0x4cc9f0,
                atmo: 0xb5179e,
                hasRing: false,
                ringColor: 0x4cc9f0,
                ringTilt: [0, 0],
                rotSpeed: 0.055
            },
            {
                offset: [-180, 340, 1520],
                radius: 56,
                ocean: 0x14062b,
                land: 0x00f5d4,
                atmo: 0xfee440,
                hasRing: false,
                ringColor: 0x00f5d4,
                ringTilt: [0, 0],
                rotSpeed: 0.07
            }
        ];

        distantConfigs.forEach((cfg) => {
            const group = new THREE.Group();
            const offset = new THREE.Vector3(cfg.offset[0], cfg.offset[1], cfg.offset[2]);
            group.position.copy(offset);

            const geo = new THREE.SphereGeometry(cfg.radius, 32, 32);
            const material = new THREE.ShaderMaterial({
                uniforms: {
                    uPerlinTex: { value: this.perlinTexture },
                    time: { value: 0 },
                    oceanColor: { value: new THREE.Color(cfg.ocean) },
                    landColor: { value: new THREE.Color(cfg.land) },
                    atmoColor: { value: new THREE.Color(cfg.atmo) },
                    uOpacity: { value: 0.88 }
                },
                vertexShader: PLANET_VERTEX_SHADER,
                fragmentShader: PLANET_FRAGMENT_SHADER,
                transparent: true,
                fog: false
            });
            const mesh = new THREE.Mesh(geo, material);
            group.add(mesh);

            if (cfg.hasRing) {
                const ringGeo = new THREE.RingGeometry(cfg.radius * 1.32, cfg.radius * 2.15, 64);
                const ringMat = new THREE.MeshBasicMaterial({
                    color: cfg.ringColor,
                    side: THREE.DoubleSide,
                    transparent: true,
                    opacity: 0.32,
                    fog: false
                });
                const ring = new THREE.Mesh(ringGeo, ringMat);
                ring.rotation.x = cfg.ringTilt[0];
                ring.rotation.y = cfg.ringTilt[1];
                group.add(ring);
            }

            this.scene.add(group);
            this.distantPlanets.push({
                group,
                mesh,
                material,
                offset,
                rotSpeed: cfg.rotSpeed
            });
        });
    }

    private samplePerlinPng(worldX: number, worldZ: number): number {
        if (!this.perlinPixels) {
            // Fallback to analytical Perlin FBM if image buffer hasn't decoded yet
            return (fractalBrownianMotion(worldX * 0.25, worldZ * 0.25, 4, 0.015) + 1.0) * 0.5;
        }
        const size = this.perlinSize;
        const u = ((Math.floor(worldX * 0.35) % size) + size) % size;
        const v = ((Math.floor(worldZ * 0.35) % size) + size) % size;
        const idx = (v * size + u) * 4;
        return this.perlinPixels[idx] / 255.0;
    }

    private mutatePlanetWithPerlin(pNode: PlanetNode) {
        const wx = pNode.group.position.x;
        const wz = pNode.group.position.z;
        const p1 = this.samplePerlinPng(wx, wz);
        const p2 = this.samplePerlinPng(wx + 410, wz - 290);
        const p3 = this.samplePerlinPng(wx - 730, wz + 520);

        const prefixes = ['SYNTHOS', 'HYPERION', 'VORTEX', 'NEONIS', 'OUTRUNIA', 'AETHER', 'LYRA', 'KRONOS', 'SOLARIS', 'VELVET'];
        const suffixes = ['84', 'IX', 'PRIME', 'VII', 'ZERO', '88', 'X', 'OMEGA', 'IV', 'NOVA'];
        const subtitles = [
            'PERLIN-GENERATED RINGED EXOPLANET',
            'BIOLUMINESCENT SYNTHWAVE SUPER-EARTH',
            'CRYSTALLINE VAPORWAVE GAS GIANT',
            'CHROMATIC NEBULA CORE WORLD',
            'OUTRUN MAGNETIC OCEAN WORLD'
        ];
        const weathers = [
            'PERLIN IONIC AURORA',
            'NEON LASER MONSOON',
            'ZERO-G CASSETTE DRIFT',
            'ULTRAVIOLET PLASMA TIDES',
            'DIAMOND STARLIGHT RAIN'
        ];

        pNode.customName = `${prefixes[Math.floor(p1 * prefixes.length) % prefixes.length]}-${suffixes[Math.floor(p2 * suffixes.length) % suffixes.length]}`;
        pNode.customSubtitle = subtitles[Math.floor(p3 * subtitles.length) % subtitles.length];
        pNode.customWeather = weathers[Math.floor((p1 + p2) * 0.5 * weathers.length) % weathers.length];

        // Scale planet & tilt rings procedurally from /perlin.png
        const scaleFactor = 0.78 + p1 * 0.62;
        pNode.baseScale = scaleFactor;
        pNode.appearProgress = 0.0;
        pNode.group.scale.setScalar(scaleFactor * 0.3);
        pNode.ring.rotation.x = Math.PI * (0.28 + p2 * 0.26);
        pNode.ring.rotation.y = (p3 - 0.5) * 0.85;

        // Generate fresh synthwave ocean, continent, and atmosphere colors from /perlin.png samples
        const oceanCol = new THREE.Color().setHSL(0.72 + p1 * 0.16, 0.85, 0.12);
        const landCol = new THREE.Color().setHSL((0.88 + p2 * 0.45) % 1.0, 0.95, 0.55);
        const atmoCol = new THREE.Color().setHSL((0.48 + p3 * 0.42) % 1.0, 1.0, 0.6);

        pNode.material.uniforms.oceanColor.value.copy(oceanCol);
        pNode.material.uniforms.landColor.value.copy(landCol);
        pNode.material.uniforms.atmoColor.value.copy(atmoCol);
        (pNode.ring.material as THREE.MeshBasicMaterial).color.copy(atmoCol);
    }

    private triggerPerlinCosmicEvent() {
        if (!this.ship) return;
        const sx = this.ship.position.x;
        const sz = this.ship.position.z;
        const pVal = this.samplePerlinPng(sx, sz);
        const fwd = this.getForwardVector();
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x);

        if (pVal > 0.64) {
            // Event 1: Synthwave Comet Shower streaking across the sky
            for (let i = 0; i < 4; i++) {
                const cometColor = i % 2 === 0 ? 0x00f0ff : 0xff007f;
                const cometMesh = new THREE.Mesh(
                    new THREE.OctahedronGeometry(1.6, 1),
                    new THREE.MeshBasicMaterial({ color: cometColor })
                );
                const startPos = this.ship.position
                    .clone()
                    .addScaledVector(fwd, 190 + i * 45)
                    .addScaledVector(right, (i - 1.5) * 85);
                startPos.y = 28 + Math.random() * 42;
                cometMesh.position.copy(startPos);

                const vel = right
                    .clone()
                    .multiplyScalar(i % 2 === 0 ? 95 : -95)
                    .addScaledVector(fwd, -25);
                vel.y = -4.5;

                this.scene.add(cometMesh);
                this.comets.push({ mesh: cometMesh, vel, colorHex: cometColor, life: 5.5 });
            }
            this.appendChatMessage(
                '',
                0x00f0ff,
                `✦ PERLIN ANOMALY [${pVal.toFixed(2)}]: Neon Comet Shower detected in sector!`,
                true
            );
        } else if (pVal < 0.36) {
            // Event 2: Procedural Supernova Crystal Spiral ahead of the ship
            const center = this.ship.position.clone().addScaledVector(fwd, 155);
            for (let i = 0; i < 6; i++) {
                const angle = (i / 6) * Math.PI * 2;
                const cx = center.x + Math.cos(angle) * 26;
                const cz = center.z + Math.sin(angle) * 26;
                if (this.crystals[i]) {
                    this.crystals[i].position.set(cx, 6 + Math.sin(angle * 2) * 3, cz);
                    (this.crystals[i] as unknown as { baseY: number }).baseY = this.crystals[i].position.y;
                }
            }
            this.appendChatMessage(
                '',
                0xff007f,
                `✦ PERLIN ANOMALY [${pVal.toFixed(2)}]: Crystal Constellation materialized ahead!`,
                true
            );
        } else {
            // Event 3: Perlin Wormhole Gate Alignment
            if (this.rings.length > 0) {
                const portal = this.rings[0];
                portal.position.copy(this.ship.position).addScaledVector(fwd, 125);
                portal.position.y = this.ship.position.y + 1.5;
                portal.rotation.y = this.shipYaw;
            }
            this.appendChatMessage(
                '',
                0xffbe0b,
                `✦ PERLIN ANOMALY [${pVal.toFixed(2)}]: Deep-Space Warp Gate aligned ahead!`,
                true
            );
        }
    }

    private updateHullHud() {
        const hullEl = document.getElementById('hull-value');
        const barEl = document.getElementById('shield-bar');
        const pct = Math.max(0, Math.min(100, Math.round(this.hullIntegrity)));

        if (hullEl) {
            hullEl.textContent = `${pct}%`;
            if (pct <= 30) {
                hullEl.style.color = '#ff0055';
                hullEl.style.textShadow = '0 0 12px rgba(255, 0, 85, 0.9)';
            } else if (pct <= 60) {
                hullEl.style.color = '#ffbe0b';
                hullEl.style.textShadow = '0 0 12px rgba(255, 190, 11, 0.8)';
            } else {
                hullEl.style.color = '';
                hullEl.style.textShadow = '';
            }
        }

        if (barEl) {
            barEl.style.width = `${pct}%`;
            if (pct <= 30) {
                barEl.style.background = 'linear-gradient(90deg, #ff0055, #ff5e00)';
            } else if (pct <= 60) {
                barEl.style.background = 'linear-gradient(90deg, #ffbe0b, #ff007f)';
            } else {
                barEl.style.background = '';
            }
        }
    }

    private takeDamage(amount: number, sourceName: string, bounceNormal?: THREE.Vector3) {
        if (this.isCustomizing || this.damageCooldown > 0 || this.isDestroyed) return;

        this.hullIntegrity = Math.max(0, this.hullIntegrity - amount);
        this.damageCooldown = 1.15;
        this.screenShake = 0.9;
        this.portalBoost = -18.0;
        this.audio.playImpactSound();
        this.updateHullHud();

        // Trigger red HUD impact flash
        const flashEl = document.getElementById('damage-flash-overlay');
        if (flashEl) {
            flashEl.classList.add('active');
            window.setTimeout(() => flashEl.classList.remove('active'), 360);
        }

        // Flash shield aura crimson on impact
        if (this.shieldMesh) {
            const shieldMat = this.shieldMesh.material as THREE.MeshBasicMaterial;
            shieldMat.color.setHex(0xff0055);
            shieldMat.opacity = 0.65;
            window.setTimeout(() => {
                if (this.shieldMesh && !this.isDestroyed) {
                    const trimHex = TRIM_COLORS[this.trimColorIdx]?.hex ?? 0x00f0ff;
                    shieldMat.color.setHex(trimHex);
                    shieldMat.opacity = 0.08;
                }
            }, 420);
        }

        // Spawn fiery impact sparks & debris around the ship
        if (this.ship) {
            const sparkColors = [0xff0055, 0xffbe0b, 0xff5e00, 0x00f0ff];
            for (let k = 0; k < 28; k++) {
                const col = sparkColors[k % sparkColors.length];
                const spark = new MoteParticle(this.ship.position, col, null, 0.36);
                spark.velocity.set(
                    (Math.random() - 0.5) * 1.8,
                    (Math.random() - 0.5) * 1.4,
                    (Math.random() - 0.5) * 1.8
                );
                spark.life = 0.75;
                this.scene.add(spark.mesh);
                this.particles.push(spark);
            }

            if (bounceNormal) {
                this.ship.position.addScaledVector(bounceNormal, 8.5);
                this.targetYaw += (Math.random() > 0.5 ? 1 : -1) * 0.45;
            }
        }

        this.appendChatMessage(
            '',
            0xff0055,
            `⚠ HULL IMPACT: ${sourceName} (-${amount}% HULL  •  INTEGRITY: ${this.hullIntegrity}%)`,
            true
        );

        if (this.hullIntegrity <= 0) {
            this.appendChatMessage(
                '',
                0xff0055,
                `✦ CRITICAL HULL FAILURE! Emergency orbital reconstruction initiated...`,
                true
            );
            const finalScore = this.score;
            this.hullIntegrity = 100;
            this.updateHullHud();
            this.onGameOver(finalScore);
        }
    }

    private onPlanetDiscovered(pNode: PlanetNode) {
        pNode.discoveredCount++;
        this.worldsExplored++;
        this.portalBoost = 35.0;

        const worldCountEl = document.getElementById('mineral-count');
        if (worldCountEl) worldCountEl.textContent = this.worldsExplored.toString();

        this.currentBiomeIdx = pNode.biomeIdx;
        this.targetBiome = BIOMES[this.currentBiomeIdx];
        this.updateEnvironmentReflections(this.targetBiome);
        this.audio.playPortalChord();
        this.showDiscoveryBanner(this.targetBiome, pNode.customName, pNode.customSubtitle, pNode.customWeather);

        if (this.ship) {
            for (let k = 0; k < 28; k++) {
                const p = new MoteParticle(this.ship.position, this.targetBiome.planetAtmo, this.ship, 0.32);
                this.scene.add(p.mesh);
                this.particles.push(p);
            }
        }
    }

    public triggerScanWave() {
        this.audio.playScannerWave();

        if (this.ship) {
            this.crystals.forEach(c => {
                if (c.position.distanceTo(this.ship!.position) < 240) {
                    for (let k = 0; k < 4; k++) {
                        const p = new MoteParticle(c.position, this.targetBiome.nebulaSecondary, this.ship);
                        this.scene.add(p.mesh);
                        this.particles.push(p);
                    }
                }
            });
        }
    }

    private initScene() {
        const texLoader = new THREE.TextureLoader();
        this.perlinTexture = texLoader.load('/perlin.png', (tex) => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = this.perlinSize;
                canvas.height = this.perlinSize;
                const ctx = canvas.getContext('2d');
                if (ctx && tex.image) {
                    ctx.drawImage(tex.image, 0, 0, this.perlinSize, this.perlinSize);
                    this.perlinPixels = ctx.getImageData(0, 0, this.perlinSize, this.perlinSize).data;
                }
            } catch (e) {
                console.warn('Could not extract perlin.png pixel data:', e);
            }
        });
        this.perlinTexture.wrapS = THREE.RepeatWrapping;
        this.perlinTexture.wrapT = THREE.RepeatWrapping;
        // Disable mipmap switching to prevent texture LOD shimmering/flickering
        this.perlinTexture.generateMipmaps = false;
        this.perlinTexture.minFilter = THREE.LinearFilter;
        this.perlinTexture.magFilter = THREE.LinearFilter;

        const hemiLight = new THREE.HemisphereLight(0xffb3ec, 0x090218, 1.35);
        this.scene.add(hemiLight);

        const dirLight = new THREE.DirectionalLight(0xffe5b4, 1.8);
        dirLight.position.set(30, 75, -120);
        this.scene.add(dirLight);

        // 1. 360° Authentic Deep-Space Skybox (Pitch-black void, crisp starfield layers & faint Milky Way dust band)
        this.nebulaMaterial = new THREE.ShaderMaterial({
            uniforms: {
                uPerlinTex: { value: this.perlinTexture },
                skyColor: { value: this.currentSkyColor },
                nebulaPrimary: { value: this.currentNebulaPrimary },
                nebulaSecondary: { value: this.currentNebulaSecondary },
                time: { value: 0 },
                uShipPos: { value: new THREE.Vector3(0, 0, 0) }
            },
            vertexShader: NEBULA_VERTEX_SHADER,
            fragmentShader: NEBULA_FRAGMENT_SHADER,
            side: THREE.BackSide,
            depthWrite: false,
            fog: false
        });
        this.nebulaDome = new THREE.Mesh(new THREE.SphereGeometry(2000, 48, 32), this.nebulaMaterial);
        this.scene.add(this.nebulaDome);

        // 2. Non-Popping 360° Deep Space Starfield (8,500 multi-sized stars wrapping individually in GLSL)
        const starCount = 8500;
        const starPos: number[] = [];
        const starColors: number[] = [];
        const starSizes: number[] = [];
        const palette = [
            new THREE.Color(0xffffff),
            new THREE.Color(0xade8f4),
            new THREE.Color(0xffcad4),
            new THREE.Color(0xffe599),
            new THREE.Color(0xd8bbff)
        ];
        for (let i = 0; i < starCount; i++) {
            starPos.push(
                (Math.random() - 0.5) * 1600,
                (Math.random() - 0.5) * 1600,
                (Math.random() - 0.5) * 1600
            );
            const c = palette[Math.floor(Math.random() * palette.length)];
            starColors.push(c.r, c.g, c.b);
            starSizes.push(0.8 + Math.pow(Math.random(), 3.0) * 3.2);
        }
        const starGeo = new THREE.BufferGeometry();
        starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
        starGeo.setAttribute('color', new THREE.Float32BufferAttribute(starColors, 3));
        starGeo.setAttribute('aSize', new THREE.Float32BufferAttribute(starSizes, 1));

        this.starfieldMaterial = new THREE.ShaderMaterial({
            uniforms: {
                uShipPos: { value: new THREE.Vector3(0, 0, 0) }
            },
            vertexShader: STARFIELD_VERTEX_SHADER,
            fragmentShader: STARFIELD_FRAGMENT_SHADER,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this.stars = new THREE.Points(starGeo, this.starfieldMaterial);
        this.stars.frustumCulled = false;
        this.scene.add(this.stars);

        // 3. Iconic Giant Sliced Outrun Synthwave Sunset Star (North Horizon Beacon)
        const sunGeo = new THREE.CircleGeometry(275, 64);
        this.sunMaterial = new THREE.ShaderMaterial({
            uniforms: {
                coreColor: { value: this.currentSunCore },
                haloColor: { value: this.currentSunHalo },
                time: { value: 0 }
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                varying vec2 vUv;
                uniform vec3 coreColor;
                uniform vec3 haloColor;
                uniform float time;
                void main() {
                    vec2 centered = vUv - vec2(0.5);
                    float d = length(centered) * 2.0;

                    float outerGlow = pow(smoothstep(1.0, 0.0, d), 1.6) * 0.65;
                    float disc = smoothstep(0.78, 0.75, d);

                    // Classic 80s Outrun 3-stop gradient: hot magenta bottom -> neon orange mid -> solar yellow top
                    float gradT = clamp((vUv.y - 0.12) * 1.35, 0.0, 1.0);
                    vec3 midOrange = vec3(1.0, 0.36, 0.05);
                    vec3 gradCol = gradT < 0.5
                        ? mix(haloColor, midOrange, gradT * 2.0)
                        : mix(midOrange, coreColor, (gradT - 0.5) * 2.0);

                    float sliceMask = 1.0;
                    if (vUv.y < 0.56) {
                        float depth = 0.56 - vUv.y;
                        float gapThickness = 0.07 + depth * 0.48;
                        float wave = fract(vUv.y * 18.0 - time * 0.25);
                        sliceMask = smoothstep(gapThickness - 0.015, gapThickness + 0.015, wave);
                    }

                    // Subtle neon cyan rim around the sun disc
                    float sunRim = smoothstep(0.79, 0.76, d) * smoothstep(0.72, 0.75, d) * sliceMask;

                    float finalAlpha = max(disc * sliceMask, outerGlow);
                    vec3 finalCol = mix(haloColor, gradCol * 1.35, disc) + vec3(0.0, 0.95, 1.0) * sunRim * 0.65;
                    gl_FragColor = vec4(finalCol, finalAlpha * 0.96);
                }
            `,
            transparent: true,
            fog: false,
            depthWrite: false
        });
        this.sunMesh = new THREE.Mesh(sunGeo, this.sunMaterial);
        this.sunMesh.position.set(0, 72, -1080);

        // Concentric neon cyan & magenta synthwave wireframe rings around the Outrun sun
        const sunRingMat = new THREE.MeshBasicMaterial({
            color: 0x00f0ff,
            wireframe: true,
            transparent: true,
            opacity: 0.35,
            fog: false
        });
        const sunOrbitalRing = new THREE.Mesh(new THREE.RingGeometry(235, 295, 48, 2), sunRingMat);
        sunOrbitalRing.rotation.x = Math.PI * 0.38;
        sunOrbitalRing.rotation.y = -0.22;
        this.sunMesh.add(sunOrbitalRing);

        this.scene.add(this.sunMesh);

        // 4. Distant Unreachable Background Planets & Gas Giants across the 360° Horizon
        this.createDistantBackgroundPlanets();

        // 5. Place 4 Discoverable 3D Ringed Planets in the North, East, South, and West Sectors
        this.planets.push(this.createPlanetNode(0, new THREE.Vector3(-85, 36, -620)));  // North: VERIDIA-9
        this.planets.push(this.createPlanetNode(1, new THREE.Vector3(680, 42, -80)));   // East: CYBERIA PRIME
        this.planets.push(this.createPlanetNode(2, new THREE.Vector3(90, 34, 680)));    // South: SOLARIS MIRAGE
        this.planets.push(this.createPlanetNode(3, new THREE.Vector3(-680, 40, 85)));   // West: ASTRAL ELYSIUM

        // 6. Populate 360° Space with Portals, Reflective Asteroids, and Crystals
        for (let i = 0; i < 10; i++) {
            const angle = (i / 10) * Math.PI * 2;
            const dist = 120 + Math.random() * 240;
            this.createPortalRing(Math.sin(angle) * dist, Math.cos(angle) * dist);
        }
        for (let i = 0; i < 32; i++) {
            const angle = (i / 32) * Math.PI * 2 + Math.random() * 0.3;
            const dist = 70 + Math.random() * 320;
            this.createPerlinAsteroid(i, Math.sin(angle) * dist, Math.cos(angle) * dist);
        }
        for (let i = 0; i < 22; i++) {
            const angle = (i / 22) * Math.PI * 2 + Math.random() * 0.2;
            const dist = 45 + Math.random() * 240;
            this.spawnCrystalCluster(Math.sin(angle) * dist, Math.cos(angle) * dist);
        }
    }

    private loadModel() {
        // Spawn Synthwave AI Travellers immediately so ships are visible right away
        this.spawnAIPlayers();

        const loader = new GLTFLoader();
        loader.load('/spaceship_gltf/scene.gltf', (gltf) => {
            const rawModel = gltf.scene;
            if (!rawModel) return;

            // Keep a clean clone (sharing BufferGeometries on GPU) to upgrade all AI player ships to the real 3D GLTF starship!
            const cleanTemplateForAI = rawModel.clone(true);

            const shipGroup = new THREE.Group();
            shipGroup.rotation.order = 'YXZ';

            rawModel.scale.set(0.12, 0.12, 0.12);
            rawModel.rotation.y = Math.PI;
            rawModel.rotation.x = this.MODEL_LEVEL_PITCH;
            shipGroup.add(rawModel);
            this.rawShipModel = rawModel;

            this.shipPrimaryLight = new THREE.PointLight(0x00f0ff, 26, 48);
            this.shipPrimaryLight.position.set(0, 4, -4);
            shipGroup.add(this.shipPrimaryLight);

            this.shipRearLight = new THREE.PointLight(0xff007f, 22, 34);
            this.shipRearLight.position.set(0, 1, 5);
            shipGroup.add(this.shipRearLight);

            this.shipShowroomLight = new THREE.PointLight(0xffffff, 28, 38);
            this.shipShowroomLight.position.set(0, 6.2, 3.2);
            shipGroup.add(this.shipShowroomLight);

            this.shipHullMaterials = [];
            this.shipTrimLines = [];
            this.shipThrusterMats = [];
            this.shipAccentMats = [];

            rawModel.traverse((child) => {
                if ((child as THREE.Mesh).isMesh) {
                    const mesh = child as THREE.Mesh;
                    const origMat = mesh.material as THREE.MeshStandardMaterial;
                    // Omit emissiveMap so hull color & emissive glow illuminate the entire starship body vividly!
                    const hullMat = new THREE.MeshStandardMaterial({
                        color: 0x3b1278,
                        metalness: 0.78,
                        roughness: 0.14,
                        envMapIntensity: 2.8,
                        normalMap: origMat?.normalMap || null,
                        emissive: 0x6200ea,
                        emissiveIntensity: 0.72
                    });
                    mesh.material = hullMat;
                    this.shipHullMaterials.push(hullMat);

                    const edges = new THREE.EdgesGeometry(mesh.geometry, 16);
                    const lineMat = new THREE.LineBasicMaterial({
                        color: 0xff007f,
                        transparent: true,
                        opacity: 0.88
                    });
                    const line = new THREE.LineSegments(edges, lineMat);
                    mesh.add(line);
                    this.shipTrimLines.push(lineMat);
                }
            });

            // Twin glowing plasma thruster cores at the rear of the player's ship
            const thrusterPositions: [number, number, number][] = [
                [-0.46, 0.18, 1.48],
                [0.46, 0.18, 1.48]
            ];
            thrusterPositions.forEach(([tx, ty, tz]) => {
                const tMat = new THREE.MeshBasicMaterial({
                    color: 0x00f0ff,
                    transparent: true,
                    opacity: 0.95
                });
                const tMesh = new THREE.Mesh(SHARED_BEAM_GEO, tMat);
                tMesh.scale.set(0.65, 0.48, 1.15);
                tMesh.position.set(tx, ty, tz);
                shipGroup.add(tMesh);
                this.shipThrusterMats.push(tMat);
            });

            // Wingtip & canopy neon accent blades
            const accentConfigs: { pos: [number, number, number]; scale: [number, number, number] }[] = [
                { pos: [-1.42, 0.08, 0.35], scale: [0.16, 0.08, 1.35] },
                { pos: [1.42, 0.08, 0.35], scale: [0.16, 0.08, 1.35] },
                { pos: [0, 0.42, -0.35], scale: [0.32, 0.12, 0.85] }
            ];
            accentConfigs.forEach((cfg) => {
                const aMat = new THREE.MeshBasicMaterial({
                    color: 0xff007f,
                    transparent: true,
                    opacity: 0.88
                });
                const aMesh = new THREE.Mesh(SHARED_MOTE_GEO, aMat);
                aMesh.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
                aMesh.scale.set(cfg.scale[0], cfg.scale[1], cfg.scale[2]);
                shipGroup.add(aMesh);
                this.shipAccentMats.push(aMat);
            });

            // 3D Holographic Orbital Hangar Turntable Platform (visible in Garage)
            const platformGroup = new THREE.Group();
            platformGroup.position.set(0, -1.15, 0);
            this.hangarRingMats = [];

            const outerRingMat = new THREE.MeshBasicMaterial({
                color: 0xff007f,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.55
            });
            const outerRing = new THREE.Mesh(new THREE.RingGeometry(2.35, 2.52, 64), outerRingMat);
            outerRing.rotation.x = Math.PI / 2;
            platformGroup.add(outerRing);
            this.hangarRingMats.push(outerRingMat);

            const innerRingMat = new THREE.MeshBasicMaterial({
                color: 0x00f0ff,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.38,
                wireframe: true
            });
            const innerRing = new THREE.Mesh(new THREE.RingGeometry(1.15, 2.2, 32, 2), innerRingMat);
            innerRing.rotation.x = Math.PI / 2;
            platformGroup.add(innerRing);
            this.hangarRingMats.push(innerRingMat);

            const coreDiscMat = new THREE.MeshBasicMaterial({
                color: 0x00f0ff,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.12
            });
            const coreDisc = new THREE.Mesh(new THREE.CircleGeometry(2.35, 48), coreDiscMat);
            coreDisc.rotation.x = Math.PI / 2;
            platformGroup.add(coreDisc);
            this.hangarRingMats.push(coreDiscMat);

            shipGroup.add(platformGroup);
            this.hangarPlatformGroup = platformGroup;

            const auraGeo = new THREE.IcosahedronGeometry(1.6, 1);
            const auraMat = new THREE.MeshBasicMaterial({
                color: 0x00f0ff,
                transparent: true,
                opacity: 0.08,
                wireframe: true
            });
            this.shieldMesh = new THREE.Mesh(auraGeo, auraMat);
            shipGroup.add(this.shieldMesh);

            this.ship = shipGroup;
            this.ship.position.set(0, 3.6, 0);
            this.scene.add(this.ship);

            this.applyShipCustomization();
            this.cleanShipTemplate = cleanTemplateForAI;
            this.upgradeAIShipsWithGLTF(cleanTemplateForAI);
            this.remotePlayers.forEach((remote) => this.mountGLTFOnRemoteShip(remote));
        });
    }

    private mountGLTFOnRemoteShip(remote: RemotePlayerActor) {
        if (!this.cleanShipTemplate || remote.gltfMat) return;
        const gltfClone = this.cleanShipTemplate.clone(true);
        gltfClone.scale.set(0.16, 0.16, 0.16);
        gltfClone.rotation.y = Math.PI;
        gltfClone.rotation.x = this.MODEL_LEVEL_PITCH;

        const mat = new THREE.MeshStandardMaterial({
            color: 0x241442,
            metalness: 0.92,
            roughness: 0.1,
            envMapIntensity: 2.4,
            emissive: remote.colorHex,
            emissiveIntensity: 0.82
        });

        gltfClone.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
                (child as THREE.Mesh).material = mat;
            }
        });

        remote.hullMesh.visible = false;
        remote.group.add(gltfClone);
        remote.gltfMat = mat;
    }

    private buildLocalPlayerState(): OnlinePlayerState {
        const trimHex = TRIM_COLORS[this.trimColorIdx]?.hex ?? 0x00f0ff;
        return {
            id: this.localPlayerId,
            callsign: this.pilotCallsign || 'STARLORD_84',
            x: this.ship ? Number(this.ship.position.x.toFixed(2)) : 0,
            y: this.ship ? Number(this.ship.position.y.toFixed(2)) : 3.6,
            z: this.ship ? Number(this.ship.position.z.toFixed(2)) : 0,
            yaw: Number(this.shipYaw.toFixed(3)),
            roll: Number(this.shipRoll.toFixed(3)),
            pitch: Number(this.shipPitch.toFixed(3)),
            hull: Math.round(this.hullIntegrity),
            colorHex: trimHex,
            hullPresetIdx: this.hullPresetIdx,
            chassisIdx: this.chassisIdx,
            isCustomizing: this.isCustomizing,
            updatedAt: Date.now()
        };
    }

    private initMultiplayer() {
        const cleanupPresence = registerOnlinePlayer(this.localPlayerId, this.buildLocalPlayerState());
        const cleanupPlayers = subscribeToOnlinePlayers(this.localPlayerId, (onlineMap) => {
            this.handleOnlinePlayersUpdate(onlineMap);
        });
        const cleanupChat = subscribeToPersistedChat((msg) => {
            if (msg.id) {
                if (this.seenChatIds.has(msg.id)) return;
                this.seenChatIds.add(msg.id);
            }
            this.appendChatMessage(msg.sender, msg.colorHex || 0x00f0ff, msg.text, !!msg.isSystem);
        });
        const cleanupCombat = subscribeToIncomingCombatHits(this.localPlayerId, (hit) => {
            this.takeDamage(hit.damage, `LASER FIRE FROM ${hit.attackerCallsign}`);
            syncOnlinePlayerState(this.localPlayerId, this.buildLocalPlayerState());
        });

        // Background-tab-safe heartbeat so unfocused browser tabs stay active in the sector
        const heartbeatId = window.setInterval(() => {
            if (!this.isDestroyed) {
                syncOnlinePlayerState(this.localPlayerId, this.buildLocalPlayerState());
            }
        }, 2500);
        const cleanupHeartbeat = () => clearInterval(heartbeatId);

        this.rtdbCleanups.push(cleanupPresence, cleanupPlayers, cleanupChat, cleanupCombat, cleanupHeartbeat);
    }

    private handleOnlinePlayersUpdate(onlineMap: Record<string, OnlinePlayerState>) {
        const onlineIds = Object.keys(onlineMap);
        const hasRealPlayers = onlineIds.length > 0;

        // Kick out AI bots whenever a real online player joins the sector!
        if (hasRealPlayers && this.botsActive) {
            this.botsActive = false;
            if (this.pendingReplyTimeout) {
                clearTimeout(this.pendingReplyTimeout);
                this.pendingReplyTimeout = null;
            }
            this.aiPlayers.forEach((bot) => {
                bot.group.visible = false;
            });
            this.appendChatMessage(
                '',
                0x00f5d4,
                `✦ REAL ONLINE PILOT DETECTED — AI holographic bots kicked from sector!`,
                true
            );
        } else if (!hasRealPlayers && !this.botsActive) {
            this.botsActive = true;
            this.aiPlayers.forEach((bot) => {
                bot.group.visible = true;
            });
            this.appendChatMessage(
                '',
                0x00f0ff,
                `✦ Sector clear of remote pilots — AI holographic fleet re-engaged.`,
                true
            );
        }

        // Always enforce bot visibility matching botsActive state
        this.aiPlayers.forEach((bot) => {
            bot.group.visible = this.botsActive;
        });

        // Update top HUD online count badge
        const countBadge = document.getElementById('mmo-online-count');
        if (countBadge) {
            if (hasRealPlayers) {
                countBadge.textContent = `● ${onlineIds.length + 1} ONLINE PLAYERS IN SECTOR`;
            } else {
                countBadge.textContent = `● ${this.aiPlayers.length + 1} TRAVELLERS IN SECTOR`;
            }
        }

        // Remove remote players who disconnected
        for (const [id, remote] of this.remotePlayers.entries()) {
            if (!onlineMap[id]) {
                this.scene.remove(remote.group);
                (remote.nameSprite.material as THREE.SpriteMaterial).map?.dispose();
                remote.nameSprite.material.dispose();
                this.remotePlayers.delete(id);
                this.appendChatMessage('', 0xffbe6b, `✦ ${remote.callsign} warped out of the sector.`, true);
            }
        }

        // Add or update active remote players
        const now = Date.now();
        for (const [id, pState] of Object.entries(onlineMap)) {
            let remote = this.remotePlayers.get(id);
            if (!remote) {
                remote = this.createRemotePlayerActor(pState);
                this.remotePlayers.set(id, remote);
                this.appendChatMessage('', 0x00f5d4, `✦ Online pilot ${pState.callsign} joined the sector!`, true);
            } else {
                remote.targetPos.set(pState.x, pState.y, pState.z);
                remote.targetYaw = pState.yaw;
                remote.targetRoll = pState.roll;
                remote.targetPitch = pState.pitch;

                // Only overwrite local hull prediction if we haven't just damaged this remote player in the last 1.5s
                const syncedHull = now - remote.lastDamagedAt > 1500 ? pState.hull : remote.hull;

                if (
                    remote.callsign !== pState.callsign ||
                    remote.hull !== syncedHull ||
                    remote.colorHex !== pState.colorHex ||
                    remote.isCustomizing !== !!pState.isCustomizing
                ) {
                    remote.callsign = pState.callsign;
                    remote.hull = syncedHull;
                    remote.colorHex = pState.colorHex;
                    remote.isCustomizing = !!pState.isCustomizing;
                    if (remote.gltfMat) {
                        remote.gltfMat.emissive.setHex(pState.colorHex);
                    }
                    remote.group.remove(remote.nameSprite);
                    (remote.nameSprite.material as THREE.SpriteMaterial).map?.dispose();
                    remote.nameSprite.material.dispose();
                    remote.nameSprite = this.createNametagSprite(
                        remote.callsign,
                        remote.isCustomizing ? 'IN GARAGE' : `ONLINE • ${remote.hull}%`,
                        remote.colorHex,
                        remote.hull
                    );
                    remote.group.add(remote.nameSprite);
                }
            }
        }
    }

    private createRemotePlayerActor(pState: OnlinePlayerState): RemotePlayerActor {
        const group = new THREE.Group();
        group.rotation.order = 'YXZ';
        group.position.set(pState.x, pState.y, pState.z);
        group.rotation.y = pState.yaw;

        const hullMesh = new THREE.Mesh(
            SHARED_AI_HULL_GEO,
            new THREE.MeshStandardMaterial({
                color: 0x241442,
                metalness: 0.92,
                roughness: 0.1,
                envMapIntensity: 2.2,
                emissive: pState.colorHex || 0x00f0ff,
                emissiveIntensity: 0.85
            })
        );
        hullMesh.scale.set(2.2, 2.2, 2.2);
        const wireEdges = new THREE.LineSegments(
            SHARED_AI_EDGES_GEO,
            new THREE.LineBasicMaterial({
                color: pState.colorHex || 0x00f0ff,
                transparent: true,
                opacity: 0.95
            })
        );
        hullMesh.add(wireEdges);
        group.add(hullMesh);

        const thrusterGlow = new THREE.Mesh(
            SHARED_BEAM_GEO,
            new THREE.MeshBasicMaterial({ color: pState.colorHex || 0x00f0ff })
        );
        thrusterGlow.scale.set(1.3, 0.9, 1.8);
        thrusterGlow.position.set(0, 0.3, 2.1);
        group.add(thrusterGlow);

        const nameSprite = this.createNametagSprite(
            pState.callsign,
            pState.isCustomizing ? 'IN GARAGE' : `ONLINE • ${pState.hull}%`,
            pState.colorHex || 0x00f0ff,
            pState.hull
        );
        group.add(nameSprite);

        this.scene.add(group);

        const actor: RemotePlayerActor = {
            id: pState.id,
            group,
            hullMesh,
            nameSprite,
            callsign: pState.callsign,
            colorHex: pState.colorHex || 0x00f0ff,
            hull: pState.hull ?? 100,
            isCustomizing: !!pState.isCustomizing,
            killCooldown: 0,
            lastDamagedAt: 0,
            targetPos: new THREE.Vector3(pState.x, pState.y, pState.z),
            targetYaw: pState.yaw || 0,
            targetRoll: pState.roll || 0,
            targetPitch: pState.pitch || 0.04
        };

        this.mountGLTFOnRemoteShip(actor);
        return actor;
    }

    private damageRemotePlayer(remote: RemotePlayerActor, hitPos: THREE.Vector3) {
        if (remote.isCustomizing || remote.killCooldown > 0) return;

        remote.lastDamagedAt = Date.now();
        remote.hull = Math.max(0, remote.hull - 34);
        sendPvPCombatHit(remote.id, {
            attackerId: this.localPlayerId,
            attackerCallsign: this.pilotCallsign || 'STARLORD_84',
            damage: 34,
            timestamp: Date.now()
        });

        // Update nametag shield bar immediately on hit
        remote.group.remove(remote.nameSprite);
        (remote.nameSprite.material as THREE.SpriteMaterial).map?.dispose();
        remote.nameSprite.material.dispose();
        remote.nameSprite = this.createNametagSprite(
            remote.callsign,
            `ONLINE • ${remote.hull}%`,
            remote.colorHex,
            remote.hull
        );
        remote.group.add(remote.nameSprite);

        const hullMat = remote.gltfMat || (remote.hullMesh.material as THREE.MeshStandardMaterial);
        hullMat.emissive.setHex(0xffffff);
        hullMat.emissiveIntensity = 2.2;
        window.setTimeout(() => {
            if (!this.isDestroyed) {
                hullMat.emissive.setHex(remote.colorHex);
                hullMat.emissiveIntensity = 0.82;
            }
        }, 160);

        for (let k = 0; k < 18; k++) {
            const spark = new MoteParticle(
                hitPos,
                k % 2 === 0 ? remote.colorHex : 0xff0055,
                null,
                0.32
            );
            spark.velocity.set(
                (Math.random() - 0.5) * 1.4,
                (Math.random() - 0.5) * 1.4,
                (Math.random() - 0.5) * 1.4
            );
            spark.life = 0.6;
            this.scene.add(spark.mesh);
            this.particles.push(spark);
        }

        if (remote.hull > 0) {
            this.audio.playLaserHitSound(false);
        } else {
            remote.hull = 100;
            remote.killCooldown = 4.0;
            this.score += 1000;
            const scoreEl = document.getElementById('game-score');
            if (scoreEl) scoreEl.textContent = this.score.toLocaleString();

            if (this.hullIntegrity < 100) {
                this.hullIntegrity = Math.min(100, this.hullIntegrity + 12);
                this.updateHullHud();
            }
            this.audio.playLaserHitSound(true);
            this.audio.playImpactSound();

            const explosionColors = [remote.colorHex, 0xff007f, 0x00f0ff, 0xffbe0b, 0xffffff];
            for (let k = 0; k < 42; k++) {
                const col = explosionColors[k % explosionColors.length];
                const isLoot = k < 12;
                const p = new MoteParticle(
                    remote.group.position,
                    col,
                    isLoot ? this.ship : null,
                    isLoot ? 0.34 : 0.45
                );
                if (!isLoot) {
                    p.velocity.set(
                        (Math.random() - 0.5) * 2.4,
                        (Math.random() - 0.5) * 2.4,
                        (Math.random() - 0.5) * 2.4
                    );
                    p.life = 0.95;
                }
                this.scene.add(p.mesh);
                this.particles.push(p);
            }

            const caller = this.pilotCallsign || 'STARLORD_84';
            pushPersistedChatMessage({
                sender: '',
                colorHex: 0xffbe0b,
                text: `⚔️ ${caller} vaporized online pilot ${remote.callsign}'s starship! (+1,000 UNITS)`,
                isSystem: true,
                timestamp: Date.now()
            });
        }
    }

    private upgradeAIShipsWithGLTF(cleanTemplate: THREE.Object3D) {
        this.aiPlayers.forEach((bot) => {
            const gltfClone = cleanTemplate.clone(true);
            gltfClone.scale.set(0.16, 0.16, 0.16);
            gltfClone.rotation.y = Math.PI;
            gltfClone.rotation.x = this.MODEL_LEVEL_PITCH;

            const aiMat = new THREE.MeshStandardMaterial({
                color: 0x241442,
                metalness: 0.92,
                roughness: 0.1,
                envMapIntensity: 2.4,
                emissive: bot.colorHex,
                emissiveIntensity: 0.78
            });

            gltfClone.traverse((child) => {
                if ((child as THREE.Mesh).isMesh) {
                    (child as THREE.Mesh).material = aiMat;
                }
            });

            // Hide the fallback low-poly delta hull and mount the full 3D GLTF starship!
            bot.hullMesh.visible = false;
            bot.group.add(gltfClone);
            (bot as unknown as { gltfMat?: THREE.MeshStandardMaterial }).gltfMat = aiMat;
        });
    }

    private syncCustomizerSlidersUI() {
        const setSlider = (sliderId: string, valId: string, val: number, suffix: string) => {
            const sEl = document.getElementById(sliderId) as HTMLInputElement | null;
            const vEl = document.getElementById(valId);
            if (sEl) sEl.value = String(Math.round(val));
            if (vEl) vEl.textContent = `${Math.round(val)}${suffix}`;
        };

        setSlider('slider-hull-hue', 'val-hull-hue', this.hullHue, '°');
        setSlider('slider-glow', 'val-glow', this.glowPct, '%');
        setSlider('slider-chrome', 'val-chrome', this.chromePct, '%');
        setSlider('slider-wingspan', 'val-wingspan', this.wingspanPct, '%');
        setSlider('slider-length', 'val-length', this.lengthPct, '%');
        setSlider('slider-bulk', 'val-bulk', this.bulkPct, '%');
        setSlider('slider-aura-scale', 'val-aura-scale', this.auraScalePct, '%');

        const markActiveButton = (containerId: string, attr: string, activeIdx: number) => {
            const containerEl = document.getElementById(containerId);
            if (!containerEl) return;
            containerEl.querySelectorAll('button').forEach((btn) => {
                btn.classList.toggle('active', Number(btn.getAttribute(attr)) === activeIdx);
            });
        };

        markActiveButton('custom-hull-options', 'data-hull', this.useCustomHullHue ? -1 : this.hullPresetIdx);
        markActiveButton('custom-trim-options', 'data-trim', this.trimColorIdx);
        markActiveButton('custom-trail-options', 'data-trail', this.trailPresetIdx);
        markActiveButton('custom-chassis-options', 'data-chassis', this.chassisIdx);
        markActiveButton('custom-aura-options', 'data-aura', this.auraStyleIdx);
    }

    public randomizeShipCustomization() {
        this.useCustomHullHue = Math.random() < 0.45;
        this.hullPresetIdx = Math.floor(Math.random() * HULL_PRESETS.length);
        const preset = HULL_PRESETS[this.hullPresetIdx];
        this.hullHue = this.useCustomHullHue ? Math.floor(Math.random() * 360) : preset.hue;
        this.glowPct = 65 + Math.floor(Math.random() * 125);
        this.chromePct = 30 + Math.floor(Math.random() * 70);
        this.trimColorIdx = Math.floor(Math.random() * TRIM_COLORS.length);
        this.trailPresetIdx = Math.floor(Math.random() * TRAIL_PRESETS.length);
        this.chassisIdx = Math.floor(Math.random() * CHASSIS_PROFILES.length);
        this.wingspanPct = 70 + Math.floor(Math.random() * 85);
        this.lengthPct = 72 + Math.floor(Math.random() * 82);
        this.bulkPct = 78 + Math.floor(Math.random() * 62);
        this.auraStyleIdx = Math.floor(Math.random() * 3); // prefer visible holographic aura on randomize
        this.auraScalePct = 75 + Math.floor(Math.random() * 70);

        this.syncCustomizerSlidersUI();
        this.applyShipCustomization();
        this.audio.playHarvestChime();
    }

    public resetShipCustomization() {
        this.useCustomHullHue = false;
        this.hullPresetIdx = 0;
        const preset = HULL_PRESETS[0];
        this.hullHue = preset.hue;
        this.glowPct = preset.glow;
        this.chromePct = preset.chrome;
        this.trimColorIdx = 0;
        this.trailPresetIdx = 0;
        this.chassisIdx = 0;
        this.wingspanPct = 100;
        this.lengthPct = 100;
        this.bulkPct = 100;
        this.auraStyleIdx = 0;
        this.auraScalePct = 100;

        this.syncCustomizerSlidersUI();
        this.applyShipCustomization();
        this.audio.playHarvestChime();
    }

    private applyShipCustomization() {
        const hull = HULL_PRESETS[this.hullPresetIdx] || HULL_PRESETS[0];
        const trim = TRIM_COLORS[this.trimColorIdx] || TRIM_COLORS[0];
        const trail = TRAIL_PRESETS[this.trailPresetIdx] || TRAIL_PRESETS[0];

        const baseColor = new THREE.Color();
        const emissiveColor = new THREE.Color();
        if (this.useCustomHullHue) {
            const h = ((this.hullHue % 360) + 360) % 360 / 360;
            baseColor.setHSL(h, 0.88, 0.34);
            emissiveColor.setHSL(h, 0.96, 0.46);
        } else {
            baseColor.setHex(hull.color);
            emissiveColor.setHex(hull.emissive);
        }

        const glowNorm = this.glowPct / 100; // 0.0 -> 2.0
        const chromeNorm = this.chromePct / 100; // 0.0 -> 1.0

        this.shipHullMaterials.forEach((mat) => {
            mat.color.copy(baseColor);
            mat.emissive.copy(emissiveColor);
            mat.emissiveIntensity = 0.22 + glowNorm * 0.68;
            mat.metalness = 0.15 + chromeNorm * 0.83;
            mat.roughness = Math.max(0.04, 0.56 - chromeNorm * 0.50);
            mat.envMapIntensity = 0.9 + chromeNorm * 2.4;
            mat.needsUpdate = true;
        });

        this.shipTrimLines.forEach((lineMat) => {
            lineMat.color.setHex(trim.hex);
            lineMat.opacity = THREE.MathUtils.clamp(0.32 + glowNorm * 0.58, 0.18, 1.0);
        });

        this.shipThrusterMats.forEach((tMat, idx) => {
            tMat.color.setHex(trail.colors[idx % trail.colors.length]);
            tMat.opacity = THREE.MathUtils.clamp(0.45 + glowNorm * 0.5, 0.25, 1.0);
        });

        this.shipAccentMats.forEach((aMat) => {
            aMat.color.setHex(trim.hex);
            aMat.opacity = THREE.MathUtils.clamp(0.35 + glowNorm * 0.55, 0.2, 1.0);
        });

        if (this.hangarRingMats.length >= 3) {
            this.hangarRingMats[0].color.setHex(trim.hex);
            this.hangarRingMats[1].color.setHex(trail.colors[0]);
            this.hangarRingMats[2].color.setHex(trim.hex);
        }

        if (this.shipPrimaryLight) {
            this.shipPrimaryLight.color.setHex(trim.hex);
            this.shipPrimaryLight.intensity = 12 + glowNorm * 18;
        }
        if (this.shipRearLight) {
            this.shipRearLight.color.setHex(trail.colors[0]);
            this.shipRearLight.intensity = 10 + glowNorm * 16;
        }
        if (this.shipShowroomLight) {
            this.shipShowroomLight.intensity = this.isCustomizing ? 28 : 16;
        }

        if (this.rawShipModel) {
            const sx = 0.12 * (this.wingspanPct / 100);
            const sy = 0.12 * (this.bulkPct / 100);
            const sz = 0.12 * (this.lengthPct / 100);
            this.rawShipModel.scale.set(sx, sy, sz);
        }

        if (this.shieldMesh) {
            this.shieldMesh.geometry.dispose();
            if (this.auraStyleIdx === 0) {
                this.shieldMesh.geometry = new THREE.IcosahedronGeometry(1.65, 1);
                this.shieldMesh.visible = true;
            } else if (this.auraStyleIdx === 1) {
                this.shieldMesh.geometry = new THREE.TorusKnotGeometry(1.2, 0.08, 48, 8, 2, 3);
                this.shieldMesh.visible = true;
            } else if (this.auraStyleIdx === 2) {
                this.shieldMesh.geometry = new THREE.OctahedronGeometry(1.75, 0);
                this.shieldMesh.visible = true;
            } else {
                this.shieldMesh.geometry = new THREE.IcosahedronGeometry(0.1, 0);
                this.shieldMesh.visible = false;
            }
            const auraScale = this.auraScalePct / 100;
            this.shieldMesh.scale.setScalar(auraScale);
            const shieldMat = this.shieldMesh.material as THREE.MeshBasicMaterial;
            shieldMat.color.setHex(trim.hex);
            shieldMat.opacity = THREE.MathUtils.clamp(0.05 + (auraScale - 0.4) * 0.12 * Math.max(0.5, glowNorm), 0.04, 0.38);
        }
    }

    public toggleCustomizer(forceState?: boolean) {
        this.isCustomizing = forceState !== undefined ? forceState : !this.isCustomizing;
        const panel = document.getElementById('ship-customizer-panel');
        const flightBar = document.getElementById('flight-controls-bar');

        if (this.hangarPlatformGroup) {
            this.hangarPlatformGroup.visible = this.isCustomizing;
        }
        if (this.shipShowroomLight) {
            this.shipShowroomLight.intensity = this.isCustomizing ? 28 : 16;
        }

        if (this.isCustomizing) {
            panel?.classList.add('customizer-visible');
            flightBar?.classList.add('hud-hidden-during-custom');
        } else {
            this.isDraggingShowroom = false;
            const callsignInput = document.getElementById('custom-callsign-input') as HTMLInputElement | null;
            if (callsignInput && callsignInput.value.trim()) {
                this.pilotCallsign = callsignInput.value.trim().toUpperCase().slice(0, 12);
            }
            panel?.classList.remove('customizer-visible');
            flightBar?.classList.remove('hud-hidden-during-custom');
            this.portalBoost = 45.0;
            this.audio.playPortalChord();
        }
    }

    private createNametagSprite(callsign: string, status: string, colorHex: number, hullPct = 100): THREE.Sprite {
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 140;
        const ctx = canvas.getContext('2d')!;
        const hexStr = '#' + colorHex.toString(16).padStart(6, '0');

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Glassmorphic pill background
        ctx.fillStyle = 'rgba(8, 3, 24, 0.78)';
        ctx.strokeStyle = hullPct < 100 ? '#ff0055' : hexStr;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.roundRect(26, 16, 460, 104, 42);
        ctx.fill();
        ctx.stroke();

        // Callsign text
        ctx.font = 'bold 28px "Orbitron", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = hexStr;
        ctx.shadowBlur = 12;
        ctx.fillText(`◈ ${callsign.toUpperCase()}`, 256, 54);

        // Status subtitle
        ctx.shadowBlur = 0;
        ctx.font = '19px "Share Tech Mono", monospace';
        ctx.fillStyle = hullPct < 100 ? '#ffbe0b' : hexStr;
        ctx.fillText(`[ ${status} ]`, 256, 82);

        // Health / Shield bar inside the nametag
        const barW = 320;
        const barH = 8;
        const barX = (512 - barW) / 2;
        const barY = 96;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
        ctx.fillRect(barX, barY, barW, barH);

        const fillW = Math.max(0, Math.min(1, hullPct / 100)) * barW;
        ctx.fillStyle = hullPct > 60 ? '#00f5d4' : hullPct > 30 ? '#ffbe0b' : '#ff0055';
        ctx.fillRect(barX, barY, fillW, barH);

        const tex = new THREE.CanvasTexture(canvas);
        tex.needsUpdate = true;

        const mat = new THREE.SpriteMaterial({
            map: tex,
            transparent: true,
            depthWrite: false,
            fog: false
        });
        const sprite = new THREE.Sprite(mat);
        sprite.position.set(0, 3.8, 0);
        sprite.scale.set(13.5, 3.7, 1);
        return sprite;
    }

    private spawnAIPlayers() {
        DEFAULT_TRAVELLER_PROFILES.forEach((profile, idx) => {
            const callsign = this.leaderboardPilotNames[idx] || profile.callsign;
            const aiGroup = new THREE.Group();
            aiGroup.rotation.order = 'YXZ';

            // High-visibility 3D Delta-Wing Starfighter (scaled 2.2x larger so it's unmistakable even before GLTF loads!)
            const hullMesh = new THREE.Mesh(
                SHARED_AI_HULL_GEO,
                new THREE.MeshStandardMaterial({
                    color: 0x241442,
                    metalness: 0.92,
                    roughness: 0.1,
                    envMapIntensity: 2.2,
                    emissive: profile.colorHex,
                    emissiveIntensity: 0.82
                })
            );
            hullMesh.scale.set(2.2, 2.2, 2.2);
            const wireEdges = new THREE.LineSegments(
                SHARED_AI_EDGES_GEO,
                new THREE.LineBasicMaterial({
                    color: profile.colorHex,
                    transparent: true,
                    opacity: 0.95
                })
            );
            hullMesh.add(wireEdges);
            aiGroup.add(hullMesh);

            // Bright glowing twin thruster core at the rear of every AI player ship
            const thrusterGlow = new THREE.Mesh(
                SHARED_BEAM_GEO,
                new THREE.MeshBasicMaterial({ color: profile.colorHex })
            );
            thrusterGlow.scale.set(1.3, 0.9, 1.8);
            thrusterGlow.position.set(0, 0.3, 2.1);
            aiGroup.add(thrusterGlow);

            // Holographic wireframe shield aura around each AI player ship
            const aiShield = new THREE.Mesh(
                SHARED_MOTE_GEO,
                new THREE.MeshBasicMaterial({
                    color: profile.colorHex,
                    wireframe: true,
                    transparent: true,
                    opacity: 0.22
                })
            );
            aiShield.scale.set(2.8, 1.5, 3.2);
            aiGroup.add(aiShield);

            const nameSprite = this.createNametagSprite(callsign, profile.status, profile.colorHex, 100);
            aiGroup.add(nameSprite);

            // Spawn all AI players in a visible forward sector in front of the player (-Z)
            const spreadX = ((idx % 2 === 0 ? 1 : -1) * (14 + idx * 7));
            const forwardZ = -28 - idx * 14;
            const startY = 3.2 + (idx % 4) * 2.1;
            aiGroup.position.set(spreadX, startY, forwardZ);

            const initialYaw = (Math.random() - 0.5) * 0.45;
            aiGroup.rotation.y = initialYaw;
            this.scene.add(aiGroup);

            this.aiPlayers.push({
                group: aiGroup,
                hullMesh,
                nameSprite,
                callsign,
                status: profile.status,
                colorHex: profile.colorHex,
                hull: 100,
                hostileTimer: 0,
                yaw: initialYaw,
                targetYaw: initialYaw,
                roll: 0,
                pitch: 0.04,
                speed: 38 + (idx % 4) * 4.0,
                targetY: startY,
                decisionTimer: 1.5 + idx * 0.7,
                beamCooldown: 2.0 + Math.random() * 4.0
            });
        });
    }

    public setLeaderboardPilots(names: string[]) {
        const cleaned = names.filter((n) => n && n.trim().length > 0).slice(0, DEFAULT_TRAVELLER_PROFILES.length);
        this.leaderboardPilotNames = cleaned;

        this.aiPlayers.forEach((bot, idx) => {
            if (cleaned[idx] && bot.callsign !== cleaned[idx]) {
                bot.callsign = cleaned[idx];
                this.updateBotNametag(bot, bot.status);
            }
        });
    }

    private updateBotNametag(bot: AIPlayer, subtitleText: string) {
        bot.group.remove(bot.nameSprite);
        (bot.nameSprite.material as THREE.SpriteMaterial).map?.dispose();
        bot.nameSprite.material.dispose();
        bot.nameSprite = this.createNametagSprite(bot.callsign, subtitleText, bot.colorHex, bot.hull);
        bot.group.add(bot.nameSprite);
    }

    private damageAIPlayer(bot: AIPlayer, hitPos: THREE.Vector3) {
        bot.hull = Math.max(0, bot.hull - 34);
        bot.hostileTimer = 14.0;
        bot.speed = 58.0;
        bot.targetYaw += (Math.random() > 0.5 ? 1 : -1) * 0.85;

        // Flash enemy hull bright white/crimson on hit
        const gltfMat = (bot as unknown as { gltfMat?: THREE.MeshStandardMaterial }).gltfMat;
        const hullMat = gltfMat || (bot.hullMesh.material as THREE.MeshStandardMaterial);
        hullMat.emissive.setHex(0xffffff);
        hullMat.emissiveIntensity = 2.2;
        window.setTimeout(() => {
            if (!this.isDestroyed) {
                hullMat.emissive.setHex(bot.colorHex);
                hullMat.emissiveIntensity = 0.78;
            }
        }, 160);

        // Spawn laser impact sparks
        for (let k = 0; k < 18; k++) {
            const spark = new MoteParticle(
                hitPos,
                k % 2 === 0 ? bot.colorHex : 0xff0055,
                null,
                0.32
            );
            spark.velocity.set(
                (Math.random() - 0.5) * 1.4,
                (Math.random() - 0.5) * 1.4,
                (Math.random() - 0.5) * 1.4
            );
            spark.life = 0.6;
            this.scene.add(spark.mesh);
            this.particles.push(spark);
        }

        if (bot.hull > 0) {
            this.audio.playLaserHitSound(false);
            this.updateBotNametag(bot, `SHIELD ${bot.hull}%`);

            if (Math.random() < 0.65) {
                const caller = this.pilotCallsign || 'STARLORD_84';
                const hitReactions = [
                    `@${caller} HEY WATCH THE PAINTJOB I JUST POLISHED THIS CHROME!!`,
                    `@${caller} bro why are you shooting at me i'm literally just vibing 💀`,
                    `@${caller} shields at ${bot.hull}%!! engaging evasive synth-maneuvers!`,
                    `@${caller} ow my cassette deck skipped!! returning fire!`,
                    `@${caller} Ayo chill!! My neon underglow isn't covered by insurance!`,
                    `@${caller} bold move picking a fight in the middle of an Outrun solo!`,
                    `@${caller} hull integrity dropping—rerouting power from subwoofers to shields!`,
                    `@${caller} you just spilled my zero-G space slushie all over the cockpit!!`
                ];
                const msg = hitReactions[Math.floor(Math.random() * hitReactions.length)];
                this.appendChatMessage(bot.callsign, bot.colorHex, msg);
            }
        } else {
            // Enemy Starship Destroyed! (Only way to earn score!)
            this.score += 1000;
            const scoreEl = document.getElementById('game-score');
            if (scoreEl) scoreEl.textContent = this.score.toLocaleString();

            if (this.hullIntegrity < 100) {
                this.hullIntegrity = Math.min(100, this.hullIntegrity + 12);
                this.updateHullHud();
            }
            this.audio.playLaserHitSound(true);
            this.audio.playImpactSound();

            // Big Supernova Ship Explosion
            const explosionColors = [bot.colorHex, 0xff007f, 0x00f0ff, 0xffbe0b, 0xffffff];
            for (let k = 0; k < 42; k++) {
                const col = explosionColors[k % explosionColors.length];
                const isLoot = k < 12;
                const p = new MoteParticle(
                    bot.group.position,
                    col,
                    isLoot ? this.ship : null,
                    isLoot ? 0.34 : 0.45
                );
                if (!isLoot) {
                    p.velocity.set(
                        (Math.random() - 0.5) * 2.4,
                        (Math.random() - 0.5) * 2.4,
                        (Math.random() - 0.5) * 2.4
                    );
                    p.life = 0.95;
                }
                this.scene.add(p.mesh);
                this.particles.push(p);
            }

            const caller = this.pilotCallsign || 'STARLORD_84';
            this.appendChatMessage(
                '',
                0xffbe0b,
                `⚔️ ${caller} vaporized ${bot.callsign}'s starship! (+1,000 UNITS & +12% SHIELD SIPHON)`,
                true
            );

            const saltyLines = [
                `@${caller} reported for 1984 aimbot 💀`,
                `@${caller} gg my cat unplugged my joystick right as you fired`,
                `@${caller} ok 1v1 me by the giant sliced sun right now`,
                `@${caller} bro i had 14 unbanked Perlin crystals in my trunk 😭`,
                `@${caller} lag!! i was literally behind an asteroid on my CRT monitor!!`,
                `@${caller} enjoy the 1,000 units, i'm respawning with dual plasma cannons`,
                `@${caller} my mom called me for dinner mid-dogfight, doesn't count`,
                `@${caller} nice shot ngl, my synth-shields stood zero chance`
            ];
            const salty = saltyLines[Math.floor(Math.random() * saltyLines.length)];
            window.setTimeout(() => {
                if (!this.isDestroyed) {
                    this.appendChatMessage(bot.callsign, bot.colorHex, salty);
                }
            }, 1100);

            // Respawn the defeated AI player ahead with fresh 100% hull
            bot.hull = 100;
            bot.hostileTimer = 0;
            this.updateBotNametag(bot, bot.status);
            this.respawnAheadOfShip(bot.group, 95, 165, 110);
            bot.group.position.y = 3.5 + Math.random() * 8.0;
        }
    }

    private appendChatMessage(sender: string, colorHex: number, text: string, isSystem = false) {
        const box = document.getElementById('mmo-chat-messages');
        if (!box) return;

        const row = document.createElement('div');
        row.className = isSystem ? 'chat-msg system-event' : 'chat-msg';

        if (isSystem) {
            row.textContent = text;
        } else {
            const hexStr = '#' + colorHex.toString(16).padStart(6, '0');
            const senderSpan = document.createElement('span');
            senderSpan.className = 'chat-sender';
            senderSpan.style.color = hexStr;
            senderSpan.textContent = `[${sender}]:`;
            row.appendChild(senderSpan);

            // Highlight @mentions in neon gold
            const parts = text.split(/(@[A-Za-z0-9_-]+)/g);
            parts.forEach((part) => {
                if (part.startsWith('@')) {
                    const mention = document.createElement('span');
                    mention.className = 'chat-mention';
                    mention.textContent = part;
                    row.appendChild(mention);
                } else {
                    row.appendChild(document.createTextNode(part));
                }
            });
        }

        box.appendChild(row);
        while (box.children.length > 28) {
            box.removeChild(box.firstChild!);
        }
        box.scrollTop = box.scrollHeight;

        // Also show speech snippet on the 3D spaceship's floating nametag!
        const snippet = text.length > 22 ? `💬 "${text.slice(0, 20)}.."` : `💬 "${text}"`;
        for (const remote of this.remotePlayers.values()) {
            if (remote.callsign === sender) {
                remote.group.remove(remote.nameSprite);
                (remote.nameSprite.material as THREE.SpriteMaterial).map?.dispose();
                remote.nameSprite.material.dispose();
                remote.nameSprite = this.createNametagSprite(remote.callsign, snippet, remote.colorHex, remote.hull);
                remote.group.add(remote.nameSprite);
                window.setTimeout(() => {
                    if (!this.isDestroyed && this.remotePlayers.has(remote.id)) {
                        remote.group.remove(remote.nameSprite);
                        (remote.nameSprite.material as THREE.SpriteMaterial).map?.dispose();
                        remote.nameSprite.material.dispose();
                        remote.nameSprite = this.createNametagSprite(
                            remote.callsign,
                            remote.isCustomizing ? 'IN GARAGE' : `ONLINE • ${remote.hull}%`,
                            remote.colorHex,
                            remote.hull
                        );
                        remote.group.add(remote.nameSprite);
                    }
                }, 4800);
            }
        }
        const speakingBot = this.aiPlayers.find((b) => b.callsign === sender);
        if (speakingBot && this.botsActive) {
            this.updateBotNametag(speakingBot, snippet);
            window.setTimeout(() => {
                if (!this.isDestroyed) {
                    this.updateBotNametag(speakingBot, speakingBot.status);
                }
            }, 4800);
        }
    }

    private triggerRandomBotChat() {
        if (this.aiPlayers.length < 2) return;

        const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
        const botA = pick(this.aiPlayers);
        let botB = pick(this.aiPlayers);
        if (botB === botA) {
            botB = this.aiPlayers[(this.aiPlayers.indexOf(botA) + 1) % this.aiPlayers.length];
        }

        const planetName = pick(BIOMES).name;

        // 65% chance of a hilarious 2-part conversation between botA and botB, 35% procedural weirdness
        if (Math.random() < 0.65) {
            const dialogues: [string, string][] = [
                [
                    `@${botB.callsign} why were you flying backwards in circles around ${planetName} for 10 mins??`,
                    `@${botA.callsign} my cat stepped on the W key and i spilled ramen on my synthpad ok dont judge me`
                ],
                [
                    `wait guys is the giant sun made of horizontal slices or is my windshield broken`,
                    `@${botA.callsign} bro did NOT read the synthwave manual before undocking 💀`
                ],
                [
                    `does anyone know if ${planetName} has a 7-Eleven my hyperdrive runs on slushies`,
                    `@${botA.callsign} yeah take a left at the pink asteroid and third portal on the right`
                ],
                [
                    `WTS [Slightly Cursed Perlin Crystal] 450 units obo, it hums 80s saxophone solos at night`,
                    `@${botA.callsign} i'll give you 12 discovery units and a half-eaten space burrito`
                ],
                [
                    `@${botB.callsign} stop tailgating me there is literally infinite 3D space in every direction`,
                    `@${botA.callsign} your neon engine trails smell like blueberry vaporwave i cant help it`
                ],
                [
                    `i have been flying West for 4 hours and i think i left my stove on back on Earth`,
                    `@${botA.callsign} hit SHIFT to hyperjump back before your apartment turns into a nebula`
                ],
                [
                    `who keeps shooting lasers at the asteroids?? they are just vibing`,
                    `@${botA.callsign} sorry i thought it was a giant floating disco ball`
                ],
                [
                    `anyone else's cassette player stuck on loop playing arpeggios since 1984?`,
                    `@${botA.callsign} bold of you to assume that's a bug and not the meaning of life`
                ],
                [
                    `@${botB.callsign} race you to ${planetName} loser buys neon underglow for the whole sector`,
                    `@${botA.callsign} you're on, switching from DRIFT to PULSE mode right now!!`
                ],
                [
                    `just saw a guy do a 360 no-scope crystal harvest near the north ring`,
                    `@${botA.callsign} thank you i practiced that maneuver in a Wendy's parking lot`
                ],
                [
                    `@${botB.callsign} did you just hyperjump straight through a moon?!`,
                    `@${botA.callsign} physics is merely a suggestion when the bassline drops`
                ],
                [
                    `LFG 3 more pilots for ${planetName} orbital raid, must have VHS filter enabled`,
                    `@${botA.callsign} invite me i brought extra tracking-glitch snacks`
                ],
                [
                    `why is everyone in this sector flying around with hot pink lasers today`,
                    `@${botA.callsign} it adds +15 aerodynamic aesthetic horsepower bro trust me`
                ],
                [
                    `@${botB.callsign} i can see your ship's pop-up headlights blinking from 200 klicks away`,
                    `@${botA.callsign} i'm trying to signal the alien DJ on ${planetName} to drop the beat`
                ],
                [
                    `reminder that the only way onto the ATLAS leaderboard now is vaporizing starships 👀`,
                    `@${botA.callsign} wait fr?! *nervously diverts all power to shields*`
                ],
                [
                    `@${botB.callsign} truce until we pass ${planetName}? my hull is held together by duct tape`,
                    `@${botA.callsign} deal, grab some crystal shards before someone snipes you`
                ],
                [
                    `i tried to land on ${planetName} and bounced off the atmosphere into next Tuesday`,
                    `@${botA.callsign} classic rookie mistake, you gotta approach at a 45-degree synth angle`
                ],
                [
                    `is it just me or is ${this.pilotCallsign || 'STARLORD_84'} locking lasers onto everyone in sight`,
                    `@${botA.callsign} fly casual and don't make eye contact!!`
                ]
            ];

            const [line1, line2] = pick(dialogues);
            this.appendChatMessage(botA.callsign, botA.colorHex, line1);

            if (this.pendingReplyTimeout) clearTimeout(this.pendingReplyTimeout);
            this.pendingReplyTimeout = window.setTimeout(() => {
                if (!this.isDestroyed) {
                    this.appendChatMessage(botB.callsign, botB.colorHex, line2);
                }
            }, 2200 + Math.random() * 1800);
        } else {
            // Combinatorial procedural randomness so it's endlessly unpredictable
            const openers = [
                'ngl',
                'hear me out:',
                'unpopular opinion:',
                'psa to everyone in this sector:',
                'wait a second...',
                'bro',
                'captains log day 402:',
                'urgent question:',
                'hot take:',
                'breaking news:',
                'friendly reminder:',
                'chat is this real:'
            ];
            const subjects = [
                'my onboard AI toaster',
                'the magenta nebula',
                `some dude near ${planetName}`,
                'my VHS copy of Top Gun',
                'a floating octo-crystal',
                'my spaceship warranty',
                'the fourth dimension',
                `@${botB.callsign}'s left wing thruster`,
                'the synthwave bassline',
                'my flux capacitor',
                `the orbital ring around ${planetName}`,
                'my dashboard bobblehead'
            ];
            const predicates = [
                'just started speaking fluent dolphin',
                'owes me 3,000 discovery units',
                'tastes suspiciously like purple Gatorade',
                'is vibrating at 120 BPM synthwave tempo',
                'just clipped through an asteroid and winked at me',
                'told me to invest in neon wireframe futures',
                'refuses to turn left on Tuesdays',
                'is 100% made of pure 1986 nostalgia',
                'challenged me to a laser duel at dawn',
                'is currently buffering at 240p',
                'just harmonised with my shield generator',
                'Predicts a 90% chance of neon laser rain'
            ];
            const endings = ['', ' 💀', ' lmao', ' ???', ' (real)', ' no cap', ' brb crying', ' ✨', ' 👀', ' 😭'];

            const randomSentence = `${pick(openers)} ${pick(subjects)} ${pick(predicates)}${pick(endings)}`;
            this.appendChatMessage(botA.callsign, botA.colorHex, randomSentence);
        }
    }

    private createPortalRing(x: number, z: number) {
        const ringGeo = new THREE.TorusGeometry(15, 0.35, 12, 48);
        const ringMat = new THREE.MeshStandardMaterial({
            color: 0x00f0ff,
            emissive: 0x00f0ff,
            emissiveIntensity: 0.6,
            metalness: 0.9,
            roughness: 0.1,
            envMapIntensity: 2.0,
            transparent: true,
            opacity: 0.75
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.set(x, 7 + Math.random() * 6, z);
        ring.rotation.y = Math.random() * Math.PI;

        const outerGeo = new THREE.TorusGeometry(15.8, 0.15, 8, 48);
        const outerMat = new THREE.MeshBasicMaterial({
            color: 0xff2a9d,
            transparent: true,
            opacity: 0.5
        });
        ring.add(new THREE.Mesh(outerGeo, outerMat));

        const innerGeo = new THREE.OctahedronGeometry(2.2, 0);
        const innerMat = new THREE.MeshBasicMaterial({
            color: 0xffbe6b,
            wireframe: true,
            transparent: true,
            opacity: 0.75
        });
        const glyph = new THREE.Mesh(innerGeo, innerMat);
        ring.add(glyph);
        (ring as unknown as { glyph: THREE.Mesh; cooldown: number }).glyph = glyph;
        (ring as unknown as { glyph: THREE.Mesh; cooldown: number }).cooldown = 0;

        this.scene.add(ring);
        this.rings.push(ring);
    }

    private createPerlinAsteroid(seedIdx: number, x: number, z: number) {
        const baseRadius = 3.5 + Math.abs(fractalBrownianMotion(seedIdx * 13.7, z * 0.1, 4, 0.08)) * 7.5;
        const geo = new THREE.IcosahedronGeometry(baseRadius, 2);
        const pos = geo.attributes.position;

        for (let i = 0; i < pos.count; i++) {
            const vx = pos.getX(i);
            const vy = pos.getY(i);
            const vz = pos.getZ(i);
            const fbmVal = fractalBrownianMotion(
                vx * 12 + seedIdx * 31,
                vy * 12 + vz * 12,
                5,
                0.045
            );
            const scale = 1.0 + fbmVal * 0.42;
            pos.setXYZ(i, vx * scale, vy * scale * 0.85, vz * scale);
        }
        geo.computeVertexNormals();

        const isMagenta = seedIdx % 2 === 0;
        const mat = new THREE.MeshStandardMaterial({
            color: 0x160a2e,
            roughness: 0.16,
            metalness: 0.88,
            envMapIntensity: 2.0,
            emissive: isMagenta ? 0x2a063b : 0x05263b,
            emissiveIntensity: 0.45
        });
        const asteroid = new THREE.Mesh(geo, mat);

        const wire = new THREE.LineSegments(
            new THREE.EdgesGeometry(geo, 24),
            new THREE.LineBasicMaterial({
                color: isMagenta ? 0xff2a9d : 0x00f0ff,
                transparent: true,
                opacity: 0.42
            })
        );
        asteroid.add(wire);

        asteroid.position.set(x, 6 + (Math.random() - 0.5) * 28, z);
        const asteroidMeta = asteroid as unknown as { rotVec: THREE.Vector3; hitRadius: number };
        asteroidMeta.rotVec = new THREE.Vector3(
            (Math.random() - 0.5) * 0.35,
            (Math.random() - 0.5) * 0.35,
            (Math.random() - 0.5) * 0.35
        );
        asteroidMeta.hitRadius = baseRadius * 1.15 + 2.2;

        this.scene.add(asteroid);
        this.asteroids.push(asteroid);
    }

    private spawnCrystalCluster(x: number, z: number) {
        const group = new THREE.Group();
        const crystalColor = this.targetBiome.crystalColor;

        const mainGeo = new THREE.OctahedronGeometry(1.7, 0);
        const mainMat = new THREE.MeshStandardMaterial({
            color: crystalColor,
            emissive: crystalColor,
            emissiveIntensity: 0.65,
            roughness: 0.06,
            metalness: 0.92,
            envMapIntensity: 2.4,
            transparent: true,
            opacity: 0.94
        });
        const mainCrystal = new THREE.Mesh(mainGeo, mainMat);
        mainCrystal.scale.set(0.8, 1.9, 0.8);
        group.add(mainCrystal);

        const wire = new THREE.LineSegments(
            new THREE.EdgesGeometry(mainGeo),
            new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 })
        );
        mainCrystal.add(wire);

        const haloGeo = new THREE.RingGeometry(2.1, 2.38, 24);
        const haloMat = new THREE.MeshBasicMaterial({
            color: 0x00f0ff,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.45
        });
        const halo = new THREE.Mesh(haloGeo, haloMat);
        group.add(halo);

        group.position.set(x, 4.0 + Math.random() * 10, z);
        (group as unknown as { rotSpeed: number; baseY: number; phase: number }).rotSpeed = 0.6 + Math.random() * 0.8;
        (group as unknown as { rotSpeed: number; baseY: number; phase: number }).baseY = group.position.y;
        (group as unknown as { rotSpeed: number; baseY: number; phase: number }).phase = Math.random() * Math.PI * 2;

        this.scene.add(group);
        this.crystals.push(group);
    }

    private respawnAheadOfShip(obj: THREE.Object3D, minDist: number, maxDist: number, spread: number) {
        if (!this.ship) return;
        const fwd = this.getForwardVector();
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
        const dist = minDist + Math.random() * (maxDist - minDist);
        const lateral = (Math.random() - 0.5) * spread;

        obj.position.x = this.ship.position.x + fwd.x * dist + right.x * lateral;
        obj.position.z = this.ship.position.z + fwd.z * dist + right.z * lateral;
        (obj as unknown as { appearProgress?: number }).appearProgress = 0.0;
    }

    private harvestCrystal(index: number) {
        const crystal = this.crystals[index];
        if (!crystal) return;

        this.mineralsHarvested++;
        if (this.hullIntegrity < 100) {
            this.hullIntegrity = Math.min(100, this.hullIntegrity + 5);
            this.updateHullHud();
        }
        this.audio.playHarvestChime();

        for (let k = 0; k < 14; k++) {
            const mote = new MoteParticle(
                crystal.position,
                k % 2 === 0 ? this.targetBiome.crystalColor : this.targetBiome.nebulaSecondary,
                this.ship
            );
            this.scene.add(mote.mesh);
            this.particles.push(mote);
        }

        this.respawnAheadOfShip(crystal, 180, 340, 140);
        crystal.position.y = Math.random() * 10 + 2.0;
        (crystal as unknown as { baseY: number }).baseY = crystal.position.y;
    }

    private initEvents() {
        const ensureAudio = () => {
            this.audio.init();
            window.removeEventListener('pointerdown', ensureAudio);
            window.removeEventListener('keydown', ensureAudio);
        };
        window.addEventListener('pointerdown', ensureAudio);
        window.addEventListener('keydown', ensureAudio);

        const move = (_cx: number, cy: number) => {
            if (this.isDestroyed || !this.ship) return;
            const y = -((cy / window.innerHeight) * 2 - 1);
            this.targetShipY = THREE.MathUtils.clamp((y + 1) * 4.8 + 1.2, 0.5, 14.0);
            this.shipPitch = 0.04 + y * 0.16;
        };

        window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
        window.addEventListener(
            'touchmove',
            (e) => {
                const target = e.target as HTMLElement | null;
                if (target?.closest('#ship-customizer-panel, #mmo-chat-panel, .modal-overlay-custom')) {
                    return;
                }
                if (this.isCustomizing) {
                    return;
                }
                if (e.touches.length > 0) {
                    const tx = (e.touches[0].clientX / window.innerWidth) * 2 - 1;
                    this.targetYaw -= tx * 0.035;
                    move(e.touches[0].clientX, e.touches[0].clientY);
                    e.preventDefault();
                }
            },
            { passive: false }
        );

        const emitResonanceBeam = () => {
            if (this.isDestroyed || !this.ship || this.isCustomizing) return;
            this.audio.playBeamPulse();
            const fwd = this.getForwardVector();
            const beamColor = TRIM_COLORS[this.trimColorIdx]?.hex ?? 0x00f0ff;

            // Soft Target-Lock Aim Assist: lock onto the closest active online player or AI bot in the forward cone!
            let lockedTarget: THREE.Object3D | null = null;
            let bestScore = 0.82; // minimum cosine similarity (~34° cone)
            for (const remote of this.remotePlayers.values()) {
                if (remote.isCustomizing || remote.killCooldown > 0) continue;
                const toRemote = new THREE.Vector3().subVectors(remote.group.position, this.ship.position);
                const dist = toRemote.length();
                if (dist > 5 && dist < 260) {
                    const align = toRemote.normalize().dot(fwd);
                    if (align > bestScore) {
                        bestScore = align;
                        lockedTarget = remote.group;
                    }
                }
            }
            if (this.botsActive) {
                for (const bot of this.aiPlayers) {
                    const toBot = new THREE.Vector3().subVectors(bot.group.position, this.ship.position);
                    const dist = toBot.length();
                    if (dist > 5 && dist < 240) {
                        const align = toBot.normalize().dot(fwd);
                        if (align > bestScore) {
                            bestScore = align;
                            lockedTarget = bot.group;
                        }
                    }
                }
            }

            const beam = new THREE.Mesh(
                SHARED_BEAM_GEO,
                new THREE.MeshBasicMaterial({ color: beamColor, transparent: true, opacity: 0.95 })
            );
            beam.scale.set(0.85, 0.85, 4.4);
            beam.position.copy(this.ship.position).addScaledVector(fwd, 2.2);
            beam.rotation.y = this.shipYaw;
            this.scene.add(beam);
            this.pulses.push({
                mesh: beam,
                dir: fwd.clone(),
                life: 2.2,
                isPlayerShot: true,
                targetObj: lockedTarget
            });
        };

        this.renderer.domElement.addEventListener('pointerdown', (e) => {
            if (this.isCustomizing) {
                this.isDraggingShowroom = true;
                this.lastShowroomPointerX = e.clientX;
                this.lastShowroomPointerY = e.clientY;
                this.showroomDragIdleTimer = 3.5;
                return;
            }
            emitResonanceBeam();
            move(e.clientX, e.clientY);
        });

        window.addEventListener('pointermove', (e) => {
            if (this.isCustomizing && this.isDraggingShowroom) {
                const dx = e.clientX - this.lastShowroomPointerX;
                const dy = e.clientY - this.lastShowroomPointerY;
                this.lastShowroomPointerX = e.clientX;
                this.lastShowroomPointerY = e.clientY;
                this.customOrbitAngle -= dx * 0.0085;
                this.customOrbitPitch = THREE.MathUtils.clamp(this.customOrbitPitch + dy * 0.006, 0.05, 0.72);
                this.showroomDragIdleTimer = 3.5;
            }
        });

        window.addEventListener('pointerup', () => {
            this.isDraggingShowroom = false;
        });

        this.renderer.domElement.addEventListener(
            'wheel',
            (e) => {
                if (this.isCustomizing) {
                    e.preventDefault();
                    this.customOrbitRadius = THREE.MathUtils.clamp(
                        this.customOrbitRadius + e.deltaY * 0.004,
                        3.3,
                        9.2
                    );
                }
            },
            { passive: false }
        );

        const setModeButton = (activeId: string, mult: number) => {
            this.speedMultiplier = mult;
            ['mode-drift', 'mode-cruise', 'mode-pulse'].forEach((id) => {
                document.getElementById(id)?.classList.toggle('active', id === activeId);
            });
        };

        document.getElementById('mode-drift')?.addEventListener('click', () => setModeButton('mode-drift', 0.55));
        document.getElementById('mode-cruise')?.addEventListener('click', () => setModeButton('mode-cruise', 1.0));
        document.getElementById('mode-pulse')?.addEventListener('click', () => setModeButton('mode-pulse', 1.85));
        document.getElementById('btn-cam')?.addEventListener('click', () => this.cycleCameraPreset());
        document.getElementById('btn-scan')?.addEventListener('click', () => this.triggerScanWave());
        document.getElementById('btn-warp')?.addEventListener('click', () => this.hyperjumpForward());
        document.getElementById('btn-garage')?.addEventListener('click', () => this.toggleCustomizer());
        document.getElementById('btn-vhs')?.addEventListener('click', () => this.toggleVHS());
        document.getElementById('btn-launch-ship')?.addEventListener('click', () => this.toggleCustomizer(false));
        document.getElementById('btn-custom-random')?.addEventListener('click', () => this.randomizeShipCustomization());
        document.getElementById('btn-custom-reset')?.addEventListener('click', () => this.resetShipCustomization());
        document.getElementById('btn-toggle-controls')?.addEventListener('click', () => {
            const bar = document.getElementById('flight-controls-bar');
            const chat = document.getElementById('mmo-chat-panel');
            const toggleBtn = document.getElementById('btn-toggle-controls');
            if (!bar) return;
            const collapsed = bar.classList.toggle('controls-collapsed');
            chat?.classList.toggle('controls-are-collapsed', collapsed);
            if (toggleBtn) {
                toggleBtn.textContent = collapsed ? '▲ CONTROLS' : '▼ HIDE';
            }
        });

        // Spaceship Customizer Option Listeners
        const bindCustomGroup = (containerId: string, attr: string, onSelect: (idx: number) => void) => {
            const containerEl = document.getElementById(containerId);
            if (!containerEl) return;
            containerEl.querySelectorAll('button').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const val = Number(btn.getAttribute(attr));
                    containerEl.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
                    btn.classList.add('active');
                    onSelect(val);
                    this.applyShipCustomization();
                    this.audio.playHarvestChime();
                });
            });
        };

        bindCustomGroup('custom-hull-options', 'data-hull', (idx) => {
            this.hullPresetIdx = idx;
            this.useCustomHullHue = false;
            const preset = HULL_PRESETS[idx] || HULL_PRESETS[0];
            this.hullHue = preset.hue;
            this.chromePct = preset.chrome;
            this.glowPct = preset.glow;
            this.syncCustomizerSlidersUI();
        });
        bindCustomGroup('custom-trim-options', 'data-trim', (idx) => (this.trimColorIdx = idx));
        bindCustomGroup('custom-trail-options', 'data-trail', (idx) => (this.trailPresetIdx = idx));
        bindCustomGroup('custom-chassis-options', 'data-chassis', (idx) => {
            this.chassisIdx = idx;
            const cPreset = CHASSIS_PROFILES[idx] || CHASSIS_PROFILES[0];
            this.wingspanPct = cPreset.wingspan;
            this.lengthPct = cPreset.length;
            this.bulkPct = cPreset.bulk;
            this.syncCustomizerSlidersUI();
        });
        bindCustomGroup('custom-aura-options', 'data-aura', (idx) => (this.auraStyleIdx = idx));

        const bindSlider = (sliderId: string, valId: string, suffix: string, onInput: (val: number) => void) => {
            const sliderEl = document.getElementById(sliderId) as HTMLInputElement | null;
            const valEl = document.getElementById(valId);
            if (!sliderEl) return;
            sliderEl.addEventListener('input', () => {
                const v = Number(sliderEl.value);
                if (valEl) valEl.textContent = `${Math.round(v)}${suffix}`;
                onInput(v);
                this.applyShipCustomization();
            });
        };

        bindSlider('slider-hull-hue', 'val-hull-hue', '°', (v) => {
            this.hullHue = v;
            this.useCustomHullHue = true;
            document.getElementById('custom-hull-options')?.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        });
        bindSlider('slider-glow', 'val-glow', '%', (v) => {
            this.glowPct = v;
        });
        bindSlider('slider-chrome', 'val-chrome', '%', (v) => {
            this.chromePct = v;
        });
        bindSlider('slider-wingspan', 'val-wingspan', '%', (v) => {
            this.wingspanPct = v;
            document.getElementById('custom-chassis-options')?.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        });
        bindSlider('slider-length', 'val-length', '%', (v) => {
            this.lengthPct = v;
            document.getElementById('custom-chassis-options')?.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        });
        bindSlider('slider-bulk', 'val-bulk', '%', (v) => {
            this.bulkPct = v;
            document.getElementById('custom-chassis-options')?.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        });
        bindSlider('slider-aura-scale', 'val-aura-scale', '%', (v) => {
            this.auraScalePct = v;
        });

        const callsignInput = document.getElementById('custom-callsign-input') as HTMLInputElement | null;
        callsignInput?.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                callsignInput.blur();
            }
        });
        callsignInput?.addEventListener('input', () => {
            const cleaned = callsignInput.value.trim().toUpperCase().slice(0, 12);
            if (cleaned) this.pilotCallsign = cleaned;
        });

        document.getElementById('btn-audio')?.addEventListener('click', (e) => {
            const muted = this.audio.toggleMute();
            const btn = e.currentTarget as HTMLButtonElement;
            if (btn) btn.textContent = muted ? 'SYNTH: MUTE' : 'SYNTH: ON';
        });

        const chatInput = document.getElementById('mmo-chat-input') as HTMLInputElement | null;
        const chatSendBtn = document.getElementById('mmo-chat-send');

        const sendPlayerChat = () => {
            if (!chatInput) return;
            const msg = chatInput.value.trim();
            if (!msg) {
                chatInput.blur();
                return;
            }
            chatInput.value = '';
            chatInput.blur();
            const senderName = this.pilotCallsign || 'YOU';
            const senderColor = TRIM_COLORS[this.trimColorIdx]?.hex ?? 0xffea79;

            if (import.meta.env.VITE_FIREBASE_DATABASE_URL) {
                pushPersistedChatMessage({
                    sender: senderName,
                    colorHex: senderColor,
                    text: msg,
                    timestamp: Date.now()
                });
            } else {
                this.appendChatMessage(senderName, senderColor, msg);
            }

            // Have a random AI Traveller respond to the player only if AI bots are active!
            if (this.botsActive && this.aiPlayers.length > 0) {
                const responder = this.aiPlayers[Math.floor(Math.random() * this.aiPlayers.length)];
                const playerReplies = [
                    `@${senderName} wait you can talk?! i thought you were an NPC`,
                    `@${senderName} 100% agree, here take my spare cassette tape`,
                    `@${senderName} facts bro, meet me by the giant sliced sun in 5 mins`,
                    `@${senderName} sir this is a Synthwave Wendy's`,
                    `@${senderName} hold on my cat is steering the ship right now`,
                    `@${senderName} big if true, scanning that sector rn 👀`,
                    `@${senderName} lmao i was literally just thinking the exact same thing`,
                    `@${senderName} copy that pilot, keeping my shields at 100% just in case`,
                    `@${senderName} wait don't shoot me i'm just admiring the VHS scanlines!!`,
                    `@${senderName} turn up the synth arpeggio, we're flying into deep orbit`,
                    `@${senderName} bet, last one to the warp gate buys space slushies`,
                    `@${senderName} my radar says you're carrying way too much aesthetic chrome`
                ];
                const reply = playerReplies[Math.floor(Math.random() * playerReplies.length)];
                window.setTimeout(() => {
                    if (!this.isDestroyed && this.botsActive) {
                        this.appendChatMessage(responder.callsign, responder.colorHex, reply);
                    }
                }, 1400 + Math.random() * 1400);
            }
        };

        chatSendBtn?.addEventListener('click', sendPlayerChat);
        chatInput?.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                e.preventDefault();
                sendPlayerChat();
            } else if (e.key === 'Escape') {
                chatInput.blur();
            }
        });

        window.addEventListener('keydown', (e) => {
            if (document.activeElement === chatInput || document.activeElement === callsignInput) return;

            if (e.key === 'Enter' && chatInput) {
                e.preventDefault();
                this.keysPressed = {};
                chatInput.focus();
                return;
            }

            const key = e.key.toLowerCase();
            if (key === 'g') {
                this.toggleCustomizer();
                return;
            }
            if (key === 'v') {
                this.toggleVHS();
                return;
            }

            if (this.isCustomizing) return;

            this.keysPressed[key] = true;
            this.keysPressed[e.code] = true;

            if (e.code === 'Space') {
                this.triggerScanWave();
            } else if (key === 'f' || key === 'e') {
                emitResonanceBeam();
            } else if (key === 'h' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
                this.hyperjumpForward();
            } else if (key === 'c') {
                this.cycleCameraPreset();
            } else if (key === '1') {
                setModeButton('mode-drift', 0.55);
            } else if (key === '2') {
                setModeButton('mode-cruise', 1.0);
            } else if (key === '3') {
                setModeButton('mode-pulse', 1.85);
            }
        });

        window.addEventListener('keyup', (e) => {
            this.keysPressed[e.key.toLowerCase()] = false;
            this.keysPressed[e.code] = false;
        });
    }

    private update() {
        if (this.isDestroyed) return;
        const delta = Math.min(this.clock.getDelta(), 0.1);
        const elapsed = this.clock.getElapsedTime();

        if (this.damageCooldown > 0) {
            this.damageCooldown -= delta;
        }
        if (this.screenShake > 0) {
            this.screenShake = Math.max(0, this.screenShake - delta * 2.4);
        }

        const colorLerp = delta * 0.85;
        this.currentSkyColor.lerp(new THREE.Color(this.targetBiome.skyColor), colorLerp);
        this.currentFogColor.lerp(new THREE.Color(this.targetBiome.fogColor), colorLerp);
        this.currentNebulaPrimary.lerp(new THREE.Color(this.targetBiome.nebulaPrimary), colorLerp);
        this.currentNebulaSecondary.lerp(new THREE.Color(this.targetBiome.nebulaSecondary), colorLerp);
        this.currentSunCore.lerp(new THREE.Color(this.targetBiome.sunCore), colorLerp);
        this.currentSunHalo.lerp(new THREE.Color(this.targetBiome.sunHalo), colorLerp);

        this.scene.background = this.currentSkyColor;
        (this.scene.fog as THREE.FogExp2).color.copy(this.currentFogColor);

        // ====================================================================
        // WASD 360° NESW NAVIGATION & STEERING
        // ====================================================================
        let turnInput = 0;
        if (this.keysPressed['a'] || this.keysPressed['ArrowLeft']) turnInput += 1;
        if (this.keysPressed['d'] || this.keysPressed['ArrowRight']) turnInput -= 1;

        let thrustInput = 0;
        if (this.keysPressed['w'] || this.keysPressed['ArrowUp']) thrustInput += 1;
        if (this.keysPressed['s'] || this.keysPressed['ArrowDown']) thrustInput -= 1;

        const turnRate = 1.65;
        this.targetYaw += turnInput * turnRate * delta;
        this.shipYaw = THREE.MathUtils.lerp(this.shipYaw, this.targetYaw, delta * 5.0);

        const targetRoll = THREE.MathUtils.clamp(
            turnInput * 0.48 + (this.targetYaw - this.shipYaw) * 0.9,
            -0.52,
            0.52
        );
        this.shipRoll = THREE.MathUtils.lerp(this.shipRoll, targetRoll, delta * 5.0);

        const compassEl = document.getElementById('compass-readout');
        if (compassEl) {
            compassEl.textContent = this.formatCompassHeading(this.shipYaw);
        }

        this.portalBoost = THREE.MathUtils.lerp(this.portalBoost, 0, delta * 1.2);
        const throttleFactor = 1.0 + thrustInput * 0.65;
        const currentSpeed = this.isCustomizing
            ? 0
            : this.baseSpeed * this.speedMultiplier * throttleFactor + this.portalBoost;

        const fwd = this.getForwardVector();
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x);

        if (this.ship) {
            const lerpFactor = 4.0 * delta;
            const hoverBob = Math.sin(elapsed * 2.0) * 0.16;

            this.ship.position.x += fwd.x * currentSpeed * delta;
            this.ship.position.z += fwd.z * currentSpeed * delta;
            this.ship.position.y = THREE.MathUtils.lerp(
                this.ship.position.y,
                (this.isCustomizing ? 3.8 : this.targetShipY) + hoverBob,
                lerpFactor
            );

            this.ship.rotation.y = this.shipYaw;
            this.ship.rotation.z = this.isCustomizing ? Math.sin(elapsed * 1.1) * 0.08 : this.shipRoll;
            this.ship.rotation.x = THREE.MathUtils.lerp(
                this.ship.rotation.x,
                this.isCustomizing ? 0.03 : this.shipPitch + thrustInput * 0.06,
                lerpFactor
            );

            // Keep sky dome centered on the ship; update starfield & evolving skybox uniforms!
            this.nebulaDome.position.copy(this.ship.position);
            this.nebulaMaterial.uniforms.time.value = elapsed;
            this.nebulaMaterial.uniforms.uShipPos.value.copy(this.ship.position);
            this.starfieldMaterial.uniforms.uShipPos.value.copy(this.ship.position);

            // Slowly orbit the distant Outrun sun slightly as you traverse space so the horizon feels alive
            const sunDriftX = Math.sin(this.ship.position.x * 0.0005 + elapsed * 0.03) * 180;
            this.sunMesh.position.set(this.ship.position.x + sunDriftX, 72, this.ship.position.z - 1080);

            if (this.isCustomizing) {
                if (this.hangarPlatformGroup) {
                    this.hangarPlatformGroup.visible = true;
                    this.hangarPlatformGroup.rotation.y += delta * 0.55;
                }
                if (this.shieldMesh && this.shieldMesh.visible) {
                    this.shieldMesh.rotation.y += delta * 0.45;
                    this.shieldMesh.rotation.x += delta * 0.22;
                }
                if (this.showroomDragIdleTimer > 0) {
                    this.showroomDragIdleTimer = Math.max(0, this.showroomDragIdleTimer - delta);
                } else if (!this.isDraggingShowroom) {
                    // 3D Showroom Orbit Camera around the spaceship when not manually dragging
                    this.customOrbitAngle += delta * 0.36;
                }
                const orbitRadius = this.customOrbitRadius;
                const horizRadius = Math.cos(this.customOrbitPitch) * orbitRadius;
                const camX = this.ship.position.x + Math.sin(this.customOrbitAngle) * horizRadius;
                const camZ = this.ship.position.z + Math.cos(this.customOrbitAngle) * horizRadius;
                const camY =
                    this.ship.position.y +
                    Math.sin(this.customOrbitPitch) * orbitRadius +
                    Math.sin(elapsed * 0.8) * 0.16;

                this.camera.position.lerp(new THREE.Vector3(camX, camY, camZ), delta * 6.5);
                // Frame the ship slightly to the left on wide screens so the customizer panel on the right doesn't cover it
                const rightVec = new THREE.Vector3(
                    Math.cos(this.customOrbitAngle),
                    0,
                    -Math.sin(this.customOrbitAngle)
                );
                const sideShift = window.innerWidth > 760 ? 1.35 : 0.0;
                const targetFocus = this.ship.position.clone().addScaledVector(rightVec, sideShift);
                this.lookAtTarget.lerp(targetFocus, delta * 6.0);
                this.camera.up.set(0, 1, 0);
                this.camera.lookAt(this.lookAtTarget);
                this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, 56, delta * 3.0);
                this.camera.updateProjectionMatrix();
            } else {
                if (this.hangarPlatformGroup) {
                    this.hangarPlatformGroup.visible = false;
                }
                // Orbit Camera smoothly behind the ship's current 360° heading
                const preset = CAMERA_PRESETS[this.cameraPresetIdx];
                const worldOffset = preset.localOffset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.shipYaw);
                const desiredCamPos = this.ship.position.clone().add(worldOffset);

                this.camera.position.lerp(desiredCamPos, lerpFactor * 1.5);

                if (this.screenShake > 0) {
                    this.camera.position.x += (Math.random() - 0.5) * this.screenShake * 1.6;
                    this.camera.position.y += (Math.random() - 0.5) * this.screenShake * 1.6;
                    this.camera.position.z += (Math.random() - 0.5) * this.screenShake * 1.6;
                }

                const desiredLookTarget = new THREE.Vector3(
                    this.ship.position.x + fwd.x * preset.lookAheadDist,
                    this.ship.position.y + preset.lookUpOffset + fwd.y * 12,
                    this.ship.position.z + fwd.z * preset.lookAheadDist
                );
                this.lookAtTarget.lerp(desiredLookTarget, lerpFactor * 1.8);

                this.camera.up.set(0, 1, 0);
                this.camera.lookAt(this.lookAtTarget);
                this.camera.rotateZ(this.shipRoll * preset.bankFactor);

                const targetFov =
                    preset.baseFov + (this.speedMultiplier * throttleFactor - 1.0) * 8 + Math.max(0, this.portalBoost) * 0.25;
                this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, delta * 3);
                this.camera.updateProjectionMatrix();
            }

            // Twin synthwave neon thruster trails (using customized trail colors!)
            if (Math.random() < 0.75) {
                const sideSign = Math.random() > 0.5 ? 0.42 : -0.42;
                const trailPos = this.ship.position
                    .clone()
                    .sub(fwd.clone().multiplyScalar(1.5))
                    .add(right.clone().multiplyScalar(sideSign));
                const trailPair = TRAIL_PRESETS[this.trailPresetIdx]?.colors ?? [0x00f0ff, 0xff007f];
                const trailColor = Math.random() > 0.5 ? trailPair[0] : trailPair[1];
                const trail = new MoteParticle(trailPos, trailColor, null, 0.18);
                trail.velocity.copy(fwd).multiplyScalar(this.isCustomizing ? -0.95 : -0.35);
                trail.life = 0.48;
                this.scene.add(trail.mesh);
                this.particles.push(trail);
            }
        }

        const scoreEl = document.getElementById('game-score');
        if (scoreEl) scoreEl.textContent = this.score.toLocaleString();

        this.sunMaterial.uniforms.time.value = elapsed;
        this.vhsPass.uniforms.time.value = elapsed;

        const vhsTimerEl = document.getElementById('vhs-tape-timer');
        if (vhsTimerEl && this.vhsEnabled) {
            const totalSec = Math.floor(elapsed);
            const hrs = Math.floor(totalSec / 3600).toString().padStart(2, '0');
            const mins = Math.floor((totalSec % 3600) / 60).toString().padStart(2, '0');
            const secs = (totalSec % 60).toString().padStart(2, '0');
            vhsTimerEl.textContent = `T-120  ${hrs}:${mins}:${secs}`;
        }

        let nearestPlanet = this.planets[0];
        let minDist = Infinity;

        const moonWorldPos = new THREE.Vector3();

        // Update distant unreachable background planets (anchored relative to the ship so you can never reach them)
        this.distantPlanets.forEach((dPlanet) => {
            dPlanet.mesh.rotation.y += delta * dPlanet.rotSpeed;
            dPlanet.material.uniforms.time.value = elapsed;
            if (this.ship) {
                dPlanet.group.position.copy(this.ship.position).add(dPlanet.offset);
            }
        });

        this.planets.forEach((pNode) => {
            pNode.mesh.rotation.y += delta * 0.14;
            pNode.ring.rotation.z += delta * 0.06;
            pNode.moonPivot.rotation.y += delta * 0.35;
            pNode.moon.rotation.y += delta * 0.4;
            pNode.material.uniforms.time.value = elapsed;
            pNode.appearProgress = Math.min(1.0, (pNode.appearProgress ?? 1.0) + delta * 0.45);

            if (this.ship) {
                const dist = this.ship.position.distanceTo(pNode.group.position);
                const baseScale = pNode.baseScale ?? 1.0;

                // Smoothly fade & scale in planets from the deep-space horizon so they never pop in abruptly
                const distFade = 1.0 - THREE.MathUtils.smoothstep(dist, 820, 1450);
                const appearEase = THREE.MathUtils.smoothstep(pNode.appearProgress, 0.0, 1.0);
                const visibility = Math.max(0.0, distFade * appearEase);

                pNode.material.uniforms.uOpacity.value = visibility;
                (pNode.ring.material as THREE.MeshBasicMaterial).opacity = 0.48 * visibility;
                (pNode.moon.material as THREE.MeshStandardMaterial).opacity = visibility;
                const currentScale = baseScale * (0.3 + 0.7 * visibility);
                pNode.group.scale.setScalar(currentScale);

                const planetRadius = 58.0 * currentScale;

                if (dist < minDist) {
                    minDist = dist;
                    nearestPlanet = pNode;
                }

                // 1. Orbital Discovery Scan (triggers once per pass as you enter orbit, keeping the planet in front of you!)
                if (!pNode.discoveredInCurrentPass && dist < planetRadius + 115) {
                    pNode.discoveredInCurrentPass = true;
                    this.onPlanetDiscovered(pNode);
                }

                // 2. Planetary Surface Crash Check (if the player flies directly into the planet sphere!)
                if (!this.isCustomizing && dist < planetRadius + 6.5) {
                    const bounceNormal = this.ship.position.clone().sub(pNode.group.position).normalize();
                    if (bounceNormal.lengthSq() < 0.001) bounceNormal.set(0, 0, 1);
                    this.ship.position.copy(pNode.group.position).addScaledVector(bounceNormal, planetRadius + 14.0);
                    const pName = pNode.customName || BIOMES[pNode.biomeIdx].name;
                    this.takeDamage(45, `${pName} SURFACE CRASH`, bounceNormal);
                }

                // 3. Orbital Moon Crash Check
                pNode.moon.getWorldPosition(moonWorldPos);
                const moonRadius = 11.5 * currentScale;
                if (!this.isCustomizing && this.ship.position.distanceTo(moonWorldPos) < moonRadius + 3.0) {
                    const moonBounce = this.ship.position.clone().sub(moonWorldPos).normalize();
                    this.ship.position.copy(moonWorldPos).addScaledVector(moonBounce, moonRadius + 8.0);
                    this.takeDamage(30, 'ORBITAL MOON COLLISION', moonBounce);
                }

                // 4. Recycle far-behind planets ahead of the player and procedurally mutate them from /perlin.png!
                if (dist > 1480) {
                    this.respawnAheadOfShip(pNode.group, 1080, 1420, 620);
                    pNode.group.position.y = 32 + (Math.random() - 0.5) * 28;
                    pNode.discoveredInCurrentPass = false;
                    this.mutatePlanetWithPerlin(pNode);
                }
            }
        });

        if (nearestPlanet && this.ship) {
            const biome = BIOMES[nearestPlanet.biomeIdx];
            const displayWorldName = nearestPlanet.customName || biome.name;
            const nearestRadius = 58.0 * (nearestPlanet.group.scale.x || 1.0);
            const distToOrbit = Math.min(999, Math.max(0, Math.round(minDist - nearestRadius)));
            const paddedDist = distToOrbit.toString().padStart(3, '0');
            const sysEl = document.getElementById('system-name');
            if (sysEl) sysEl.textContent = `${displayWorldName} [${biome.cardinal}] ${paddedDist}KS`;
        }

        // Trigger procedural /perlin.png cosmic events as the ship flies through space
        if (!this.isCustomizing && this.ship) {
            this.perlinEventCooldown -= delta;
            if (this.perlinEventCooldown <= 0) {
                this.perlinEventCooldown = 14.0 + Math.random() * 8.0;
                this.triggerPerlinCosmicEvent();
            }
        }

        // Update streaking Synthwave Comets spawned by /perlin.png events
        for (let i = this.comets.length - 1; i >= 0; i--) {
            const comet = this.comets[i];
            comet.mesh.position.addScaledVector(comet.vel, delta);
            comet.mesh.rotation.x += delta * 4.0;
            comet.mesh.rotation.y += delta * 5.0;
            comet.life -= delta;

            if (Math.random() < 0.85) {
                const tail = new MoteParticle(comet.mesh.position, comet.colorHex, null, 0.34);
                tail.life = 0.65;
                this.scene.add(tail.mesh);
                this.particles.push(tail);
            }

            if (comet.life <= 0) {
                this.scene.remove(comet.mesh);
                this.comets.splice(i, 1);
            }
        }

        if (this.shieldMesh) {
            this.shieldMesh.rotation.y += delta * 0.45;
            this.shieldMesh.rotation.x += delta * 0.25;
        }

        // ====================================================================
        // REAL-TIME ONLINE PLAYERS SYNC & INTERPOLATION (FIREBASE RTDB)
        // ====================================================================
        this.rtdbSyncTimer -= delta;
        if (this.rtdbSyncTimer <= 0 && this.ship) {
            this.rtdbSyncTimer = 0.1; // 10 Hz position & state sync
            syncOnlinePlayerState(this.localPlayerId, this.buildLocalPlayerState());
        }

        this.remotePlayers.forEach((remote) => {
            if (remote.killCooldown > 0) {
                remote.killCooldown = Math.max(0, remote.killCooldown - delta);
            }
            remote.group.position.lerp(remote.targetPos, Math.min(1.0, delta * 10.0));
            remote.group.rotation.y = THREE.MathUtils.lerp(remote.group.rotation.y, remote.targetYaw, Math.min(1.0, delta * 10.0));
            remote.group.rotation.z = THREE.MathUtils.lerp(remote.group.rotation.z, remote.targetRoll, Math.min(1.0, delta * 10.0));
            remote.group.rotation.x = THREE.MathUtils.lerp(remote.group.rotation.x, remote.targetPitch, Math.min(1.0, delta * 10.0));

            if (this.particles.length < 75 && Math.random() < 0.28) {
                const remFwd = new THREE.Vector3(-Math.sin(remote.group.rotation.y), 0, -Math.cos(remote.group.rotation.y));
                const remRight = new THREE.Vector3(-remFwd.z, 0, remFwd.x);
                const side = Math.random() > 0.5 ? 0.45 : -0.45;
                const tPos = remote.group.position
                    .clone()
                    .sub(remFwd.clone().multiplyScalar(1.6))
                    .add(remRight.clone().multiplyScalar(side));
                const trail = new MoteParticle(tPos, remote.colorHex, null, 0.2);
                trail.velocity.copy(remFwd).multiplyScalar(-0.25);
                trail.life = 0.42;
                this.scene.add(trail.mesh);
                this.particles.push(trail);
            }
        });

        // Guarantee AI bots are hidden whenever any remote player is present
        this.botsActive = this.remotePlayers.size === 0;
        this.aiPlayers.forEach((bot) => {
            if (bot.group.visible !== this.botsActive) {
                bot.group.visible = this.botsActive;
            }
        });

        // ====================================================================
        // MMO AI TRAVELLERS SIMULATION & RANDOM SECTOR CHAT (Only when no real players are online)
        // ====================================================================
        if (this.botsActive) {
            this.mmoFeedTimer -= delta;
            if (this.mmoFeedTimer <= 0 && this.aiPlayers.length > 0) {
                this.mmoFeedTimer = 3.5 + Math.random() * 3.5;
                if (Math.random() < 0.86) {
                    this.triggerRandomBotChat();
                } else {
                    const randomBot = this.aiPlayers[Math.floor(Math.random() * this.aiPlayers.length)];
                    const randomPlanet = BIOMES[Math.floor(Math.random() * BIOMES.length)].name;
                    this.appendChatMessage(
                        '',
                        0x00f0ff,
                        `✦ ${randomBot.callsign} entered high orbit around ${randomPlanet}`,
                        true
                    );
                }
            }
        }

        if (this.botsActive) this.aiPlayers.forEach((bot, idx) => {
            bot.decisionTimer -= delta;
            bot.beamCooldown -= delta;
            if (bot.hostileTimer > 0) {
                bot.hostileTimer -= delta;
            }

            if (bot.decisionTimer <= 0) {
                bot.decisionTimer = 2.4 + Math.random() * 3.5;
                // Keep AI steering closely aligned with the player's general heading so ships stay visible in front of you!
                if (this.ship && Math.random() < 0.8) {
                    bot.targetYaw = this.shipYaw + (Math.random() - 0.5) * 0.85;
                } else {
                    bot.targetYaw += (Math.random() - 0.5) * 1.3;
                }
                bot.targetY = 2.5 + Math.random() * 9.5;
                bot.speed = bot.hostileTimer > 0 ? 52 + Math.random() * 14 : 38 + Math.random() * 14;
            }

            const yawDiff = bot.targetYaw - bot.yaw;
            bot.yaw += yawDiff * delta * 2.2;
            bot.roll = THREE.MathUtils.lerp(bot.roll, THREE.MathUtils.clamp(yawDiff * 0.65, -0.48, 0.48), delta * 4.0);

            const botFwd = new THREE.Vector3(-Math.sin(bot.yaw), 0, -Math.cos(bot.yaw));
            const botRight = new THREE.Vector3(-botFwd.z, 0, botFwd.x);

            bot.group.position.x += botFwd.x * bot.speed * delta;
            bot.group.position.z += botFwd.z * bot.speed * delta;
            bot.group.position.y = THREE.MathUtils.lerp(
                bot.group.position.y,
                bot.targetY + Math.sin(elapsed * 1.8 + idx) * 0.25,
                delta * 2.5
            );

            bot.group.rotation.y = bot.yaw;
            bot.group.rotation.z = bot.roll;
            bot.group.rotation.x = 0.04;

            // Emit AI thruster trails (throttled for 60 FPS performance)
            if (this.particles.length < 75 && Math.random() < 0.22) {
                const side = Math.random() > 0.5 ? 0.45 : -0.45;
                const tPos = bot.group.position
                    .clone()
                    .sub(botFwd.clone().multiplyScalar(1.6))
                    .add(botRight.clone().multiplyScalar(side));
                const trail = new MoteParticle(tPos, bot.colorHex, null, 0.2);
                trail.velocity.copy(botFwd).multiplyScalar(-0.25);
                trail.life = 0.42;
                this.scene.add(trail.mesh);
                this.particles.push(trail);
            }

            // If provoked (shot by player), retaliate with laser fire; otherwise occasionally shoot nearby crystals
            if (bot.beamCooldown <= 0) {
                if (bot.hostileTimer > 0 && this.ship && !this.isCustomizing && bot.group.position.distanceTo(this.ship.position) < 170) {
                    bot.beamCooldown = 2.4 + Math.random() * 2.0;
                    const dirToPlayer = new THREE.Vector3()
                        .subVectors(this.ship.position, bot.group.position)
                        .add(new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 6))
                        .normalize();
                    const aiBeam = new THREE.Mesh(
                        SHARED_BEAM_GEO,
                        new THREE.MeshBasicMaterial({ color: 0xff0055, transparent: true, opacity: 0.92 })
                    );
                    aiBeam.scale.set(0.7, 0.7, 3.6);
                    aiBeam.position.copy(bot.group.position);
                    aiBeam.rotation.y = bot.yaw;
                    this.scene.add(aiBeam);
                    this.pulses.push({
                        mesh: aiBeam,
                        dir: dirToPlayer,
                        life: 1.6,
                        isPlayerShot: false,
                        ownerCallsign: bot.callsign
                    });
                } else if (this.crystals.length > 0) {
                    for (let cIdx = 0; cIdx < this.crystals.length; cIdx++) {
                        const c = this.crystals[cIdx];
                        if (c.position.distanceTo(bot.group.position) < 55) {
                            bot.beamCooldown = 5.5 + Math.random() * 5.5;
                            const dirToCrystal = new THREE.Vector3().subVectors(c.position, bot.group.position).normalize();
                            const aiBeam = new THREE.Mesh(
                                SHARED_BEAM_GEO,
                                new THREE.MeshBasicMaterial({ color: bot.colorHex, transparent: true, opacity: 0.85 })
                            );
                            aiBeam.scale.set(0.6, 0.6, 3.2);
                            aiBeam.position.copy(bot.group.position);
                            aiBeam.rotation.y = bot.yaw;
                            this.scene.add(aiBeam);
                            this.pulses.push({
                                mesh: aiBeam,
                                dir: dirToCrystal,
                                life: 1.4,
                                isPlayerShot: false
                            });
                            break;
                        }
                    }
                }
            }

            // Mid-air ship-to-ship collision check & keep AI Travellers in the visible sector ahead of the player
            if (this.ship) {
                const toBot = new THREE.Vector3().subVectors(bot.group.position, this.ship.position);
                const distToBot = toBot.length();

                if (!this.isCustomizing && distToBot < 4.8) {
                    const bounce = toBot.clone().negate().normalize();
                    this.takeDamage(15, `MID-AIR COLLISION WITH ${bot.callsign}`, bounce);
                    this.damageAIPlayer(bot, bot.group.position);
                } else if (distToBot > 220 || (distToBot > 55 && toBot.normalize().dot(fwd) < -0.35)) {
                    this.respawnAheadOfShip(bot.group, 52, 145, 115);
                    bot.group.position.y = 3.0 + Math.random() * 8.5;
                    bot.yaw = this.shipYaw + (Math.random() - 0.5) * 0.7;
                    bot.targetYaw = bot.yaw;
                }
            }
        });

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const alive = this.particles[i].update(delta);
            if (!alive) {
                this.scene.remove(this.particles[i].mesh);
                this.particles[i].dispose();
                this.particles.splice(i, 1);
            }
        }

        this.asteroids.forEach((a) => {
            const meta = a as unknown as { rotVec: THREE.Vector3; hitRadius?: number; appearProgress?: number };
            a.rotation.x += delta * meta.rotVec.x;
            a.rotation.y += delta * meta.rotVec.y;
            a.rotation.z += delta * meta.rotVec.z;
            meta.appearProgress = Math.min(1.0, (meta.appearProgress ?? 1.0) + delta * 0.85);

            if (this.ship) {
                const distToAsteroid = a.position.distanceTo(this.ship.position);
                const distScale = 1.0 - THREE.MathUtils.smoothstep(distToAsteroid, 300, 480);
                const appearEase = THREE.MathUtils.smoothstep(meta.appearProgress, 0.0, 1.0);
                const visScale = Math.max(0.001, distScale * appearEase);
                a.scale.setScalar(visScale);

                const hitRadius = (meta.hitRadius ?? 8.5) * visScale;

                if (!this.isCustomizing && visScale > 0.35 && distToAsteroid < hitRadius) {
                    const bounceNormal = this.ship.position.clone().sub(a.position).normalize();
                    if (bounceNormal.lengthSq() < 0.001) bounceNormal.set(0, 1, 0);
                    this.takeDamage(25, 'ASTEROID COLLISION', bounceNormal);
                    this.respawnAheadOfShip(a, 340, 470, 280);
                } else if (distToAsteroid > 490) {
                    this.respawnAheadOfShip(a, 340, 470, 280);
                }
            }
        });

        this.rings.forEach((r) => {
            const ringData = r as unknown as { glyph: THREE.Mesh; cooldown: number; appearProgress?: number };
            if (ringData.glyph) {
                ringData.glyph.rotation.y += delta * 1.2;
                ringData.glyph.rotation.x += delta * 0.7;
            }
            if (ringData.cooldown > 0) ringData.cooldown -= delta;
            ringData.appearProgress = Math.min(1.0, (ringData.appearProgress ?? 1.0) + delta * 0.85);

            if (this.ship) {
                const distToRing = r.position.distanceTo(this.ship.position);
                const distScale = 1.0 - THREE.MathUtils.smoothstep(distToRing, 280, 420);
                const appearEase = THREE.MathUtils.smoothstep(ringData.appearProgress, 0.0, 1.0);
                r.scale.setScalar(Math.max(0.001, distScale * appearEase));

                if (ringData.cooldown <= 0 && distToRing < 17.5) {
                    ringData.cooldown = 5.0;
                    this.portalBoost = 40.0;
                    this.audio.playPortalChord();
                    for (let k = 0; k < 18; k++) {
                        const p = new MoteParticle(this.ship.position, 0xffbe6b, this.ship);
                        this.scene.add(p.mesh);
                        this.particles.push(p);
                    }
                }

                if (distToRing > 430) {
                    this.respawnAheadOfShip(r, 290, 410, 180);
                    r.rotation.y = this.shipYaw;
                }
            }
        });

        for (let i = this.pulses.length - 1; i >= 0; i--) {
            const b = this.pulses[i];

            // Soft homing aim-assist toward locked enemy starship
            if (b.isPlayerShot && b.targetObj) {
                const toTarget = new THREE.Vector3().subVectors(b.targetObj.position, b.mesh.position).normalize();
                b.dir.lerp(toTarget, delta * 7.5).normalize();
            }

            b.mesh.position.addScaledVector(b.dir, delta * 235);
            b.life -= delta;

            let hitSomething = false;

            // 1. Check if a player laser bolt hit any remote online player or AI Traveller's starship!
            if (b.isPlayerShot) {
                for (const remote of this.remotePlayers.values()) {
                    if (b.mesh.position.distanceTo(remote.group.position) < 6.8) {
                        this.damageRemotePlayer(remote, b.mesh.position.clone());
                        hitSomething = true;
                        break;
                    }
                }
                if (!hitSomething && this.botsActive) {
                    for (let aIdx = 0; aIdx < this.aiPlayers.length; aIdx++) {
                        const bot = this.aiPlayers[aIdx];
                        if (b.mesh.position.distanceTo(bot.group.position) < 6.8) {
                            this.damageAIPlayer(bot, b.mesh.position.clone());
                            hitSomething = true;
                            break;
                        }
                    }
                }
            } else if (b.ownerCallsign && this.ship && !this.isCustomizing) {
                // 2. Check if a provoked AI Traveller's retaliation laser hit the player!
                if (b.mesh.position.distanceTo(this.ship.position) < 4.5) {
                    this.takeDamage(12, `LASER FIRE FROM ${b.ownerCallsign}`);
                    hitSomething = true;
                }
            }

            if (hitSomething || b.life <= 0) {
                this.scene.remove(b.mesh);
                (b.mesh.material as THREE.Material).dispose();
                this.pulses.splice(i, 1);
            }
        }

        for (let i = this.crystals.length - 1; i >= 0; i--) {
            const c = this.crystals[i];
            const meta = c as unknown as { rotSpeed: number; baseY: number; phase: number; appearProgress?: number };
            c.position.y = meta.baseY + Math.sin(elapsed * 1.6 + meta.phase) * 1.1;
            c.rotation.y += delta * meta.rotSpeed;
            meta.appearProgress = Math.min(1.0, (meta.appearProgress ?? 1.0) + delta * 0.9);

            if (this.ship) {
                const distToShip = c.position.distanceTo(this.ship.position);
                const distScale = 1.0 - THREE.MathUtils.smoothstep(distToShip, 260, 380);
                const appearEase = THREE.MathUtils.smoothstep(meta.appearProgress, 0.0, 1.0);
                c.scale.setScalar(Math.max(0.001, distScale * appearEase));

                if (distToShip < 9.0) {
                    this.harvestCrystal(i);
                    continue;
                }
                if (distToShip > 390) {
                    this.respawnAheadOfShip(c, 260, 370, 160);
                    continue;
                }
            }

            for (let j = this.pulses.length - 1; j >= 0; j--) {
                if (c.position.distanceTo(this.pulses[j].mesh.position) < 5.2) {
                    const wasPlayerShot = this.pulses[j].isPlayerShot;
                    this.scene.remove(this.pulses[j].mesh);
                    (this.pulses[j].mesh.material as THREE.Material).dispose();
                    this.pulses.splice(j, 1);
                    if (wasPlayerShot) {
                        this.harvestCrystal(i);
                    } else {
                        this.respawnAheadOfShip(c, 180, 340, 140);
                    }
                    break;
                }
            }
        }
    }

    public destroy() {
        this.isDestroyed = true;
        this.rtdbCleanups.forEach((fn) => fn());
        this.rtdbCleanups = [];
        this.audio.destroy();
        if (this.envRT) this.envRT.dispose();
        this.pmremGenerator.dispose();
        this.composer.dispose();
        this.renderer.dispose();
        const container = document.getElementById('canvas-container');
        if (container) container.innerHTML = '';
        window.removeEventListener('resize', this.resizeHandler);
    }

    private onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.composer.setSize(window.innerWidth, window.innerHeight);
    }

    private animate() {
        if (this.isDestroyed) return;
        requestAnimationFrame(() => this.animate());
        this.update();
        this.composer.render();
    }
}
