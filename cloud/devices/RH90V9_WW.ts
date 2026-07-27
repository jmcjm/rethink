import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import log from '@/util/logging'

// LG RH90V9_WW heat-pump tumble dryer (EU model, deviceType 202).
// Protocol documentation: wiki Appliance:RH90V9_WW.md — packet types 30EB/30EC/303E/3072,
// 25-byte status block layout, F025/F026 command semantics.

export const STATES = [
    'Off',
    'Ready',
    'Drying',
    'Paused',
    'Done', // includes the cooling phase after the heater stops
]

export const COURSES: Record<number, string> = {
    0x01: 'Deodoration', // downloadable-only base, no dial slot
    0x02: 'Towels',
    0x04: 'Bedding',
    0x05: 'Synthetics',
    0x06: 'Mixed',
    0x07: 'Cotton',
    0x08: 'Sportswear',
    0x09: 'Quick 30',
    0x0a: 'Delicates',
    0x0b: 'Wool',
    0x0c: 'Rack Dry',
    0x0e: 'Warm Air',
    0x10: 'Allergy Care',
    0x13: 'Drum Clean',
    0x19: 'Eco',
}

export const DRY_LEVELS: Record<number, string> = {
    0x01: 'Energy save',
    0x03: 'Time save',
}

export const DRYNESS_LEVELS: Record<number, string> = {
    0x00: 'Sensor', // programs with fixed duration or sensor-based end detection
    0x01: 'Iron',
    0x03: 'Cupboard',
    0x04: 'Extra',
}

// Custom-course IDs downloaded from the ThinQ app; the last downloaded CC is echoed at
// status block byte 23 and persists across power cycles.
export const CC_NAMES: Record<number, string> = {
    0x65: 'Baby Care',
    0x6b: 'Deodoration',
    0x70: 'Economic Dry',
    0x74: 'Full Size Load',
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
// There is no known remote-start opcode — the user starts the staged course from
// the physical panel. Parameter sets below are byte-for-byte from live app captures.
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

// The four downloadable courses captured from the ThinQ app (2026-04-19 session).
export const DOWNLOADABLE_COURSES: Record<string, F025Params> = {
    'Economic Dry': { dryLevel: 0x01, duration: 150, base: 0x19, cc: 0x70, dryness: 0x03 },
    'Baby Care': { dryLevel: 0x03, duration: 130, base: 0x02, cc: 0x65, dryness: 0x00 },
    Deodoration: { dryLevel: 0x03, duration: 39, base: 0x01, cc: 0x6b, dryness: 0x00 },
    'Full Size Load': { dryLevel: 0x03, duration: 160, base: 0x19, cc: 0x74, dryness: 0x04 },
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        device_class: 'power',
                    },
                    power_off: {
                        platform: 'button',
                        unique_id: '$deviceid-power_off',
                        command_topic: '$this/power_off/set',
                        payload_press: '',
                        name: 'Power off',
                        icon: 'mdi:power',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: [...STATES, 'unknown'],
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Remaining time',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Initial time',
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:speedometer',
                    },
                    dryness_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dryness_level',
                        state_topic: '$this/dryness_level',
                        name: 'Dryness level',
                        icon: 'mdi:water-percent',
                    },
                    anti_crease: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-anti_crease',
                        state_topic: '$this/anti_crease',
                        name: 'Anti-crease',
                        icon: 'mdi:iron-outline',
                    },
                    delay_active: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-delay_active',
                        state_topic: '$this/delay_active',
                        name: 'Delay timer',
                        icon: 'mdi:timer-outline',
                    },
                    delay_remaining: {
                        platform: 'sensor',
                        unique_id: '$deviceid-delay_remaining',
                        state_topic: '$this/delay_remaining',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Delay remaining',
                        entity_category: 'diagnostic',
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
                        name: 'Stage course',
                        icon: 'mdi:download-circle-outline',
                        options: Object.keys(DOWNLOADABLE_COURSES),
                    },
                    raw_send: {
                        platform: 'text',
                        unique_id: '$deviceid-raw_send',
                        command_topic: '$this/raw_send/set',
                        name: 'Raw hex send',
                        icon: 'mdi:console',
                        pattern: '^[0-9a-fA-F]{8,400}$',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    processAABB(buf: Buffer) {
        // 30EB single-block status (idle heartbeat): 30EB 0019 [block:25]
        if (buf.length === 29 && buf[0] == 0x30 && buf[1] == 0xeb) {
            this.parseStatusBlock(buf.subarray(4))
            return
        }

        // 30EC double-block status (transition): 30EC 0019 [block1:25] 0019 [block2:25]
        // Block1 is the previous state, block2 the current one.
        if (buf.length === 56 && buf[0] == 0x30 && buf[1] == 0xec) {
            this.parseStatusBlock(buf.subarray(31))
            return
        }

        // 303E sensor burst (~10 identical packets every 15 min while drying):
        // 303E 00 [tempF] [energy_hi energy_lo] [reading#]
        if (buf.length === 7 && buf[0] == 0x30 && buf[1] == 0x3e) {
            const tempC = Math.round((((buf[3] - 32) * 5) / 9) * 10) / 10
            this.publishProperty('temperature', tempC)
            this.publishProperty('energy', (buf[4] << 8) | buf[5])
            return
        }

        // 3072 cycle markers (0xC9 start / 0x00 clearing / 0xC8 end) and 3031/30DC info
        // dumps carry no HA-relevant state; log everything else for reverse-engineering.
        if (buf[1] != 0x72 && buf[1] != 0x31 && buf[1] != 0xdc && buf[1] != 0x00) {
            log('status', `RH90V9_WW unknown packet len=${buf.length} hex=${buf.toString('hex')}`)
        }
    }

    // 25-byte status block, layout per wiki Appliance:RH90V9_WW.md
    parseStatusBlock(b: Buffer) {
        const state = b[0]
        const remaining = b[1] * 60 + b[2]
        const initial = b[3] * 60 + b[4]
        const course = b[5]
        const drynessLevel = b[7]
        const dryLevel = b[8]
        const delayRemaining = b[12] * 60 + b[13]
        const options = b[14]
        const cc = b[23]

        this.publishProperty('power', state > 0 ? 'ON' : 'OFF')
        this.publishProperty('status', STATES[state] ?? 'unknown')
        this.publishProperty('remaining_time', remaining)
        this.publishProperty('initial_time', initial)
        this.publishProperty('course', course ? (COURSES[course] ?? `unknown (0x${course.toString(16)})`) : 'None')
        this.publishProperty('dry_level', DRY_LEVELS[dryLevel] ?? `unknown (0x${dryLevel.toString(16)})`)
        this.publishProperty(
            'dryness_level',
            DRYNESS_LEVELS[drynessLevel] ?? `unknown (0x${drynessLevel.toString(16)})`,
        )
        this.publishProperty('anti_crease', options & 0x02 ? 'ON' : 'OFF')
        this.publishProperty('delay_active', options & 0x01 ? 'ON' : 'OFF')
        this.publishProperty('delay_remaining', delayRemaining)
        this.publishProperty('staged_cc', cc ? (CC_NAMES[cc] ?? `unknown (0x${cc.toString(16)})`) : 'None')
    }

    setProperty(prop: string, mqttValue: string) {
        // F026 with any payload powers the dryer off. It does NOT start a cycle (unlike the
        // washer opcode space) — no start command is known for this dryer.
        if (prop === 'power_off') {
            this.send(Buffer.from('F026010100', 'hex'))
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
            this.thinq.send_packet(packet)
            return
        }
    }
}
