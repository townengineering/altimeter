# pxt-bmp384

MakeCode extension for the **Bosch BMP384** barometric pressure / altimeter sensor (SparkFun Qwiic breakout).

This extension lets the BBC micro:bit read **pressure, temperature, and altitude** from the BMP384 over I²C. Blocks are provided for easy classroom use.

---

## ✨ Features
- Read **pressure** in Pascals (Pa)
- Read **temperature** in °C
- Compute **altitude** in meters
- Set **sea-level pressure (P₀)** for calibration
- **Zero (tare)** altitude at your current location

---

## 🧰 Hardware
- **Sensor:** [SparkFun Qwiic Pressure Sensor – BMP384](https://www.sparkfun.com/products/22646)  
- **Microcontroller:** BBC micro:bit (v1 or v2)

### Wiring (Qwiic → micro:bit pins)
| BMP384 (Qwiic) | micro:bit |
|----------------|-----------|
| SDA            | P20       |
| SCL            | P19       |
| 3.3V           | 3V        |
| GND            | GND       |

(If you use a Qwiic adapter for micro:bit, wiring is automatic.)

---

## 🧩 Blocks

After importing the extension, you’ll see a new **BMP384** category in the MakeCode toolbox.

- **BMP384 init** – initialize the sensor
- **set sea-level pressure P₀ (Pa)** – calibrate absolute altitude (default 101325 Pa)
- **zero altitude here** – tare the current altitude to 0 m
- **pressure (Pa)** – read pressure
- **temperature (°C)** – read temperature
- **altitude (m)** – read altitude relative to sea-level and zero point

---

## 🚀 Example program

```typescript
bmp384.init()
bmp384.setSeaLevelPa(101325)

input.onButtonPressed(Button.A, function () {
    bmp384.zeroHere()
    basic.showIcon(IconNames.Yes)
})

basic.forever(function () {
    serial.writeLine("Pressure: " + bmp384.pressurePa() + " Pa")
    serial.writeLine("Temp: " + bmp384.temperatureC() + " °C")
    serial.writeLine("Alt: " + bmp384.altitudeM() + " m")
    basic.pause(1000)
})
