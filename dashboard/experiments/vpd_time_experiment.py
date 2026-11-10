#!/usr/bin/env python3
"""vpd_time_experiment.py - how long each fan PWM takes to dry a saturated box
to a target VPD.

    python vpd_time_experiment.py

The VPD Time sheet of "experiment plan.xlsx". Runs on the backend's own
machine, so it talks to localhost. There are no arguments - everything about
the experiment is a constant below.

The whole set of rounds, 10%, 25% ... 100%, is done REPEATS times, in order.
One round:

    1. write "Start"
    2. wait for a sensorID 1 reading taken since the last run ended; if
       humidity is below TARGET_HUMIDITY, mist ON until a reading reaches it,
       mist OFF. Skipped when the box is already there
    3. wait MIST_SETTLE_SECONDS, then fan SET_SPEED at the round's PWM, and
       write "Fan on" with the time the fan Pi confirms it is running
    4. wait for the first VPD reading (sensorID 1) at or above TARGET_VPD,
       write "Reached", move to the next PWM
    5. fan OFF straight away
    6. hold HOLD_SECONDS with the mist and fan off - VPD is not checked during
       it - then the next round

There is no timeout on step 2 or step 4 - a round waits for as long as it
takes. Ctrl-C stops the experiment and turns the mist and fan off.

THE PROGRESS FILE

vpd_time_experiment.txt, next to this script, created on the first run, is
both the result and the resume point:

    current repeat: 1 of 3
    current PWM: 25% (start 10%)
    Time Record
    Repeat 1
    2026-11-09 12:00:15 Start 10%
    2026-11-09 12:03:40 Fan on 10%
    2026-11-09 12:10:12 Reached VPD 0.35 kPa 10% (6m32s)
    2026-11-09 12:11:12 Start 25%

"current PWM" moves on when "Reached" is written. A round that was stopped
part-way has a Start (and maybe a Fan on) but no Reached; running the script
again replaces those lines with the redone round's. After the last round both
header lines read "complete" and the file ends with an "experiment end" line,
which is what experiment_manager.py looks for. A further run then does nothing.
Delete or rename the file to start a new experiment.

WHICH TIMES ARE RECORDED

Start   - this PC's clock, when the round begins.
Fan on  - the server's timestamp of the fan Pi's first report at the new duty
          (/api/actuators statusUpdatedAtMs). "(unconfirmed)" means the Pi did
          not report within CONFIRM_TIMEOUT_SECONDS and the send time was used.
Reached - the timestamp of the first reading at or above the target
          (/api/logs datetime). The bracket is Reached minus Fan on, so it is
          only right when the sensor Pi's clock agrees with this PC's.

Readings arrive only as often as the sensor uploads (sendSeconds in the
dashboard's schedule, 60 s by default), so Reached can be up to one upload
late. A shorter send period gives sharper times.

SAFETY

With no timeout, the fan has to run for as long as a round takes - but it is
never sent without a duration. It is sent for FAN_RUN_SECONDS (the backend's
limit) and re-sent every FAN_RESEND_SECONDS, so if this script dies mid-run
the fan Pi still stops the fan within FAN_RUN_SECONDS. Each re-send re-applies
the same duty and re-arms the Pi's timer. The mist works the same way with its
own, shorter limit. Every start sends OFF to both before anything else, and
Ctrl-C, or any error, sends OFF to both before exiting.
"""

import re
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

BASE_DIR = Path(__file__).resolve().parent

BACKEND = "http://localhost:5000"
PROGRESS_FILE = BASE_DIR / "vpd_time_experiment.txt"

# --- The experiment ---
TARGET_VPD = 0.35           # kPa; reached on the first reading at or above this
PWM_START = 10
PWM_STEP = 15               # 10, 25, 40, 55, 70, 85, 100
REPEATS = 3
TARGET_HUMIDITY = 100.0     # mist to this first; a DHT22 often tops out at 99.x
MIST_SETTLE_SECONDS = 120   # after the mist stops, before the fan starts
HOLD_SECONDS = 60           # fan off after Reached, before the next Start (not checked)

