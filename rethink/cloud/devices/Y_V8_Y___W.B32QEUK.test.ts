import { describe, it, expect } from 'vitest'
import { parse53Byte } from './Y_V8_Y___W.B32QEUK.js'

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
