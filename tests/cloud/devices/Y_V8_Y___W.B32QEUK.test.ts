import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT, { buildF025Set, buildF026Start } from '@/cloud/devices/Y_V8_Y___W.B32QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'Y_V8_Y___W.B32QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: 'Y_V8_Y___W.B32QEUK', swVersion: '2.11.207' }

// Real packet captures from two Y_V8_Y___W.B32QEUK washers:
// - issue #11 (lg-washer-rethink-cloud-14-min-prog.txt), and
// - wiki captures_sessions/ from the EU unit the course map was verified on.
// Frame: AA <unused> 20 0A 00 39 ... (53-byte inner block, total 57 bytes).

const SAMPLE_INITIAL = buf(
    'AAFF200A0039000381000100EB0027000001032603260000000000000000000000000003000011007100000000000000000000000000974EBB',
)
const SAMPLE_RUNNING_DOOR_LOCKED = buf(
    'AAFF200A0039000398000100EB0027000006000E000E0C0003020201000000014220000101001100710000010000000000000000000056D9BB',
)
const SAMPLE_RINSING = buf(
    'AAFF200A00390003C6000100EB0027000007000B000E0C000302000100000001420000010600110071000001000022000000000000004970BB',
)
const SAMPLE_SPINNING = buf(
    'AAFF200A0039000435000100EB00270000080005000E0C00000200000000000042000001070011007100000100002600000000000000AF09BB',
)
const SAMPLE_END = buf(
    'AAFF200A0039000478000100EB002700000A0000000E0C00000000000000000040000001080011007100000100002900000000000000C901BB',
)
const SAMPLE_POWER_OFF = buf(
    'AAFF200A0039000487000100EB00270000000000000E0C000000000000000000000000000A0011007100000100002900000000000000CB19BB',
)
// EU unit, AI Wash staged at 20°C / 1200 rpm during load detection
// (captures_sessions/washer_capture_2026-04-06_ai-wash_20C_1200rpm.log)
const SAMPLE_AI_WASH_DETECTING = buf(
    'AAFF200A003900B0CC00010AE20027000004003800383A000309020100000000022100010100030047000004000052000000000000007AC5BB',
)
// 65-byte model info packet
const SAMPLE_MODEL_INFO = buf(
    'AAFF200A004100ACF2000201030006100D0102100101050025595F56385F595F5F5F572E4233325145554B00000102C5B827EB06070000000000000000002540BB',
)
// 96-byte staged-echo packet, CC=0x47 (Baby Care) staged
const SAMPLE_STAGED_ECHO = buf(
    'AAFF200A006000ACF4000100EC004E0000000000000000000000000000000000000000000A000000000000000000D10000000000C0000000010000000000000000000000000000000000000000030047000000000000000000000000004C47BB',
)
// 138-byte diagnostic packet (lifetime cycle counter = 203)
const SAMPLE_DIAGNOSTIC = buf(
    'AAFF200A008A00AD4E00020102004F0D0102650003000306000500340038000001251E2022241419141313F4FAF2F3F30000000000000000000000000000000000000000000000000000000000000000000000000132000000000000000001050025595F56385F595F5F5F572E4233325145554B00000102CBB827EB06070000000000000000007B0BBB',
)