# --- Which devices ---
SENSOR_ID = 1
LOCATION = "Inside Box 1"     # Location: of the fan and mist Pis, not the sensor's
FAN_TYPE = "FAN"            # Type: in config_fan.txt
MIST_TYPE = "Mist Maker"    # Type: in config.txt

REQUEST_TIMEOUT = 5

# MAX_MIST_SECONDS / MAX_FAN_SECONDS in the backend's config.js. A longer ask
# is clamped to these anyway, so re-sending well inside them keeps a run going
# with no gap while a dead script still leaves a deadline behind.
MIST_RUN_SECONDS = 600
MIST_RESEND_SECONDS = 300
FAN_RUN_SECONDS = 3600
FAN_RESEND_SECONDS = 1800

# Both Pis poll for commands every 5 s, so 10 s covers a full poll on each.
STARTUP_OFF_SECONDS = 10

READING_POLL_SECONDS = 10
# fan_control.py polls every 5 s and measures rpm for 1 s before it reports,
# so a confirmation normally lands inside ~7 s. The poll is faster than the
# Pi's 15 s re-report so the FIRST report is the one recorded.
CONFIRM_POLL_SECONDS = 2
CONFIRM_TIMEOUT_SECONDS = 30

# How far back /api/logs is asked to look. Whole hours only: MySQL rounds
# INTERVAL 0.25 HOUR to 0, so a fractional window returns no rows.
LOG_WINDOW_HOURS = 1

TIME_FORMAT = "%Y-%m-%d %H:%M:%S"
END_LINE = "experiment end"


def log(message):
    print(f"[{datetime.now().strftime(TIME_FORMAT)}] {message}", flush=True)


def _now_text():
    return datetime.now().strftime(TIME_FORMAT)


def _fmt(pwm):
    return f"{pwm:g}"


def _percent(text):
    return float(text.strip().rstrip("%"))


def _vpd(value):
    return f"VPD {value:g} kPa"


def _duration(seconds):
    # Negative only if the sensor Pi's clock is behind this PC's.
    seconds = int(round(seconds))
    sign = "-" if seconds < 0 else ""
    seconds = abs(seconds)
    return f"{sign}{seconds // 60}m{seconds % 60:02d}s"


def parse_reading_time(text):
    """/api/logs datetime as an aware datetime.

    mysql2 sends DATETIME as ISO in UTC ("2026-11-09T05:10:12.000Z"). A value
    with no zone is taken as this PC's local time, which is the backend's.
    """
    text = str(text).strip()
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        dt = datetime.strptime(text[:19].replace("T", " "), TIME_FORMAT)

    if dt.tzinfo is None:
        dt = dt.astimezone()   # local
    return dt


# ---------------------------------------------------------------------------
# Progress file
# ---------------------------------------------------------------------------

START_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} Start (\S+)%$")


