import { describe, it, expect } from 'vitest'
import {
    parse53Byte, parse65Byte, parse96Byte, parse134Byte, parse138Byte,
    decodeFlagsByte1, decodeFlagsByte2, decodeAiddLed, CC_NAMES, CC_BY_NAME,
    buildF025Set, buildF026Start, buildF02APowerToggle, buildF024TurnOff,
} from './Y_V8_Y___W.B32QEUK.js'
import {
    CMD_F025_COLD_WASH,
    CMD_F025_MIXED_1200_20,
    CMD_F025_MIXED_CC_FF,
    CMD_F026_MIXED_START,
    CMD_F026_DUVET_START,
    CMD_F026_AI_WASH_START,
} from './Y_V8_Y___W.B32QEUK.fixtures.js'

describe('parse53Byte', () => {
    it('parses a constructed INITIAL status packet', () => {
        const buf = Buffer.alloc(53)
        buf[0] = 0x20
        buf[1] = 0x0a
        buf[3] = 0x39
        buf[10] = 0xEC
        buf[15] = 0x01
        buf[16] = 0x00
        buf[17] = 0x00
        buf[18] = 0x01
        buf[19] = 0x05
        buf[20] = 0x07
        buf[21] = 0x00
        buf[23] = 0x09
        buf[24] = 0x02
        buf[30] = 0x00
        buf[36] = 0x06
        buf[44] = 0x00

        const parsed = parse53Byte(buf)
        expect(parsed).not.toBeNull()
        expect(parsed!.state).toBe('initial')
        expect(parsed!.remaining_time).toBe(0)
        expect(parsed!.initial_time).toBe(65)
        expect(parsed!.course).toBe('Mixed')
        expect(parsed!.error).toBe('ok')
        expect(parsed!.spin).toBe(1200)
        expect(parsed!.temperature).toBe('20')
        expect(parsed!.cycles).toBe(6)
        expect(parsed!.energy).toBe(0)
        expect(parsed!.door_lock).toBe(true)
        expect(parsed!.turbo_wash).toBe(false)
        expect(parsed!.steam).toBe(false)
        expect(parsed!.child_lock).toBe(false)
        expect(parsed!.aidd_led).toBe(false)
    })

    it('returns null when discriminator byte[3] does not match 0x39', () => {
        const buf = Buffer.alloc(53)
        buf[0] = 0x20
        buf[1] = 0x0a
        buf[3] = 0x60
        expect(parse53Byte(buf)).toBeNull()
    })

    it('returns null when buffer shorter than 53 bytes', () => {
        const buf = Buffer.alloc(40)
        buf[0] = 0x20
        buf[1] = 0x0a
        buf[3] = 0x39
        expect(parse53Byte(buf)).toBeNull()
    })

    it('returns null when byte[0] is not 0x20', () => {
        const buf = Buffer.alloc(53)
        buf[0] = 0xFF
        buf[1] = 0x0a
        buf[3] = 0x39
        expect(parse53Byte(buf)).toBeNull()
    })

    it('maps spin=0xFF to "max"', () => {
        const buf = Buffer.alloc(53)
        buf[0] = 0x20
        buf[1] = 0x0a
        buf[3] = 0x39
        buf[15] = 0x01
        buf[20] = 0x07
        buf[23] = 0xFF
        buf[24] = 0x02
        const parsed = parse53Byte(buf)
        expect(parsed!.spin).toBe('max')
    })
})

describe('parse65Byte', () => {
    it('parses a constructed 65-byte short status packet', () => {
        // Minimal hand-built inner buffer (post-strip, 61 bytes)
        const buf = Buffer.alloc(61)
        buf[0] = 0x20
        buf[1] = 0x0a
        buf[3] = 0x41
        buf[7] = 0xed  // counter
        buf[18] = 0x01 // param_flag
        // model name ASCII at [23..40]
        Buffer.from('Y_V8_Y___W.B32QEUK', 'ascii').copy(buf, 23)

        const parsed = parse65Byte(buf)
        expect(parsed).not.toBeNull()
        expect(parsed!.packet_type).toBe('65_byte_short')
        expect(parsed!.counter).toBe(0xed)
        expect(parsed!.model_name).toBe('Y_V8_Y___W.B32QEUK')
        expect(parsed!.param_flag).toBe(0x01)
    })

    it('returns null when discriminator byte[3] does not match 0x41', () => {
        const buf = Buffer.alloc(61)
        buf[0] = 0x20
        buf[1] = 0x0a
        buf[3] = 0x39  // 53-byte signature
        expect(parse65Byte(buf)).toBeNull()
    })

    it('returns null when buffer shorter than 61 bytes', () => {
        const buf = Buffer.alloc(40)
        buf[0] = 0x20
        buf[1] = 0x0a
        buf[3] = 0x41
        expect(parse65Byte(buf)).toBeNull()
    })
})

