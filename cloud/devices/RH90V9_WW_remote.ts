import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection, type DeviceDiscovery } from '../homeassistant'
import { type Metadata } from '../thinq'
import { Enum } from '@/util/enum'
import { DRY_LEVELS } from './RC90U2_WW'
import UpstreamDevice from './RH90V9_WW'

// LG RH90V9_WW heat-pump tumble dryer, deployment build: upstream's read-only RH90V9_WW driver
// (status decoding inherited from RC90U2_WW) plus remote control, the 303E sensor bursts and this
// unit's own panel labels. Protocol notes: wiki Appliance:RH90V9_WW.md — packet types 30EB/30EC/303E/3072,
// F025/F026 command semantics.

const STATUS_LENGTH = 27 // 00 19 + the 25-byte record
const OPTION1_OFFSET = 14
const OPTION2_OFFSET = 15
const DOWNLOADED_COURSE_OFFSET = 23

// Course codes as printed on this unit's dial.
const BASE_COURSES = Enum.of({
    Towels: 0x02,
    Bedding: 0x04,
    Synthetics: 0x05,
    Mixed: 0x06,
    Cotton: 0x07,
    Sportswear: 0x08,
    'Quick 30': 0x09,
    Delicates: 0x0a,
    Wool: 0x0b,
    'Rack Dry': 0x0c,
    'Warm Air': 0x0e,
    'Allergy Care': 0x10,
    'Condenser Care': 0x12,
    'Drum Clean': 0x13,
    Eco: 0x19,
})

// The Eco Hybrid byte, labelled the way this unit's panel and the ThinQ app show it.
export const ECO_HYBRID = Enum.of({
    'Not selected': 0,
    'Energy save': 1,
    'Time save': 3,
})

// Valid option sets per course, from the modelJson course schema in alexw23's
// implementation (upstream PR #55). An empty `dryness` list means the course has no
// dryness selection and F026 byte 3 stays 0.
export interface CourseSchema {
    dryness: number[]
    defaultDryness: number
    dryLevels: number[]
    defaultDryLevel: number
}

export const COURSE_SCHEMA: Record<number, CourseSchema> = {
    0x02: { dryness: [], defaultDryness: 0, dryLevels: [0x03], defaultDryLevel: 0x03 },
    0x04: { dryness: [], defaultDryness: 0, dryLevels: [0x03], defaultDryLevel: 0x03 },
    0x05: { dryness: [0x01, 0x03], defaultDryness: 0x03, dryLevels: [0x01, 0x03], defaultDryLevel: 0x03 },
    0x06: { dryness: [0x01, 0x03, 0x04], defaultDryness: 0x03, dryLevels: [0x01, 0x03], defaultDryLevel: 0x03 },
    0x07: { dryness: [0x01, 0x03, 0x04], defaultDryness: 0x03, dryLevels: [0x03], defaultDryLevel: 0x03 },
    0x08: { dryness: [], defaultDryness: 0, dryLevels: [0x01], defaultDryLevel: 0x01 },
    0x09: { dryness: [], defaultDryness: 0, dryLevels: [0x03], defaultDryLevel: 0x03 },
    0x0a: { dryness: [], defaultDryness: 0, dryLevels: [0x01], defaultDryLevel: 0x01 },
    0x0b: { dryness: [], defaultDryness: 0, dryLevels: [0x01], defaultDryLevel: 0x01 },
    0x0c: { dryness: [], defaultDryness: 0, dryLevels: [0x01], defaultDryLevel: 0x01 },
    0x0e: { dryness: [], defaultDryness: 0, dryLevels: [0x01, 0x03], defaultDryLevel: 0x01 },
    0x10: { dryness: [], defaultDryness: 0, dryLevels: [0x03], defaultDryLevel: 0x03 },
    0x12: { dryness: [], defaultDryness: 0, dryLevels: [0x03], defaultDryLevel: 0x03 },
    0x13: { dryness: [], defaultDryness: 0, dryLevels: [0x03], defaultDryLevel: 0x03 },
    0x19: { dryness: [0x01, 0x03, 0x04], defaultDryness: 0x03, dryLevels: [0x01, 0x03], defaultDryLevel: 0x01 },
}