class Progress:
    """The .txt file: where the experiment is, and every round's lines."""

    def __init__(self, path):
        self.path = Path(path)
        self.start = PWM_START
        self.repeat = 1               # None, with current, once all are done
        self.current = PWM_START
        self.rounds = {}              # {repeat: [[pwm, [line, ...]], ...]}

    @property
    def complete(self):
        return self.current is None

    def load(self):
        if not self.path.exists():
            return

        section = 1

        for line in self.path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            lower = line.lower()

            if not line or lower in ("time record", END_LINE):
                continue

            if lower.startswith("current repeat:"):
                value = line.split(":", 1)[1].strip()
                self.repeat = None if value.startswith("complete") else int(value.split()[0])

            elif lower.startswith("current pwm:"):
                rest = line.split(":", 1)[1].strip()
                current, _, start = rest.partition("(start")
                current = current.strip()
                self.current = None if current == "complete" else _percent(current)
                if start:
                    self.start = _percent(start.rstrip(")").strip())

            elif lower.startswith("repeat "):
                section = int(line.split()[1])

            else:
                m = START_RE.match(line)
                rounds = self.rounds.setdefault(section, [])
                if m:
                    rounds.append([_percent(m.group(1)), [line]])
                elif rounds:
                    rounds[-1][1].append(line)
                else:
                    raise SystemExit(f"{self.path}: {line!r} comes before any Start line")

        if self.current is None:
            self.repeat = None

        # A file from before PWM_START / PWM_STEP changed would resume off the
        # new sequence and mix two experiments in one file.
        if self.start != PWM_START or (
                not self.complete and (self.current - self.start) % PWM_STEP):
            raise SystemExit(
                f"{self.path} was written with different PWM settings "
                f"(start {_fmt(self.start)}%) - rename or delete it to start "
                f"the {_fmt(PWM_START)}% / +{_fmt(PWM_STEP)}% experiment")

    def begin_round(self):
        """Write the Start line, replacing a part-done try at this round."""
        pwm = self.current
        rounds = [r for r in self.rounds.get(self.repeat, []) if r[0] != pwm]
        rounds.append([pwm, [f"{_now_text()} Start {_fmt(pwm)}%"]])
        self.rounds[self.repeat] = rounds
        self.save()
        return rounds[-1][1][0]

    def add_line(self, line):
        self.rounds[self.repeat][-1][1].append(line)
        self.save()

    def finish_round(self, line):
        """Write Reached and move on - one write, so a crash cannot leave a
        reached round that is still marked current."""
        self.rounds[self.repeat][-1][1].append(line)

        nxt = self.current + PWM_STEP
        if nxt <= 100:
            self.current = nxt
        elif self.repeat < REPEATS:
            self.repeat += 1
            self.current = self.start
        else:
            self.repeat = None
            self.current = None

        self.save()

    def save(self):
        if self.complete:
            lines = [f"current repeat: complete ({REPEATS} repeats)",
                     f"current PWM: complete (start {_fmt(self.start)}%)"]
        else:
            lines = [f"current repeat: {self.repeat} of {REPEATS}",
                     f"current PWM: {_fmt(self.current)}% (start {_fmt(self.start)}%)"]

        lines.append("Time Record")

        for repeat in sorted(self.rounds):
            lines.append(f"Repeat {repeat}")
            for _, round_lines in self.rounds[repeat]:
                lines += round_lines

        if self.complete:
            lines.append(END_LINE)

        # Atomic: a half-written progress file would resume from the wrong PWM.
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
        tmp.replace(self.path)


# ---------------------------------------------------------------------------
# Dashboard API
# ---------------------------------------------------------------------------