describe('parse96Byte', () => {
    it('extracts active program parameters from staged block at inner[62..67] + cc at inner[77]', () => {
        const buf = Buffer.alloc(92)
        buf[0] = 0x20
        buf[1] = 0x0a
        buf[3] = 0x60
        // previous program at [20..25]
        buf[20] = 0x07; buf[22] = 0x03; buf[23] = 0x07; buf[24] = 0x04; buf[25] = 0x01
        // active/staged program at [62..67]
        buf[62] = 0x07; buf[64] = 0x03; buf[65] = 0x09; buf[66] = 0x02; buf[67] = 0x01
        // cc at [77]
        buf[77] = 0xFF

        const parsed = parse96Byte(buf)
        expect(parsed).not.toBeNull()
        expect(parsed!.packet_type).toBe('96_byte_extended')
        expect(parsed!.active_program).toEqual({
            program_id: 0x07,
            spin: 0x09,
            temp: 0x02,
            rinse: 0x01,
            cc: 0xFF,
        })
    })

    it('returns null when discriminator byte[3] does not match 0x60', () => {
        const buf = Buffer.alloc(92)
        buf[0] = 0x20
        buf[1] = 0x0a
        buf[3] = 0x41
        expect(parse96Byte(buf)).toBeNull()
    })

    it('returns null when buffer shorter than 92 bytes', () => {
        const buf = Buffer.alloc(60)
        buf[0] = 0x20
        buf[1] = 0x0a
        buf[3] = 0x60
        expect(parse96Byte(buf)).toBeNull()
    })
})

describe('parse134Byte', () => {
    it('parses a constructed 134-byte counter packet', () => {
        const buf = Buffer.alloc(130)
        buf[0] = 0x20
        buf[1] = 0x0a
        buf[3] = 0x86
        buf[28] = 0x82
        buf[29] = 0x02
        buf[30] = 0x46
        const parsed = parse134Byte(buf)
        expect(parsed).not.toBeNull()
        expect(parsed!.packet_type).toBe('134_byte_counters')
        expect(parsed!.counter_28).toBe(0x82)
        expect(parsed!.counter_29_30).toBe(0x0246)
    })

    it('returns null when discriminator byte[3] does not match 0x86', () => {
        const buf = Buffer.alloc(130)
        buf[0] = 0x20
        buf[1] = 0x0a
        buf[3] = 0x60
        expect(parse134Byte(buf)).toBeNull()
    })
})

describe('parse138Byte', () => {
    it('parses a constructed 138-byte diagnostic packet', () => {
        const buf = Buffer.alloc(134)
        buf[0] = 0x20
        buf[1] = 0x0a
        buf[3] = 0x8a
        buf[120] = 203
        buf[91] = 0x0D
        buf[92] = 0x03
        const parsed = parse138Byte(buf)
        expect(parsed).not.toBeNull()
        expect(parsed!.packet_type).toBe('138_byte_diagnostic')
        expect(parsed!.cycle_counter).toBe(203)
        expect(parsed!.cumulative_energy).toBe(0x0D03)
        expect(parsed!.sensor_temps.length).toBe(10)
    })

    it('returns null when discriminator byte[3] does not match 0x8a', () => {
        const buf = Buffer.alloc(134)
        buf[0] = 0x20
        buf[1] = 0x0a
        buf[3] = 0x86
        expect(parse138Byte(buf)).toBeNull()
    })
})

