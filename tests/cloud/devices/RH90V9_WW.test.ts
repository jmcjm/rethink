import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT, { buildF025SetCourse, buildF026Start, DOWNLOADABLE_COURSES } from '@/cloud/devices/RH90V9_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RH90V9_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'RH90V9_WW', swVersion: '2.10.123' }

// Real packet captures from an RH90V9_WW dryer (wiki captures_sessions/dryer_capture.log
// and dryer_capture_2026-04-06_eco_2h30m.log).

// 30EB idle heartbeat: Ready, no course, CC echo 0x70 (Economic Dry).
const SAMPLE_IDLE = buf('AA2130EB001901000000000000000000000000000808000000000000007000D5BB')
// 30EC transition, block2: Ready, course 0x07 (Cotton), TR=2h30m staged, dryness=Cupboard, dryLevel=Time save.
const SAMPLE_SELECT_COTTON = buf(
    'AA3C30EC001901000000000000000000000000000808000000000000007000001901021E0000070003030200000000080800000000000000700030BB',
)
// 30EC transition, block2: Drying, course 0x06 (Mixed), TR=TD=1h30m, dryLevel=Energy save, running=1.
const SAMPLE_DRYING_MIXED = buf(
    'AA3C30EC001901011E00000600030102000000000008000000000000000000001902011E011E0600030102000000000009000000010000000000EBBB',
)
// 30EC transition, block2: Drying, course 0x19 (Eco), anti-crease ON (options=0x02).
const SAMPLE_DRYING_ECO_ANTICREASE = buf(
    'AA3C30EC001901021E00001900030102000000000A08000000000000007000001902021E021E190003010200000000020950000001000000700076BB',
)
// 303E sensor bursts: 108°F/108Wh (reading 1) and 127°F/642Wh (reading 5).
const SAMPLE_SENSOR_FIRST = buf('AA0B303E006C006C01A9BB')
const SAMPLE_SENSOR_LATER = buf('AA0B303E007F0282057EBB')
// 3072 cycle marker (start) — carries no HA state, must be ignored without noise.
const SAMPLE_CYCLE_START = buf('AA09307200C9004BBB')

