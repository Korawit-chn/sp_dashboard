#!/usr/bin/env python3
"""experiment_manager.py - run queued experiments one after another.

    python experiment_manager.py

THE QUEUE

experiment_queue.txt, next to this script, one experiment per line, run top
to bottom. It is created with instructions on the first run. Edit it any
time - it is re-read before each experiment starts, so lines added, removed or
reordered while one is running take effect when it finishes.

    vpd_time_experiment
    humidity_time_experiment
    vpd_time_experiment

A finished line is rewritten in place so the file doubles as a history:

    done 2026-11-09 14:02:11 vpd_time_experiment -> results/vpd_time_experiment_2026-11-09_140211.txt

Lines starting with # are ignored, and so are "done" and "skipped" lines. A
name with no matching script is marked "skipped" and the queue carries on.
When nothing is left to run the manager exits.

RESULTS

Every experiment keeps its record in a .txt named after it, ends that file
with an "experiment end" line once every round is done, and refuses to run
again after that. So when an experiment finishes, the manager moves its .txt
into results/ with the date and time in the name, and the same experiment can
be queued again and start fresh. A finished .txt already there when an
experiment is about to start (from a run by hand) is moved into results/
first, for the same reason. An unfinished one is left alone, so the
experiment resumes it.

FAILURES AND CTRL-C

Each experiment runs as its own process, exactly as if started by hand.

- Exit code 0 AND its .txt ends with "experiment end": done - archive, mark
  the line, next experiment. Exit code 0 without that line counts as a
  failure, below - the experiment stopped early without saying why.
- Ctrl-C: the experiment turns the mist and fan off and exits; the manager
  waits for that, then stops. Its line stays queued, so running the manager
  again resumes it.
- Anything else (backend down, actuator missing ...): wait RETRY_SECONDS and
  run it again - it resumes from its .txt. After MAX_ATTEMPTS in a row the
  manager stops and leaves the line queued.

If an experiment process is still running CHILD_EXIT_SECONDS after a Ctrl-C,
it is killed and the manager sends OFF to the mist and fan itself.
"""

import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
QUEUE_FILE = BASE_DIR / "experiment_queue.txt"
RESULTS_DIR = BASE_DIR / "results"

RETRY_SECONDS = 300         # wait after a failed experiment before re-running it
MAX_ATTEMPTS = 3            # failed runs in a row before the manager gives up
CHILD_EXIT_SECONDS = 60     # how long a Ctrl-C'd experiment gets to stop cleanly
WAIT_SLICE_SECONDS = 1

# Only for the emergency OFF after an experiment had to be killed - the same
# devices the experiments use.
BACKEND = "http://localhost:5000"
LOCATION = "Inside Box 1"
FAN_TYPE = "FAN"
MIST_TYPE = "Mist Maker"
REQUEST_TIMEOUT = 5

END_LINE = "experiment end"
TIME_FORMAT = "%Y-%m-%d %H:%M:%S"
FINISHED_PREFIXES = ("done ", "skipped ")

QUEUE_TEMPLATE = """\
# Experiment queue - one experiment per line, run top to bottom.
# Edit any time: the manager re-reads this file before each experiment.
# Finished lines are rewritten as "done ..."; lines starting with # are ignored.
#
# Experiments in this folder:
{names}
"""


def log(message):
    print(f"[{datetime.now().strftime(TIME_FORMAT)}] [manager] {message}", flush=True)


def available():
    return sorted(p.stem for p in BASE_DIR.glob("*_experiment.py"))


# ---------------------------------------------------------------------------
# Queue file
# ---------------------------------------------------------------------------

def _clean(line):
    name = line.strip()
    return name[:-3] if name.endswith(".py") else name


def _pending(line):
    text = line.strip()
    return bool(text) and not text.startswith("#") and not text.startswith(FINISHED_PREFIXES)


def next_in_queue():
    """The first line still to run, as written, or None."""
    for line in QUEUE_FILE.read_text(encoding="utf-8").splitlines():
        if _pending(line):
            return line.strip()
    return None


def mark(raw, new_text):
    """Rewrite the first queued line that reads `raw` as `new_text`.

    The file is re-read here, not reused from when the experiment started, so
    edits made while it ran are kept. A line removed meanwhile is left gone.
    """
    lines = QUEUE_FILE.read_text(encoding="utf-8").splitlines()

    for i, line in enumerate(lines):
        if _pending(line) and line.strip() == raw:
            lines[i] = new_text
            break
    else:
        log(f"{raw!r} is no longer in the queue - not marked")
        return

    tmp = QUEUE_FILE.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tmp.replace(QUEUE_FILE)


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

def _lines(record):
    if not record.exists():
        return []
    return [l.strip() for l in record.read_text(encoding="utf-8").splitlines() if l.strip()]


def has_end(record):
    """True if the experiment wrote its "experiment end" line."""
    lines = _lines(record)
    return bool(lines) and lines[-1].lower() == END_LINE


def finished_before(record):
    """A .txt from an earlier, finished run. One written before experiments
    had the "experiment end" line is recognised by its "complete" header."""
    lines = _lines(record)
    return has_end(record) or (bool(lines) and "complete" in lines[0].lower())


