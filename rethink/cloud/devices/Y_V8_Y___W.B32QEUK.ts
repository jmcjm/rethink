import HADevice from './base.js'
import { Device as Thinq2Device } from "../thinq2/device.js"
import { type Connection } from '../homeassistant.js'
import { type Metadata } from "../thinq.js"
import { allowExtendedType } from '../../util/util.js'
import AABBDevice from './aabb_device.js'

/* official integration exposes these:

event.device_201_notification
Device 201 Notification 
event_types: washing_is_complete, error_during_washing

number.device_201_delayed_end
Device 201 Delayed end
min: 0
max: 19
step: 1
mode: box
unit_of_measurement: h

sensor.device_201_delayed_end
Device 201 Delayed end
device_class: timestamp

sensor.device_201_total_time
Device 201 Total time 
unit_of_measurement: min
device_class: duration
friendly_name: Device 201 Total time

*/

// Names are based on the official ThinQ integration, the missing ones - on the values returned by the backend.
const ERRORS = [
    'ok',
    'door_lock_error', // DE2
    'door_open_error', // DE1
    'water_supply_error', // IE
    'water_drain_error', // OE
    'out_of_balance_error', // UE
    'overfill_error', // FE
    'water_level_sensor_error', // PE
    'temperature_sensor_error', // TE
    'locked_motor_error', // LE
    undefined,  
    'dHE_error',
    'power_fail_error', // PF
    'FF_error',
    'DCE_error',
    'AE_error',
    'eeprom_error',
    'PS_error',
    'door_sensor_error', // DE4
    'vibration_sensor_error',  // VS
    'LE8_error',
    'LE9_error',
    'ED1_error',
    'ED2_error',
    'ED3_error',
    'ED4_error',
    'ED5_error',
]

export const STATES = [
    'power_off',
    'initial',
    'pause',
    undefined,
    'detecting',
    undefined,
    'running',
    'rinsing',
    'spinning',
    'drying',
    'end',
    'cool_down',
    'rinse_hold',
    undefined,
    'refreshing',
    'steam_softening',
    'demo',
    undefined,
    'error',
    'auto_dt_open_pause'
]

export const COURSES: Record<number, string> = {
    0x01: 'Cotton',
    0x02: 'Cotton Eco',
    0x03: 'Easy Care',
    0x04: 'Delicates',
    0x05: 'Duvet',
    0x06: 'Wool',
    0x07: 'Mixed',
    0x08: 'Speed 14',
    0x09: 'Rinse+Spin',
    0x0A: 'Spin Only',
    0x0B: 'Drum Clean',
    0x3A: 'AI Wash',
}

export const SPIN_RPM: Record<number, number | undefined> = {
    0x00: 0,
    0x01: 0,
    0x02: 400,
    0x03: 600,
    0x04: 700,
    0x05: 800,
    0x06: 900,
    0x07: 1000,
    0x08: 1100,
    0x09: 1200,
}

export const TEMPS: Record<number, string> = {
    0x00: 'off',
    0x01: 'cold',
    0x02: '20',
    0x03: '30',
    0x04: '40',
    0x06: '60',
    0x07: '95',
}

export { ERRORS }

export interface Parsed53 {
    state: string
    remaining_time: number
    initial_time: number
    course: string
    error: string
    spin: number | string
    temperature: string
    cycles: number
    energy: number
    door_lock: boolean    // true = locked (bit clear), preserves existing "inverted" semantics
    remote_start: boolean
    flags1_raw: number
}

export function parse53Byte(buf: Buffer): Parsed53 | null {
    // Length discriminator via buf[3]=0x39 — strict to avoid shadowing 96-byte (buf[3]=0x60) etc.
    if(buf.length < 53) return null
    if(buf[0] !== 0x20 || buf[1] !== 0x0a || buf[3] !== 0x39) return null

    const status = buf[15]
    const tremain = buf[16] * 60 + buf[17]
    const tinitial = buf[18] * 60 + buf[19]
    const course = buf[20]
    const error = buf[21]
    const spin = buf[23]
    const temp = buf[24]
    const flags1_raw = buf[30]
    const cycles = buf[36]
    const energy = buf[44]

    return {
        state: STATES[status] ?? 'unknown_status',
        remaining_time: tremain,
        initial_time: tinitial,
        course: COURSES[course] ?? `unknown_${course.toString(16)}`,
        error: ERRORS[error] ?? 'unknown_error',
        spin: SPIN_RPM[spin] ?? (spin === 0xFF ? 'max' : spin * 100),
        temperature: TEMPS[temp] ?? `${temp * 10}`,
        cycles,
        energy,
        door_lock: !(flags1_raw & 0x40),  // existing: bit CLEAR = locked
        remote_start: (flags1_raw & 0x02) !== 0,
        flags1_raw,
    }
}

export interface Parsed65 {
    packet_type: '65_byte_short'
    counter: number
    model_name: string
    param_flag: number
    suffix_bytes: Buffer
}

