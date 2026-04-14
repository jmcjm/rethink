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

// Flag byte decoders per wiki Appliance:Y_V8_Y___W.B32QEUK.md ascii-art layout.
// byte[29]: turboWash/creaseCare/steamSoftener/ecoHybrid/medicRinse/rinseSpin/preWash/steam
// byte[30]: initialBit/remoteStart/wrinkleCare/doorLock/childLock
// byte[31]: AIDD LED (bit 0x01)

export interface FlagsByte1 {
    turboWash: boolean
    creaseCare: boolean
    steamSoftener: boolean
    ecoHybrid: boolean
    medicRinse: boolean
    rinseSpin: boolean
    preWash: boolean
    steam: boolean
}

export function decodeFlagsByte1(b: number): FlagsByte1 {
    return {
        turboWash: (b & 0x01) !== 0,
        creaseCare: (b & 0x02) !== 0,
        steamSoftener: (b & 0x04) !== 0,
        ecoHybrid: (b & 0x08) !== 0,
        medicRinse: (b & 0x10) !== 0,
        rinseSpin: (b & 0x20) !== 0,
        preWash: (b & 0x40) !== 0,
        steam: (b & 0x80) !== 0,
    }
}

export interface FlagsByte2 {
    initialBit: boolean
    remoteStart: boolean
    wrinkleCare: boolean
    doorLock: boolean  // raw bit — SET = unlocked (inverted per HA lock device_class)
    childLock: boolean
}

export function decodeFlagsByte2(b: number): FlagsByte2 {
    return {
        initialBit: (b & 0x01) !== 0,
        remoteStart: (b & 0x02) !== 0,
        wrinkleCare: (b & 0x20) !== 0,
        doorLock: (b & 0x40) !== 0,
        childLock: (b & 0x80) !== 0,
    }
}

export function decodeAiddLed(b: number): boolean {
    return (b & 0x01) !== 0
}

export const CC_NAMES: Record<number, string> = {
    0x47: 'Baby Care',
    0x4D: 'Cold Wash',
    0x84: 'Silent Wash',
    0x49: 'Small Load',
    0x36: 'Swimming Wear',
    0x48: 'Hygiene',
}

export const CC_BY_NAME: Record<string, number> = Object.fromEntries(
    Object.entries(CC_NAMES).map(([hex, name]) => [name, Number(hex)])
)

export interface F025Params {
    program_id: number
    spin: number
    temp: number
    rinse: number
    flags_byte?: number
    cc?: number
}

export function buildF025Set(p: F025Params): Buffer {
    // 20-byte inner payload per wiki layout:
    // F0 25 03 15 <program> 03 <spin> <temp> <rinse> 00 00 00 00 <flags> 00 00 <cc> 00 00 00
    const buf = Buffer.alloc(20)
    buf[0] = 0xF0
    buf[1] = 0x25
    buf[2] = 0x03
    buf[3] = 0x15
    buf[4] = p.program_id
    buf[5] = 0x03
    buf[6] = p.spin
    buf[7] = p.temp
    buf[8] = p.rinse
    buf[13] = p.flags_byte ?? 0
    buf[16] = p.cc ?? 0
    return buf
}

export interface F026Params {
    program_id: number
    spin: number
    temp: number
    rinse: number
    delay?: number  // hours, 0-19
}

export function buildF026Start(p: F026Params): Buffer {
    // 18-byte inner payload, session-offset form:
    // F0 26 <program> 03 <spin> <temp> <rinse> 00 00 <delay> 00 00 0x03 00 00 00 00
    const buf = Buffer.alloc(18)
    buf[0] = 0xF0
    buf[1] = 0x26
    buf[2] = p.program_id
    buf[3] = 0x03
    buf[4] = p.spin
    buf[5] = p.temp
    buf[6] = p.rinse
    buf[9] = p.delay ?? 0
    buf[13] = 0x03  // session-confirmed magic byte
    return buf
}

export function buildF02APowerToggle(): Buffer {
    return Buffer.from([0xF0, 0x2A, 0x01, 0x00])
}

