# Pressure insole v1: hardware

A measurement insole that sits **on top of** each printed orthotic prototype, so every prototype is measured with the same sensors, shoe and sock. Right foot only. Repeatability matters more than absolute accuracy: we compare prototype against prototype.

Files:
- `sensor_layout.csv` (generated): 24 sensors, multiplexer channel, position in builder coordinates, and the P01 orthotic surface under each pad.
- `sensor_template.svg` (generated): 1:1 A4 print of the foot outline, the P01 outline and the pads.
- Regenerate both for a new foot or prototype with `node tools/sensor_layout.mjs <orthotic-settings.json saved from the builder>` (uses the geometry in `builder/src/`).

## Architecture

```
 sensor sheet (flex PCB + Velostat dots, 24 pads)
        │ 26-way tail out the back of the heel
        ▼
 ankle box:  2 × CD74HC4067 (16-ch mux) ──► XIAO ESP32-S3 ADC ──► BLE ──► laptop
             reference resistors, 100 nF caps          │
                                                       LiPo 500 mAh
```

Each pad is a variable resistor `Rs` between 3.3 V and one mux input. Each mux output goes to its own ADC pin, with a reference resistor `Rref` to ground. Only one pad per mux is connected at a time, so pads don't affect each other's readings.

`V = 3.3 × Rref / (Rref + Rs)`, so `Rs = Rref × (3.3 / V − 1)`. Pressure follows roughly from conductance `1/Rs`, which is close to linear in pressure (de Fazio 2021, R² ≈ 0.98).

The two muxes cover different pressure ranges:

| Mux | Pads | Expected pressure | Starting Rref |
|---|---|---|---|
| A | 12 medial arch (A11–A43), 2 lateral midfoot (L1, L2) | low, under ~100 kPa | 10 kΩ |
| B | 3 heel, 5 metatarsal heads, 2 toes | high, up to ~500 kPa | 3.3 kΩ |

The Rref values are starting guesses. Set the final ones in the bench test below with `Rref ≈ √(R_light × R_heavy)` for that pad group.

## Parts (prices are rough estimates)

| Part | Qty | Notes | ~USD |
|---|---|---|---|
| Seeed XIAO ESP32-S3 | 1 | BLE, small, built-in LiPo charger (battery pads on the back) | 8 |
| CD74HC4067 16-ch mux breakout | 2 | runs at 3.3 V; on-resistance ~100 Ω, negligible against kΩ pads | 6 |
| LiPo 3.7 V, 400–500 mAh | 1 | solder to the XIAO battery pads, add a slide switch | 8 |
| Velostat / Linqstat sheet (e.g. Adafruit 1361) | 1 | 0.1 mm; one sheet makes many sensor sets | 5 |
| Flex PCB, 2-layer polyimide | 1 order | sensor sheet, design is the next step; get a quote | 40–100 |
| FPC/FFC ZIF breakout, 26-pin 1.0 mm pitch | 1 | the flex tail plugs in here | 5 |
| Kapton (polyimide) tape, 25–50 mm wide | 1 roll | holds Velostat dots on the pads | 8 |
| 10 mm hole punch (leather punch) | 1 | cuts consistent Velostat dots | 5 |
| Resistors 1k–22k (1%), 100 nF caps, perfboard, slide switch | — | | 5 |
| 3D-printed ankle box + velcro strap | 1 | | — |
| **Bench test only:** copper foil tape, PET or Kapton film, breadboard, jumpers | — | | 10 |

Total about $100–160, mostly the flex PCB.

## XIAO ESP32-S3 pin plan

| Signal | XIAO pin | GPIO | Notes |
|---|---|---|---|
| Mux A output (ADC) | D0 | 1 | ADC1; 10 kΩ to GND, 100 nF to GND |
| Mux B output (ADC) | D1 | 2 | ADC1; 3.3 kΩ to GND, 100 nF to GND |
| S0–S3 (shared by both muxes) | D2, D3, D8, D9 | 3, 4, 7, 8 | |
| Mux EN (both) | GND | — | always enabled |
| Spare I²C (optional IMU later) | D4, D5 | 5, 6 | |