export function parse65Byte(buf: Buffer): Parsed65 | null {
    // After AABBDevice.processData strip: FULL=65 → INNER=61 bytes.
    if(buf.length < 61) return null
    if(buf[0] !== 0x20 || buf[1] !== 0x0a || buf[3] !== 0x41) return null

    const modelName = buf.subarray(23, 23 + 18).toString('ascii').replace(/\0+$/, '')

    return {
        packet_type: '65_byte_short',
        counter: buf[7],
        model_name: modelName,
        param_flag: buf[18],
        suffix_bytes: buf.subarray(41),
    }
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, 'device', thinq)
        this.setConfig(allowExtendedType({
            ...HADevice.deviceConfig(meta, { name: "LG Washer" }),
            components: {
                power: {
                    platform: 'switch',
                    unique_id: '$deviceid-power',
                    state_topic: '$this/power',
                    command_topic: '$this/power/set',
                    name: 'Power',
                },
                status: {
                    platform: 'sensor',
                    unique_id: '$deviceid-status',
                    state_topic: '$this/status',
                    name: 'Current status',
                    options: [ ...STATES.filter((a) => a !== undefined), 'unknown_status' ]
                },
                error: {
                    platform: 'sensor',
                    unique_id: '$deviceid-error',
                    state_topic: '$this/error',
                    name: 'Error',
                    options: [ ...ERRORS.filter((a) => a !== undefined), 'unknown_error' ]
                },
                operation: {
                    platform: 'select',
                     unique_id: '$deviceid-operation',
                     command_topic: '$this/operation/set',
                     name: 'Operation',
                     options: [ 'start', 'stop', 'pause', 'power_off', 'wake_up' ]
                },
                cycles: {
                    platform: 'sensor',
                    unique_id: '$deviceid-cycles',
                    state_topic: '$this/cycles',
                    name: 'Cycle count',
                },
                remote_start: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-remote_start',
                    state_topic: '$this/remote_start',
                    name: 'Remote start'
                },
                door_lock: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-door_lock',
                    state_topic: '$this/door_lock',
                    name: 'Door lock',
                    device_class: 'lock' // inverted logic, off=locked
                },
                remaining_time: {
                    platform: 'sensor',
                    unique_id: '$deviceid-remaining_time',
                    state_topic: '$this/remaining_time',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    name: 'Remaining time'
                },
                initial_time: {
                    platform: 'sensor',
                    unique_id: '$deviceid-initial_time',
                    state_topic: '$this/initial_time',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    name: 'Total time'
                },
                course: {
                    platform: 'sensor',
                    unique_id: '$deviceid-course',
                    state_topic: '$this/course',
                    name: 'Program',
                },
                spin: {
                    platform: 'sensor',
                    unique_id: '$deviceid-spin',
                    state_topic: '$this/spin',
                    unit_of_measurement: 'rpm',
                    name: 'Spin speed',
                },
                temperature: {
                    platform: 'sensor',
                    unique_id: '$deviceid-temperature',
                    state_topic: '$this/temperature',
                    name: 'Wash temperature',
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
            }
        }))
    }

    start() {
        // this is only *slightly* different to the init string for the fridge                       
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    processAABB(buf: Buffer) {
        const parsed53 = parse53Byte(buf)
        if(parsed53) { this.publishParsed53(parsed53); return }

        const parsed65 = parse65Byte(buf)
        if(parsed65) { this.publishParsed65(parsed65); return }

        // Dispatcher extended in later tasks (96/134/138-byte parsers)
    }

    private publishParsed65(p: Parsed65) {
        this.publishProperty('param_flag', p.param_flag)
        this.publishProperty('model_name', p.model_name)
    }

    private publishParsed53(p: Parsed53) {
        this.publishProperty('power', p.state !== 'power_off' ? 'ON' : 'OFF')
        this.publishProperty('status', p.state)
        this.publishProperty('error', p.error)
        this.publishProperty('cycles', p.cycles)
        this.publishProperty('remote_start', p.remote_start ? 'ON' : 'OFF')
        this.publishProperty('door_lock', p.door_lock ? 'ON' : 'OFF')  // preserves existing: ON=locked
        this.publishProperty('remaining_time', p.remaining_time)
        this.publishProperty('initial_time', p.initial_time)
        this.publishProperty('course', p.course)
        this.publishProperty('spin', p.spin)
        this.publishProperty('temperature', p.temperature)
        this.publishProperty('energy', p.energy)
    }

    setProperty(prop: string, mqttValue: string) {
        if(prop === 'power' && mqttValue === 'OFF') {
            // only power-off is supported
            this.send(Buffer.from('f024010100', 'hex'))
        }

        if(prop === 'operation') {
            // options: [ 'start', 'stop', 'power_off', 'wake_up' ]
            if(mqttValue === 'start') {
                // this op. is complex, it needs to supply the full configuration
                console.warn('not supported yet')
            }

            if(mqttValue === 'pause')
                this.send(Buffer.from('F024040100', 'hex'))

            // this is actually 'pause'
            if(mqttValue === 'stop')
                this.send(Buffer.from('F024040100', 'hex'))

            if(mqttValue === 'power_off')
                this.send(Buffer.from('f024010100', 'hex'))

            if(mqttValue === 'wake_up')
                this.send(Buffer.from('F02A0100', 'hex'))
        }
    }
}
