//% weight=95 color=#2E86C1 icon="\uf135" block="BMP384"
namespace bmp384 {
    // ========= I2C + Registers =========
    let ADDR = 0x77 // default; auto-try 0x76 if CHIP_ID mismatch

    const REG_CHIP_ID  = 0x00 // expect 0x50
    const REG_STATUS   = 0x03
    const REG_DATA_0   = 0x04 // press[23:0] 0x04..0x06, temp[23:0] 0x07..0x09
    const REG_PWR_CTRL = 0x1B
    const REG_OSR      = 0x1C
    const REG_ODR      = 0x1D
    const REG_CONFIG   = 0x1F
    const REG_CMD      = 0x7E

    // calibration NVM block (inclusive range 0x31..0x45)
    const CALIB_START = 0x31
    const CALIB_LEN   = 0x45 - 0x31 + 1

    // ========= calibration (converted “par_*”) and state =========
    let par_t1=0, par_t2=0, par_t3=0
    let par_p1=0, par_p2=0, par_p3=0, par_p4=0, par_p5=0, par_p6=0, par_p7=0, par_p8=0, par_p9=0, par_p10=0, par_p11=0
    let t_lin = 0 // linearized temperature used in pressure compensation

    let seaLevelPa = 101325 // P0 (Pa)
    let zeroAlt = 0 // absolute altitude at "zero here"
    let initialized = false

    // ========= low-level I2C helpers =========
    function wr8(reg: number, val: number) {
        const b = pins.createBuffer(2)
        b[0] = reg; b[1] = val & 0xFF
        pins.i2cWriteBuffer(ADDR, b)
    }
    function rdFrom(reg: number, len: number): Buffer {
        pins.i2cWriteNumber(ADDR, reg, NumberFormat.UInt8LE)
        return pins.i2cReadBuffer(ADDR, len)
    }
    function softReset() { wr8(REG_CMD, 0xB6); basic.pause(10) }

    // ========= bring-up =========
    function readChipId(): number {
        pins.i2cWriteNumber(ADDR, REG_CHIP_ID, NumberFormat.UInt8LE)
        return pins.i2cReadNumber(ADDR, NumberFormat.UInt8LE)
    }

    function setConfig() {
        // Enable temp+press, NORMAL mode
        // PWR_CTRL: [4:3] mode (11b normal), [1] temp_en, [0] press_en
        wr8(REG_PWR_CTRL, (0b11 << 3) | (1 << 1) | (1 << 0))

        // Oversampling: OSR 0x1C: osr_t[5:3], osr_p[2:0]
        // High-res but still snappy: temp x8 (100b), press x16 (101b)
        wr8(REG_OSR, (0b100 << 3) | 0b101)

        // IIR filter (CONFIG 0x1F): iir_filter[2:0]; lighter = faster response
        wr8(REG_CONFIG, 0b010) // ~coef 4
        // Optional ODR (leave default): wr8(REG_ODR, 0x00)
    }

    // ========= read + convert calibration =========
    function readCalib() {
        const c = rdFrom(CALIB_START, CALIB_LEN)
        function U16(lo: number, hi: number) { return (lo | (hi << 8)) & 0xFFFF }
        function S16(lo: number, hi: number) {
            let u = U16(lo, hi); if (u & 0x8000) u = -((~u + 1) & 0xFFFF); return u
        }
        function S8(x: number) { return (x & 0x80) ? x - 256 : x }
        function p2(n: number) { return Math.pow(2, n) }

        // NVM map (BMP38x)
        const NVM_T1 = U16(c[0], c[1])
        const NVM_T2 = U16(c[2], c[3])
        const NVM_T3 = S8(c[4])

        const NVM_P1 = S16(c[5], c[6])
        const NVM_P2 = S16(c[7], c[8])
        const NVM_P3 = S8(c[9])
        const NVM_P4 = S8(c[10])

        const NVM_P5 = U16(c[11], c[12])
        const NVM_P6 = U16(c[13], c[14])

        const NVM_P7  = S8(c[15])
        const NVM_P8  = S8(c[16])
        const NVM_P9  = S16(c[17], c[18])
        const NVM_P10 = S8(c[19])
        const NVM_P11 = S8(c[20])

        // Convert to par_* (use powers of two; avoid 32-bit shifts)
        par_t1  = NVM_T1  / p2(8)
        par_t2  = NVM_T2  / p2(30)
        par_t3  = NVM_T3  / p2(48)

        par_p1  = (NVM_P1 - p2(14)) / p2(20)
        par_p2  = (NVM_P2 - p2(14)) / p2(29)
        par_p3  = NVM_P3  / p2(32)
        par_p4  = NVM_P4  / p2(37)
        par_p5  = NVM_P5  / p2(3)
        par_p6  = NVM_P6  / p2(6)
        par_p7  = NVM_P7  / p2(8)
        par_p8  = NVM_P8  / p2(15)
        par_p9  = NVM_P9  / p2(48)
        par_p10 = NVM_P10 / p2(48)
        par_p11 = NVM_P11 / p2(65)

        t_lin = 0
    }

