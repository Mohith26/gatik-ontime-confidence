# On-time confidence for Gatik Live Operations (concept demo)

**Live demo:** https://mohith26.github.io/gatik-ontime-confidence/

Unofficial concept demo by Mohith Gajjela. Not affiliated with Gatik. All trip data is synthetic.

## What it is
gatik.ai shows a Live Operations board: each truck's start, end, driving time, stops and an "On Time" / "Completed" status. This demo adds what a shipper and a dispatcher actually need next to that status:

- an **arrival window (90%)** for every stop, from conformal prediction on the network's own history;
- an **on-time probability** for every active or parked trip against its appointment, with an "At risk" label when it drops below 80%;
- a hover card (same pattern as the production board) that draws each stop's band, the actual arrivals so far and the appointment;
- an analysis section (in the newsroom list style) showing coverage per condition, behaviour under a road change, calibration of the probabilities, and how much padding a 99%-on-time promise needs.

## How it works (`core/eta.mjs`)
1. **Synthetic network and simulator** (`scripts/gen_data.mjs`, seeded): 2 DFW distribution centres, 36 stores, 44 trips/day for 120 days, 1-5 stops per trip. Leg time = distance/speed by road mix × rush-hour profile × rain, plus AV-style unprotected-left and signal delays, school-zone slowdowns, multiplicative noise that widens in rain, rare remote-assist pauses; store-specific lognormal dock dwell. From day 106 a lane closure slows legs on one corridor (a regime shift the model never saw).
2. **Models** (days 0-69): ordinary least squares for the cumulative arrival time at each stop on dispatch-time features (miles, highway miles, lefts, signals, school-zone miles, peak × miles, rain, expected prior dwell and its variability, stop index), and a second linear model for the absolute residual (a learned scale).
3. **Conformal calibration** (days 70-95): normalised scores |y - ŷ| / σ̂(x) give split-conformal bands with a finite-sample guarantee; Mondrian conformal calibrates each condition group (rain/dry × first/later stop) separately.
4. **Adaptive conformal inference** (Gibbs & Candès, 2021): after each day's outcomes, each group's miscoverage level is nudged toward the target (α ← α + γ Σ(α* − errᵢ)), so bands re-widen after the lane closure without retraining.
5. **Late risk**: a conformal predictive p-value, the share of calibration scores beyond the appointment's normalised distance. In-trip updates on the board shift the band by the delay seen at the last completed stop (a heuristic, outside the guarantee).
6. **Promises**: arrival promise = ETA + q·σ̂(x) with q the conformal 99% one-sided quantile, compared with flat-minute and percent-of-ETA buffers tuned the same way.

Everything on the page is computed in the browser from `data/trips.json` by this code.

## Results on the held-out days (96-119)
- 90% bands: Gaussian ±1.645σ is 33 min wide and covers 78%-100% depending on condition; Mondrian conformal is 25 min wide; with ACI 26 min and 86%-89% in every condition; the route-table p5-p95 is 46 min wide.
- Before the lane closure split conformal covers 90%; after it, 85%; with ACI 88%.
- Late-risk Brier score 0.079 (conformal) vs 0.088 (Gaussian).
- At 99% on time, the average padding is 47 min (flat minutes), 39 min (percent of ETA), 35 min (conformal scale). Tuned on calibration days only, conformal and flat-minute promises both land at 98.8% on time with 34 vs 41 min of slack.

## Tests
`node --test tests/test.mjs` (9 tests): seeded data reproduces the committed file; finite-sample conformal rank; coverage of split conformal over 200 synthetic draws; OLS recovers known coefficients; calibration-period coverage ≈ 90%; conformal narrower than Gaussian and route-table, ACI beats split conformal after the shift, conditional spread far tighter than Gaussian; late-risk Brier and monotonicity; promise slack; board snapshot never reads the future.

## Honest limitations
- Synthetic network and simulator; nothing here is Gatik data, and real dispatch-time features (telemetry, remote-assist logs, dock schedules) would change the models.
- Linear mean and scale models; a gradient-boosted or quantile model would tighten bands further, and conformal calibration would wrap it the same way.
- Coverage guarantees are marginal (or per group for Mondrian) under exchangeability; the closure breaks that, and ACI only restores long-run coverage, not every day.
- The 99% promise pools rain and dry trips (a per-group 99% quantile needs ≥99 calibration trips per group).
- Appointment times are synthetic (route median + 10 min).

## Novelty note
Freight-visibility platforms (FourKites Dynamic ETA, project44) publish predictive point ETAs; I found no public product offering distribution-free, coverage-guaranteed arrival windows or calibrated on-time probabilities, and Gatik's public Live Operations board shows status only.
