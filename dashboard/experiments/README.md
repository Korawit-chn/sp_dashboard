# Fan / mist experiment

`fan_mist_experiment.py` steps the dome fan through PWM 5%, 10%, ... 100%.
Before each step it mists the dome until humidity (sensorID 1) reaches 100%,
then runs the fan for 30 s and records the time the fan started.

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
python dashboard\experiments\fan_mist_experiment.py
```

Each round prints what it is doing:

```
[2026-10-27 15:58:35] === round 5% ===
[2026-10-27 15:58:35] mist ON - waiting for humidity >= 100% (now 82.4%)
[2026-10-27 15:58:45] humidity 91.0%
[2026-10-27 15:58:55] humidity 100.0%
[2026-10-27 15:58:55] mist OFF after 20s
[2026-10-27 15:58:55] fan SET_SPEED 5% for 30s - waiting for the Pi
[2026-10-27 15:58:59] fan confirmed at 5%
[2026-10-27 15:58:59] recorded 5%: 2026-10-27 15:58:59
```

## Results and progress

Results go to `fan_experiment.txt`, created next to the script:

```
current PWM: 10% (start 5%)
Time Record
5%: 2026-10-27 15:58:59
```

- The recorded time is when the fan Pi reported it was running, not when the
  command was sent. `(unconfirmed)` after a time means the Pi did not report
  within 30 s and the send time was used instead.
- `current PWM` moves up as soon as a time is recorded.
- Misting has no time limit - it keeps going until humidity reaches the
  target. If it never gets there, press Ctrl-C.
- **Ctrl-C** stops the experiment and turns the mist and fan off. Run the
  script again to carry on from `current PWM`.
- When 100% is recorded the file says `current PWM: complete`. Delete or
  rename the file to start a new experiment.

## Settings

There are no command-line options. To change the experiment, edit the
constants at the top of `fan_mist_experiment.py`:

| Constant | Default | Meaning |
|---|---|---|
| `TARGET_HUMIDITY` | `100.0` | Humidity to reach before each fan run. A DHT22 often tops out at 99.x - set `99` if it never reaches 100. |
| `PWM_START` / `PWM_STEP` | `5` / `5` | First PWM and the increase per round |
| `FAN_SECONDS` | `30` | How long the fan runs each round |
| `SENSOR_ID` | `1` | Sensor whose humidity is used |
| `LOCATION`, `FAN_TYPE`, `MIST_TYPE` | `Inside Box`, `FAN`, `Mist Maker` | How the fan and mister are found in the dashboard - the `Location:` and `Type:` the actuator Pis register with (case does not matter) |

## If something goes wrong

- **`ModuleNotFoundError: No module named 'requests'`** - step 3 was not run,
  or ran for a different Python. Run `python -m pip install requests` again.
- **Connection refused / backend error** - the backend is not running on this
  PC, or not on port 5000.
- **`expected one 'FAN' actuator at 'Inside Box', found 0`** - the fan or
  mist Pi has never registered with this backend, or registered with a
  different `Location:`. Check it appears on the dashboard, and that
  `LOCATION` matches its location there.
- **Humidity never prints** - sensorID 1 has not uploaded anything in the last
  15 minutes. Humidity also arrives only as often as the sensor uploads (60 s
  by default), so a shorter send period in the dashboard schedule makes each
  round finish sooner.
