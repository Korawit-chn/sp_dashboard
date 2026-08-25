/**
 * API-level checks for the time-sync work (timeSyncPlan.md §10).
 *
 * Covers what can be checked without hardware. The rest of §10 - boot
 * recovery, power-cycle logging, the alignment measurement - needs real Pis.
 *
 *   node verify_timesync.js [baseUrl]
 *
 * Default baseUrl is http://127.0.0.1:<PORT from .env>.
 * Run migration_timesync.sql first, as root.
 */

require('dotenv').config()

const BASE = process.argv[2] || `http://127.0.0.1:${process.env.PORT || 5000}`

let failures = 0

function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`)
  if (!ok) failures++
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`)
  return { status: res.status, body: await res.json() }
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, body: await res.json() }
}

async function main() {
  console.log(`Checking ${BASE}\n`)

  // -- /api/time --------------------------------------------------------
  // The Pis measure round-trip delay against this route, so latency here
  // becomes clock error on the sensors.
  const t0 = Date.now()
  const time = await get('/api/time')
  const rtt = Date.now() - t0

  check('/api/time returns epochMs', typeof time.body.epochMs === 'number')
  check('/api/time agrees with this machine', Math.abs(time.body.epochMs - Date.now()) < 2000)
  check('/api/time round trip under 100ms (the Pi rejects anything slower)',
        rtt < 100, { rtt })

  // Repeat under no load to see the spread the Pis will be working with.
  const rtts = []
  for (let i = 0; i < 10; i++) {
    const s = Date.now()
    await get('/api/time')
    rtts.push(Date.now() - s)
  }
  rtts.sort((a, b) => a - b)
  console.log(`     RTT min=${rtts[0]}ms median=${rtts[5]}ms max=${rtts[9]}ms ` +
              `(the Pi keeps the minimum-RTT sample)`)

  // -- /api/schedule ----------------------------------------------------
  const before = await get('/api/schedule')
  check('/api/schedule readable', before.status === 200, before.body)

  if (before.status !== 200) {
    console.log('\nSchedule table missing - run migration_timesync.sql as root first.')
    process.exit(1)
  }

  const original = before.body.periodSeconds

  const tooFast = await post('/api/schedule', { periodSeconds: 1 })
  check('rejects a period below the DHT22 2s limit', tooFast.status === 400)

  const applied = await post('/api/schedule', { periodSeconds: 10, leadSeconds: 30 })
  check('accepts a valid period', applied.status === 201, applied.body)

  if (applied.status === 201) {
    const eff = applied.body.effectiveFromMs
    check('effectiveFrom is a multiple of the new period (all Pis land on one grid)',
          eff % (10 * 1000) === 0, { eff })
    check('effectiveFrom is at least leadSeconds away (every Pi can poll first)',
          eff - applied.body.serverEpochMs >= 25000,
          { leadMs: eff - applied.body.serverEpochMs })

    const after = await get('/api/schedule')
    check('newest schedule is served to the Pis', after.body.periodSeconds === 10)
  }

  // restore
  await post('/api/schedule', { periodSeconds: original, leadSeconds: 30 })
  console.log(`     restored period to ${original}s`)

  // -- devices ----------------------------------------------------------
  const devices = await get('/api/devices')
  check('/api/devices readable', devices.status === 200, devices.body.message)
  check('/api/devices reports the startup grace window',
        typeof devices.body.inStartupGrace === 'boolean')
  check('/api/devices is keyed on deviceID, not sensorID',
        !devices.body.devices?.length ||
        devices.body.devices[0].deviceID !== undefined)

  if (devices.body.devices) {
    const sensorCount = devices.body.devices
      .reduce((n, d) => n + (d.sensors?.length || 0), 0)
    console.log(`     ${devices.body.devices.length} device(s) carrying ` +
                `${sensorCount} sensor(s), ` +
                `${devices.body.devices.filter(d => d.isOnline).length} online`)
  }

  const events = await get('/api/deviceEvents?limit=5')
  check('/api/deviceEvents readable', events.status === 200)
  check('SERVER_START was logged at boot (this is what suppresses spurious OFFLINE)',
        Array.isArray(events.body) &&
        events.body.some(e => e.eventType === 'SERVER_START'),
        Array.isArray(events.body) ? events.body.map(e => e.eventType) : events.body)
  check('SERVER_START carries no deviceID (it is about the backend)',
        !Array.isArray(events.body) ||
        events.body.filter(e => e.eventType === 'SERVER_START')
                   .every(e => e.deviceID === null))

  // -- heartbeat / batch need a real sensorID ---------------------------
  const sensors = await get('/api/sensors')
  const sensorID = Array.isArray(sensors.body) && sensors.body.length
    ? sensors.body[0].sensorID
    : null

  if (sensorID == null) {
    console.log('\n     no registered sensors - skipping heartbeat and batch checks')
  } else {
    const hb = await post('/api/heartbeat', {
      sensorID,
      bootID: '00000000-0000-4000-8000-00000000test',
      uptimeSeconds: 120,
      offsetMs: 3.5,
      rttMs: 4,
      detail: 'verify_timesync.js'
    })
    check('/api/heartbeat accepted', hb.status === 200, hb.body)
    check('heartbeat resolved the sensor to a device', hb.body.tracked === true)

    const after = await get('/api/devices')
    const dev = after.body.devices.find(d =>
      (d.sensors || []).some(s => s.sensorID === sensorID))
    check('heartbeat marks the device online', dev && dev.isOnline)
    check('heartbeat records a boot time from uptime',
          dev && dev.bootAtMs != null &&
          Math.abs(Date.now() - dev.bootAtMs - 120000) < 5000)
    check('heartbeat records clock health for the device',
          dev && dev.lastSyncRttMs != null, dev && dev.lastSyncRttMs)

    // Distinct ticks: v3 puts UNIQUE (sensorID, datetime) on SensorLog, so two
    // rows sharing a timestamp would be one insert plus one absorbed duplicate.
    const t = Date.now()
    const sqlTime = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
    const tickA = sqlTime(t - 10000)
    const tickB = sqlTime(t - 5000)

    const batch = await post('/api/sensorLogBatch', {
      rows: [
        { sensorID, time: tickA, temperature: 25.5, humidity: 60, VPD: 1.3,
          timeConfidence: 'SYNCED', readLatencyMs: 900, tickJitterMs: 4,
          queueDelayMs: 12, syncRttMs: 4 },
        { sensorID, time: tickB, temperature: 25.6, humidity: 61, VPD: 1.31,
          timeConfidence: 'CORRECTED', readLatencyMs: 880, tickJitterMs: 2,
          queueDelayMs: 380000, syncRttMs: 6 }
      ]
    })
    check('/api/sensorLogBatch inserts a multi-row batch',
          batch.status === 200 && batch.body.inserted === 2, batch.body)

    // The trap this guards: the Pi's flush loop only advances a row on a 200
    // and stops on anything else, so a duplicate that threw would wedge that
    // Pi's whole queue. Re-sending the SAME rows must still return 200.
    const replay = await post('/api/sensorLogBatch', {
      rows: [
        { sensorID, time: tickA, temperature: 25.5, humidity: 60, VPD: 1.3,
          timeConfidence: 'SYNCED', readLatencyMs: 900, tickJitterMs: 4,
          queueDelayMs: 12, syncRttMs: 4 }
      ]
    })
    check('re-sending an already-stored row returns 200, not 500',
          replay.status === 200, replay.body)
    check('the duplicate was absorbed rather than stored twice',
          replay.body.stored === 0, { stored: replay.body.stored })

    const bad = await post('/api/sensorLogBatch', { rows: [{ sensorID }] })
    check('batch rejects rows missing required fields', bad.status === 400)

    const logs = await get('/api/logs?hours=1&instrumentation=1')
    const mine = Array.isArray(logs.body)
      ? logs.body.filter(r => r.readLatencyMs != null)
      : []
    check('instrumentation columns come back on /api/logs', mine.length >= 2, mine.length)

    if (mine.length) {
      const e2e = mine[mine.length - 1].endToEndUs
      check('end-to-end delay (recordedAt - datetime) is measurable',
            typeof e2e === 'number', { endToEndMs: e2e / 1000 })
      console.log('     NOTE: resolution is microseconds, accuracy is bounded by')
      console.log('           sync quality - realistically +/-1-5 ms on a LAN.')
    }

    const replayed = mine.filter(r => r.queueDelayMs > 60000).length
    check('cache replays are separable from live inserts by queueDelayMs',
          replayed >= 1, { replayed })
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : failures + ' check(s) failed.'}`)
  console.log('Still needs hardware: alignment coverage, boot recovery,')
  console.log('power-cycle logging, and the server-downtime pitfall (§10.3, .6, .7).')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('verification error:', err.message)
  process.exit(1)
})