export function buildF024TurnOff(): Buffer {
    return Buffer.from([0xF0, 0x24, 0x01, 0x01, 0x00])
}

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
    door_lock: boolean
    remote_start: boolean
    child_lock: boolean
    wrinkle_care: boolean
    turbo_wash: boolean
    crease_care: boolean
    steam_softener: boolean
    eco_hybrid: boolean
    medic_rinse: boolean
    rinse_spin: boolean
    pre_wash: boolean
    steam: boolean
    aidd_led: boolean
    flags1_raw: number  // byte[29]
    flags2_raw: number  // byte[30]
    flags3_raw: number  // byte[31]
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
    const cycles = buf[36]
    const energy = buf[44]

    const flags1_raw = buf[29]
    const flags2_raw = buf[30]
    const flags3_raw = buf[31]
    const f1 = decodeFlagsByte1(flags1_raw)
    const f2 = decodeFlagsByte2(flags2_raw)
    const aidd_led = decodeAiddLed(flags3_raw)

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
        door_lock: !f2.doorLock,  // inverted: bit CLEAR = locked = ON in HA
        remote_start: f2.remoteStart,
        child_lock: f2.childLock,
        wrinkle_care: f2.wrinkleCare,
        turbo_wash: f1.turboWash,
        crease_care: f1.creaseCare,
        steam_softener: f1.steamSoftener,
        eco_hybrid: f1.ecoHybrid,
        medic_rinse: f1.medicRinse,
        rinse_spin: f1.rinseSpin,
        pre_wash: f1.preWash,
        steam: f1.steam,
        aidd_led,
        flags1_raw,
        flags2_raw,
        flags3_raw,
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

export interface Parsed96 {
    packet_type: '96_byte_extended'
    active_program: {
        program_id: number
        spin: number
        temp: number
        rinse: number
        cc: number
    }
}

export function parse96Byte(buf: Buffer): Parsed96 | null {
    // FULL=96 → INNER=92 bytes after AABBDevice strip.
    // Layout from session capture 2026-04-13: staged program echoed at inner[62..67],
    // cc at inner[77]. Q-item: re-verify offsets with more captures.
    if(buf.length < 92) return null
    if(buf[0] !== 0x20 || buf[1] !== 0x0a || buf[3] !== 0x60) return null

    return {
        packet_type: '96_byte_extended',
        active_program: {
            program_id: buf[62],
            spin: buf[65],
            temp: buf[66],
            rinse: buf[67],
            cc: buf[77],
        },
    }
}

export interface Parsed134 {
    packet_type: '134_byte_counters'
    counter_28: number
    counter_29_30: number
}

export function parse134Byte(buf: Buffer): Parsed134 | null {
    if(buf.length < 130) return null
    if(buf[0] !== 0x20 || buf[1] !== 0x0a || buf[3] !== 0x86) return null
    return {
        packet_type: '134_byte_counters',
        counter_28: buf[28],
        counter_29_30: (buf[29] << 8) | buf[30],
    }
}

export interface Parsed138 {
    packet_type: '138_byte_diagnostic'
    cycle_counter: number
    cumulative_energy: number
    sensor_temps: Buffer
}