export interface F025Params {
    dryLevel: number // 0x01=energy save, 0x03=time save
    duration: number // minutes, matches the TD the dryer reports at cycle start
    base: number // base program id (see COURSES)
    cc: number // custom-course id (see CC_NAMES)
    dryness: number // 0x00=sensor/fixed, 0x01=iron, 0x03=cupboard, 0x04=extra
}

// F025 "stage a downloadable course", 25-byte inner payload:
// F0 25 03 15 00 [dryLevel] [duration] 00*7 [base] [cc] 00*3 [dryness] 00*5
// The dryer accepts this layout without resetting (unlike washer-style payloads).
// Parameter sets below are byte-for-byte from live app captures.
export function buildF025SetCourse(p: F025Params): Buffer {
    const buf = Buffer.alloc(25)
    buf[0] = 0xf0
    buf[1] = 0x25
    buf[2] = 0x03
    buf[3] = 0x15
    buf[5] = p.dryLevel
    buf[6] = p.duration
    buf[14] = p.base
    buf[15] = p.cc
    buf[19] = p.dryness
    return buf
}

// Downloadable courses. The first five are byte-for-byte from our own ThinQ app captures
// (2026-04-19 and 2026-07-27 sessions); the rest carry the modelJson SmartCourse defaults
// from alexw23's independent implementation (upstream PR #55) — his capture-confirmed
// values match ours exactly where the sets overlap (Small Load, Economic Dry, Baby Care,
// Full Size Load), so the remaining entries are trusted with the same serialization.
export const DOWNLOADABLE_COURSES: Record<string, F025Params> = {
    'Economic Dry': { dryLevel: 0x01, duration: 150, base: 0x19, cc: 0x70, dryness: 0x03 },
    'Baby Care': { dryLevel: 0x03, duration: 130, base: 0x02, cc: 0x65, dryness: 0x00 },
    Deodoration: { dryLevel: 0x03, duration: 39, base: 0x01, cc: 0x6b, dryness: 0x00 },
    'Full Size Load': { dryLevel: 0x03, duration: 160, base: 0x19, cc: 0x74, dryness: 0x04 },
    'Small Load': { dryLevel: 0x03, duration: 50, base: 0x0e, cc: 0x6c, dryness: 0x00 },
    'Gym Clothes': { dryLevel: 0x01, duration: 60, base: 0x08, cc: 0x66, dryness: 0x00 },
    Blanket: { dryLevel: 0x03, duration: 165, base: 0x04, cc: 0x67, dryness: 0x00 },
    'Blanket Refresh': { dryLevel: 0x03, duration: 30, base: 0x00, cc: 0x68, dryness: 0x00 },
    'Rainy Day': { dryLevel: 0x03, duration: 30, base: 0x0e, cc: 0x69, dryness: 0x00 },
    'Single Garments': { dryLevel: 0x03, duration: 40, base: 0x0e, cc: 0x6a, dryness: 0x00 },
    Lingerie: { dryLevel: 0x01, duration: 50, base: 0x0a, cc: 0x6d, dryness: 0x00 },
    'Easy Ironing': { dryLevel: 0x01, duration: 110, base: 0x19, cc: 0x6e, dryness: 0x01 },
    'Super Dry': { dryLevel: 0x03, duration: 160, base: 0x19, cc: 0x6f, dryness: 0x04 },
    'Big Size Item': { dryLevel: 0x03, duration: 165, base: 0x04, cc: 0x71, dryness: 0x00 },
    'Minimize Wrinkles': { dryLevel: 0x03, duration: 130, base: 0x19, cc: 0x72, dryness: 0x03 },
    'Shoes / Fabric Doll': { dryLevel: 0x01, duration: 180, base: 0x0c, cc: 0x73, dryness: 0x00 },
}

// Custom-course IDs echoed at status block byte 23; the echo persists across power cycles.
export const CC_NAMES: Record<number, string> = Object.fromEntries(
    Object.entries(DOWNLOADABLE_COURSES).map(([name, p]) => [p.cc, name]),
)

export const START_MODE = 0x03 // start a cycle from scratch
export const RESUME_MODE = 0x01 // resume after a pause
export const DELAY_UNCHANGED = 0xff // leave the delay timer as it is

