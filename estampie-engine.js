/**
 * Estampie Synthesis Engine — Physical Modelling (waveguide strings + drone)
 *
 * Where the chant engine synthesizes a *voice*, this engine synthesizes the
 * *instruments* of a medieval dance band with real physical models — no
 * oscillator-as-a-string shortcuts:
 *
 *   - PSALTERY / LUTE : a genuine Karplus–Strong plucked-string waveguide,
 *       run inside an AudioWorklet: a fractional (allpass-interpolated) delay
 *       line + an in-loop one-pole damping lowpass + a sub-unity feedback
 *       coefficient, plucked by preloading the line with a band-limited noise
 *       burst. Pitch is the *total* loop delay — delay line + interpolator +
 *       filter phase delay — compensated so every note tunes true at any
 *       frequency. (A DelayNode feedback loop cannot do this: the render
 *       graph inserts a full 128-sample quantum of extra latency into every
 *       cycle, which detunes the string by hundreds of cents and caps the
 *       playable range at ~sr/256.) Brightness and decay are the loop-filter
 *       cutoff and the feedback gain; loop gain is < 1 by construction, so
 *       the string always decays.
 *   - VIELLE / REBEC  : a bowed string — a sustained sawtooth excitation driven
 *       through a strong resonant body band-pass, with a bow-noise component,
 *       a slow singing attack and a blooming vibrato: continuous, not plucked.
 *   - DRONE           : a hurdy-gurdy / bagpipe open fifth (tonic + fifth) held
 *       under everything, coloured by a wooden soundbox and given a subtle
 *       rhythmic trompette "buzz".
 *
 * Every instrument passes through a shared BODY-RESONANCE stage — a small bank
 * of peaking filters modelling a resonant wooden box — so the strings sing like
 * carved instruments rather than raw tones.
 *
 * On top of that: the 8 medieval church tones, a dance FORM engine that lays
 * out *puncta* each played twice with an open (ouvert) then closed (clos)
 * ending, a leaping compound/triple rhythm, a solo→consort ensemble, and a
 * stone courtyard convolution reverb.
 */

/**
 * Karplus–Strong string voice, as an AudioWorklet processor (registered from a
 * Blob URL — no separate file). One processor = one plucked note.
 *
 *  - Fractional tuning: total loop delay = N (line) + η (allpass interpolator)
 *    + τ (one-pole phase delay at the fundamental) = sampleRate / f exactly.
 *  - Stability: the loop is delay → allpass (unity magnitude) → one-pole
 *    lowpass (|H| ≤ 1, DC gain 1) → feedback g < 1, so loop gain < 1 at every
 *    frequency and the string can only decay.
 *  - Pluck: the line is preloaded with mean-removed, lowpass-filtered noise.
 *  - Life cycle: silent until startFrame (sample-accurate onset), fades over
 *    the last 30 ms and the processor retires itself at endFrame.
 */
