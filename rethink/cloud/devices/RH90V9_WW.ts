import HADevice from './base.js'
import { Device as Thinq2Device } from "../thinq2/device.js"
import { type Connection } from '../homeassistant.js'
import { type Metadata } from "../thinq.js"
import { allowExtendedType } from '../../util/util.js'
import AABBDevice from './aabb_device.js'

const STATES: Record<number, string> = {
    0x00: 'power_off',
    0x01: 'ready',
    0x02: 'drying',
    0x03: 'paused',
    0x04: 'done',
}

const COURSES: Record<number, string> = {
    0x02: 'Ręczniki',
    0x04: 'Pościel',
    0x05: 'Syntetyczne',
    0x06: 'Mieszane',
    0x07: 'Bawełna',
    0x08: 'Odzież sportowa',
    0x09: 'Szybki 30',
    0x0A: 'Delikatne',
    0x0B: 'Wełna',
    0x0C: 'Na stojaku',
    0x0E: 'Ciepłe powietrze',
    0x10: 'Antyalergiczne',
    0x13: 'Czyszczenie bębna',
    0x19: 'Eco',
}

const DRY_LEVELS: Record<number, string> = {
    0x01: 'energy_save',
    0x03: 'time_save',
}

const DRYNESS_LEVELS: Record<number, string> = {
    0x00: 'none',
    0x01: 'prasowanie',
    0x03: 'do_szafy',
    0x04: 'ekstra',
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, 'device', thinq)
        this.setConfig(allowExtendedType({
            ...HADevice.deviceConfig(meta, { name: "LG Dryer" }),
            components: {
                power: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-power',
                    state_topic: '$this/power',
                    name: 'Power',
                    device_class: 'power',
                },
                status: {
                    platform: 'sensor',
                    unique_id: '$deviceid-status',
                    state_topic: '$this/status',
                    name: 'Current status',
                    options: [ ...Object.values(STATES), 'unknown_status' ]
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
                    name: 'Total time',
                },
                course: {
                    platform: 'sensor',
                    unique_id: '$deviceid-course',
                    state_topic: '$this/course',
                    name: 'Program',
                },
                dry_level: {
                    platform: 'sensor',
                    unique_id: '$deviceid-dry_level',
                    state_topic: '$this/dry_level',
                    name: 'Dry level',
                },
                dryness_level: {
                    platform: 'sensor',
                    unique_id: '$deviceid-dryness_level',
                    state_topic: '$this/dryness_level',
                    name: 'Dryness level',
                },
                temperature: {
                    platform: 'sensor',
                    unique_id: '$deviceid-temperature',
                    state_topic: '$this/temperature',
                    device_class: 'temperature',
                    unit_of_measurement: '°C',
                    name: 'Temperature',
                },
                energy: {
                    platform: 'sensor',
                    unique_id: '$deviceid-energy',
                    state_topic: '$this/energy',
                    device_class: 'energy',
                    state_class: 'total_increasing',
                    unit_of_measurement: 'Wh',
                    name: 'Cycle energy',
                },
                anti_crease: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-anti_crease',
                    state_topic: '$this/anti_crease',
                    name: 'Anti-crease',
                },
            }
        }))
    }

    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    processAABB(buf: Buffer) {
        // 30EB single-block status: 30EB 0019 [block:25]
        if(buf.length === 29 && buf[0] === 0x30 && buf[1] === 0xEB) {
            this.parseStatusBlock(buf.subarray(4))
        }

        // 30EC double-block status: 30EC 0019 [block1:25] 0019 [block2:25]
        if(buf.length === 56 && buf[0] === 0x30 && buf[1] === 0xEC) {
            this.parseStatusBlock(buf.subarray(31))
        }

        // 303E sensor + energy: 303E 00 [temp_F] [energy_hi energy_lo] [reading#]
        if(buf.length === 7 && buf[0] === 0x30 && buf[1] === 0x3E) {
            const tempF = buf[3]
            const tempC = Math.round((tempF - 32) * 5 / 9 * 10) / 10
            const energy = (buf[4] << 8) | buf[5]

            this.publishProperty('temperature', tempC)
            this.publishProperty('energy', energy)
        }
    }

    parseStatusBlock(b: Buffer) {
        const state = b[0]
        const tremain = b[1] * 60 + b[2]
        const tinitial = b[3] * 60 + b[4]
        const course = b[5]
        const drynessLevel = b[7]
        const dryLevel = b[8]
        const options = b[14]

        this.publishProperty('power', state > 0 ? 'ON' : 'OFF')
        this.publishProperty('status', STATES[state] ?? 'unknown_status')
        this.publishProperty('remaining_time', tremain)
        this.publishProperty('initial_time', tinitial)
        this.publishProperty('course', COURSES[course] ?? `unknown_${course.toString(16)}`)
        this.publishProperty('dry_level', DRY_LEVELS[dryLevel] ?? `unknown_${dryLevel}`)
        this.publishProperty('dryness_level', DRYNESS_LEVELS[drynessLevel] ?? `unknown_${drynessLevel}`)
        this.publishProperty('anti_crease', (options & 0x02) ? 'ON' : 'OFF')
    }

    setProperty(prop: string, mqttValue: string) {
        if(prop === 'power' && mqttValue === 'OFF') {
            this.send(Buffer.from('F026010100', 'hex'))
        }
    }
}