describe('decodeFlagsByte1 (byte[29])', () => {
    it('decodes turbo + ecoHybrid + steam', () => {
        expect(decodeFlagsByte1(0x89)).toEqual({
            turboWash: true,
            creaseCare: false,
            steamSoftener: false,
            ecoHybrid: true,
            medicRinse: false,
            rinseSpin: false,
            preWash: false,
            steam: true,
        })
    })

    it('zero byte = all false', () => {
        const f = decodeFlagsByte1(0x00)
        expect(Object.values(f).every(v => v === false)).toBe(true)
    })
})

describe('decodeFlagsByte2 (byte[30])', () => {
    it('decodes remoteStart + doorLock + childLock', () => {
        expect(decodeFlagsByte2(0xC2)).toEqual({
            initialBit: false,
            remoteStart: true,
            wrinkleCare: false,
            doorLock: true,
            childLock: true,
        })
    })
})

describe('decodeAiddLed (byte[31])', () => {
    it('returns true when bit 0x01 set', () => {
        expect(decodeAiddLed(0x01)).toBe(true)
    })
    it('returns false when bit 0x01 clear', () => {
        expect(decodeAiddLed(0x00)).toBe(false)
    })
})

describe('CC_NAMES', () => {
    it('maps downloadable course CC hex to names', () => {
        expect(CC_NAMES[0x4D]).toBe('Cold Wash')
        expect(CC_NAMES[0x47]).toBe('Baby Care')
        expect(CC_NAMES[0x84]).toBe('Silent Wash')
        expect(CC_NAMES[0x49]).toBe('Small Load')
        expect(CC_NAMES[0x36]).toBe('Swimming Wear')
        expect(CC_NAMES[0x48]).toBe('Hygiene')
    })

    it('CC_BY_NAME reverses CC_NAMES', () => {
        expect(CC_BY_NAME['Cold Wash']).toBe(0x4D)
        expect(CC_BY_NAME['Hygiene']).toBe(0x48)
    })
})

// Updated parse53Byte test — now that offsets are corrected, flags fields must be present
describe('parse53Byte with flag decoders', () => {
    it('extracts turbo/steam/door_lock/child_lock from correct offsets', () => {
        const buf = Buffer.alloc(53)
        buf[0] = 0x20; buf[1] = 0x0a; buf[3] = 0x39
        buf[15] = 0x01
        buf[20] = 0x07
        buf[23] = 0x09
        buf[24] = 0x02
        buf[29] = 0x81  // turbo + steam
        buf[30] = 0x80  // childLock; doorLock bit CLEAR => locked=true
        buf[31] = 0x01  // AIDD led

        const parsed = parse53Byte(buf)
        expect(parsed).not.toBeNull()
        expect(parsed!.turbo_wash).toBe(true)
        expect(parsed!.steam).toBe(true)
        expect(parsed!.crease_care).toBe(false)
        expect(parsed!.child_lock).toBe(true)
        expect(parsed!.door_lock).toBe(true)  // bit CLEAR = locked
        expect(parsed!.aidd_led).toBe(true)
    })
})

describe('buildF025Set', () => {
    it('builds Cold Wash packet matching confirmed hex', () => {
        const inner = buildF025Set(CMD_F025_COLD_WASH.params)
        expect(inner.toString('hex')).toBe('f02503150103070101000000000000004d000000')
    })

    it('builds Mixed 1200rpm 20C (no CC)', () => {
        const inner = buildF025Set(CMD_F025_MIXED_1200_20.params)
        expect(inner.toString('hex')).toBe('f025031507030902010000000000000000000000')
    })

    it('builds Mixed with CC=FF', () => {
        const inner = buildF025Set(CMD_F025_MIXED_CC_FF.params)
        expect(inner.toString('hex')).toBe('f0250315070309020100000000000000ff000000')
    })

    it('defaults flags_byte and cc to 0 when omitted', () => {
        const inner = buildF025Set({
            program_id: 0x07, spin: 0x09, temp: 0x02, rinse: 0x01
        })
        expect(inner[13]).toBe(0x00)  // flags byte
        expect(inner[16]).toBe(0x00)  // cc byte
        expect(inner.length).toBe(20)
    })
})