const KS_STRING_WORKLET = `
class KSString extends AudioWorkletProcessor {
    constructor(opts) {
        super();
        const o = (opts && opts.processorOptions) || {};
        const sr = sampleRate;
        const f = Math.max(20, Math.min(sr * 0.4, o.freq || 220));
        this.startFrame = Math.max(0, Math.round((o.t0 || 0) * sr));
        this.endFrame = this.startFrame + Math.round(((o.ring || 1.5) + 0.15) * sr);
        this.fadeFrames = Math.round(0.03 * sr);
        this.feedback = Math.min(0.995, Math.max(0.5, o.feedback || 0.965));

        // In-loop damping: one-pole lowpass lp += a*(x - lp).
        const fc = Math.min(sr * 0.45, Math.max(1200, o.damp || f * 6));
        this.a = 1 - Math.exp(-2 * Math.PI * fc / sr);

        // Tuning: solve N + eta + tau = sr/f, with tau the one-pole's phase
        // delay at the fundamental and eta realised by a first-order allpass.
        const w = 2 * Math.PI * f / sr;
        const b = 1 - this.a;
        const tau = Math.atan2(b * Math.sin(w), 1 - b * Math.cos(w)) / w;
        const D = sr / f;
        let N = Math.floor(D - tau - 0.1);
        if (N < 2) N = 2;
        let eta = D - tau - N;
        if (eta < 0.05) eta = 0.05;
        this.apC = (1 - eta) / (1 + eta);
        this.N = N;

        // The pluck: band-limited noise preloaded into the string, mean-removed
        // so no DC thud rides the loop, normalised to the excitation amplitude.
        this.buf = new Float32Array(N);
        const exA = 1 - Math.exp(-2 * Math.PI * Math.min(8000, f * 10) / sr);
        let lp = 0, mean = 0;
        for (let i = 0; i < N; i++) {
            lp += exA * ((Math.random() * 2 - 1) - lp);
            this.buf[i] = lp; mean += lp;
        }
        mean /= N;
        let pk = 0;
        for (let i = 0; i < N; i++) {
            this.buf[i] -= mean;
            const v = Math.abs(this.buf[i]); if (v > pk) pk = v;
        }
        const amp = (o.amp || 0.8) / (pk || 1);
        for (let i = 0; i < N; i++) this.buf[i] *= amp;

        this.idx = 0; this.lpState = 0; this.apX1 = 0; this.apY1 = 0;
    }
    process(inputs, outputs) {
        const out = outputs[0][0];
        if (!out) return currentFrame < this.endFrame;
        const start = this.startFrame, end = this.endFrame;
        for (let i = 0; i < out.length; i++) {
            const fr = currentFrame + i;
            if (fr < start || fr >= end) { out[i] = 0; continue; }
            const x = this.buf[this.idx];
            // fractional delay: first-order allpass
            const ap = this.apC * (x - this.apY1) + this.apX1;
            this.apX1 = x; this.apY1 = ap;
            // damping lowpass, then sub-unity feedback back into the line
            this.lpState += this.a * (ap - this.lpState);
            this.buf[this.idx] = this.lpState * this.feedback;
            this.idx++; if (this.idx >= this.N) this.idx = 0;
            const rem = end - fr;
            out[i] = rem < this.fadeFrames ? x * (rem / this.fadeFrames) : x;
        }
        return currentFrame + out.length < end;
    }
}
registerProcessor('ks-string', KSString);
`;

class EstampieEngine {
    constructor() {
        this.ctx = null;
        this.isPlaying = false;
        this.currentMode = 1;
        this.instrument = 'both';        // 'vielle' | 'psaltery' | 'both'
        this.numVoices = 1;              // solo / consort layers on the melody
        this.tempo = 112;               // dance tactus, bpm
        this.droneVolume = 0.5;
        this.stringVolume = 0.75;
        this.reverbMix = 0.45;

        this.active = [];                // live melody note handles
        this.droneNodes = [];            // live drone oscillators / lfos
        this.stepTimeout = null;

        this.masterGain = null;
        this.compressor = null;
        this.mixBus = null;
        this.instrumentBus = null;
        this.droneBus = null;
        this.dryGain = null;
        this.reverbGain = null;
        this.convolver = null;
        this.analyser = null;
        this.noiseBuffer = null;
        this.ksCeiling = 1500;           // safety guard; set for real in init()

        // E3 — a grounded medieval instrumental register; the whole diatonic
        // octave above it stays under the Karplus–Strong delay-loop ceiling.
        this.basePitch = 164.81;

        // === The 8 medieval church tones (same shape as the chant engine) ===
        // intervals: cents from the finalis; the melody dances within them.
        this.modes = {
            1: { name: "Dorian",        intervals: [0,200,300,500,700,900,1000,1200], finalis: 0, tenor: 4, up: 5 },
            2: { name: "Hypodorian",    intervals: [0,200,300,500,700,900,1000,1200], finalis: 0, tenor: 2, up: 4 },
            3: { name: "Phrygian",      intervals: [0,100,300,500,700,800,1000,1200], finalis: 0, tenor: 5, up: 6 },
            4: { name: "Hypophrygian",  intervals: [0,100,300,500,700,800,1000,1200], finalis: 0, tenor: 3, up: 5 },
            5: { name: "Lydian",        intervals: [0,200,400,600,700,900,1100,1200], finalis: 0, tenor: 4, up: 6 },
            6: { name: "Hypolydian",    intervals: [0,200,400,600,700,900,1100,1200], finalis: 0, tenor: 2, up: 4 },
            7: { name: "Mixolydian",    intervals: [0,200,400,500,700,900,1000,1200], finalis: 0, tenor: 4, up: 6 },
            8: { name: "Hypomixolydian",intervals: [0,200,400,500,700,900,1000,1200], finalis: 0, tenor: 3, up: 5 }
        };

        this.sequence = [];
        this.pos = 0;
    }