class Api:
    def __init__(self, base_url):
        self.base = base_url.rstrip("/")
        self.session = requests.Session()

    def _get(self, path, **params):
        r = self.session.get(f"{self.base}{path}", params=params, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return r.json()

    def command(self, actuator_id, action, duty=None, seconds=None):
        body = {"actuatorID": actuator_id, "action": action,
                "triggerSource": "AUTOMATION"}
        if duty is not None:
            body["pwmDutyPercent"] = duty
        if seconds is not None:
            body["durationSeconds"] = int(seconds)

        r = self.session.post(f"{self.base}/api/actuatorCommand", json=body,
                              timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return r.json()

    def actuators(self):
        return self._get("/api/actuators")

    def actuator(self, actuator_id):
        data = self.actuators()
        for a in data["actuators"]:
            if a["actuatorID"] == actuator_id:
                return a, data["serverEpochMs"]
        raise SystemExit(f"actuator {actuator_id} has disappeared from /api/actuators")

    def find_actuator(self, type_name):
        matches = [a for a in self.actuators()["actuators"]
                   if (a.get("typeName") or "").lower() == type_name.lower()
                   and (a.get("locationName") or "").lower() == LOCATION.lower()]

        if len(matches) != 1:
            raise SystemExit(
                f"expected one {type_name!r} actuator at {LOCATION!r}, found "
                f"{len(matches)} - check FAN_TYPE / MIST_TYPE / LOCATION")

        return matches[0]["actuatorID"]

    def readings(self, field):
        """Every (datetime, value) of `field` from SENSOR_ID, oldest first.

        The datetimes are only compared with each other, never with this PC's
        clock, so a stale reading cannot look new.
        """
        rows = self._get("/api/logs", hours=LOG_WINDOW_HOURS)
        out = [(parse_reading_time(r["datetime"]), float(r[field])) for r in rows
               if r.get("sensorID") == SENSOR_ID and r.get(field) is not None]
        out.sort(key=lambda x: x[0])
        return out

    def latest(self, field):
        rows = self.readings(field)
        return rows[-1] if rows else None


# ---------------------------------------------------------------------------
# One round
# ---------------------------------------------------------------------------

def newest_reading_time(api):
    reading = api.latest("humidity")
    return reading[0] if reading else None


def _newer(reading, baseline):
    return reading and (baseline is None or reading[0] > baseline)


def saturate(api, mist_id, baseline):
    """Mist until humidity reaches TARGET_HUMIDITY, then wait out the settle
    time. The first reading newer than baseline decides; one already at the
    target skips the mist (but not the settle wait - the fan always starts
    MIST_SETTLE_SECONDS after this).
    """
    reading = api.latest("humidity")
    if not _newer(reading, baseline):
        log("waiting for a new humidity reading")
    while not _newer(reading, baseline):
        time.sleep(READING_POLL_SECONDS)
        reading = api.latest("humidity")

    if reading[1] >= TARGET_HUMIDITY:
        log(f"humidity {reading[1]:.1f}% - already at {TARGET_HUMIDITY:g}%, no mist")
    else:
        log(f"humidity {reading[1]:.1f}% - mist ON until >= {TARGET_HUMIDITY:g}%")
        started = time.monotonic()
        last_send = None
        last_shown = reading[0]

        while True:
            now = time.monotonic()
            if last_send is None or now - last_send >= MIST_RESEND_SECONDS:
                api.command(mist_id, "ON", seconds=MIST_RUN_SECONDS)
                last_send = now

            time.sleep(READING_POLL_SECONDS)
            reading = api.latest("humidity")

            if reading and reading[0] > last_shown:
                last_shown = reading[0]
                log(f"humidity {reading[1]:.1f}%")
                if reading[1] >= TARGET_HUMIDITY:
                    break

        api.command(mist_id, "OFF")
        log(f"mist OFF after {time.monotonic() - started:.0f}s")

    log(f"waiting {MIST_SETTLE_SECONDS:g}s before the fan")
    time.sleep(MIST_SETTLE_SECONDS)


def start_fan(api, fan_id, pwm):
    """Start the fan at pwm. Returns (epoch seconds, confirmed): the time of
    the Pi's confirmation, or of the send if it never confirms."""
    _, sent_ms = api.actuator(fan_id)
    api.command(fan_id, "SET_SPEED", duty=pwm, seconds=FAN_RUN_SECONDS)
    sent_at = time.time()
    log(f"fan SET_SPEED {_fmt(pwm)}% - waiting for the Pi")

    deadline = time.monotonic() + CONFIRM_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        a, _ = api.actuator(fan_id)
        duty = a.get("lastDutyPercent")
        reported_ms = a.get("statusUpdatedAtMs") or 0

        # Only the Pi's telemetry row has a pulseCount - that is what tells
        # its report apart from the command row, which carries the same duty.
        if (a.get("status") == "ON" and a.get("lastPulseCount") is not None
                and duty is not None and abs(float(duty) - pwm) < 0.01
                and reported_ms >= sent_ms):
            log(f"fan confirmed at {_fmt(pwm)}%")
            return reported_ms / 1000, True

        time.sleep(CONFIRM_POLL_SECONDS)

    log("fan did not confirm - recording the time the command was sent")
    return sent_at, False


def wait_vpd(api, fan_id, pwm, baseline):
    """Watch readings newer than baseline for the first VPD at or above
    TARGET_VPD, and return its datetime.

    Every new reading is checked, not just the newest, so the first one past
    the target is the one recorded even if several arrive between two polls.
    Keeps the fan's deadline ahead meanwhile.
    """
    log(f"waiting for {_vpd(TARGET_VPD)}")

    last_seen = baseline
    last_fan_send = time.monotonic()

    while True:
        if time.monotonic() - last_fan_send >= FAN_RESEND_SECONDS:
            api.command(fan_id, "SET_SPEED", duty=pwm, seconds=FAN_RUN_SECONDS)
            last_fan_send = time.monotonic()
            log(f"fan SET_SPEED {_fmt(pwm)}% re-sent to keep it running")

        new = [r for r in api.readings("VPD")
               if last_seen is None or r[0] > last_seen]

        if new:
            last_seen = new[-1][0]
            log(_vpd(new[-1][1]))

        for when, value in new:
            if value >= TARGET_VPD:
                return when

        time.sleep(READING_POLL_SECONDS)


def stop_fan(api, fan_id):
    """Fan OFF, then wait for the Pi to report it stopped, so the next round's
    misting never overlaps a fan that is still spinning."""
    _, sent_ms = api.actuator(fan_id)
    api.command(fan_id, "OFF")

    deadline = time.monotonic() + CONFIRM_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        a, _ = api.actuator(fan_id)
        if (a.get("status") != "ON" and a.get("lastPulseCount") is not None
                and (a.get("statusUpdatedAtMs") or 0) >= sent_ms):
            log("fan stopped")
            return
        time.sleep(CONFIRM_POLL_SECONDS)

    log("fan Pi did not confirm OFF - carrying on")


def stop_all(api, ids):
    for actuator_id in ids:
        try:
            api.command(actuator_id, "OFF")
        except requests.RequestException as e:
            log(f"could not send OFF to actuator {actuator_id}: {e}")


# ---------------------------------------------------------------------------

def main():
    api = Api(BACKEND)

    progress = Progress(PROGRESS_FILE)
    progress.load()

    fan_id = api.find_actuator(FAN_TYPE)
    mist_id = api.find_actuator(MIST_TYPE)
    log(f"fan actuatorID {fan_id}, mist actuatorID {mist_id}, sensorID {SENSOR_ID}")

    try:
        # Whatever the last run left behind, both start this one OFF. The wait
        # gives each Pi one poll to pick the OFF up before anything is sent ON.
        stop_all(api, (mist_id, fan_id))
        log(f"mist and fan OFF at startup - waiting {STARTUP_OFF_SECONDS}s for the Pis")
        time.sleep(STARTUP_OFF_SECONDS)

        if progress.complete:
            log(f"{progress.path} is already complete - nothing to do")
            return 0

        progress.save()
        log(f"progress: {progress.path}")
        log(f"starting at repeat {progress.repeat} of {REPEATS}, "
            f"{_fmt(progress.current)}% (start {_fmt(progress.start)}%, "
            f"step {_fmt(PWM_STEP)}%), target {_vpd(TARGET_VPD)}")

        baseline = newest_reading_time(api)

        while not progress.complete:
            repeat, pwm = progress.repeat, progress.current
            log(f"=== repeat {repeat} of {REPEATS}, round {_fmt(pwm)}% ===")
            log(f"recorded: {progress.begin_round()}")

            saturate(api, mist_id, baseline)

            # Readings newer than this one were taken after the fan command.
            fan_baseline = newest_reading_time(api)
            fan_epoch, confirmed = start_fan(api, fan_id, pwm)
            line = (f"{datetime.fromtimestamp(fan_epoch).strftime(TIME_FORMAT)} "
                    f"Fan on {_fmt(pwm)}%" + ("" if confirmed else " (unconfirmed)"))
            progress.add_line(line)
            log(f"recorded: {line}")

            reached = wait_vpd(api, fan_id, pwm, fan_baseline)
            elapsed = _duration(reached.timestamp() - fan_epoch)
            line = (f"{reached.astimezone().strftime(TIME_FORMAT)} Reached "
                    f"{_vpd(TARGET_VPD)} {_fmt(pwm)}% ({elapsed})")
            progress.finish_round(line)
            log(f"recorded: {line}")

            # Fan off as soon as the target is reached, then the hold. The
            # hold follows every run, the last one too, so the box always gets
            # it before whatever runs next.
            stop_fan(api, fan_id)
            baseline = newest_reading_time(api)
            log(f"hold {HOLD_SECONDS:g}s - mist and fan off")
            time.sleep(HOLD_SECONDS)

        log("experiment complete")
        return 0

    except KeyboardInterrupt:
        log("interrupted - stopping mist and fan")
        return 130

    except requests.RequestException as e:
        log(f"stopping: {e}")
        return 1

    finally:
        stop_all(api, (mist_id, fan_id))


if __name__ == "__main__":
    sys.exit(main())