    // ========= raw burst read =========
    function readUncomp(): { up: number, ut: number } {
        const b = rdFrom(REG_DATA_0, 6)
        const up = (b[0] << 16) | (b[1] << 8) | b[2]
        const ut = (b[3] << 16) | (b[4] << 8) | b[5]
        return { up: up, ut: ut }
    }

    // ========= compensation (floating point) =========
    function compensateTemperature(uncomp_temp: number): number {
        const pd1 = (uncomp_temp - par_t1)
        const pd2 = pd1 * par_t2
        t_lin = pd2 + (pd1 * pd1) * par_t3
        return t_lin // approx °C
    }

    function compensatePressure(uncomp_press: number): number {
        // Uses t_lin computed above.
        const pd1 = par_p6 * t_lin
        const pd2 = par_p7 * t_lin * t_lin
        const pd3 = par_p8 * t_lin * t_lin * t_lin
        const quad1 = par_p5 + pd1 + pd2 + pd3

        const qd1 = par_p2 * t_lin
        const qd2 = par_p3 * t_lin * t_lin
        const qd3 = par_p4 * t_lin * t_lin * t_lin
        const quad2 = (uncomp_press) * (par_p1 + qd1 + qd2 + qd3)
            + (uncomp_press * uncomp_press) * (par_p9 + par_p10 * t_lin)
            + (uncomp_press * uncomp_press * uncomp_press) * par_p11

        return quad1 + quad2 // Pascals
    }

    function pressureToAltitude(pa: number): number {
        return 44330 * (1 - Math.pow(pa / seaLevelPa, 0.1903))
    }

    function ensureInit() {
        if (initialized) return
        softReset()

        // Try default address, then alternate (expect CHIP_ID 0x50)
        let id = readChipId()
        if (id != 0x50) { ADDR = 0x76; id = readChipId() }
        // If still not 0x50, we continue anyway; reads will reveal issues.

        setConfig()
        readCalib()

        // Prime t_lin
        const u = readUncomp()
        compensateTemperature(u.ut)
        compensatePressure(u.up)

        initialized = true
    }

    // ========= Blocks =========

    //% block="BMP384 init (I²C auto-detect)"
    //% weight=100
    export function init() { ensureInit() }

    //% block="set sea-level pressure P₀ to %pa Pa"
    //% pa.defl=101325
    //% weight=95
    export function setSeaLevelPa(pa: number) {
        seaLevelPa = Math.max(80000, Math.min(105000, pa | 0))
    }

    //% block="zero altitude here"
    //% weight=90
    export function zeroHere() {
        ensureInit()
        const u = readUncomp()
        compensateTemperature(u.ut)
        const p = compensatePressure(u.up)
        zeroAlt = pressureToAltitude(p)
    }

    //% block="pressure (Pa)"
    //% weight=85
    export function pressurePa(): number {
        ensureInit()
        const u = readUncomp()
        if (u.up === 0 && u.ut === 0) return 0 // likely I2C/wiring issue
        compensateTemperature(u.ut)
        const p = compensatePressure(u.up)
        if (!(p > 0 && p < 200000)) return 0
        return p // float Pa
    }

    //% block="temperature (°C)"
    //% weight=80
    export function temperatureC(): number {
        ensureInit()
        const u = readUncomp()
        return compensateTemperature(u.ut) // float °C
    }

    //% block="altitude (m)"
    //% weight=75
    export function altitudeM(): number {
        const p = pressurePa()
        if (!(p > 0)) return 0
        return pressureToAltitude(p) - zeroAlt // float meters
    }

    //% block="relative altitude (m)"
    //% weight=70
    export function relativeAltitudeM(): number {
        // identical to altitudeM() but named for students; handy in Blocks
        return altitudeM()
    }
}