    async init() {
        if (this.ctx) return;
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        const ctx = this.ctx;

        // === Output safety chain: compressor → trim → soft-clip → out ===
        // The compressor glues the dance; the trim restores the headroom its
        // makeup gain spends; the soft clipper is a transparent last-resort
        // ceiling (identity below 0.7, saturating toward 0.95 — never 1.0).
        this.compressor = ctx.createDynamicsCompressor();
        this.compressor.threshold.value = -10;
        this.compressor.knee.value = 6;
        this.compressor.ratio.value = 6;
        this.compressor.attack.value = 0.003;
        this.compressor.release.value = 0.25;

        this.outTrim = ctx.createGain();
        this.outTrim.gain.value = 0.85;

        this.softClip = ctx.createWaveShaper();
        const curve = new Float32Array(4096);
        for (let i = 0; i < curve.length; i++) {
            const x = (i / (curve.length - 1)) * 2 - 1;
            const ax = Math.abs(x);
            curve[i] = Math.sign(x) * (ax <= 0.7 ? ax : 0.7 + 0.25 * Math.tanh((ax - 0.7) / 0.25));
        }
        this.softClip.curve = curve;

        this.compressor.connect(this.outTrim);
        this.outTrim.connect(this.softClip);
        this.softClip.connect(ctx.destination);

        this.masterGain = ctx.createGain();
        this.masterGain.gain.value = 0.9;
        this.masterGain.connect(this.compressor);

        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.82;
        this.softClip.connect(this.analyser);

        // Shared white-noise source material for pluck bursts and bow air.
        this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const nd = this.noiseBuffer.getChannelData(0);
        for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

        // The plucked string lives in an AudioWorklet so it can tune true at
        // any pitch. If the worklet cannot load, fall back to the DelayNode
        // loop — whose cycle carries a whole extra render quantum of latency,
        // so compensate for it and keep the melody folded into the range the
        // loop can actually hold.
        this.ksWorklet = false;
        try {
            const url = URL.createObjectURL(new Blob([KS_STRING_WORKLET], { type: 'application/javascript' }));
            await ctx.audioWorklet.addModule(url);
            URL.revokeObjectURL(url);
            this.ksWorklet = true;
            this.ksCeiling = 1500;                      // sanity guard only
        } catch (e) {
            // total loop period = delayTime (min 128 samples) + 128-sample
            // cycle latency + ~6 samples of loop-filter delay
            this.ksCycleLatency = (128 + 6) / ctx.sampleRate;
            this.ksCeiling = ctx.sampleRate / 266;
        }

        await this.createReverb();

        // === Signal routing ===
        //   instruments → body resonance ┐
        //   drone       → body resonance ┴→ mixBus → dry ─┐
        //                └→ reverb┴→ master → compressor → trim → soft-clip → out
        this.mixBus = ctx.createGain();
        this.mixBus.gain.value = 1.0;

        this.dryGain = ctx.createGain();
        this.dryGain.gain.value = 1 - this.reverbMix * 0.5;
        this.reverbGain = ctx.createGain();
        this.reverbGain.gain.value = this.reverbMix;

        this.mixBus.connect(this.dryGain);
        this.mixBus.connect(this.convolver);
        this.dryGain.connect(this.masterGain);
        this.convolver.connect(this.reverbGain);
        this.reverbGain.connect(this.masterGain);

        // Melody strings through a shared wooden body.
        this.instrumentBus = ctx.createGain();
        this.instrumentBus.gain.value = this.stringVolume;
        const body = this.makeBody([[240, 4, 3.5], [430, 3, 2.5], [1150, 2.2, 2]]);
        this.instrumentBus.connect(body.input);
        body.output.connect(this.mixBus);

        // Drone through its own larger soundbox.
        this.droneBus = ctx.createGain();
        this.droneBus.gain.value = this.droneVolume;
        const dBody = this.makeBody([[150, 5, 4], [300, 4, 3], [620, 3, 2]]);
        this.droneBus.connect(dBody.input);
        dBody.output.connect(this.mixBus);
    }

