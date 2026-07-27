import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { ERRORS, STATES } from './washer_common'
import log from '@/util/logging'

// LG Y_V8_Y___W.B32QEUK front-load washer (EU unit).
// Protocol documentation: wiki Appliance:Y_V8_Y___W.B32QEUK.md — 53-byte status layout,
// 65/96/134/138-byte auxiliary packets, F024/F025/F026/F02A command formats.

// Course map for the EU unit, established 2026-04-15 by rotating the physical dial
// through every labelled slot while capturing internal MQTT. The shared washer_common
// COURSES table does not match this unit (e.g. 0x05 is the Drum Clean dial slot here,
// not Duvet) — the same modelId appears to use region-dependent course tables.
export const COURSES: Record<number, string> = {
    0x01: 'Cotton',
    0x02: 'Synthetics',
    0x04: 'Eco 40-60',
    0x05: 'Drum Clean',
    0x07: 'Mixed',
    0x08: 'Speed 14',
    0x0c: 'Bedding',
    0x1b: 'Sportswear',
    0x20: 'Delicates', // Hand/Wool shares 0x20; distinguished only by inner[62] of the 96-byte packet
    0x2d: 'Hygiene', // steam auto-enabled
    0x31: 'TurboWash 39', // turboWash auto-enabled
    0x3a: 'AI Wash', // AIDD LED auto-enabled
    // Wiki-derived, not verified on this unit:
    0x03: 'Easy Care',
    0x06: 'Wool',
    0x09: 'Rinse+Spin',
    0x0a: 'Spin Only',
}

// max is model-dependent; on this unit 0xFF selects 1400 rpm.
export const SPIN_RPM: Record<number, number> = {
    0x01: 0, // no spin (drain only)
    0x02: 400,
    0x03: 600,
    0x04: 700,
    0x05: 800,
    0x06: 900,
    0x07: 1000,
    0x08: 1100,
    0x09: 1200,
}

export const TEMP_NAMES: Record<number, string> = {
    0x00: 'Not selected',
    0x01: 'Cold',
    0x02: '20',
    0x03: '30',
    0x04: '40',
    0x06: '60',
    0x07: '95',
}

// Downloadable courses installed via the ThinQ app (F025 with a CC id at inner[16]).
export const CC_NAMES: Record<number, string> = {
    0x36: 'Swimming Wear',
    0x3e: 'Single Garment',
    0x47: 'Baby Care',
    0x48: 'Hygiene',
    0x49: 'Small Load',
    0x4d: 'Cold Wash',
    0x84: 'Silent Wash',
}

export interface F025Params {
    program_id: number
    spin: number
    temp: number
    rinse: number
    flags_byte?: number // inner[13]: 01=turboWash 10=medicRinse 40=preWash 80=steam
    secondary?: number // inner[14]: secondary program parameter, preserve the byte the app emits
    cc?: number // inner[16]: downloadable course id
}

// F025 "set program without starting", 20-byte inner payload:
// F0 25 03 15 [program] 03 [spin] [temp] [rinse] 00*4 [flags] [secondary] 00 [cc] 00 00 00
export function buildF025Set(p: F025Params): Buffer {
    const buf = Buffer.alloc(20)
    buf[0] = 0xf0
    buf[1] = 0x25
    buf[2] = 0x03
    buf[3] = 0x15
    buf[4] = p.program_id
    buf[5] = 0x03
    buf[6] = p.spin
    buf[7] = p.temp
    buf[8] = p.rinse
    buf[13] = p.flags_byte ?? 0
    buf[14] = p.secondary ?? 0
    buf[16] = p.cc ?? 0
    return buf
}

export interface F026Params {
    program_id: number
    spin: number
    temp: number
    rinse: number
    // Hours until cycle END, 0-19. Offset [9] follows from the byte[13]-magic layout
    // (older wiki examples place delay at [8] with the magic at [12]); a delayed start
    // has not been session-verified yet.
    delay?: number
}