const WRITE_INIT = 'AA0EF0ED1121010000001800B5BB'
const WRITE_POWER_OFF = 'AA09F0260101009EBB'

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
            'power_off',
            'status',
            'course',
            'remaining_time',
            'initial_time',
            'dry_level',
            'dryness_level',
            'anti_crease',
            'delay_active',
            'delay_remaining',
            'temperature',
            'energy',
            'staged_cc',
            'process_state',
            'remote_start',
            'error',
            'error_message',
            'power_on',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.ok((components.status.options as string[]).includes('Drying'))
    })

    test('idle heartbeat (30EB) decodes to Ready with no course', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_IDLE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Ready')
        assert.equal(props.course, 'None')
        assert.equal(props.remaining_time, 0)
        assert.equal(props.staged_cc, 'Economic Dry')
        assert.equal(props.anti_crease, 'OFF')
        assert.equal(props.delay_active, 'OFF')
    })

    test('course selection (30EC) uses the current-state block', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SELECT_COTTON)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Ready')
        assert.equal(props.course, 'Cotton')
        assert.equal(props.remaining_time, 2 * 60 + 30)
        assert.equal(props.initial_time, 0) // TD not filled until drying starts
        assert.equal(props.dry_level, 'Time save')
        assert.equal(props.dryness_level, 'Cupboard')
    })

    test('active drying (30EC)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DRYING_MIXED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Drying')
        assert.equal(props.course, 'Mixed')
        assert.equal(props.remaining_time, 90)
        assert.equal(props.initial_time, 90)
        assert.equal(props.dry_level, 'Energy save')
    })

    test('anti-crease option bit is decoded while drying', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DRYING_ECO_ANTICREASE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Drying')
        assert.equal(props.course, 'Eco')
        assert.equal(props.anti_crease, 'ON')
    })

    test('sensor burst (303E) publishes temperature and cumulative energy', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SENSOR_FIRST)
        let props = ha.devices[DEVICE_ID].properties
        assert.equal(props.temperature, 42.2) // 108°F
        assert.equal(props.energy, 108)

        thinq.emit('data', SAMPLE_SENSOR_LATER)
        props = ha.devices[DEVICE_ID].properties
        assert.equal(props.temperature, 52.8) // 127°F
        assert.equal(props.energy, 642)
    })

    test('a zero temperature reading is not published as -17.8 °C', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SENSOR_LATER)
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 52.8)

        // Outside a cycle the dryer emits 303E bursts with a zero temperature field;
        // the last real reading must survive instead of being overwritten.
        thinq.emit('data', buf('AA0B303E0000000001A5BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 52.8)
        assert.equal(ha.devices[DEVICE_ID].properties.energy, 0)
    })

    // Synthetic 30EB blocks (checksummed) — no error capture exists, layout per
    // anszom's field decode in upstream issue #33: b[0]=state (5=Error), b[6]=error code.
    const SAMPLE_ERROR_DOOR = buf('AA2130EB00190500000000000F00000000000000000000000000000000000046BB')
    const SAMPLE_ERROR_TE1 = buf('AA2130EB00190100000000000100000000000000000000000000000000000054BB')

    test('error code decodes to the error entities and the Error state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_ERROR_DOOR)
        let props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Error')
        assert.equal(props.error, 'ON')
        assert.equal(props.error_message, 'DOOR')

        thinq.emit('data', SAMPLE_ERROR_TE1)
        props = ha.devices[DEVICE_ID].properties
        assert.equal(props.error_message, 'TE1')

        thinq.emit('data', SAMPLE_IDLE)
        props = ha.devices[DEVICE_ID].properties
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'None')
    })

    test('process state and remote-start flag while drying', () => {
        const { ha, thinq } = makeDevice()
        // app-started drying: b[9]=0x02 (Dry phase), b[15] bit 0x01 set (remote start armed)
        thinq.emit('data', SAMPLE_DRYING_MIXED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.process_state, 'Dry')
        assert.equal(props.remote_start, 'ON')
    })

    test('process state reads "-" outside a running cycle', () => {
        const { ha, thinq } = makeDevice()
        // course staged but not started: b[9] already reads 0x02, which is meaningless here
        thinq.emit('data', SAMPLE_SELECT_COTTON)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.process_state, '-')
        assert.equal(props.remote_start, 'OFF')
    })

    test('cycle markers (3072) are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_IDLE)
        const before = { ...ha.devices[DEVICE_ID].properties }
        thinq.emit('data', SAMPLE_CYCLE_START)
        assert.deepEqual(ha.devices[DEVICE_ID].properties, before)
    })

    test('start() sends the F0ED initialisation packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_INIT)
    })

    test('HA power_off button sends F026', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power_off', '')
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_OFF)
    })

    const WRITE_POWER_ON = 'AA08F02A010098BB'

    test('power_on stages the last downloaded course as a wake, then sends F02A', async () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_IDLE) // CC echo 0x70 (Economic Dry)
        thinq.resetRecorder()
        dev.setProperty('power_on', '')
        assert.equal(thinq.outbox.length, 1, 'wake F025 goes out first')
        assert.equal(hex(thinq.outbox[0]), 'AA1DF025031500019600000000000000197000000003000000000042BB')
        await new Promise((resolve) => setTimeout(resolve, 600))
        assert.equal(thinq.outbox.length, 2)
        assert.equal(hex(thinq.outbox[1]), WRITE_POWER_ON)
    })

    test('power_on without a known downloaded course sends F02A alone', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power_on', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_ON)
    })

    test('staging a downloadable course reproduces the app-captured F025 packets', () => {
        // Raw packets the ThinQ app sent, verbatim from
        // captures_sessions/dryer_capture_2026-04-19_economic-dry_2h30m.log
        const expected: Record<string, string> = {
            'Economic Dry': 'AA1DF025031500019600000000000000197000000003000000000042BB',
            'Baby Care': 'AA1DF0250315000382000000000000000265000000000000000000B5BB',
            Deodoration: 'AA1DF025031500032700000000000000016B000000000000000000DFBB',
            'Full Size Load': 'AA1DF02503150003A00000000000000019740000000400000000007DBB',
            // captured 2026-07-27; the app set inner[12] to 0x01 in this one, which the
            // appliance does not validate — replaying it with 0x00 stages the course too
            'Small Load': 'AA1DF0250315000332000000000000000E6C000000000000000000F6BB',
        }
        for (const [name, packet] of Object.entries(expected)) {
            const { thinq, dev } = makeDevice()
            thinq.resetRecorder()
            dev.setProperty('stage_course', name)
            assert.equal(thinq.outbox.length, 1, `${name} sends one packet`)
            assert.equal(hex(thinq.outbox[0]), packet, name)
        }
    })

    test('staging echoes the selection and rejects unknown courses', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('stage_course', 'Economic Dry')
        assert.equal(ha.devices[DEVICE_ID].properties.stage_course, 'Economic Dry')

        thinq.resetRecorder()
        dev.setProperty('stage_course', 'Nonexistent Course')
        assert.equal(thinq.outbox.length, 0)
    })

    test('builder output matches the course table', () => {
        const b = buildF025SetCourse(DOWNLOADABLE_COURSES['Deodoration'])
        assert.equal(b.length, 25)
        assert.equal(b[5], 0x03) // dryLevel
        assert.equal(b[6], 39) // duration
        assert.equal(b[14], 0x01) // base
        assert.equal(b[15], 0x6b) // cc
        assert.equal(b[19], 0x00) // dryness
    })

    test('raw_send forwards a packet with a valid checksum only', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('raw_send', WRITE_POWER_OFF)
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_OFF)

        thinq.resetRecorder()
        dev.setProperty('raw_send', 'AA09F026010100FFBB') // wrong checksum
        dev.setProperty('raw_send', 'F026010100') // no AA..BB envelope
        assert.equal(thinq.outbox.length, 0)
    })

    // Cycle control packets captured live from the ThinQ app on 2026-07-27.
    const APP_START_MIXED = 'AA14F0260603011E00000000000003000000AABB'
    const APP_START_ECO_DELAYED = 'AA14F0261903010000000300000203000000ACBB'
    const APP_RESUME_ECO = 'AA14F026190301000000FF00000201000000A6BB'
    const APP_PAUSE = 'AA09F02404010099BB'

    test('F026 builder reproduces the app-captured cycle commands', () => {
        // start Mixed, energy save, 30 min, no delay, no anti-crease
        assert.equal(hex(buildF026Start({ course: 0x06, dryLevel: 0x01, duration: 30 })), APP_START_MIXED.slice(4, -4))
        // start Eco, energy save, course default duration, 3 h delayed end, anti-crease on
        assert.equal(
            hex(buildF026Start({ course: 0x19, dryLevel: 0x01, delay: 3, options: 0x02 })),
            APP_START_ECO_DELAYED.slice(4, -4),
        )
        // resume the same cycle: delay untouched, resume mode
        assert.equal(
            hex(buildF026Start({ course: 0x19, dryLevel: 0x01, delay: 0xff, options: 0x02, mode: 0x01 })),
            APP_RESUME_ECO.slice(4, -4),
        )
    })

    test('staged cycle: configure in HA, then start', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('stage_program', 'Eco')
        dev.setProperty('stage_dry_level', 'Energy save')
        dev.setProperty('stage_delay', '3')
        dev.setProperty('stage_anti_crease', 'ON')
        assert.equal(thinq.outbox.length, 0, 'staging alone sends nothing')
        assert.equal(ha.devices[DEVICE_ID].properties.stage_program, 'Eco')

        dev.setProperty('start', '')
        assert.equal(hex(thinq.outbox[0]), APP_START_ECO_DELAYED)
    })

    test('pause and resume', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('pause', '')
        assert.equal(hex(thinq.outbox[0]), APP_PAUSE)

        thinq.resetRecorder()
        dev.setProperty('stage_program', 'Eco')
        dev.setProperty('stage_dry_level', 'Energy save')
        dev.setProperty('stage_anti_crease', 'ON')
        dev.setProperty('resume', '')
        assert.equal(hex(thinq.outbox[0]), APP_RESUME_ECO, 'resume keeps the delay untouched')
    })

    test('resume falls back to the running configuration reported by the dryer', () => {
        const { thinq, dev } = makeDevice()
        // the appliance reports Eco / energy save / anti-crease on
        thinq.emit('data', SAMPLE_DRYING_ECO_ANTICREASE)
        thinq.resetRecorder()
        dev.setProperty('resume', '')
        assert.equal(hex(thinq.outbox[0]), APP_RESUME_ECO)
    })

    test('start without any known course emits no packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.equal(thinq.outbox.length, 0)
    })

    test('HA write to unknown property emits no packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('does-not-exist', 'whatever')
        assert.equal(thinq.outbox.length, 0)
    })
})