export interface F026Params {
    course: number
    dryLevel: number
    dryness?: number // see DRY_LEVELS; defaults to 0x03 (Cupboard), matching captures
    duration?: number // minutes; 0 lets the dryer pick the course default
    delay?: number // hours until the cycle ends; DELAY_UNCHANGED keeps the current setting
    options?: number // bitfield, 0x02 = anti-crease
    mode?: number // START_MODE / RESUME_MODE
}

// F026 starts a cycle, with the full configuration in the payload — the same shape the
// washer uses, contrary to older documentation claiming F026 only powers the dryer off.
// (That behaviour comes from sending a malformed payload, which is what `power_off` below
// still does deliberately.) 16-byte inner payload:
// F0 26 [course] [dryness] [dryLevel] [duration] 00 00 [delay] 00 00 [options] [mode] 00 00 00
// Field mapping verified 2026-07-27 against live ThinQ app captures of a start, a start
// with a 3 h delayed end plus anti-crease, and a resume after pause. Byte 3 read as a
// constant 0x03 in every capture; alexw23's PR #55 identifies it as the dryness level
// (0x03 = Cupboard, the default of each captured course), which fits all our packets.
export function buildF026Start(p: F026Params): Buffer {
    const buf = Buffer.alloc(16)
    buf[0] = 0xf0
    buf[1] = 0x26
    buf[2] = p.course
    buf[3] = p.dryness ?? 0x03
    buf[4] = p.dryLevel
    buf[5] = p.duration ?? 0
    buf[8] = p.delay ?? 0
    buf[11] = p.options ?? 0
    buf[12] = p.mode ?? START_MODE
    return buf
}

// Pause, shared with the washer opcode space (older documentation claims the dryer
// ignores F024 — the ThinQ app itself uses this exact packet).
export function buildF024Pause(): Buffer {
    return Buffer.from([0xf0, 0x24, 0x04, 0x01, 0x00])
}

// Base dial courses, then the downloadable ones under their own names. Deodoration runs on base code
// 0x01, which has no dial slot, so that code reads back as the downloaded course too.
const COURSES = new Enum<string>([
    ...BASE_COURSES.entries,
    ...Object.entries(DOWNLOADABLE_COURSES).map(([name, p]): [string, number | number[]] =>
        p.base === 0x01 ? [name, [p.cc, 0x01]] : [name, p.cc],
    ),
])