export function parse138Byte(buf: Buffer): Parsed138 | null {
    if(buf.length < 134) return null
    if(buf[0] !== 0x20 || buf[1] !== 0x0a || buf[3] !== 0x8a) return null
    return {
        packet_type: '138_byte_diagnostic',
        cycle_counter: buf[120],
        cumulative_energy: (buf[91] << 8) | buf[92],
        sensor_temps: buf.subarray(33, 43),
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
                child_lock: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-child_lock',
                    state_topic: '$this/child_lock',
                    name: 'Child lock',
                },
                wrinkle_care: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-wrinkle_care',
                    state_topic: '$this/wrinkle_care',
                    name: 'Wrinkle care',
                },
                turbo_wash: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-turbo_wash',
                    state_topic: '$this/turbo_wash',
                    name: 'Turbo wash',
                },
                crease_care: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-crease_care',
                    state_topic: '$this/crease_care',
                    name: 'Crease care',
                },
                steam_softener: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-steam_softener',
                    state_topic: '$this/steam_softener',
                    name: 'Steam softener',
                },
                eco_hybrid: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-eco_hybrid',
                    state_topic: '$this/eco_hybrid',
                    name: 'Eco hybrid',
                },
                medic_rinse: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-medic_rinse',
                    state_topic: '$this/medic_rinse',
                    name: 'Medic rinse',
                },
                rinse_spin: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-rinse_spin',
                    state_topic: '$this/rinse_spin',
                    name: 'Rinse+spin',
                },
                pre_wash: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-pre_wash',
                    state_topic: '$this/pre_wash',
                    name: 'Pre-wash',
                },
                steam: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-steam',
                    state_topic: '$this/steam',
                    name: 'Steam',
                },
                aidd_led: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-aidd_led',
                    state_topic: '$this/aidd_led',
                    name: 'AIDD LED',
                    entity_category: 'diagnostic',
                },
                active_program_id: {
                    platform: 'sensor',
                    unique_id: '$deviceid-active_program_id',
                    state_topic: '$this/active_program_id',
                    name: 'Active program ID',
                    entity_category: 'diagnostic',
                },
                active_program_name: {
                    platform: 'sensor',
                    unique_id: '$deviceid-active_program_name',
                    state_topic: '$this/active_program_name',
                    name: 'Active program',
                },
                active_spin: {
                    platform: 'sensor',
                    unique_id: '$deviceid-active_spin',
                    state_topic: '$this/active_spin',
                    unit_of_measurement: 'rpm',
                    name: 'Active spin',
                },
                active_temp: {
                    platform: 'sensor',
                    unique_id: '$deviceid-active_temp',
                    state_topic: '$this/active_temp',
                    name: 'Active temperature',
                },
                active_rinse: {
                    platform: 'sensor',
                    unique_id: '$deviceid-active_rinse',
                    state_topic: '$this/active_rinse',
                    name: 'Active rinse',
                },
                active_cc: {
                    platform: 'sensor',
                    unique_id: '$deviceid-active_cc',
                    state_topic: '$this/active_cc',
                    name: 'Active custom course',
                    entity_category: 'diagnostic',
                },
                cycles_lifetime: {
                    platform: 'sensor',
                    unique_id: '$deviceid-cycles_lifetime',
                    state_topic: '$this/cycles_lifetime',
                    state_class: 'total_increasing',
                    name: 'Lifetime cycles',
                    entity_category: 'diagnostic',
                },
                energy_cumulative: {
                    platform: 'sensor',
                    unique_id: '$deviceid-energy_cumulative',
                    state_topic: '$this/energy_cumulative',
                    device_class: 'energy',
                    state_class: 'total_increasing',
                    unit_of_measurement: 'Wh',
                    name: 'Cumulative energy',
                },
                sensor_temps_raw: {
                    platform: 'sensor',
                    unique_id: '$deviceid-sensor_temps_raw',
                    state_topic: '$this/sensor_temps_raw',
                    name: 'Sensor temps (raw hex)',
                    entity_category: 'diagnostic',
                },
                model_name: {
                    platform: 'sensor',
                    unique_id: '$deviceid-model_name',
                    state_topic: '$this/model_name',
                    name: 'Model name',
                    entity_category: 'diagnostic',
                },
                param_flag: {
                    platform: 'sensor',
                    unique_id: '$deviceid-param_flag',
                    state_topic: '$this/param_flag',
                    name: 'Param flag',
                    entity_category: 'diagnostic',
                },
                stat_counter_28: {
                    platform: 'sensor',
                    unique_id: '$deviceid-stat_counter_28',
                    state_topic: '$this/stat_counter_28',
                    name: 'Stat counter 28',
                    entity_category: 'diagnostic',
                },
                stat_counter_29_30: {
                    platform: 'sensor',
                    unique_id: '$deviceid-stat_counter_29_30',
                    state_topic: '$this/stat_counter_29_30',
                    name: 'Stat counter 29-30',
                    entity_category: 'diagnostic',
                },
                stage_program: {
                    platform: 'select',
                    unique_id: '$deviceid-stage_program',
                    state_topic: '$this/stage_program',
                    command_topic: '$this/stage_program/set',
                    name: 'Staged: Program',
                    options: Object.values(COURSES),
                },
                stage_spin: {
                    platform: 'select',
                    unique_id: '$deviceid-stage_spin',
                    state_topic: '$this/stage_spin',
                    command_topic: '$this/stage_spin/set',
                    name: 'Staged: Spin',
                    options: ['no_spin', '400', '600', '700', '800', '900', '1000', '1100', '1200', 'max'],
                },
                stage_temp: {
                    platform: 'select',
                    unique_id: '$deviceid-stage_temp',
                    state_topic: '$this/stage_temp',
                    command_topic: '$this/stage_temp/set',
                    name: 'Staged: Temp',
                    options: ['cold', '20', '30', '40', '60', '95'],
                },
                stage_rinse: {
                    platform: 'select',
                    unique_id: '$deviceid-stage_rinse',
                    state_topic: '$this/stage_rinse',
                    command_topic: '$this/stage_rinse/set',
                    name: 'Staged: Rinse',
                    options: ['normal', 'rinse_plus'],
                },
                stage_cc: {
                    platform: 'text',
                    unique_id: '$deviceid-stage_cc',
                    state_topic: '$this/stage_cc',
                    command_topic: '$this/stage_cc/set',
                    name: 'Staged: Custom course (hex)',
                    pattern: '^[0-9a-fA-F]{1,2}$',
                },
                stage_delay: {
                    platform: 'number',
                    unique_id: '$deviceid-stage_delay',
                    state_topic: '$this/stage_delay',
                    command_topic: '$this/stage_delay/set',
                    name: 'Staged: Delay (hours)',
                    min: 0,
                    max: 19,
                    step: 1,
                },
                set_program: {
                    platform: 'button',
                    unique_id: '$deviceid-set_program',
                    command_topic: '$this/set_program/press',
                    name: 'Set staged program (F025)',
                },
                start_program: {
                    platform: 'button',
                    unique_id: '$deviceid-start_program',
                    command_topic: '$this/start_program/press',
                    name: 'Start staged program (F026)',
                },
                power_toggle_btn: {
                    platform: 'button',
                    unique_id: '$deviceid-power_toggle_btn',
                    command_topic: '$this/power_toggle_btn/press',
                    name: 'Power toggle (F02A)',
                },
                turn_off_btn: {
                    platform: 'button',
                    unique_id: '$deviceid-turn_off_btn',
                    command_topic: '$this/turn_off_btn/press',
                    name: 'Turn off (F024)',
                },
            }
        }))
    }

    private staged: {
        program?: string
        spin?: string
        temp?: string
        rinse?: string
        cc?: string
        delay?: number
    } = {}

    private programNameToId(name: string): number | undefined {
        for(const [id, n] of Object.entries(COURSES)) {
            if(n === name) return Number(id)
        }
        return undefined
    }

    private spinStringToByte(s: string): number {
        if(s === 'no_spin') return 0x01
        if(s === 'max') return 0xFF
        const rpm = Number(s)
        for(const [b, r] of Object.entries(SPIN_RPM)) {
            if(r === rpm) return Number(b)
        }
        return 0x07
    }

    private tempStringToByte(s: string): number {
        if(s === 'cold') return 0x01
        for(const [b, t] of Object.entries(TEMPS)) {
            if(t === s) return Number(b)
        }
        return 0x02
    }

    private rinseStringToByte(s: string): number {
        if(s === 'rinse_plus') return 0x02
        return 0x01
    }

    private stagedToF025Params(): F025Params | null {
        const s = this.staged
        if(!s.program) return null
        const program_id = this.programNameToId(s.program)
        if(program_id === undefined) return null
        return {
            program_id,
            spin: this.spinStringToByte(s.spin ?? '1000'),
            temp: this.tempStringToByte(s.temp ?? 'cold'),
            rinse: this.rinseStringToByte(s.rinse ?? 'normal'),
            cc: s.cc ? parseInt(s.cc, 16) : 0,
        }
    }

    private stagedToF026Params(): F026Params | null {
        const s = this.staged
        if(!s.program) return null
        const program_id = this.programNameToId(s.program)
        if(program_id === undefined) return null
        return {
            program_id,
            spin: this.spinStringToByte(s.spin ?? '1000'),
            temp: this.tempStringToByte(s.temp ?? 'cold'),
            rinse: this.rinseStringToByte(s.rinse ?? 'normal'),
            delay: s.delay ?? 0,
        }
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

        const parsed96 = parse96Byte(buf)
        if(parsed96) { this.publishParsed96(parsed96); return }

        const parsed134 = parse134Byte(buf)
        if(parsed134) { this.publishParsed134(parsed134); return }

        const parsed138 = parse138Byte(buf)
        if(parsed138) { this.publishParsed138(parsed138); return }

        // Unknown packet type — log for later reverse-engineering (83/76/87/99/... observed in captures)
        console.log(`[washer ${this.id}] unknown packet len=${buf.length} buf[3]=0x${buf[3]?.toString(16)} hex=${buf.toString('hex').slice(0, 48)}...`)
    }

    private publishParsed134(p: Parsed134) {
        this.publishProperty('stat_counter_28', p.counter_28)
        this.publishProperty('stat_counter_29_30', p.counter_29_30)
    }

    private publishParsed138(p: Parsed138) {
        this.publishProperty('cycles_lifetime', p.cycle_counter)
        this.publishProperty('energy_cumulative', p.cumulative_energy)
        this.publishProperty('sensor_temps_raw', p.sensor_temps.toString('hex'))
    }

    private publishParsed65(p: Parsed65) {
        this.publishProperty('param_flag', p.param_flag)
        this.publishProperty('model_name', p.model_name)
    }

    private publishParsed96(p: Parsed96) {
        const ap = p.active_program
        this.publishProperty('active_program_id', `0x${ap.program_id.toString(16).padStart(2,'0')}`)
        this.publishProperty('active_program_name', COURSES[ap.program_id] ?? `unknown_${ap.program_id.toString(16)}`)
        this.publishProperty('active_spin', SPIN_RPM[ap.spin] ?? (ap.spin === 0xFF ? 'max' : ap.spin * 100))
        this.publishProperty('active_temp', TEMPS[ap.temp] ?? `${ap.temp}`)
        this.publishProperty('active_rinse', ap.rinse)
        this.publishProperty('active_cc', `0x${ap.cc.toString(16).padStart(2,'0')}`)
    }

    private publishParsed53(p: Parsed53) {
        this.publishProperty('power', p.state !== 'power_off' ? 'ON' : 'OFF')
        this.publishProperty('status', p.state)
        this.publishProperty('error', p.error)
        this.publishProperty('cycles', p.cycles)
        this.publishProperty('remote_start', p.remote_start ? 'ON' : 'OFF')
        this.publishProperty('door_lock', p.door_lock ? 'ON' : 'OFF')  // ON=locked preserved
        this.publishProperty('child_lock', p.child_lock ? 'ON' : 'OFF')
        this.publishProperty('wrinkle_care', p.wrinkle_care ? 'ON' : 'OFF')
        this.publishProperty('turbo_wash', p.turbo_wash ? 'ON' : 'OFF')
        this.publishProperty('crease_care', p.crease_care ? 'ON' : 'OFF')
        this.publishProperty('steam_softener', p.steam_softener ? 'ON' : 'OFF')
        this.publishProperty('eco_hybrid', p.eco_hybrid ? 'ON' : 'OFF')
        this.publishProperty('medic_rinse', p.medic_rinse ? 'ON' : 'OFF')
        this.publishProperty('rinse_spin', p.rinse_spin ? 'ON' : 'OFF')
        this.publishProperty('pre_wash', p.pre_wash ? 'ON' : 'OFF')
        this.publishProperty('steam', p.steam ? 'ON' : 'OFF')
        this.publishProperty('aidd_led', p.aidd_led ? 'ON' : 'OFF')
        this.publishProperty('remaining_time', p.remaining_time)
        this.publishProperty('initial_time', p.initial_time)
        this.publishProperty('course', p.course)
        this.publishProperty('spin', p.spin)
        this.publishProperty('temperature', p.temperature)
        this.publishProperty('energy', p.energy)
    }

    setProperty(prop: string, mqttValue: string) {
        // Power OFF
        if(prop === 'power' && mqttValue === 'OFF') {
            this.send(buildF024TurnOff())
            return
        }

        // Operation select (pause/stop/power_off/wake_up)
        if(prop === 'operation') {
            if(mqttValue === 'pause' || mqttValue === 'stop') {
                this.send(Buffer.from('F024040100', 'hex'))
            }
            if(mqttValue === 'power_off') this.send(buildF024TurnOff())
            if(mqttValue === 'wake_up') this.send(buildF02APowerToggle())
            return
        }

        // Staged values — cache and echo to state_topic so HA UI reflects current selection
        if(prop.startsWith('stage_')) {
            const key = prop.slice('stage_'.length)
            if(key === 'delay') {
                this.staged.delay = Number(mqttValue)
            } else {
                (this.staged as any)[key] = mqttValue
            }
            this.HA.publishProperty(this.id, prop, mqttValue)
            return
        }

        // Button handlers — build & send packets from staged cache
        if(prop === 'set_program') {
            const params = this.stagedToF025Params()
            if(params) this.send(buildF025Set(params))
            return
        }
        if(prop === 'start_program') {
            const params = this.stagedToF026Params()
            if(params) this.send(buildF026Start(params))
            return
        }
        if(prop === 'power_toggle_btn') {
            this.send(buildF02APowerToggle())
            return
        }
        if(prop === 'turn_off_btn') {
            this.send(buildF024TurnOff())
            return
        }
    }
}