// F026 "start program", 18-byte inner payload. The washer has no bare "start current
// program" opcode — the full program configuration is sent. The fixed 0x03 sits at
// inner[13] (session-verified 2026-04-13; wiki examples showing byte[12] are unconfirmed).
export function buildF026Start(p: F026Params): Buffer {
    const buf = Buffer.alloc(18)
    buf[0] = 0xf0
    buf[1] = 0x26
    buf[2] = p.program_id
    buf[3] = 0x03
    buf[4] = p.spin
    buf[5] = p.temp
    buf[6] = p.rinse
    buf[9] = p.delay ?? 0
    buf[13] = 0x03
    return buf
}

export function buildF02APowerToggle(): Buffer {
    return Buffer.from([0xf0, 0x2a, 0x01, 0x00])
}

export function buildF024TurnOff(): Buffer {
    return Buffer.from([0xf0, 0x24, 0x01, 0x01, 0x00])
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: '',
                        icon: 'mdi:washing-machine',
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: '',
                        name: 'Start',
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
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATES.filter((a) => a !== undefined),
                    },
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        icon: 'mdi:check-circle',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error-message',
                        state_topic: '$this/error_message',
                        name: 'Error message',
                        icon: 'mdi:alert-circle-outline',
                        device_class: 'enum',
                        entity_category: 'diagnostic',
                        options: ERRORS.filter((a) => a !== undefined),
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                    },
                    cycles: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycles',
                        state_topic: '$this/cycles',
                        name: 'Cycle count',
                        icon: 'mdi:counter',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:play-circle-outline',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        device_class: 'lock',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:account-lock-outline',
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
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Initial time',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Remaining time',
                    },
                    // program option flags decoded from status bytes [29]/[30]/[31]
                    turbo_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_wash',
                        state_topic: '$this/turbo_wash',
                        name: 'Turbo wash',
                        icon: 'mdi:weather-windy',
                    },
                    crease_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-crease_care',
                        state_topic: '$this/crease_care',
                        name: 'Crease care',
                        icon: 'mdi:iron-outline',
                    },
                    steam_softener: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam_softener',
                        state_topic: '$this/steam_softener',
                        name: 'Steam softener',
                        icon: 'mdi:heat-wave',
                    },
                    eco_hybrid: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-eco_hybrid',
                        state_topic: '$this/eco_hybrid',
                        name: 'Eco hybrid',
                        icon: 'mdi:leaf',
                    },
                    medic_rinse: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-medic_rinse',
                        state_topic: '$this/medic_rinse',
                        name: 'Medic rinse',
                        icon: 'mdi:water-plus-outline',
                    },
                    rinse_spin: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-rinse_spin',
                        state_topic: '$this/rinse_spin',
                        name: 'Rinse+spin',
                        icon: 'mdi:rotate-right',
                    },
                    pre_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-pre_wash',
                        state_topic: '$this/pre_wash',
                        name: 'Pre-wash',
                        icon: 'mdi:water-outline',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:heat-wave',
                    },
                    wrinkle_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        name: 'Wrinkle care',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    aidd_led: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-aidd_led',
                        state_topic: '$this/aidd_led',
                        name: 'AIDD LED',
                        icon: 'mdi:led-on',
                        entity_category: 'diagnostic',
                    },
                    downloaded_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-downloaded_course',
                        state_topic: '$this/downloaded_course',
                        name: 'Downloaded course',
                        icon: 'mdi:download-circle-outline',
                        entity_category: 'diagnostic',
                    },
                    // 65-byte packet
                    model_name: {
                        platform: 'sensor',
                        unique_id: '$deviceid-model_name',
                        state_topic: '$this/model_name',
                        name: 'Model name',
                        icon: 'mdi:tag-outline',
                        entity_category: 'diagnostic',
                    },
                    // 96-byte packet, staged program echo at inner[62..67]/[77]
                    staged_program_raw: {
                        platform: 'sensor',
                        unique_id: '$deviceid-staged_program_raw',
                        state_topic: '$this/staged_program_raw',
                        name: 'Staged program (raw)',
                        icon: 'mdi:code-braces',
                        entity_category: 'diagnostic',
                    },
                    staged_cc: {
                        platform: 'sensor',
                        unique_id: '$deviceid-staged_cc',
                        state_topic: '$this/staged_cc',
                        name: 'Staged downloadable course',
                        icon: 'mdi:download-circle-outline',
                        entity_category: 'diagnostic',
                    },
                    // 134/138-byte diagnostic packets
                    cycles_lifetime: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycles_lifetime',
                        state_topic: '$this/cycles_lifetime',
                        state_class: 'total_increasing',
                        name: 'Lifetime cycles',
                        icon: 'mdi:counter',
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
                        entity_category: 'diagnostic',
                    },
                    sensor_temps_raw: {
                        platform: 'sensor',
                        unique_id: '$deviceid-sensor_temps_raw',
                        state_topic: '$this/sensor_temps_raw',
                        name: 'Sensor temperatures (raw hex)',
                        icon: 'mdi:thermometer-lines',
                        entity_category: 'diagnostic',
                    },
                    // remote program staging: pick program/spin/temp/rinse/delay in HA,
                    // then push it with the set/start buttons below
                    stage_program: {
                        platform: 'select',
                        unique_id: '$deviceid-stage_program',
                        state_topic: '$this/stage_program',
                        command_topic: '$this/stage_program/set',
                        name: 'Staged: Program',
                        icon: 'mdi:format-list-bulleted',
                        options: Object.values(COURSES),
                    },
                    stage_spin: {
                        platform: 'select',
                        unique_id: '$deviceid-stage_spin',
                        state_topic: '$this/stage_spin',
                        command_topic: '$this/stage_spin/set',
                        name: 'Staged: Spin',
                        icon: 'mdi:autorenew',
                        options: ['No spin', '400', '600', '700', '800', '900', '1000', '1100', '1200', 'max'],
                    },
                    stage_temp: {
                        platform: 'select',
                        unique_id: '$deviceid-stage_temp',
                        state_topic: '$this/stage_temp',
                        command_topic: '$this/stage_temp/set',
                        name: 'Staged: Temperature',
                        icon: 'mdi:thermometer',
                        options: ['Cold', '20', '30', '40', '60', '95'],
                    },
                    stage_rinse: {
                        platform: 'select',
                        unique_id: '$deviceid-stage_rinse',
                        state_topic: '$this/stage_rinse',
                        command_topic: '$this/stage_rinse/set',
                        name: 'Staged: Rinse',
                        icon: 'mdi:water-sync',
                        options: ['Normal', 'Rinse+'],
                    },
                    stage_delay: {
                        platform: 'number',
                        unique_id: '$deviceid-stage_delay',
                        state_topic: '$this/stage_delay',
                        command_topic: '$this/stage_delay/set',
                        name: 'Staged: Delay (h)',
                        icon: 'mdi:timer-outline',
                        min: 0,
                        max: 19,
                        step: 1,
                    },
                    stage_cc: {
                        platform: 'text',
                        unique_id: '$deviceid-stage_cc',
                        state_topic: '$this/stage_cc',
                        command_topic: '$this/stage_cc/set',
                        name: 'Staged: Course CC (hex)',
                        icon: 'mdi:code-tags',
                        pattern: '^[0-9a-fA-F]{0,2}$',
                    },
                    set_program: {
                        platform: 'button',
                        unique_id: '$deviceid-set_program',
                        command_topic: '$this/set_program/set',
                        payload_press: '',
                        name: 'Set staged program',
                        icon: 'mdi:upload-outline',
                    },
                    start_program: {
                        platform: 'button',
                        unique_id: '$deviceid-start_program',
                        command_topic: '$this/start_program/set',
                        payload_press: '',
                        name: 'Start staged program',
                        icon: 'mdi:play-box-outline',
                    },
                    power_toggle: {
                        platform: 'button',
                        unique_id: '$deviceid-power_toggle',
                        command_topic: '$this/power_toggle/set',
                        payload_press: '',
                        name: 'Power toggle',
                        icon: 'mdi:power-cycle',
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

    private staged: {
        program?: string
        spin?: string
        temp?: string
        rinse?: string
        cc?: string
        delay?: number
    } = {}

    start() {
        // this is only *slightly* different to the init string for the fridge
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf.length < 4 || buf[0] != 0x20 || buf[1] != 0x0a) return

        // inner[3] discriminates the packet type (0x39/0x41/0x60/0x86/0x8a for the
        // 53/65/96/134/138-byte packets respectively, named after their raw lengths)
        switch (buf[3]) {
            case 0x39:
                if (buf.length >= 53) this.parseStatus(buf)
                return
            case 0x41:
                if (buf.length >= 61) this.parseModelInfo(buf)
                return
            case 0x60:
                if (buf.length >= 92) this.parseStagedEcho(buf)
                return
            case 0x86:
                if (buf.length >= 130) this.parseCounters(buf)
                return
            case 0x8a:
                if (buf.length >= 134) this.parseDiagnostics(buf)
                return
            default:
                log('status', `B32QEUK unknown packet len=${buf.length} type=0x${buf[3]?.toString(16)}`)
        }
    }

    // 53-byte status packet — the primary state report
    parseStatus(buf: Buffer) {
        const status = buf[15]
        const time_remain = buf[16] * 60 + buf[17]
        const time_initial = buf[18] * 60 + buf[19]
        const course = buf[20]
        const error = buf[21]
        const spin = buf[23]
        const temp = buf[24]
        const flags1 = buf[29] // 01=turboWash 02=creaseCare 04=steamSoftener 08=ecoHybrid 10=medicRinse 20=rinseSpin 40=preWash 80=steam
        const flags2 = buf[30] // 01=initialBit 02=remoteStart 20=wrinkleCare 40=doorLock 80=childLock
        const flags3 = buf[31] // 01=AIDDLed
        const cycles = buf[36]
        const downloadedCC = buf[38]
        const energy = buf[44] // per-cycle Wh, resets to 0 at cycle start

        this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
        this.publishProperty('error_message', ERRORS[error] ?? 'unknown') // publish message before set error state
        this.publishProperty('error', error ? 'ON' : 'OFF')
        this.publishProperty('status', STATES[status] ?? 'unknown')
        this.publishProperty('course', course ? (COURSES[course] ?? `unknown (0x${course.toString(16)})`) : 'None')
        this.publishProperty('spin', spin === 0xff ? 'max' : spin === 0 ? 'Not selected' : (SPIN_RPM[spin] ?? spin))
        this.publishProperty('temp', TEMP_NAMES[temp] ?? `unknown (0x${temp.toString(16)})`)
        this.publishProperty('cycles', cycles)
        this.publishProperty('remote_start', flags2 & 0x02 ? 'ON' : 'OFF')
        this.publishProperty('door_lock', !(flags2 & 0x40) ? 'ON' : 'OFF') // inverted logic, off=locked
        this.publishProperty('child_lock', flags2 & 0x80 ? 'ON' : 'OFF')
        this.publishProperty('wrinkle_care', flags2 & 0x20 ? 'ON' : 'OFF')
        this.publishProperty('turbo_wash', flags1 & 0x01 ? 'ON' : 'OFF')
        this.publishProperty('crease_care', flags1 & 0x02 ? 'ON' : 'OFF')
        this.publishProperty('steam_softener', flags1 & 0x04 ? 'ON' : 'OFF')
        this.publishProperty('eco_hybrid', flags1 & 0x08 ? 'ON' : 'OFF')
        this.publishProperty('medic_rinse', flags1 & 0x10 ? 'ON' : 'OFF')
        this.publishProperty('rinse_spin', flags1 & 0x20 ? 'ON' : 'OFF')
        this.publishProperty('pre_wash', flags1 & 0x40 ? 'ON' : 'OFF')
        this.publishProperty('steam', flags1 & 0x80 ? 'ON' : 'OFF')
        this.publishProperty('aidd_led', flags3 & 0x01 ? 'ON' : 'OFF')
        this.publishProperty(
            'downloaded_course',
            downloadedCC ? (CC_NAMES[downloadedCC] ?? `unknown (0x${downloadedCC.toString(16)})`) : 'None',
        )
        this.publishProperty('initial_time', time_initial)
        this.publishProperty('remaining_time', time_remain)
        this.publishProperty('energy', energy)
    }

    // 65-byte packet: model name + parameter flag
    parseModelInfo(buf: Buffer) {
        const modelName = buf.subarray(23, 41).toString('ascii').replace(/\0+$/, '')
        if (modelName) this.publishProperty('model_name', modelName)
    }

    // 96-byte packet: staged program echo at inner[62..67], CC at inner[77].
    // inner[62] semantics are only partially understood (it lags F025 and is NOT the
    // same id space as the 53-byte course field) — exposed raw for diagnostics.
    parseStagedEcho(buf: Buffer) {
        const prog = buf[62]
        const spin = buf[65]
        const temp = buf[66]
        const rinse = buf[67]
        const cc = buf[77]
        this.publishProperty(
            'staged_program_raw',
            `prog=0x${prog.toString(16).padStart(2, '0')} spin=0x${spin.toString(16).padStart(2, '0')} ` +
                `temp=0x${temp.toString(16).padStart(2, '0')} rinse=0x${rinse.toString(16).padStart(2, '0')}`,
        )
        this.publishProperty('staged_cc', cc ? (CC_NAMES[cc] ?? `unknown (0x${cc.toString(16)})`) : 'None')
    }

    // 134-byte packet: statistics counters (partially decoded)
    parseCounters(buf: Buffer) {
        // wiki documents these at raw offsets 28/29-30; inner offsets are 2 lower
        void buf[26] // counter observed at 0x82=130, semantics unknown — not published yet
        void ((buf[27] << 8) | buf[28])
    }

    // 138-byte packet: live diagnostics
    parseDiagnostics(buf: Buffer) {
        // wiki documents raw offsets 33-42 (temps), 91-92 (cumulative Wh), 120 (cycles);
        // inner offsets are 2 lower
        const temps = buf.subarray(31, 41)
        const cumulativeEnergy = (buf[89] << 8) | buf[90]
        const lifetimeCycles = buf[118]

        this.publishProperty('sensor_temps_raw', temps.toString('hex'))
        this.publishProperty('cycles_lifetime', lifetimeCycles)
        if (cumulativeEnergy) this.publishProperty('energy_cumulative', cumulativeEnergy)
    }

    private programNameToId(name: string): number | undefined {
        for (const [id, n] of Object.entries(COURSES)) {
            if (n === name) return Number(id)
        }
        return undefined
    }

    private spinNameToByte(s: string): number {
        if (s === 'No spin') return 0x01
        if (s === 'max') return 0xff
        const rpm = Number(s)
        for (const [b, r] of Object.entries(SPIN_RPM)) {
            if (r === rpm) return Number(b)
        }
        return 0x07
    }

    private tempNameToByte(s: string): number {
        for (const [b, t] of Object.entries(TEMP_NAMES)) {
            if (t === s) return Number(b)
        }
        return 0x01
    }

    private stagedParams() {
        const s = this.staged
        if (!s.program) return undefined
        const program_id = this.programNameToId(s.program)
        if (program_id === undefined) return undefined
        return {
            program_id,
            spin: this.spinNameToByte(s.spin ?? '1000'),
            temp: this.tempNameToByte(s.temp ?? 'Cold'),
            rinse: s.rinse === 'Rinse+' ? 0x02 : 0x01,
        }
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power') {
            if (mqttValue === 'ON') {
                this.send(buildF02APowerToggle())
            } else if (mqttValue === 'OFF') {
                this.send(buildF024TurnOff())
            }
            return
        }

        if (prop === 'pause') {
            this.send(Buffer.from('F024040100', 'hex'))
            return
        }
        if (prop === 'start') {
            this.send(Buffer.from(mqttValue || 'F024050100', 'hex'))
            return
        }
        if (prop === 'power_toggle') {
            this.send(buildF02APowerToggle())
            return
        }

        // staged values — cache and echo to the state topic so the HA UI reflects the selection
        if (prop.startsWith('stage_')) {
            const key = prop.slice('stage_'.length) as keyof typeof this.staged
            if (key === 'delay') this.staged.delay = Number(mqttValue)
            else this.staged[key] = mqttValue
            this.HA.publishProperty(this.id, prop, mqttValue)
            return
        }

        if (prop === 'set_program') {
            const params = this.stagedParams()
            if (params) this.send(buildF025Set({ ...params, cc: this.staged.cc ? parseInt(this.staged.cc, 16) : 0 }))
            return
        }
        if (prop === 'start_program') {
            const params = this.stagedParams()
            if (params) this.send(buildF026Start({ ...params, delay: this.staged.delay ?? 0 }))
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