// Entities added on top of upstream's read-only set.
const CONTROL_COMPONENTS = {
    power_off: {
        platform: 'button',
        unique_id: '$deviceid-power_off',
        command_topic: '$this/power_off/set',
        payload_press: '',
        name: 'Power off',
        icon: 'mdi:power',
    },
    power_on: {
        platform: 'button',
        unique_id: '$deviceid-power_on',
        command_topic: '$this/power_on/set',
        payload_press: '',
        name: 'Power on',
        icon: 'mdi:power',
    },
    temperature: {
        platform: 'sensor',
        unique_id: '$deviceid-temperature',
        state_topic: '$this/temperature',
        name: 'Air temperature',
        device_class: 'temperature',
        unit_of_measurement: '°C',
        suggested_display_precision: 1,
    },
    energy: {
        platform: 'sensor',
        unique_id: '$deviceid-energy',
        state_topic: '$this/energy',
        name: 'Energy',
        icon: 'mdi:lightning-bolt',
        device_class: 'energy',
        state_class: 'total_increasing',
        unit_of_measurement: 'Wh',
    },
    remote_start: {
        platform: 'binary_sensor',
        unique_id: '$deviceid-remote_start',
        state_topic: '$this/remote_start',
        name: 'Remote start',
        icon: 'mdi:remote',
    },
    staged_cc: {
        platform: 'sensor',
        unique_id: '$deviceid-staged_cc',
        state_topic: '$this/staged_cc',
        name: 'Downloaded course',
        icon: 'mdi:download-circle-outline',
        entity_category: 'diagnostic',
    },
    stage_course: {
        platform: 'select',
        unique_id: '$deviceid-stage_course',
        state_topic: '$this/stage_course',
        command_topic: '$this/stage_course/set',
        name: 'Stage downloadable course',
        icon: 'mdi:download-circle-outline',
        options: Object.keys(DOWNLOADABLE_COURSES),
    },
    // remote cycle configuration: pick the values, then press start
    stage_program: {
        platform: 'select',
        unique_id: '$deviceid-stage_program',
        state_topic: '$this/stage_program',
        command_topic: '$this/stage_program/set',
        name: 'Staged: Course',
        icon: 'mdi:format-list-bulleted',
        options: BASE_COURSES.options,
    },
    stage_dry_level: {
        platform: 'select',
        unique_id: '$deviceid-stage_dry_level',
        state_topic: '$this/stage_dry_level',
        command_topic: '$this/stage_dry_level/set',
        name: 'Staged: Eco Hybrid',
        icon: 'mdi:leaf',
        options: ECO_HYBRID.options.filter((o) => o !== 'Not selected'),
    },
    stage_dryness: {
        platform: 'select',
        unique_id: '$deviceid-stage_dryness',
        state_topic: '$this/stage_dryness',
        command_topic: '$this/stage_dryness/set',
        name: 'Staged: Dry level',
        icon: 'mdi:water-percent',
        options: DRY_LEVELS.options,
    },
    stage_delay: {
        platform: 'number',
        unique_id: '$deviceid-stage_delay',
        state_topic: '$this/stage_delay',
        command_topic: '$this/stage_delay/set',
        name: 'Staged: Delayed end (h)',
        icon: 'mdi:timer-outline',
        min: 0,
        max: 19,
        step: 1,
    },
    stage_anti_crease: {
        platform: 'switch',
        unique_id: '$deviceid-stage_anti_crease',
        state_topic: '$this/stage_anti_crease',
        command_topic: '$this/stage_anti_crease/set',
        name: 'Staged: Anti-crease',
        icon: 'mdi:iron-outline',
    },
    start: {
        platform: 'button',
        unique_id: '$deviceid-start',
        command_topic: '$this/start/set',
        payload_press: '',
        name: 'Start staged cycle',
        icon: 'mdi:play-circle-outline',
    },
    pause: {
        platform: 'button',
        unique_id: '$deviceid-pause',
        command_topic: '$this/pause/set',
        payload_press: '',
        name: 'Pause',
        icon: 'mdi:pause-circle-outline',
    },
    resume: {
        platform: 'button',
        unique_id: '$deviceid-resume',
        command_topic: '$this/resume/set',
        payload_press: '',
        name: 'Resume',
        icon: 'mdi:play-pause',
    },
    raw_send: {
        platform: 'text',
        unique_id: '$deviceid-raw_send',
        command_topic: '$this/raw_send/set',
        name: 'Raw hex send',
        icon: 'mdi:console',
        pattern: '^[0-9a-fA-F]{8,400}$',
    },
}