// Expected outgoing packets emitted by the device file.
const WRITE_INIT = 'AA0EF0ED1121010000001800B5BB'
const WRITE_POWER_ON = 'AA08F02A010098BB'
const WRITE_POWER_OFF = 'AA09F0240101009CBB'
const WRITE_PAUSE = 'AA09F02404010099BB'
const WRITE_START = 'AA09F02405010098BB'
// session-verified start of Mixed at 1200 rpm / 20°C (wiki Appliance:Y_V8_Y___W.B32QEUK.md)
const WRITE_F026_MIXED = 'AA16F02607030902010000000000000300000000BABB'
const WRITE_F025_MIXED = 'AA18F02503150703090201000000000000000000000050BB'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes expected components on construction', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        for (const c of [
            'power',
            'start',
            'pause',
            'status',
            'error',
            'error_message',
            'course',
            'temp',
            'spin',
            'cycles',
            'remote_start',
            'door_lock',
            'child_lock',
            'energy',
            'initial_time',
            'remaining_time',
            'turbo_wash',
            'steam',
            'aidd_led',
            'stage_program',
            'stage_spin',
            'stage_temp',
            'stage_rinse',
            'stage_delay',
            'set_program',
            'start_program',
            'raw_send',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.ok((components.status.options as string[]).includes('Washing'))
        assert.ok((components.stage_program.options as string[]).includes('AI Wash'))
    })

    test('initial state push decodes status, time and cycles', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Ready')
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
        assert.equal(props.remaining_time, 3 * 60 + 38) // 03:38
        assert.equal(props.initial_time, 3 * 60 + 38)
        assert.equal(props.cycles, 17)
        assert.equal(props.energy, 0)
        assert.equal(props.remote_start, 'OFF')
        assert.equal(props.door_lock, 'ON') // unlocked, the inverted convention
        assert.equal(props.child_lock, 'OFF')
    })

    test('running state with door locked + remote_start active', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING_DOOR_LOCKED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Washing') // 0x06
        // 0x0C is the Bedding dial slot on the EU unit the course map was verified on
        // (the issue #11 unit showed 0x0C for its 14-minute program — the id space
        // appears to be region-dependent)
        assert.equal(props.course, 'Bedding')
        assert.equal(props.spin, 400) // spin byte is inner[23], 0x02=400 rpm
        assert.equal(props.temp, '20') // temp byte is inner[24], 0x02=20°C
        assert.equal(props.turbo_wash, 'ON') // flags[29]=0x01
        assert.equal(props.initial_time, 14)
        assert.equal(props.remaining_time, 14) // 00:14
        // flags[30]=0x42 = 0x40 lock bit set + 0x02 remote_start bit set
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'OFF')
    })

    test('rinsing state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RINSING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Rinsing') // 0x07
        assert.equal(props.remaining_time, 11)
    })

    test('spinning state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SPINNING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Spinning') // 0x08
    })

    test('end state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_END)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'End') // 0x0A
        assert.equal(props.remaining_time, 0)
        assert.equal(props.energy, 41)
        assert.equal(props.door_lock, 'OFF') // still locked at the end-of-cycle reading
        assert.equal(props.remote_start, 'OFF')
    })

    test('power-off transition (status=0)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_POWER_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
    })

    test('EU capture: AI Wash staged at 20°C / 1200 rpm', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_AI_WASH_DETECTING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Measuring') // 0x04 load detection
        assert.equal(props.course, 'AI Wash') // 0x3A
        assert.equal(props.spin, 1200) // 0x09
        assert.equal(props.temp, '20') // 0x02
        assert.equal(props.energy, 82) // per-cycle Wh at inner[44], matches the wiki cycle log
        assert.equal(props.aidd_led, 'ON') // flags[31] bit 0x01, auto-set by AI Wash
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.downloaded_course, 'Baby Care') // CC echo 0x47 at inner[38]
        assert.equal(props.cycles, 3)
    })

    test('model info packet (65-byte) publishes the model name', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_MODEL_INFO)
        assert.equal(ha.devices[DEVICE_ID].properties.model_name, 'Y_V8_Y___W.B32QEUK')
    })

    test('staged-echo packet (96-byte) exposes the staged CC', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STAGED_ECHO)
        assert.equal(ha.devices[DEVICE_ID].properties.staged_cc, 'Baby Care') // inner[77]=0x47
    })

    test('diagnostic packet (138-byte) publishes lifetime counters', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DIAGNOSTIC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.cycles_lifetime, 203) // inner[118], matches the wiki observation
        assert.equal(props.sensor_temps_raw, '251e2022241419141313')
    })

    test('frames not matching the AA..BB envelope are ignored', () => {
        const { ha, thinq } = makeDevice()
        const before = ha.devices[DEVICE_ID].properties.power
        thinq.emit('data', buf('001122'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, before)
    })

    test('frames with wrong inner length are ignored', () => {
        const { ha, thinq } = makeDevice()
        const before = ha.devices[DEVICE_ID].properties.power
        // valid AA..BB envelope but inner is too short to be a 53-byte status
        thinq.emit('data', buf('AA08200A01020304BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, before)
    })

    test('start() sends the F0ED initialisation packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_INIT)
    })

    test('HA write power=ON', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'ON')
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_ON)
    })

    test('HA write power=OFF', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'OFF')
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_OFF)
    })

    test('HA write pause button', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('pause', '')
        assert.equal(hex(thinq.outbox[0]), WRITE_PAUSE)
    })

    test('HA write start button', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.equal(hex(thinq.outbox[0]), WRITE_START)
    })

    test('staged program flow: select values, then start (F026)', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('stage_program', 'Mixed')
        dev.setProperty('stage_spin', '1200')
        dev.setProperty('stage_temp', '20')
        dev.setProperty('stage_rinse', 'Normal')
        assert.equal(thinq.outbox.length, 0) // staging alone must not send anything
        // staged selections are echoed back so the HA UI reflects them
        assert.equal(ha.devices[DEVICE_ID].properties.stage_program, 'Mixed')

        dev.setProperty('start_program', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_F026_MIXED)
    })

    test('staged program flow: set without starting (F025)', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('stage_program', 'Mixed')
        dev.setProperty('stage_spin', '1200')
        dev.setProperty('stage_temp', '20')
        dev.setProperty('set_program', '')
        assert.equal(hex(thinq.outbox[0]), WRITE_F025_MIXED)
    })

    test('set/start buttons do nothing when no program is staged', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('set_program', '')
        dev.setProperty('start_program', '')
        assert.equal(thinq.outbox.length, 0)
    })

    test('raw_send forwards a packet with a valid checksum only', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('raw_send', WRITE_POWER_OFF)
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_OFF)

        thinq.resetRecorder()
        dev.setProperty('raw_send', 'AA09F024010100FFBB') // wrong checksum
        dev.setProperty('raw_send', 'F024010100') // no AA..BB envelope
        assert.equal(thinq.outbox.length, 0)
    })

    test('command builders reproduce app-captured packets', () => {
        // Expected values are the raw F025 packets the ThinQ app sent, taken verbatim from
        // captures_sessions/program_mapping_2026_04_15.log (the wiki transcriptions of these
        // examples have byte-shift typos — the captures are authoritative).

        // set Small Load (base 0x0C, CC=0x49, spin=400, temp=20, turboWash, secondary=0x02)
        assert.equal(
            hex(
                buildF025Set({
                    program_id: 0x0c,
                    spin: 0x02,
                    temp: 0x02,
                    rinse: 0x01,
                    flags_byte: 0x01,
                    secondary: 0x02,
                    cc: 0x49,
                }),
            ),
            'F02503150C030202010000000001020049000000',
        )
        // set Cold Wash (base 0x01, CC=0x4D, spin=max, temp=cold, secondary=0x02)
        assert.equal(
            hex(buildF025Set({ program_id: 0x01, spin: 0xff, temp: 0x01, rinse: 0x01, secondary: 0x02, cc: 0x4d })),
            'F02503150103FF0101000000000002004D000000',
        )
        // start Duvet with delayed end in 4h — wiki example (inner only, magic byte at [13])
        assert.equal(
            hex(buildF026Start({ program_id: 0x05, spin: 0x03, temp: 0x02, rinse: 0x01, delay: 4 })),
            'F02605030302010000040000000300000000',
        )
    })

    test('HA write to unknown property emits no packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('does-not-exist', 'whatever')
        assert.equal(thinq.outbox.length, 0)
    })
})
