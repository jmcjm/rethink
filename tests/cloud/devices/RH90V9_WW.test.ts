import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT, { buildF025SetCourse, DOWNLOADABLE_COURSES } from '@/cloud/devices/RH90V9_WW'
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

    test('staging a downloadable course reproduces the app-captured F025 packets', () => {
        // Raw packets the ThinQ app sent, verbatim from
        // captures_sessions/dryer_capture_2026-04-19_economic-dry_2h30m.log
        const expected: Record<string, string> = {
            'Economic Dry': 'AA1DF025031500019600000000000000197000000003000000000042BB',
            'Baby Care': 'AA1DF0250315000382000000000000000265000000000000000000B5BB',
            Deodoration: 'AA1DF025031500032700000000000000016B000000000000000000DFBB',
            'Full Size Load': 'AA1DF02503150003A00000000000000019740000000400000000007DBB',
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

    test('HA write to unknown property emits no packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('does-not-exist', 'whatever')
        assert.equal(thinq.outbox.length, 0)
    })
})