describe('buildF026Start', () => {
    it('builds session Mixed 1200rpm 20C start', () => {
        const inner = buildF026Start(CMD_F026_MIXED_START.params)
        expect(inner.toString('hex')).toBe('f02607030902010000000000000300000000')
    })

    it('builds Duvet start (session offset)', () => {
        const inner = buildF026Start(CMD_F026_DUVET_START.params)
        expect(inner.toString('hex').toLowerCase()).toBe('f02605030701010000000000000300000000')
    })

    it('builds AI Wash start with spin=max', () => {
        const inner = buildF026Start(CMD_F026_AI_WASH_START.params)
        expect(inner.toString('hex').toLowerCase()).toBe('f0263a03ff04010000000000000300000000')
    })

    it('supports delay=4h at byte[9]', () => {
        const inner = buildF026Start({
            program_id: 0x05, spin: 0x07, temp: 0x02, rinse: 0x01, delay: 4
        })
        expect(inner.toString('hex').toLowerCase()).toBe('f02605030702010000040000000300000000')
    })

    it('defaults delay to 0 when omitted', () => {
        const inner = buildF026Start({
            program_id: 0x07, spin: 0x09, temp: 0x02, rinse: 0x01
        })
        expect(inner[9]).toBe(0)
        expect(inner[13]).toBe(0x03)  // magic byte
        expect(inner.length).toBe(18)
    })
})

describe('buildF02APowerToggle', () => {
    it('produces 4-byte inner F0 2A 01 00', () => {
        expect(buildF02APowerToggle().toString('hex').toLowerCase()).toBe('f02a0100')
    })
})

describe('buildF024TurnOff', () => {
    it('produces 5-byte inner F0 24 01 01 00', () => {
        expect(buildF024TurnOff().toString('hex').toLowerCase()).toBe('f024010100')
    })
})

describe('Device staged command flow', () => {
    function mockInfra() {
        const sent: Buffer[] = []
        const published: Array<[string, string, any]> = []
        const mockHA: any = {
            publishProperty: (id: string, prop: string, value: any) => published.push([id, prop, value]),
            publishConfig: () => {},
            on: () => {},
        }
        const mockThinq: any = {
            id: 'test-uuid',
            meta: { modelName: 'test', swVersion: '1', modelId: 'Y_V8_Y___W.B32QEUK' },
            send: (buf: Buffer) => sent.push(buf),
            on: () => {},
        }
        return { mockHA, mockThinq, sent, published }
    }

    it('staging selects + set_program press builds F025 with staged values', async () => {
        const Device = (await import('./Y_V8_Y___W.B32QEUK.js')).default
        const { mockHA, mockThinq, sent } = mockInfra()
        const dev = new Device(mockHA, mockThinq, mockThinq.meta)

        dev.setProperty('stage_program', 'Mixed')
        dev.setProperty('stage_spin', '1200')
        dev.setProperty('stage_temp', '20')
        dev.setProperty('stage_rinse', 'normal')
        dev.setProperty('set_program', 'PRESS')

        expect(sent.length).toBe(1)
        const full = sent[0]
        expect(full[0]).toBe(0xAA)
        expect(full[full.length - 1]).toBe(0xBB)
        const innerHex = full.subarray(2, 2 + 20).toString('hex')
        expect(innerHex).toBe('f025031507030902010000000000000000000000')
    })

    it('start_program press builds F026 with staged values', async () => {
        const Device = (await import('./Y_V8_Y___W.B32QEUK.js')).default
        const { mockHA, mockThinq, sent } = mockInfra()
        const dev = new Device(mockHA, mockThinq, mockThinq.meta)

        dev.setProperty('stage_program', 'Mixed')
        dev.setProperty('stage_spin', '1200')
        dev.setProperty('stage_temp', '20')
        dev.setProperty('stage_rinse', 'normal')
        dev.setProperty('start_program', 'PRESS')

        expect(sent.length).toBe(1)
        const innerHex = sent[0].subarray(2, 2 + 18).toString('hex')
        expect(innerHex).toBe('f02607030902010000000000000300000000')
    })

    it('power_toggle_btn press builds F02A', async () => {
        const Device = (await import('./Y_V8_Y___W.B32QEUK.js')).default
        const { mockHA, mockThinq, sent } = mockInfra()
        const dev = new Device(mockHA, mockThinq, mockThinq.meta)

        dev.setProperty('power_toggle_btn', 'PRESS')
        expect(sent.length).toBe(1)
        expect(sent[0].toString('hex').toLowerCase()).toBe('aa08f02a010098bb')
    })
})
