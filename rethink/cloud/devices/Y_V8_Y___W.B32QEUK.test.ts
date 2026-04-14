import { describe, it, expect } from 'vitest'
import { parse53Byte, parse65Byte, parse96Byte, parse134Byte, parse138Byte } from './Y_V8_Y___W.B32QEUK.js'

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