export default class Device extends UpstreamDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, meta)
    }

    protected courses() {
        return COURSES
    }

    protected ecoHybrid() {
        return ECO_HYBRID
    }

    // Upstream builds the discovery config in its constructor; merging here publishes it once, complete.
    setConfig(config: DeviceDiscovery) {
        super.setConfig({ ...config, components: { ...config.components, ...CONTROL_COMPONENTS } })
    }

    processAABB(buf: Buffer) {
        super.processAABB(buf)
        this.processCommonStatus(buf, 0x30, STATUS_LENGTH, this.processControlStatus)

        // 303E sensor burst (~10 identical packets every 15 min while drying):
        // 303E 00 [tempF] [energy_hi energy_lo] [reading#]
        if (buf.length === 7 && buf[0] == 0x30 && buf[1] == 0x3e) {
            // A zero temperature is the "no reading" sentinel the dryer emits outside a
            // cycle; converting it would publish a bogus -17.8 °C.
            if (buf[3] !== 0) {
                this.publishProperty('temperature', Math.round((((buf[3] - 32) * 5) / 9) * 10) / 10)
            }
            this.publishProperty('energy', (buf[4] << 8) | buf[5])
        }
    }

    // The record fields remote control needs, which upstream decodes but does not keep.
    private processControlStatus(status: Buffer) {
        const rec = status.subarray(2)
        const cc = rec[DOWNLOADED_COURSE_OFFSET]

        this.lastStatus = { course: rec[5], ecoHybrid: rec[8], options: rec[OPTION1_OFFSET] }
        if (cc) this.lastCC = cc

        this.publishProperty('remote_start', rec[OPTION2_OFFSET] & 0x01 ? 'ON' : 'OFF')
        this.publishProperty('staged_cc', cc ? (CC_NAMES[cc] ?? `unknown (0x${cc.toString(16)})`) : 'None')
    }

    // last known live configuration, used as the fallback when resuming a cycle that was
    // configured on the appliance itself rather than from HA
    private lastStatus = { course: 0, ecoHybrid: 0x01, options: 0 }

    // last downloadable-course echo (status byte 23); survives power cycles on the
    // appliance, so it is the safest F025 payload for the power-on wake sequence
    private lastCC = 0

    private staged: {
        course?: string
        ecoHybrid?: string
        dryness?: string
        delay?: number
        antiCrease?: boolean
    } = {}

    private stagedF026(mode: number): Buffer | undefined {
        const course = this.staged.course ? BASE_COURSES.unmap(this.staged.course) : this.lastStatus.course
        if (!course) return undefined

        const ecoHybrid = this.staged.ecoHybrid ? ECO_HYBRID.unmap(this.staged.ecoHybrid) : this.lastStatus.ecoHybrid
        const dryness = this.staged.dryness
            ? DRY_LEVELS.unmap(this.staged.dryness)
            : COURSE_SCHEMA[course]?.defaultDryness
        const antiCrease = this.staged.antiCrease ?? !!(this.lastStatus.options & 0x02)

        return buildF026Start({
            course,
            dryLevel: ecoHybrid ?? this.lastStatus.ecoHybrid,
            dryness,
            delay: mode === RESUME_MODE ? DELAY_UNCHANGED : (this.staged.delay ?? 0),
            options: antiCrease ? 0x02 : 0x00,
            mode,
        })
    }

    setProperty(prop: string, mqttValue: string) {
        // A malformed F026 payload powers the dryer off: a quirk of the start opcode
        // rejecting garbage, not a dedicated power command.
        if (prop === 'power_off') {
            this.send(Buffer.from('F026010100', 'hex'))
            return
        }

        // F02A powers the dryer on, but a firmware idle lockout blocks it a few minutes
        // after the last interaction; re-staging the last downloaded course via F025
        // counts as interaction and lifts the gate (sequence found by alexw23, PR #55).
        if (prop === 'power_on') {
            const wake = Object.values(DOWNLOADABLE_COURSES).find((p) => p.cc === this.lastCC)
            if (wake) {
                this.send(buildF025SetCourse(wake))
                setTimeout(() => this.send(Buffer.from('F02A0100', 'hex')), 500)
            } else {
                this.send(Buffer.from('F02A0100', 'hex'))
            }
            return
        }

        if (prop === 'pause') {
            this.send(buildF024Pause())
            return
        }

        if (prop === 'start' || prop === 'resume') {
            const packet = this.stagedF026(prop === 'resume' ? RESUME_MODE : START_MODE)
            if (packet) this.send(packet)
            return
        }

        if (prop.startsWith('stage_') && prop !== 'stage_course') {
            const key = prop.slice('stage_'.length)
            if (key === 'program') this.staged.course = mqttValue
            else if (key === 'dry_level') this.staged.ecoHybrid = mqttValue
            else if (key === 'dryness') this.staged.dryness = mqttValue
            else if (key === 'delay') this.staged.delay = Number(mqttValue)
            else if (key === 'anti_crease') this.staged.antiCrease = mqttValue === 'ON'
            else return
            this.HA.publishProperty(this.id, prop, mqttValue)
            return
        }

        // Stage one of the known downloadable courses; the cycle is then started from
        // the physical panel.
        if (prop === 'stage_course') {
            const params = DOWNLOADABLE_COURSES[mqttValue]
            if (!params) return
            this.send(buildF025SetCourse(params))
            this.HA.publishProperty(this.id, prop, mqttValue)
            return
        }

        if (prop === 'raw_send') {
            const hexStr = mqttValue.replace(/\s+/g, '')
            if (!/^[0-9a-fA-F]{8,}$/.test(hexStr) || hexStr.length % 2 !== 0) return
            const packet = Buffer.from(hexStr, 'hex')
            if (packet[0] !== 0xaa || packet[packet.length - 1] !== 0xbb) return
            let sum = 0
            for (let i = 0; i < packet.length - 2; i++) sum += packet[i]
            if (((sum & 0xff) ^ 0x55) !== packet[packet.length - 2]) return
            this.send_packet(packet)
            return
        }
    }
}