    /**
     * A wooden body: a short chain of peaking resonances modelling the box.
     * Returns {input, output} so a whole bus can be coloured at once.
     */
    makeBody(peaks) {
        const ctx = this.ctx;
        const input = ctx.createGain();
        let node = input;
        for (const [freq, q, gainDb] of peaks) {
            const bq = ctx.createBiquadFilter();
            bq.type = 'peaking';
            bq.frequency.value = freq;
            bq.Q.value = q;
            bq.gain.value = gainDb;
            node.connect(bq);
            node = bq;
        }
        const output = ctx.createGain();
        output.gain.value = 0.9;
        node.connect(output);
        return { input, output };
    }

    /** Stone courtyard — a ~3.5 s tail with a scatter of early reflections. */
    async createReverb() {
        const sr = this.ctx.sampleRate;
        const length = Math.floor(sr * 3.5);
        const impulse = this.ctx.createBuffer(2, length, sr);
        const reflections = [0.009, 0.019, 0.031, 0.047, 0.063, 0.083, 0.107, 0.134];
        for (let ch = 0; ch < 2; ch++) {
            const data = impulse.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                const t = i / sr;
                const env = Math.exp(-t * 1.1) * 0.4 + Math.exp(-t * 0.5) * 0.38 + Math.exp(-t * 0.24) * 0.22;
                data[i] = (Math.random() * 2 - 1) * env;
                if (i < sr * 0.18) {
                    for (const d of reflections) {
                        if (i === Math.floor(d * sr)) data[i] += (Math.random() * 2 - 1) * 0.32;
                    }
                }
            }
        }
        this.convolver = this.ctx.createConvolver();
        this.convolver.buffer = impulse;
    }

    centsToFreq(cents) { return this.basePitch * Math.pow(2, cents / 1200); }

    /** Keep a pitch inside the plucked-string delay-loop range. */
    clampKs(freq) {
        let f = freq;
        while (f > this.ksCeiling) f /= 2;
        return f;
    }

    degToFreq(deg) {
        const m = this.modes[this.currentMode];
        const idx = ((deg % 8) + 8) % 8;
        const oct = Math.floor(deg / 8);
        return this.centsToFreq(m.intervals[idx]) * Math.pow(2, oct);
    }

    // === Physical models ===

    /**
     * Karplus–Strong plucked string. The waveguide loop runs inside the
     * ks-string AudioWorklet (see KS_STRING_WORKLET above) with a fractional,
     * tuning-compensated delay, so every note — high or low — sounds at its
     * true pitch and the loop decays by construction. The output envelope
     * shapes the musical decay on top of the string's own damping.
     */
    pluckString(freq, dur, t0, level) {
        const ctx = this.ctx;
        const f = this.clampKs(freq);
        const ring = Math.min(2.2, Math.max(dur * 1.3, 0.55));

        if (this.ksWorklet) {
            const node = new AudioWorkletNode(ctx, 'ks-string', {
                numberOfInputs: 0,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                processorOptions: { freq: f, t0, ring, feedback: 0.965, amp: 1.7 }
            });
            const out = ctx.createGain();
            out.gain.setValueAtTime(0.0001, t0);
            out.gain.linearRampToValueAtTime(level, t0 + 0.005);
            out.gain.exponentialRampToValueAtTime(0.0001, t0 + ring);
            node.connect(out);
            out.connect(this.instrumentBus);
            const handle = { gain: out, oscs: [], srcs: [], nodes: [node, out], tEnd: t0 + ring + 0.05 };
            this.register(handle);
            return;
        }

        // === Fallback: DelayNode loop, compensated for its cycle latency ===
        const period = Math.max(1 / f - this.ksCycleLatency, 128 / ctx.sampleRate);

        const delay = ctx.createDelay(0.1);
        delay.delayTime.value = period;

        const loopFilter = ctx.createBiquadFilter();
        loopFilter.type = 'lowpass';
        loopFilter.frequency.value = Math.min(7000, Math.max(1600, f * 6));
        loopFilter.Q.value = 0.2;

        const feedback = ctx.createGain();
        feedback.gain.value = 0.965;              // < 1.0 → the string decays

        // The waveguide loop: delay → damping → feedback → delay.
        delay.connect(loopFilter);
        loopFilter.connect(feedback);
        feedback.connect(delay);

        // Excitation: one period's worth of band-limited noise, plucking the loop.
        const burstLen = Math.max(period, 0.006);
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuffer;
        src.loop = true;
        const exFilter = ctx.createBiquadFilter();
        exFilter.type = 'lowpass';
        exFilter.frequency.value = Math.min(8000, f * 10);
        const exGain = ctx.createGain();
        exGain.gain.setValueAtTime(0.9, t0);
        exGain.gain.setValueAtTime(0.9, t0 + burstLen * 0.7);
        exGain.gain.linearRampToValueAtTime(0, t0 + burstLen);
        src.connect(exFilter); exFilter.connect(exGain); exGain.connect(delay);

        // Output envelope — the plucked decay on top of the loop's own damping.
        const out = ctx.createGain();
        out.gain.setValueAtTime(0.0001, t0);
        out.gain.linearRampToValueAtTime(level, t0 + 0.005);
        out.gain.exponentialRampToValueAtTime(0.0001, t0 + ring);
        delay.connect(out);
        out.connect(this.instrumentBus);

        src.start(t0, Math.random() * 1.5, burstLen + 0.02);
        // Damp the loop before teardown so it never clicks off mid-ring.
        feedback.gain.setValueAtTime(0.965, t0 + ring * 0.6);
        feedback.gain.linearRampToValueAtTime(0, t0 + ring);

        const handle = { gain: out, oscs: [], srcs: [src], nodes: [delay, loopFilter, feedback, exFilter, exGain, out], tEnd: t0 + ring + 0.05 };
        this.register(handle);
    }

    /**
     * Bowed string (vielle / rebec). A sawtooth is driven through a resonant
     * body band-pass and blended with bow noise; a slow attack and blooming
     * vibrato give it a sustained, singing character quite unlike the pluck.
     */
    bowString(freq, dur, t0, level) {
        const ctx = this.ctx;

        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = freq;

        // Direct tone path — a gentle lowpass tames the raw saw.
        const tone = ctx.createBiquadFilter();
        tone.type = 'lowpass';
        tone.frequency.value = Math.min(6500, freq * 7);
        tone.Q.value = 0.6;

        // Resonant body path — the strong band-pass that sings.
        const bodyBp = ctx.createBiquadFilter();
        bodyBp.type = 'bandpass';
        bodyBp.frequency.value = 620;
        bodyBp.Q.value = 3.2;
        const bodyGain = ctx.createGain();
        bodyGain.gain.value = 1.3;

        const amp = ctx.createGain();
        const attack = Math.min(0.09, dur * 0.4);
        const release = Math.max(0.14, dur * 0.5);
        amp.gain.setValueAtTime(0.0001, t0);
        amp.gain.linearRampToValueAtTime(level, t0 + attack);
        amp.gain.setValueAtTime(level * 0.92, t0 + Math.max(attack, dur * 0.75));
        amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + release);

        osc.connect(tone); tone.connect(amp);
        osc.connect(bodyBp); bodyBp.connect(bodyGain); bodyGain.connect(amp);

        // Bow noise — the hairs biting the string.
        const noise = ctx.createBufferSource();
        noise.buffer = this.noiseBuffer; noise.loop = true;
        const nf = ctx.createBiquadFilter();
        nf.type = 'bandpass'; nf.frequency.value = 3200; nf.Q.value = 0.8;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.0001, t0);
        ng.gain.linearRampToValueAtTime(level * 0.09, t0 + attack);
        ng.gain.linearRampToValueAtTime(level * 0.02, t0 + dur + release);
        noise.connect(nf); nf.connect(ng); ng.connect(amp);

        amp.connect(this.instrumentBus);

        // Vibrato blooms once the bow is speaking.
        const vib = ctx.createOscillator();
        vib.type = 'sine';
        vib.frequency.value = 5 + Math.random() * 1.2;
        const vibDepth = ctx.createGain();
        vibDepth.gain.value = freq * 0.006;
        vib.connect(vibDepth); vibDepth.connect(osc.frequency);

        const tEnd = t0 + dur + release;
        osc.start(t0); osc.stop(tEnd + 0.05);
        noise.start(t0, Math.random() * 1.5); noise.stop(tEnd + 0.05);
        vib.start(t0 + attack); vib.stop(tEnd + 0.05);

        const handle = { gain: amp, oscs: [osc, vib], srcs: [noise], nodes: [tone, bodyBp, bodyGain, amp, nf, ng, vibDepth], tEnd: tEnd + 0.1 };
        this.register(handle);
    }

    register(handle) {
        this.active.push(handle);
        const ms = (handle.tEnd - this.ctx.currentTime) * 1000 + 60;
        handle.timer = setTimeout(() => {
            for (const n of handle.nodes) { try { n.disconnect(); } catch (e) {} }
            const idx = this.active.indexOf(handle);
            if (idx > -1) this.active.splice(idx, 1);
        }, Math.max(60, ms));
    }

    // === Drone: hurdy-gurdy / bagpipe open fifth ===

    startDrone() {
        const ctx = this.ctx;
        const now = ctx.currentTime;
        const tonic = this.basePitch;
        const fifth = this.basePitch * Math.pow(2, 700 / 1200);

        // Two gain stages so the envelope and the buzz never fight: droneGain
        // holds the fade-in/out envelope, buzzGain holds the trompette
        // amplitude modulation (0.86 ± 0.14 → always within [0.72, 1.0]).
        const droneGain = ctx.createGain();
        droneGain.gain.setValueAtTime(0.0001, now);
        droneGain.gain.linearRampToValueAtTime(0.8, now + 2.0);

        const buzzGain = ctx.createGain();
        buzzGain.gain.value = 0;                     // driven entirely by buzz + offset
        droneGain.connect(buzzGain);
        buzzGain.connect(this.droneBus);

        // A rhythmic trompette buzz — the hurdy-gurdy's dog barking on the beat.
        const buzz = ctx.createOscillator();
        buzz.type = 'sine';
        buzz.frequency.value = this.tempo / 60;      // one buzz per tactus
        const buzzDepth = ctx.createGain();
        buzzDepth.gain.value = 0.14;
        const buzzOffset = ctx.createConstantSource();
        buzzOffset.offset.value = 0.86;
        buzz.connect(buzzDepth); buzzDepth.connect(buzzGain.gain);
        buzzOffset.connect(buzzGain.gain);
        buzz.start(now); buzzOffset.start(now);

        this.droneNodes.push(buzz, buzzOffset, buzzDepth, buzzGain, droneGain);
        this.droneGainNode = droneGain;
        this.buzzOsc = buzz;

        // Two reed-like sawtooths per pitch, slightly detuned, for a chorusing
        // open fifth. A soft lowpass keeps them woody, not buzzy-harsh.
        for (const [freq, lvl] of [[tonic, 0.5], [fifth, 0.42], [tonic * 0.5, 0.3]]) {
            for (const det of [-6, 6]) {
                const osc = ctx.createOscillator();
                osc.type = 'sawtooth';
                osc.frequency.value = freq;
                osc.detune.value = det;
                const lp = ctx.createBiquadFilter();
                lp.type = 'lowpass';
                lp.frequency.value = Math.min(2600, freq * 9);
                lp.Q.value = 0.5;
                const g = ctx.createGain();
                g.gain.value = lvl * 0.5;
                osc.connect(lp); lp.connect(g); g.connect(droneGain);
                osc.start(now);
                this.droneNodes.push(osc, lp, g);
            }
        }
    }

    stopDrone() {
        const ctx = this.ctx;
        if (!ctx) return;
        const now = ctx.currentTime;
        if (this.droneGainNode) {
            try {
                this.droneGainNode.gain.cancelScheduledValues(now);
                this.droneGainNode.gain.setValueAtTime(this.droneGainNode.gain.value, now);
                this.droneGainNode.gain.linearRampToValueAtTime(0.0001, now + 1.0);
            } catch (e) {}
        }
        const nodes = this.droneNodes;
        this.droneNodes = [];
        this.droneGainNode = null;
        this.buzzOsc = null;
        setTimeout(() => {
            for (const n of nodes) {
                try { n.stop && n.stop(); } catch (e) {}
                try { n.disconnect(); } catch (e) {}
            }
        }, 1200);
    }

    // === Dance FORM engine: puncta with ouvert / clos endings ===

    /**
     * Compose an estampie: a run of puncta, each a lively melodic gesture that
     * is stated twice — first with an *open* (ouvert) ending that hangs above
     * the finalis, then with a *closed* (clos) ending that settles home.
     */
    buildEstampie() {
        const m = this.modes[this.currentMode];
        const seq = [];
        const puncta = 2 + Math.floor(Math.random() * 2);   // 2–3 puncta

        // Endings: ouvert leaves us hanging a step up; clos lands, lengthened.
        const ouvert = [{ deg: 2, len: 0.5 }, { deg: 1, len: 1.5 }];
        const clos   = [{ deg: 1, len: 0.5 }, { deg: 0, len: 2.0 }];

        for (let p = 0; p < puncta; p++) {
            const body = this.genPunctum(m, p);
            seq.push(...body, ...ouvert);   // ...primo: open
            seq.push(...body, ...clos);     // ...secundo: closed
        }

        this.sequence = seq;
        this.pos = 0;
    }

    /** One punctum's melodic body — leaping compound-metre dance figures. */
    genPunctum(m, p) {
        const body = [];
        const top = Math.max(4, m.up + 1);
        // Compound/triple groupings of longs and quick leaping shorts.
        const cells = [
            [{ deg: 0, len: 1 }, { deg: 2, len: 0.5 }, { deg: 4, len: 0.5 }],
            [{ deg: 4, len: 0.5 }, { deg: 5, len: 0.5 }, { deg: 4, len: 1 }],
            [{ deg: 3, len: 0.5 }, { deg: 1, len: 0.5 }, { deg: 2, len: 1 }],
            [{ deg: 4, len: 0.5 }, { deg: 2, len: 0.5 }, { deg: 3, len: 0.5 }, { deg: 1, len: 0.5 }]
        ];
        const bars = 2 + Math.floor(Math.random() * 2);
        let last = p % 2 === 0 ? 0 : 4;
        for (let b = 0; b < bars; b++) {
            const cell = cells[Math.floor(Math.random() * cells.length)];
            for (const note of cell) {
                let deg = note.deg + (last > 3 ? 1 : 0);      // saltarello leap upward
                deg = Math.max(0, Math.min(top, deg));
                const item = { deg, len: note.len };
                // A quick plucked/bowed ornament on some longer beats.
                if (note.len >= 1 && Math.random() < 0.3) {
                    item.orn = [deg, Math.min(top, deg + 1), deg];
                }
                body.push(item);
                last = deg;
            }
        }
        return body;
    }

    start() {
        this.isPlaying = true;
        this.startDrone();
        this.buildEstampie();
        // Let the drone breathe in before the dance strikes up.
        this.stepTimeout = setTimeout(() => this.step(), 1200);
    }

    stop() {
        this.isPlaying = false;
        if (this.stepTimeout) { clearTimeout(this.stepTimeout); this.stepTimeout = null; }
        const now = this.ctx ? this.ctx.currentTime : 0;
        for (const h of this.active) {
            try {
                h.gain.gain.cancelScheduledValues(now);
                h.gain.gain.setValueAtTime(h.gain.gain.value, now);
                h.gain.gain.linearRampToValueAtTime(0.0001, now + 0.4);
            } catch (e) {}
            if (h.timer) clearTimeout(h.timer);
            setTimeout(() => {
                for (const o of h.oscs) { try { o.stop(); } catch (e) {} }
                for (const s of h.srcs) { try { s.stop(); } catch (e) {} }
                for (const n of h.nodes) { try { n.disconnect(); } catch (e) {} }
            }, 500);
        }
        this.active = [];
        this.stopDrone();
    }

    step() {
        if (!this.isPlaying) return;
        const item = this.sequence[this.pos];
        const beat = 60 / this.tempo;
        const dur = beat * item.len;

        const freqs = item.orn ? item.orn.map(d => this.degToFreq(d)) : [this.degToFreq(item.deg)];
        const sub = dur / freqs.length;
        freqs.forEach((freq, i) => this.playMelody(freq, sub, i * sub));

        this.pos++;
        if (this.pos >= this.sequence.length) this.buildEstampie();

        // Light articulation gap keeps the dance springing without stopping.
        const gap = beat * 0.05;
        this.stepTimeout = setTimeout(() => this.step(), (dur + gap) * 1000);
    }

    /** Play one melodic note across the chosen instrument(s) and voices. */
    playMelody(freq, dur, delay) {
        const t0 = this.ctx.currentTime + (delay || 0);
        for (let v = 0; v < this.numVoices; v++) {
            const spread = (v - (this.numVoices - 1) / 2);
            const detune = spread * 7 + (Math.random() - 0.5) * 5;
            const f = freq * Math.pow(2, detune / 1200);
            const t = t0 + Math.abs(spread) * 0.012;      // consort strums, not lock-step
            const lvl = 0.5 / Math.sqrt(this.numVoices);

            if (this.instrument === 'psaltery' || this.instrument === 'both') {
                this.pluckString(f, dur, t, lvl);
            }
            if (this.instrument === 'vielle' || this.instrument === 'both') {
                this.bowString(f, dur, t, this.instrument === 'both' ? lvl * 0.7 : lvl);
            }
        }
    }

    // === Public transport / control ===

    async begin() {
        await this.init();
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        if (!this.isPlaying) this.start();
    }

    end() { this.stop(); }

    setMode(mode) {
        this.currentMode = mode;
        if (this.isPlaying) this.buildEstampie();
    }

    setVoices(count) { this.numVoices = count; }

    setInstrument(which) { this.instrument = which; }

    setDroneVolume(v) {
        this.droneVolume = v;
        if (this.droneBus) this.droneBus.gain.linearRampToValueAtTime(v, this.ctx.currentTime + 0.2);
    }

    setStringVolume(v) {
        this.stringVolume = v;
        if (this.instrumentBus) this.instrumentBus.gain.linearRampToValueAtTime(v, this.ctx.currentTime + 0.2);
    }

    setReverbMix(v) {
        this.reverbMix = v;
        if (this.reverbGain && this.dryGain) {
            const now = this.ctx.currentTime;
            this.reverbGain.gain.linearRampToValueAtTime(v, now + 0.2);
            this.dryGain.gain.linearRampToValueAtTime(1 - v * 0.5, now + 0.2);
        }
    }

    setTempo(bpm) {
        this.tempo = bpm;
        // Keep the trompette buzz barking on the new tactus.
        if (this.buzzOsc && this.ctx) {
            this.buzzOsc.frequency.setTargetAtTime(bpm / 60, this.ctx.currentTime, 0.2);
        }
    }

    getAnalyserData() {
        if (!this.analyser) return null;
        const d = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteTimeDomainData(d);
        return d;
    }
    getFrequencyData() {
        if (!this.analyser) return null;
        const d = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(d);
        return d;
    }
}
