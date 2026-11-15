// Lucid probe firmware (Arduino Uno R3).
//
// Drives the coil from an AD9833, reads the detector and the IR receiver through an
// ADS1115, reads tilt from a GY-521 (MPU-6050), and prints one JSON line per sample
// at about 50 Hz over USB serial (115200 baud):
//
//   {"t":1234,"coil_v":0.8123,"nir_v":0.4410,"pitch":4.2,"roll":-1.0}
//
// The probe sends raw values only. The laptop bridge (agent/lucid/device) turns
// coil_v into dB against a saved baseline, decides when a spot is done, and
// grades contact quality.
//
// Libraries: Adafruit ADS1X15 (Library Manager). SPI and Wire ship with the IDE.

#include <SPI.h>
#include <Wire.h>
#include <Adafruit_ADS1X15.h>

// ---- Pins (change these to match the build) --------------------------------
const uint8_t PIN_FSYNC = 10;   // AD9833 FSYNC; SCLK = D13, SDATA = D11
const uint8_t PIN_NIR_LED = 7;  // 800 nm LED through a series resistor
const uint8_t ADS_COIL = 0;     // ADS1115 A0: detector output (coil signal level)
const uint8_t ADS_NIR = 1;      // ADS1115 A1: IR receiver

// ---- Settings --------------------------------------------------------------
const uint32_t BAUD = 115200;
const float COIL_HZ = 3.0e6;          // coil drive frequency
const float AD9833_MCLK_HZ = 25.0e6;  // crystal on the AD9833 module
const uint16_t SAMPLE_MS = 20;        // 50 Hz
const uint16_t LED_SETTLE_US = 400;   // let the receiver settle after the LED switches
const uint8_t MPU_ADDR = 0x68;
const char FW_VERSION[] = "0.1.0";

Adafruit_ADS1115 ads;
bool adsOk = false;
bool mpuOk = false;
uint32_t nextSample = 0;

// ---- AD9833 ----------------------------------------------------------------
void ad9833Write(uint16_t word) {
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE2));
  digitalWrite(PIN_FSYNC, LOW);
  SPI.transfer16(word);
  digitalWrite(PIN_FSYNC, HIGH);
  SPI.endTransaction();
}

void ad9833SetSine(float hz) {
  // 28-bit frequency word: f * 2^28 / MCLK.
  uint32_t word = (uint32_t)((double)hz * 268435456.0 / AD9833_MCLK_HZ + 0.5);
  ad9833Write(0x2100);                             // reset, 28-bit writes
  ad9833Write(0x4000 | (uint16_t)(word & 0x3FFF)); // FREQ0, low 14 bits
  ad9833Write(0x4000 | (uint16_t)((word >> 14) & 0x3FFF)); // FREQ0, high 14 bits
  ad9833Write(0xC000);                             // PHASE0 = 0
  ad9833Write(0x2000);                             // leave reset: sine out
}

// ---- MPU-6050 --------------------------------------------------------------
bool mpuBegin() {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x6B);  // PWR_MGMT_1
  Wire.write(0x00);  // wake
  return Wire.endTransmission() == 0;
}

bool mpuTilt(float &pitch, float &roll) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);  // ACCEL_XOUT_H
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MPU_ADDR, (uint8_t)6) != 6) return false;
  int16_t ax = (Wire.read() << 8) | Wire.read();
  int16_t ay = (Wire.read() << 8) | Wire.read();
  int16_t az = (Wire.read() << 8) | Wire.read();
  pitch = atan2(-(float)ax, sqrt((float)ay * ay + (float)az * az)) * 57.2958;
  roll = atan2((float)ay, (float)az) * 57.2958;
  return true;
}

// ---- Readings --------------------------------------------------------------
float readVolts(uint8_t channel) {
  return ads.computeVolts(ads.readADC_SingleEnded(channel));
}

// LED on minus LED off, so room light and the receiver's offset cancel.
float readNir() {
  digitalWrite(PIN_NIR_LED, HIGH);
  delayMicroseconds(LED_SETTLE_US);
  float lit = readVolts(ADS_NIR);
  digitalWrite(PIN_NIR_LED, LOW);
  delayMicroseconds(LED_SETTLE_US);
  float dark = readVolts(ADS_NIR);
  return lit - dark;
}

void hello() {
  Serial.print(F("{\"lucid\":\"probe\",\"fw\":\""));
  Serial.print(FW_VERSION);
  Serial.print(F("\",\"coil_hz\":"));
  Serial.print(COIL_HZ, 0);
  Serial.print(F(",\"ads\":"));
  Serial.print(adsOk ? F("true") : F("false"));
  Serial.print(F(",\"imu\":"));
  Serial.print(mpuOk ? F("true") : F("false"));
  Serial.println(F("}"));
}

void setup() {
  Serial.begin(BAUD);
  pinMode(PIN_FSYNC, OUTPUT);
  digitalWrite(PIN_FSYNC, HIGH);
  pinMode(PIN_NIR_LED, OUTPUT);
  digitalWrite(PIN_NIR_LED, LOW);

  SPI.begin();
  ad9833SetSine(COIL_HZ);

  Wire.begin();
  Wire.setClock(400000);
  adsOk = ads.begin();
  if (adsOk) {
    ads.setGain(GAIN_ONE);                     // +/- 4.096 V
    ads.setDataRate(RATE_ADS1115_860SPS);      // fastest, so three reads fit in one 20 ms sample
  }
  mpuOk = mpuBegin();

  hello();
  nextSample = millis();
}

void loop() {
  if (Serial.available() && Serial.read() == '?') hello();  // the bridge asks who is there

  uint32_t now = millis();
  if ((int32_t)(now - nextSample) < 0) return;
  nextSample += SAMPLE_MS;
  if ((int32_t)(now - nextSample) > 5 * SAMPLE_MS) nextSample = now;  // fell behind: do not burst

  float coil = adsOk ? readVolts(ADS_COIL) : 0;
  float nir = adsOk ? readNir() : 0;
  float pitch = 0, roll = 0;
  if (mpuOk) mpuTilt(pitch, roll);

  Serial.print(F("{\"t\":"));
  Serial.print(now);
  Serial.print(F(",\"coil_v\":"));
  Serial.print(coil, 4);
  Serial.print(F(",\"nir_v\":"));
  Serial.print(nir, 4);
  Serial.print(F(",\"pitch\":"));
  Serial.print(pitch, 1);
  Serial.print(F(",\"roll\":"));
  Serial.print(roll, 1);
  Serial.println(F("}"));
}
