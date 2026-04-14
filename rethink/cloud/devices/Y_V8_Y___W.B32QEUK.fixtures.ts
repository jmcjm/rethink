// Known-good packets captured from live washer Y_V8_Y___W.B32QEUK.
// Sources: wiki (Appliance:Y_V8_Y___W.B32QEUK.md, rethink-rules.md confirmed packets)
// and live capture sessions. Fixtures marked "SYNTHETIC" are hand-constructed
// for parser unit tests and should be replaced with real captures when available.

// F025 set Cold Wash, spin=1000 (confirmed in rethink-rules.md)
export const CMD_F025_COLD_WASH = {
  hex: 'aa18f02503150103070101000000000000004d0000001cbb',
  params: {
    op: 'set' as const,
    program_id: 0x01,
    spin: 0x07,
    temp: 0x01,
    rinse: 0x01,
    flags_byte: 0x00,
    cc: 0x4D,
  },
}

// Session-confirmed: F025 set Mixed, spin=1200, temp=20, CC=0x00
export const CMD_F025_MIXED_1200_20 = {
  hex: 'aa18f02503150703090201000000000000000000000050bb',
  params: {
    op: 'set' as const,
    program_id: 0x07,
    spin: 0x09,
    temp: 0x02,
    rinse: 0x01,
    flags_byte: 0x00,
    cc: 0x00,
  },
}

// Session-confirmed: F025 set Mixed with CC=0xFF
export const CMD_F025_MIXED_CC_FF = {
  hex: 'aa18f0250315070309020100000000000000ff00000051bb',
  params: {
    op: 'set' as const,
    program_id: 0x07,
    spin: 0x09,
    temp: 0x02,
    rinse: 0x01,
    flags_byte: 0x00,
    cc: 0xFF,
  },
}

// Session-confirmed: F026 start Mixed, spin=1200, temp=20, no delay
export const CMD_F026_MIXED_START = {
  hex: 'aa16f02607030902010000000000000300000000babb',
  params: {
    op: 'start' as const,
    program_id: 0x07,
    spin: 0x09,
    temp: 0x02,
    rinse: 0x01,
    delay: 0,
  },
}

// Wiki example: F026 start Duvet (inner only, no framing)
export const CMD_F026_DUVET_START = {
  hex: 'F02605030701010000000000030000000000',
  params: {
    op: 'start' as const,
    program_id: 0x05,
    spin: 0x07,
    temp: 0x01,
    rinse: 0x01,
    delay: 0,
  },
}

// Wiki example: F026 start AI Wash (inner only)
export const CMD_F026_AI_WASH_START = {
  hex: 'F0263A03FF04010000000000030000000000',
  params: {
    op: 'start' as const,
    program_id: 0x3A,
    spin: 0xFF,
    temp: 0x04,
    rinse: 0x01,
    delay: 0,
  },
}

// Session-confirmed: F02A power toggle
export const CMD_F02A_POWER_TOGGLE = {
  hex: 'aa08f02a010098bb',
  params: { op: 'power_toggle' as const },
}

// Wiki-confirmed: F024 turn off
export const CMD_F024_TURN_OFF = {
  hex: 'aa09f0240101009cbb',
  params: { op: 'turn_off' as const },
}

// 96-byte extended status observed live 2026-04-13 20:08:18 after sending F025 CC=FF.
// Full frame (AA FF ... BB). Parser will strip 4 framing bytes before processing.
// SYNTHETIC CAVEAT: captured from log snippets, byte count may be slightly off —
// replace with pristine capture when available.
export const STATUS_96_AFTER_F025_CC_FF = {
  hex: 'aaff200a00600097ea000100ec004e000001011501150700030704010000000000' +
       '000002000006004700000300000000000000000000000001010b010b0700030902' +
       '010000000000000100ff0600ff000003000000000000000000001aaebb',
  expected_active_program: {
    program_id: 0x07,
    spin: 0x09,
    temp: 0x02,
    rinse: 0x01,
    cc: 0xFF,
  },
}
