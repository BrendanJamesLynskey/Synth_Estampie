# Synth Estampie — Medieval Dance Synthesizer

A web-based synthesizer that plays a medieval **estampie** in real time in the browser. No samples, no libraries — the *instruments* themselves are synthesized with **physical modelling** (Karplus–Strong waveguide strings and a bowed vielle over a droning fifth) using only the Web Audio API.

**[Launch the app](https://brendanjameslynskey.github.io/Synth_Estampie/)** — auto-detects your device and recommends desktop or mobile.

---

## The style

The **estampie** is one of the earliest surviving purely **instrumental** forms of Western music — a lively courtly dance with no words, meant to be played and danced rather than sung. Together with its cousins the *saltarello* (a leaping dance) and the *ductia*, it was struck up on vielle, psaltery, hurdy-gurdy and bagpipes at courts and gardens across 13th–14th-century Europe.

Its form is a chain of repeated **puncta**: each phrase is stated twice — first with an *open* (**ouvert**) ending that hangs unresolved, then with a *closed* (**clos**) ending that lands home. The handful that were written down survive in the **Robertsbridge Codex** and the **Manuscrit du Roi**. It sits on the secular, instrumental branch of early music, grown from the sung monophony of the troubadours and trouvères.

## How it sounds high quality

Rather than pure tones, the engine models the **instruments of a dance band**:

- **Psaltery / lute** — a genuine **Karplus–Strong plucked string**: a feedback loop of a `DelayNode` (delay = 1 ⁄ frequency) + an in-loop damping lowpass `BiquadFilter` + a sub-unity feedback `GainNode`, excited by a short filtered noise burst. Pitch is the delay length; brightness and decay are the loop-filter cutoff and feedback gain. A real waveguide string, not an oscillator.
- **Vielle / rebec** — a **bowed string**: a sustained sawtooth excitation driven through a strong resonant body band-pass, blended with a bow-noise component, a slow singing attack and a blooming vibrato — continuous, not plucked.
- **Drone** — a hurdy-gurdy / bagpipe **open fifth** (tonic + fifth) held underneath, coloured by a wooden soundbox and given a subtle rhythmic *trompette* buzz on the beat.
- **Body resonance** — every instrument passes through a shared bank of peaking filters modelling a resonant wooden box, so the strings sing like carved instruments.
- **Form & ensemble** — a dance FORM engine lays out *puncta* with ouvert/clos endings in a leaping compound/triple metre, played solo or as a consort, in a stone **courtyard convolution reverb** (~3.5 s tail).

## Where it sits — the lineage of early Western music

Everything in this collection grows from plainchant, but the estampie sits on a **parallel, secular, instrumental** branch:

```
Plainsong ──► Organum ──► Ars Nova ──► (Renaissance polyphony)   [sacred]
   │
   └── Troubadour song ──► Estampie dances                       [secular]
              (sung             (the melody steps off the page
               monophony)        and onto the dance floor)
```

| App | Style | Synthesis technique |
|---|---|---|
| [Synth Gregorian](https://github.com/BrendanJamesLynskey/Synth_Gregorian) | Plainsong | Source–filter formant vocal synthesis |
| [Synth Organum](https://github.com/BrendanJamesLynskey/Synth_Organum) | Notre-Dame polyphony | Additive synthesis in Pythagorean just intonation |
| [Synth Ars Nova](https://github.com/BrendanJamesLynskey/Synth_ArsNova) | 14th-c. isorhythm | FM synthesis |
| [Synth Troubadour](https://github.com/BrendanJamesLynskey/Synth_Troubadour) | Secular monophony | Subtractive synthesis |
| **Synth Estampie** (this) | Medieval dance | Physical modelling |

## Quick start

```bash
git clone https://github.com/BrendanJamesLynskey/Synth_Estampie.git
cd Synth_Estampie
python3 -m http.server 8080
```

Open <http://localhost:8080> and press **Begin Dance**. Any static file server works — there is no build step or dependency.

## Files

| File | Purpose |
|---|---|
| `index.html` | Landing page — detects device, links to desktop or mobile |
| `desktop.html` | Desktop web app |
| `style.css` | Earthy secular styles (amber, forest-green, gold) |
| `estampie-engine.js` | Physical-modelling synthesis engine (Web Audio API) |
| `app.js` | UI controller, string visualizer, drifting motes |
| `estampie_mobile.html` | Self-contained mobile version (single file) |

## Controls

| Control | Description |
|---|---|
| **Mode** | One of the 8 church tones (Dorian → Hypomixolydian) |
| **Drone** | Volume of the hurdy-gurdy open-fifth drone |
| **Strings** | Volume of the plucked / bowed melody strings |
| **Courtyard Reverb** | Wet/dry mix of the stone-courtyard convolution reverb |
| **Tempo** | Speed of the dance |
| **Instrument** | Vielle (bowed), Psaltery (plucked), or Both (consort) |
| **Ensemble** | Solo, Duo, or Consort melody voices |

## License

MIT
