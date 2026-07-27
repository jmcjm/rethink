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
        if (prop === 'power_off') this.send(Buffer.from('F026010100', 'hex'))
    }
}
