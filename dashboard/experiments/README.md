# Fan PWM experiment

`fan_pwm_experiment.py` steps the box fan through PWM 10%, 25%, 40%, 55%, 70%,
85% and 100%, and does that whole set 3 times, in order.

Before each run it checks humidity (sensorID 1):

- **Already 100%** - no mist, the fan starts straight away.
- **Below 100%** - it mists until humidity reaches 100%, turns the mist off,
  waits 20 s, then starts the fan.

The fan runs for 30 s and the time it started is recorded. After each run it
pauses 60 s with the mist and fan off, so the humidity log shows how the box
settles before the next run.

It runs on the **Windows PC that runs the dashboard backend** and controls the
mist and fan through the dashboard API at `http://localhost:5000`. Nothing is
installed on the Pis.

## Setup on a new PC

The backend must already be set up and running on this PC, and the mist, fan
and sensor Pis must be online in the dashboard.

1. Install Python 3.8 or newer from https://www.python.org/downloads/ and tick
   **Add python.exe to PATH** in the installer.

2. Open a terminal (PowerShell or Command Prompt) and check it works:

   ```
   python --version
   ```

3. Install the one library the script needs:

   ```
   python -m pip install requests
   ```

## Run

From the project folder:

```
python dashboard\experiments\fan_pwm_experiment.py
```

Each round prints what it is doing:

```
[2026-10-29 09:00:00] === repeat 1 of 3, round 10% ===
[2026-10-29 09:00:00] humidity 82.4% - mist ON until >= 100%
[2026-10-29 09:00:10] humidity 91.0%
[2026-10-29 09:00:20] humidity 100.0%
[2026-10-29 09:00:20] mist OFF after 20s - waiting 20s before the fan
[2026-10-29 09:00:40] fan SET_SPEED 10% for 30s - waiting for the Pi
[2026-10-29 09:00:44] fan confirmed at 10%
[2026-10-29 09:00:44] recorded repeat 1, 10%: 2026-10-29 09:00:44
[2026-10-29 09:01:16] fan stopped
[2026-10-29 09:01:16] pause 60s - mist and fan off
```

A round that finds the box already at 100% shows
`humidity 100.0% - already at 100%, no mist` and goes straight to the fan.
The reading that decides is always one taken after the previous run ended,
so the humidity from before the fan dried the box never counts.

## Results and progress

Results go to `fan_pwm_experiment.txt`, created next to the script, one
section per repeat:

```
current repeat: 2 of 3
current PWM: 25% (start 10%)
Time Record
Repeat 1
10%: 2026-10-29 09:00:44
...
100%: 2026-10-29 09:21:55
Repeat 2
10%: 2026-10-29 09:23:30
```

- The recorded time is when the fan Pi reported it was running, not when the
  command was sent. `(unconfirmed)` after a time means the Pi did not report
  within 30 s and the send time was used instead.
- `current PWM` moves up as soon as a time is recorded. After 100% it goes back
  to 10% and `current repeat` moves to the next repeat.
- A progress file written with a different start or step (the old 5% / +5%
  one, for example) is refused rather than mixed in. Rename or delete it.
- Every start first turns the mist and fan off and waits 10 s, so a run
  never begins with the mist left on from last time.
- Misting has no time limit - it keeps going until humidity reaches the
  target. If it never gets there, press Ctrl-C.
- **Ctrl-C** stops the experiment and turns the mist and fan off. Run the
  script again to carry on from `current repeat` and `current PWM`.
- When 100% is recorded in the last repeat, both lines say `complete`. Delete
  or rename the file to start a new experiment.

## Settings

There are no command-line options. To change the experiment, edit the
constants at the top of `fan_pwm_experiment.py`:

| Constant | Default | Meaning |
|---|---|---|
| `TARGET_HUMIDITY` | `100.0` | Humidity to reach before each fan run. A DHT22 often tops out at 99.x - set `99` if it never reaches 100. |
| `PWM_START` / `PWM_STEP` | `10` / `15` | First PWM and the increase per round |
| `FAN_SECONDS` | `30` | How long the fan runs each round |
| `MIST_SETTLE_SECONDS` | `20` | Wait after the mist stops, before the fan starts. Skipped when no mist was needed |
| `PAUSE_SECONDS` | `60` | Pause after each run, mist and fan off, before the next misting |
| `REPEATS` | `3` | How many times the whole 5%-100% set is done |
| `SENSOR_ID` | `1` | Sensor whose humidity is used |
| `LOCATION`, `FAN_TYPE`, `MIST_TYPE` | `Inside Box 1`, `FAN`, `Mist Maker` | How the fan and mister are found in the dashboard - the `Location:` and `Type:` the actuator Pis register with (case does not matter) |

## If something goes wrong

- **`ModuleNotFoundError: No module named 'requests'`** - step 3 was not run,
  or ran for a different Python. Run `python -m pip install requests` again.
- **Connection refused / backend error** - the backend is not running on this
  PC, or not on port 5000.
- **`expected one 'FAN' actuator at 'Inside Box 1', found 0`** - the fan or
  mist Pi has never registered with this backend, or registered with a
  different `Location:`. Check it appears on the dashboard, and that
  `LOCATION` matches its location there.
- **Humidity never prints** - sensorID 1 has not uploaded anything in the last
  hour. Humidity also arrives only as often as the sensor uploads (60 s
  by default), so a shorter send period in the dashboard schedule makes each
  round finish sooner.