Use ADC1 pins only and read with `analogReadMilliVolts()`, which applies the chip's calibration. Leave ~20 µs after switching channels before reading, and average 4 readings per pad. 24 pads × 4 readings at 100 Hz is well within the ESP32's speed.

## Sensor sheet

- **Base:** 2-layer polyimide flex PCB cut to the full foot outline (solid line on the template), not the orthotic outline, so the forefoot pads stay under the foot even past a 3/4 orthotic.
- **Pads:** 10 mm, two interleaved electrodes on the top layer (one to its own trace, one to the shared 3.3 V net). All traces run on the bottom layer and gather into a 26-way tail (24 pads + 2 × 3.3 V) that leaves behind the heel and runs ~120 mm up the heel counter to the ZIF breakout. Ask for a stiffener on the tail contacts.
- **Velostat:** punch 10 mm dots, lay them on a strip of Kapton tape in the pad pattern (print the template as a guide), then press the tape onto the sheet: the UCL method. Discrete dots avoid most of the crosstalk de Fazio saw with one continuous sheet.
- **Conforming to the arch:** P01's arch puts pads A11–A43 on 20–31° slopes (see the csv). Cut lengthwise slits in the flex between the arch pad columns (about 30–57% of foot length, routing traces around them) so the sheet can follow the arch without wrinkling. Wrinkles pressing on a pad read as load.
- **Gap between pads:** the tightest pair (A12–A13) has a 3.4 mm gap, which is fine for discrete dots.

## Check positions against your foot before ordering

The pad positions use typical foot proportions. Check them against your own foot:

1. Print `sensor_template.svg` at 100% and check the 50 mm bar.
2. Stand on it, or put the paper in the shoe. Feel for your 1st and 5th metatarsal heads (the knuckles of the ball of the foot), the centre of the heel and the big-toe pad, and mark each.
3. Adjust the `f` (fraction of length) and `a` (fraction across from the inner edge) values for H2, M1–M5 and T1 in `tools/sensor_layout.mjs`, then re-run it.

Watch **M5**: its default position is 1.4 mm from P01's front edge. A pad on the orthotic's edge reads the step, not your foot. If your 5th metatarsal head really is there, the 3/4 orthotic ends under a pressure point, which is a fit question in itself. Options are moving the pad a few mm forward, or a sulcus-length orthotic.

## Bench test (while the flex PCB is being made)

1. Make 4 test pads from copper foil tape on PET or Kapton film: 2 at 10 mm with Velostat dots, plus spares.
2. With a multimeter, measure `Rs` unloaded, under a light finger press, and with full body weight on the heel.
3. Wire one mux and one pad to the XIAO on a breadboard and check the ADC reading follows the multimeter.
4. **Calibration rig:** a 3D-printed 10 mm plunger (78.5 mm² face) with a platform for weights. Pressure = mass × 9.81 / 78.5 mm²:

   | Mass on plunger | Pressure |
   |---|---|
   | 0.25 kg | 31 kPa |
   | 0.5 kg | 62 kPa |
   | 1 kg | 125 kPa |
   | 2 kg | 250 kPa |
   | 4 kg | 500 kPa |

   Load each step for 30 s, read on the way up and on the way down (hysteresis), and repeat 3 times. Fit `1/Rs` against pressure, then choose the final Rref for each mux.

## Known risks

- **Velostat drifts with temperature and keeps a "memory" of recent load.** Walk 5 minutes in the shoe before a test, always run tests in the same order, and re-measure a reference (the no-orthotic shoe) every session.
- **Material is a variable.** P01 is PLA in shell style. PLA is rigid and TPU is not, so the same shape reads differently in each. The builder recommends TPU; switching material counts as the one change for that round.
- **Bending can change readings.** Zero the sheet unloaded on each prototype, not on a flat table.