def archive(name):
    """Move <name>.txt into results/ and return its new path relative to here."""
    record = BASE_DIR / f"{name}.txt"
    RESULTS_DIR.mkdir(exist_ok=True)

    stamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    target = RESULTS_DIR / f"{name}_{stamp}.txt"
    n = 2
    while target.exists():
        target = RESULTS_DIR / f"{name}_{stamp}_{n}.txt"
        n += 1

    record.replace(target)
    return target.relative_to(BASE_DIR).as_posix()


# ---------------------------------------------------------------------------
# Running one experiment
# ---------------------------------------------------------------------------

def safety_off():
    """Mist and fan OFF from here, for when an experiment had to be killed."""
    try:
        import requests
        r = requests.get(f"{BACKEND}/api/actuators", timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        ids = [a["actuatorID"] for a in r.json()["actuators"]
               if (a.get("typeName") or "").lower() in (FAN_TYPE.lower(), MIST_TYPE.lower())
               and (a.get("locationName") or "").lower() == LOCATION.lower()]

        for actuator_id in ids:
            requests.post(f"{BACKEND}/api/actuatorCommand", timeout=REQUEST_TIMEOUT,
                          json={"actuatorID": actuator_id, "action": "OFF",
                                "triggerSource": "AUTOMATION"}).raise_for_status()

        log(f"sent OFF to actuators {ids}" if ids else
            f"no mist or fan found at {LOCATION!r} - check them by hand")
    except Exception as e:
        log(f"could not send OFF to the mist and fan: {e} - check them by hand")


def run(name):
    """Run one experiment to the end. Returns (exit code, interrupted)."""
    proc = subprocess.Popen([sys.executable, str(BASE_DIR / f"{name}.py")], cwd=BASE_DIR)
    interrupted = False
    deadline = None

    # Ctrl-C reaches the experiment too - it shares this console - and it
    # turns the mist and fan off before exiting. Keep waiting for that rather
    # than killing it mid-cleanup, which is what subprocess.run() would do.
    #
    # Waited for in short slices: on Windows a wait with no timeout cannot be
    # interrupted, so Ctrl-C would not reach this loop until the experiment
    # had already exited - and a stuck one would never be killed.
    while True:
        try:
            code = proc.wait(timeout=WAIT_SLICE_SECONDS)
            return code, interrupted

        except subprocess.TimeoutExpired:
            if deadline is not None and time.monotonic() >= deadline:
                log(f"{name} did not stop within {CHILD_EXIT_SECONDS}s - killing it")
                proc.kill()
                proc.wait()
                safety_off()
                return proc.returncode, True

        except KeyboardInterrupt:
            if not interrupted:
                interrupted = True
                deadline = time.monotonic() + CHILD_EXIT_SECONDS
                log(f"Ctrl-C - waiting for {name} to turn the mist and fan off")


# ---------------------------------------------------------------------------

def main():
    if not QUEUE_FILE.exists():
        QUEUE_FILE.write_text(QUEUE_TEMPLATE.format(
            names="\n".join(f"#   {n}" for n in available())), encoding="utf-8")
        log(f"created {QUEUE_FILE.name} - add experiments to it, one per line, "
            f"and run this again")
        return 0

    attempts = 0
    last = None

    try:
        while True:
            raw = next_in_queue()
            if raw is None:
                log("queue finished")
                return 0

            # A failed experiment that was moved down the queue during the
            # retry wait does not pass its failures on to the new first line.
            if raw != last:
                attempts = 0
            last = raw

            name = _clean(raw)
            if name not in available():
                log(f"no experiment called {name!r} - skipping it")
                mark(raw, f"skipped {datetime.now().strftime(TIME_FORMAT)} {raw} "
                          f"- no such experiment")
                continue

            record = BASE_DIR / f"{name}.txt"
            if attempts == 0 and finished_before(record):
                log(f"{record.name} is from an earlier complete run - "
                    f"moved to {archive(name)}")

            attempts += 1
            log(f"=== starting {name} (attempt {attempts} of {MAX_ATTEMPTS}) ===")
            code, interrupted = run(name)

            # Checked before the Ctrl-C: an experiment that finished just as
            # Ctrl-C landed is still finished.
            if code == 0 and has_end(record):
                saved = archive(name)
                mark(raw, f"done {datetime.now().strftime(TIME_FORMAT)} {name} -> {saved}")
                log(f"{name} done - results in {saved}")
                last = None
                if interrupted:
                    log("stopped")
                    return 130
                continue

            # 130 is the experiment's own Ctrl-C exit, in case only it saw one.
            if interrupted or code == 130:
                log(f"stopped - {name} stays queued and resumes next time")
                return 130

            if code == 0:
                log(f"{name} exited without writing '{END_LINE}' to {record.name} "
                    f"- treating it as a failure")

            if attempts >= MAX_ATTEMPTS:
                log(f"{name} failed {attempts} times in a row (exit code {code}) - "
                    f"stopping the queue. Fix the problem and run the manager again; "
                    f"{name} resumes from its .txt.")
                return 1

            log(f"{name} failed (exit code {code}) - retrying in {RETRY_SECONDS}s")
            time.sleep(RETRY_SECONDS)

    except KeyboardInterrupt:
        # Between experiments, so nothing is running and nothing needs turning off.
        log("stopped")
        return 130


if __name__ == "__main__":
    sys.exit(main())
