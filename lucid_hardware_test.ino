// lucid_hardware_test
// All the Lucid hardware tests in one sketch, plus a live data stream for the laptop program.
// Board: Arduino Uno R4 WiFi.   Serial: 115200 baud, commands end with a newline.
//
// Two ways to use it:
//   1. In the Serial Monitor: type HELP.
//   2. With lucid_hardware_monitor.py, which sends these commands for you.
//
// Wiring: as in the Lucid wiring document. Extra jumpers for this sketch:
//   ADS1115 A1 -> GND        ground reference reading (the GND column in the live data)
//   AD9833 OUT -> Uno A2     only while running FREQCHECK
//   ADS1115 A3 -> 3.3V       only while running VREF
//
// Needs the "Adafruit ADS1X15" library (Library Manager; it also installs BusIO).
// This is untested draft code.

#include <SPI.h>
#include <Wire.h>
#include <Adafruit_ADS1X15.h>

// ---------- pins and addresses ----------
const int FSYNC_PIN = 10;         // AD9833 FSYNC (SCLK = D13, SDATA = D11)
const int LED_PIN = 7;            // IR LED through 1 k + 180 ohm
const int TEMP_PIN = A0;          // TMP36 signal
const int DET_UNO_PIN = A1;       // detector output if the ADS1115 is missing
const int FREQ_PIN = A2;          // AD9833 OUT jumper, for FREQCHECK only
const uint8_t ADS_ADDR = 0x48;
const uint8_t DET_CH = 0;         // diode detector, ADS1115 AIN0
const uint8_t GND_CH = 1;         // ground reference: jumper ADS1115 A1 to GND
const uint8_t PD_CH = 2;          // photodiode (IR sensor), ADS1115 AIN2
const uint8_t REF_CH = 3;         // VREF test: jumper A3 to 3.3 V

// ---------- types (defined first so the IDE's auto-generated prototypes see them) ----------
struct GainEntry {
  adsGain_t gain;
  float mvPerCount;
  const char* label;
};

struct Peak {
  double freq;
  float mv;
  float floorMV;
  double fwhm;
  int idx;
};

const GainEntry GAINS[] = {
  { GAIN_SIXTEEN,   0.0078125f, "+/-0.256 V" },
  { GAIN_EIGHT,     0.015625f,  "+/-0.512 V" },
  { GAIN_FOUR,      0.03125f,   "+/-1.024 V" },
  { GAIN_TWO,       0.0625f,    "+/-2.048 V" },
  { GAIN_ONE,       0.125f,     "+/-4.096 V" },
  { GAIN_TWOTHIRDS, 0.1875f,    "+/-6.144 V" }
};
const int NGAINS = 6;

// ---------- settings ----------
double mclkHz = 25000000.0;       // AD9833 module oscillator
double capPF = 920.0;             // total C0G tank capacitor
double targetHz = 3000000.0;
double assumedL_uH = 3.3;         // CALCULATED value, only used to aim the guided scan
int settleMs = 5;
double WIDE_S = 200000.0, WIDE_STEP = 25000.0;
int WIDE_N = 313;                 // 0.2 MHz to 8 MHz
const double FINE_SPAN = 200000.0, FINE_STEP = 2000.0;
const int FINE_N = 201;
const int MAXPTS = 320;

// ---------- state ----------
Adafruit_ADS1115 ads;
bool adsOK = false;
bool streaming = false;
unsigned long streamMs = 200;
unsigned long lastStream = 0;
bool ledState = false;
int blinkLeft = 0;
unsigned long blinkMs = 250, blinkLast = 0;
int passCount = 0, failCount = 0, warnCount = 0;
int gainIdx = 0;
int chGain[4] = { 0, 0, 0, 0 };

uint8_t mpuAddr = 0;
const float GYRO_SCALE = 65.5f;   // LSB per deg/s at +/-500 deg/s
const float PEAK_LIMIT = 450.0f;  // deg/s, warn above this
float ax, ay, az, gx, gy, gz, chipC;
float biasX = 0, biasY = 0, biasZ = 0;
bool haveRef = false;
float refX = 0, refY = 0, refZ = 0;
float finalAng[3], peakAng[3];
float peakRate = 0;

float wideBuf[MAXPTS], fineBuf[MAXPTS], tmpBuf[MAXPTS];
double fineS = 0;
bool located = false;
float lastRelSd = 1.0f;

// ---------- LED ----------
void setLed(bool on) {
  ledState = on;
  digitalWrite(LED_PIN, on ? HIGH : LOW);
}

void startBlink(int count, unsigned long ms) {
  blinkMs = ms;
  blinkLast = millis();
  setLed(true);
  blinkLeft = count * 2 - 1;
}

void serviceBlink() {
  if (blinkLeft > 0 && millis() - blinkLast >= blinkMs) {
    blinkLast = millis();
    setLed(!ledState);
    blinkLeft--;
  }
}

// ---------- test reporting ----------
void beginTest(const char* name) {
  streaming = false;
  blinkLeft = 0;
  passCount = failCount = warnCount = 0;
  Serial.println();
  Serial.print("=== ");
  Serial.print(name);
  Serial.println(" ===");
}

void endTest() {
  Serial.print("=== RESULT: ");
  Serial.print(passCount);
  Serial.print(" passed, ");
  Serial.print(failCount);
  Serial.print(" failed, ");
  Serial.print(warnCount);
  Serial.println(" warnings ===");
}

void pass(const char* m) { Serial.print("  PASS: "); Serial.println(m); passCount++; }
void fail(const char* m) { Serial.print("  FAIL: "); Serial.println(m); failCount++; }
void warn(const char* m) { Serial.print("  WARN: "); Serial.println(m); warnCount++; }

void countdown(const char* label, int secs) {
  Serial.print("    ");
  Serial.print(label);
  Serial.print(" in ");
  for (int s = secs; s > 0; s--) {
    Serial.print(s);
    Serial.print(' ');
    delay(1000);
  }
  Serial.println();
}

// ---------- ADS1115 ----------
void setGainIdx(int i) {
  gainIdx = i;
  ads.setGain(GAINS[i].gain);
}

int16_t rawChan(uint8_t ch) {
  return ads.readADC_SingleEnded(ch);
}

// Start at the most sensitive range and back off while near full scale
void autoRange(uint8_t ch) {
  setGainIdx(0);
  while (gainIdx < NGAINS - 1 && abs((int)rawChan(ch)) > 28000) {
    setGainIdx(gainIdx + 1);
  }
}

void sampleStats(uint8_t ch, int n, float &meanMV, float &stdMV) {
  ads.setGain(GAINS[gainIdx].gain);
  double sum = 0, sumsq = 0;
  for (int i = 0; i < n; i++) {
    float mv = rawChan(ch) * GAINS[gainIdx].mvPerCount;
    sum += mv;
    sumsq += (double)mv * mv;
  }
  meanMV = sum / n;
  double var = sumsq / n - (double)meanMV * meanMV;
  stdMV = var > 0 ? sqrt(var) : 0;
}

// One reading in mV with a range remembered per channel (widens when near full scale,
// narrows when the reading is small)
float readChannelMV(uint8_t ch) {
  if (!adsOK) return NAN;
  int g = chGain[ch];
  ads.setGain(GAINS[g].gain);
  int16_t raw = ads.readADC_SingleEnded(ch);
  while (abs((int)raw) > 30000 && g < NGAINS - 1) {
    g++;
    ads.setGain(GAINS[g].gain);
    raw = ads.readADC_SingleEnded(ch);
  }
  while (abs((int)raw) < 3000 && g > 0) {
    g--;
    ads.setGain(GAINS[g].gain);
    raw = ads.readADC_SingleEnded(ch);
  }
  chGain[ch] = g;
  return raw * GAINS[g].mvPerCount;
}

float unoDetectorMV() {
  long sum = 0;
  for (int i = 0; i < 8; i++) sum += analogRead(DET_UNO_PIN);
  return (sum / 8.0f) * 5000.0f / 16383.0f;
}

float readDetectorMV() {
  if (adsOK) return readChannelMV(DET_CH);
  return unoDetectorMV();
}

long i2cReadReg16(uint8_t addr, uint8_t reg) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission() != 0) return -1;
  if (Wire.requestFrom((int)addr, 2) != 2) return -1;
  uint8_t hi = Wire.read();
  uint8_t lo = Wire.read();
  return ((long)hi << 8) | lo;
}

// ---------- AD9833 ----------
void ad9833Write(uint16_t w) {
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE2));
  digitalWrite(FSYNC_PIN, LOW);
  SPI.transfer16(w);
  digitalWrite(FSYNC_PIN, HIGH);
  SPI.endTransaction();
}

void setFreq(double f) {
  uint32_t word = (uint32_t)(f * 268435456.0 / mclkHz + 0.5);   // 2^28
  ad9833Write(0x2000);
  ad9833Write(0x4000 | (word & 0x3FFF));
  ad9833Write(0x4000 | ((word >> 14) & 0x3FFF));
}

void muteOutput() { ad9833Write(0x2100); }

// ---------- GY-521 ----------
bool mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool mpuRead(uint8_t reg, uint8_t* buf, uint8_t n) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)mpuAddr, (int)n) != n) return false;
  for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

// Accelerometer, temperature and gyro in one burst. Gyro values are raw (offset not removed).
bool readAll() {
  uint8_t b[14];
  if (!mpuAddr) return false;
  if (!mpuRead(0x3B, b, 14)) return false;
  ax = (int16_t)((b[0] << 8) | b[1]) / 16384.0f;
  ay = (int16_t)((b[2] << 8) | b[3]) / 16384.0f;
  az = (int16_t)((b[4] << 8) | b[5]) / 16384.0f;
  chipC = (int16_t)((b[6] << 8) | b[7]) / 340.0f + 36.53f;
  gx = (int16_t)((b[8] << 8) | b[9]) / GYRO_SCALE;
  gy = (int16_t)((b[10] << 8) | b[11]) / GYRO_SCALE;
  gz = (int16_t)((b[12] << 8) | b[13]) / GYRO_SCALE;
  return true;
}

bool initMPU() {
  mpuAddr = 0;
  for (uint8_t a = 0x68; a <= 0x69; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      mpuAddr = a;
      break;
    }
  }
  if (!mpuAddr) return false;
  mpuWrite(0x6B, 0x01);   // wake up, clock from the gyro X PLL
  delay(100);
  mpuWrite(0x1A, 0x03);   // low-pass filter about 42 Hz
  mpuWrite(0x1B, 0x08);   // gyro +/-500 deg/s
  mpuWrite(0x1C, 0x00);   // accelerometer +/-2 g
  delay(50);
  return true;
}

bool calibrate(unsigned long ms) {
  double sx = 0, sy = 0, sz = 0;
  int n = 0;
  unsigned long t0 = millis();
  while (millis() - t0 < ms) {
    if (readAll()) {
      sx += gx;
      sy += gy;
      sz += gz;
      n++;
    }
    delay(2);
  }
  if (n < 50) return false;
  biasX = sx / n;
  biasY = sy / n;
  biasZ = sz / n;
  return true;
}

float tiltFromCurrent() {
  if (!haveRef) return NAN;
  float m1 = sqrt(ax * ax + ay * ay + az * az);
  float m2 = sqrt(refX * refX + refY * refY + refZ * refZ);
  if (m1 < 0.01f || m2 < 0.01f) return NAN;
  float c = (ax * refX + ay * refY + az * refZ) / (m1 * m2);
  if (c > 1.0f) c = 1.0f;
  if (c < -1.0f) c = -1.0f;
  return acos(c) * 180.0f / PI;
}

// Integrate the gyro for ms milliseconds. Fills finalAng, peakAng and peakRate.
void recordMotion(unsigned long ms) {
  for (int i = 0; i < 3; i++) {
    finalAng[i] = 0;
    peakAng[i] = 0;
  }
  peakRate = 0;
  unsigned long t0 = millis();
  unsigned long tPrev = micros();
  while (millis() - t0 < ms) {
    if (!readAll()) continue;
    unsigned long tNow = micros();
    float dt = (tNow - tPrev) / 1000000.0f;
    tPrev = tNow;
    float r[3] = { gx - biasX, gy - biasY, gz - biasZ };
    for (int i = 0; i < 3; i++) {
      finalAng[i] += r[i] * dt;
      if (fabsf(finalAng[i]) > peakAng[i]) peakAng[i] = fabsf(finalAng[i]);
    }
    float m = sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
    if (m > peakRate) peakRate = m;
  }
}

int dominantAxis() {
  int k = 0;
  for (int i = 1; i < 3; i++) {
    if (peakAng[i] > peakAng[k]) k = i;
  }
  return k;
}

void printAngles() {
  const char axisName[3] = { 'X', 'Y', 'Z' };
  Serial.print("  final angle: X ");
  Serial.print(finalAng[0], 1);
  Serial.print("  Y ");
  Serial.print(finalAng[1], 1);
  Serial.print("  Z ");
  Serial.print(finalAng[2], 1);
  Serial.println(" degrees");
  int k = dominantAxis();
  Serial.print("  main axis: ");
  Serial.print(axisName[k]);
  Serial.print(", reached ");
  Serial.print(peakAng[k], 1);
  Serial.print(" degrees, peak rate ");
  Serial.print(peakRate, 0);
  Serial.println(" deg/s");
  if (peakRate > PEAK_LIMIT) {
    warn("the gyro reached its +/-500 deg/s limit, so the angle reads low. Turn more slowly.");
  }
}

// ---------- TMP36 ----------
float readTempC(int n) {
  long sum = 0;
  for (int i = 0; i < n; i++) {
    sum += analogRead(TEMP_PIN);
    delay(1);
  }
  float volts = (sum / (float)n) * 5.0f / 16383.0f;
  return (volts - 0.5f) * 100.0f;
}

// ---------- live data line for the laptop program ----------
// D,millis,a0_mV,gnd_mV,temp_C,gx,gy,gz,gyro_dps,ax,ay,az,accel_g,tilt_deg,pd_mV,led
void sendData() {
  float a0, gnd = NAN, pd = NAN;
  if (adsOK) {
    a0 = readChannelMV(DET_CH);
    gnd = readChannelMV(GND_CH);
    pd = readChannelMV(PD_CH);
  } else {
    a0 = unoDetectorMV();
  }
  float temp = readTempC(8);
  float rx = NAN, ry = NAN, rz = NAN, gmag = NAN;
  float aax = NAN, aay = NAN, aaz = NAN, amag = NAN, tilt = NAN;
  if (readAll()) {
    rx = gx - biasX;
    ry = gy - biasY;
    rz = gz - biasZ;
    gmag = sqrt(rx * rx + ry * ry + rz * rz);
    aax = ax;
    aay = ay;
    aaz = az;
    amag = sqrt(ax * ax + ay * ay + az * az);
    tilt = tiltFromCurrent();
  }
  Serial.print("D,");
  Serial.print(millis());
  Serial.print(',');
  Serial.print(a0, 3);
  Serial.print(',');
  Serial.print(gnd, 3);
  Serial.print(',');
  Serial.print(temp, 2);
  Serial.print(',');
  Serial.print(rx, 2);
  Serial.print(',');
  Serial.print(ry, 2);
  Serial.print(',');
  Serial.print(rz, 2);
  Serial.print(',');
  Serial.print(gmag, 2);
  Serial.print(',');
  Serial.print(aax, 3);
  Serial.print(',');
  Serial.print(aay, 3);
  Serial.print(',');
  Serial.print(aaz, 3);
  Serial.print(',');
  Serial.print(amag, 3);
  Serial.print(',');
  Serial.print(tilt, 1);
  Serial.print(',');
  Serial.print(pd, 3);
  Serial.print(',');
  Serial.println(ledState ? 1 : 0);
}

// ===================== TESTS =====================

// ---------- self-test: I2C, ADS1115, TMP36, GY-521 ----------
void selfTest() {
  beginTest("Self-test: I2C, ADS1115, TMP36, GY-521");

  Serial.println("[1] I2C scan");
  int count = 0;
  bool found48 = false;
  uint8_t mpuFound = 0;
  for (uint8_t a = 0x08; a < 0x78; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.print("  device at 0x");
      Serial.println(a, HEX);
      count++;
      if (a == ADS_ADDR) found48 = true;
      if (a == 0x68 || a == 0x69) mpuFound = a;
    }
  }
  if (count == 0) Serial.println("  no devices found");
  if (found48) {
    pass("ADS1115 answers at 0x48");
  } else {
    fail("no ADS1115 at 0x48. Check VDD, GND, SDA, SCL and ADDR to ground.");
  }
  if (mpuFound) {
    pass("GY-521 answers on the I2C bus");
  } else {
    warn("no GY-521 at 0x68 or 0x69");
  }
  adsOK = found48 ? ads.begin(ADS_ADDR, &Wire) : false;
  if (mpuFound && !mpuAddr) initMPU();

  Serial.println("[2] ADS1115 communication and conversions");
  if (!adsOK) {
    Serial.println("  SKIPPED: ADS1115 not found");
  } else {
    long cfg = i2cReadReg16(ADS_ADDR, 0x01);
    long lo = i2cReadReg16(ADS_ADDR, 0x02);
    long hi = i2cReadReg16(ADS_ADDR, 0x03);
    Serial.print("  config register: 0x");
    Serial.println(cfg, HEX);
    if (cfg < 0 || lo < 0 || hi < 0) {
      fail("could not read the ADS1115 registers over I2C");
    } else if (lo == 0x8000 && hi == 0x7FFF) {
      pass("registers read back like a genuine ADS1115");
    } else {
      warn("threshold registers are not at their power-up defaults. Not necessarily a fault.");
    }
    const char* names[4] = { "A0 (diode detector)", "A1 (ground reference)", "A2 (photodiode)", "A3 (unused)" };
    int zeros = 0;
    for (uint8_t ch = 0; ch < 4; ch++) {
      float mv = readChannelMV(ch);
      Serial.print("  ");
      Serial.print(names[ch]);
      Serial.print(": ");
      Serial.print(mv, 3);
      Serial.println(" mV");
      if (mv == 0.0f) zeros++;
    }
    Serial.println("  (A1 should read about 0 if it is jumpered to GND. Unused inputs can read anything.)");
    if (zeros == 4) {
      warn("all four inputs read exactly 0. Conversions may not be running.");
    } else {
      pass("conversions return values");
    }
  }

  Serial.println("[3] TMP36 temperature");
  float t1 = readTempC(32);
  Serial.print("  reading: ");
  Serial.print(t1, 1);
  Serial.println(" C");
  if (t1 > 5.0f && t1 < 45.0f) {
    pass("plausible room temperature");
  } else {
    fail("not a plausible temperature. Check the three legs and the A0 wire. A hot TMP36 means power and ground are swapped. Unplug it.");
  }
  Serial.println("  Pinch the TMP36 body between two fingers for 15 seconds...");
  delay(15000);
  float t2 = readTempC(32);
  Serial.print("  after warming: ");
  Serial.print(t2, 1);
  Serial.print(" C  (change ");
  Serial.print(t2 - t1, 1);
  Serial.println(" C)");
  if (t2 - t1 >= 1.0f) {
    pass("sensor responds to warming");
  } else {
    warn("little or no change. Pinch longer, or check the signal wire to A0.");
  }

  Serial.println("[4] GY-521 basics");
  if (!mpuAddr) {
    Serial.println("  SKIPPED: not found");
  } else {
    uint8_t who = 0;
    if (mpuRead(0x75, &who, 1)) {
      Serial.print("  WHO_AM_I = 0x");
      Serial.println(who, HEX);
      if (who == 0x68) pass("identifies as an MPU-6050");
      else warn("responding, but not the 0x68 an MPU-6050 returns");
    } else {
      fail("could not read WHO_AM_I");
    }
    if (readAll()) {
      float g = sqrt(ax * ax + ay * ay + az * az);
      Serial.print("  acceleration magnitude: ");
      Serial.print(g, 3);
      Serial.println(" g");
      if (g > 0.8f && g < 1.2f) {
        pass("about 1 g at rest");
        if (g < 0.95f || g > 1.05f) warn("more than 5% from 1 g. Tilt directions still work.");
      } else {
        fail("acceleration is not about 1 g. Keep the board still, or check its power.");
      }
      Serial.print("  chip temperature: ");
      Serial.print(chipC, 1);
      Serial.println(" C (the chip, not the coil)");
    } else {
      fail("could not read the GY-521");
    }
  }
  endTest();
}

// Optional: jumper ADS1115 A3 to the Uno 3.3V pin first
void vrefTest() {
  beginTest("Voltage reference");
  if (!adsOK) {
    Serial.println("  SKIPPED: ADS1115 not found");
    endTest();
    return;
  }
  Serial.println("  Jumper ADS1115 A3 to the Uno 3.3V pin now.");
  countdown("Measuring", 5);
  autoRange(REF_CH);
  float mean, sd;
  sampleStats(REF_CH, 20, mean, sd);
  Serial.print("  A3 reads ");
  Serial.print(mean, 1);
  Serial.print(" mV (expected about 3300, noise ");
  Serial.print(sd, 2);
  Serial.println(" mV)");
  if (mean > 3200.0f && mean < 3400.0f) {
    pass("the ADS1115 measures a known voltage correctly");
  } else if (fabsf(mean) < 100.0f) {
    fail("A3 reads about 0. It is not connected to 3.3 V, or the input is damaged.");
  } else {
    fail("reading is off from 3.3 V by more than 3%.");
  }
  Serial.println("  Remove the A3 jumper afterwards.");
  endTest();
}

// ---------- gyroscope tests ----------
void gyroNoise() {
  beginTest("Gyro noise and drift");
  if (!mpuAddr) {
    fail("GY-521 not found");
    endTest();
    return;
  }
  Serial.println("  Lay the board flat and keep it completely still for 12 seconds.");
  countdown("Starting", 3);
  if (!calibrate(2000)) {
    fail("could not read the gyro");
    endTest();
    return;
  }
  Serial.print("  gyro offset: X ");
  Serial.print(biasX, 2);
  Serial.print("  Y ");
  Serial.print(biasY, 2);
  Serial.print("  Z ");
  Serial.print(biasZ, 2);
  Serial.println(" deg/s");
  if (fabsf(biasX) > 20 || fabsf(biasY) > 20 || fabsf(biasZ) > 20) {
    warn("an offset above 20 deg/s is larger than the datasheet allows (from memory). It is corrected here.");
  }
  double sum[3] = { 0, 0, 0 }, sq[3] = { 0, 0, 0 }, ang[3] = { 0, 0, 0 };
  int n = 0;
  unsigned long t0 = millis();
  unsigned long tPrev = micros();
  while (millis() - t0 < 10000) {
    if (!readAll()) continue;
    unsigned long tNow = micros();
    float dt = (tNow - tPrev) / 1000000.0f;
    tPrev = tNow;
    float r[3] = { gx - biasX, gy - biasY, gz - biasZ };
    for (int i = 0; i < 3; i++) {
      sum[i] += r[i];
      sq[i] += (double)r[i] * r[i];
      ang[i] += r[i] * dt;
    }
    n++;
  }
  float noiseMax = 0, driftMax = 0;
  const char axisName[3] = { 'X', 'Y', 'Z' };
  for (int i = 0; i < 3; i++) {
    double m = sum[i] / n;
    double var = sq[i] / n - m * m;
    float sd = var > 0 ? sqrt(var) : 0;
    Serial.print("  ");
    Serial.print(axisName[i]);
    Serial.print(": noise ");
    Serial.print(sd, 3);
    Serial.print(" deg/s, drift over 10 s ");
    Serial.print(ang[i], 2);
    Serial.println(" degrees");
    if (sd > noiseMax) noiseMax = sd;
    if (fabsf(ang[i]) > driftMax) driftMax = fabsf(ang[i]);
  }
  if (noiseMax < 0.5f) pass("noise is low");
  else if (noiseMax < 2.0f) warn("noise is higher than expected. Check for vibration, loose wires or a weak 5 V supply.");
  else fail("noise is very high. The board may be moving, or something is wrong with the module.");
  if (driftMax < 2.0f) pass("drift over 10 seconds is small");
  else if (driftMax < 5.0f) warn("some drift. Let the board warm up for a few minutes, then re-run.");
  else fail("large drift. Make sure the board really was still.");
  endTest();
}

void gyro90() {
  beginTest("Gyro 90 degree turn");
  if (!mpuAddr) {
    fail("GY-521 not found");
    endTest();
    return;
  }
  Serial.println("  Lay the board flat and still while its offset is measured.");
  countdown("Measuring offset", 3);
  if (!calibrate(1500)) {
    fail("could not read the gyro");
    endTest();
    return;
  }
  Serial.println("  GO: turn the board 90 degrees about one axis, smoothly, then hold it still. 6 seconds.");
  recordMotion(6000);
  printAngles();
  float a = fabsf(finalAng[dominantAxis()]);
  if (a > 75.0f && a < 105.0f) pass("angle reads about 90 degrees for a 90 degree turn");
  else if (a < 20.0f) fail("almost no rotation measured. Turn the board, or check the gyro.");
  else warn("more than 15 degrees from 90. Your hand turn may be rough. Repeat against a square stop.");
  endTest();
}

void gyroBack() {
  beginTest("Gyro there and back");
  if (!mpuAddr) {
    fail("GY-521 not found");
    endTest();
    return;
  }
  Serial.println("  Lay the board flat and still while its offset is measured.");
  countdown("Measuring offset", 3);
  if (!calibrate(1500)) {
    fail("could not read the gyro");
    endTest();
    return;
  }
  Serial.println("  GO: turn 90 degrees, then back exactly to the start, then hold still. 8 seconds.");
  recordMotion(8000);
  printAngles();
  int k = dominantAxis();
  float peak = peakAng[k];
  float fin = fabsf(finalAng[k]);
  if (peak < 60.0f) fail("the board did not turn far enough. Turn about 90 degrees out and back.");
  else if (fin < 8.0f) pass("returns to within 8 degrees of the start");
  else if (fin < 15.0f) warn("ends 8-15 degrees from the start. Some drift, or the return was not exact.");
  else fail("does not return to the start. Check for drift, clipping, or an inexact return.");
  endTest();
}

void gyroSpin() {
  beginTest("Gyro full spin");
  if (!mpuAddr) {
    fail("GY-521 not found");
    endTest();
    return;
  }
  Serial.println("  Lay the board flat on the table and still while its offset is measured.");
  countdown("Measuring offset", 3);
  if (!calibrate(1500)) {
    fail("could not read the gyro");
    endTest();
    return;
  }
  Serial.println("  GO: turn the board once around on the table, smoothly, then hold still. 12 seconds.");
  recordMotion(12000);
  printAngles();
  float a = fabsf(finalAng[dominantAxis()]);
  if (a > 335.0f && a < 385.0f) pass("angle reads about 360 degrees for a full turn");
  else if (a < 60.0f) fail("almost no rotation measured.");
  else warn("more than 25 degrees from 360. Your hand turn may be inexact, or the gyro scale is off.");
  endTest();
}

// ---------- IR LED and photodiode tests ----------
void measurePhase(bool ledOn, int phaseMs, float &mean, float &sd) {
  unsigned long t0 = millis();
  setLed(ledOn);
  delay(100);
  sampleStats(PD_CH, 8, mean, sd);
  while (millis() - t0 < (unsigned long)phaseMs) { }
}

void irBlink() {
  beginTest("IR blink test");
  if (!adsOK) {
    fail("ADS1115 not found, so the photodiode cannot be read");
    endTest();
    return;
  }
  const int CYCLES = 10;
  const int PHASE_MS = 400;
  Serial.println("  Aim the LED at the photodiode, or hold a white card 1-2 cm in front of both.");
  Serial.println("  The LED will blink 10 times. Keep everything still.");
  countdown("Starting", 4);
  setLed(true);
  delay(150);
  autoRange(PD_CH);
  setLed(false);
  delay(150);
  float on[CYCLES], off[CYCLES], sdOff[CYCLES];
  for (int i = 0; i < CYCLES; i++) {
    float sdOn;
    measurePhase(false, PHASE_MS, off[i], sdOff[i]);
    measurePhase(true, PHASE_MS, on[i], sdOn);
  }
  setLed(false);
  double sdSum = 0, diffSum = 0;
  for (int i = 0; i < CYCLES; i++) {
    sdSum += sdOff[i];
    diffSum += on[i] - off[i];
  }
  float avgSd = sdSum / CYCLES;
  float avgDiff = diffSum / CYCLES;
  float thr = fmaxf(0.2f, 5.0f * avgSd);
  int detected = 0;
  for (int i = 0; i < CYCLES; i++) {
    float d = on[i] - off[i];
    bool hit = d >= thr;
    if (hit) detected++;
    Serial.print("  blink ");
    Serial.print(i + 1);
    Serial.print(": off ");
    Serial.print(off[i], 3);
    Serial.print(" mV, on ");
    Serial.print(on[i], 3);
    Serial.print(" mV, difference ");
    Serial.print(d, 3);
    Serial.println(hit ? " mV  seen" : " mV  not seen");
  }
  Serial.print("  average signal ");
  Serial.print(avgDiff, 3);
  Serial.print(" mV, noise ");
  Serial.print(avgSd, 3);
  Serial.print(" mV, needed ");
  Serial.print(thr, 3);
  Serial.println(" mV");
  Serial.print("  blinks detected: ");
  Serial.print(detected);
  Serial.println(" of 10");
  if (detected >= 9) pass("the photodiode sees every blink");
  else if (avgDiff <= -thr) fail("the signal goes NEGATIVE when the LED is on. The photodiode is probably backwards.");
  else if (detected >= 6) warn("it sees most blinks. Move the LED closer, aim it better, or shade the photodiode.");
  else fail("it does not see the LED. Run IR,PD to test the photodiode alone and IR,STEADY to check the LED.");
  endTest();
}

void irPhotodiodeOnly() {
  beginTest("Photodiode only (LED off)");
  if (!adsOK) {
    fail("ADS1115 not found");
    endTest();
    return;
  }
  setLed(false);
  Serial.println("  Cover the photodiode completely with your finger.");
  countdown("Measuring dark", 4);
  autoRange(PD_CH);
  float dark, darkSd;
  sampleStats(PD_CH, 20, dark, darkSd);
  Serial.println("  Now shine a phone flashlight straight at the photodiode, 2-5 cm away.");
  countdown("Measuring lit", 5);
  autoRange(PD_CH);
  float lit, litSd;
  sampleStats(PD_CH, 20, lit, litSd);
  float d = lit - dark;
  float need = fmaxf(0.5f, 5.0f * darkSd);
  Serial.print("  covered: ");
  Serial.print(dark, 3);
  Serial.print(" mV (noise ");
  Serial.print(darkSd, 3);
  Serial.println(" mV)");
  Serial.print("  flashlight: ");
  Serial.print(lit, 3);
  Serial.println(" mV");
  Serial.print("  difference: ");
  Serial.print(d, 3);
  Serial.print(" mV (need at least ");
  Serial.print(need, 3);
  Serial.println(" mV)");
  if (d >= need) pass("the photodiode and the ADS1115 work");
  else if (d <= -need) fail("the signal goes negative in light. The photodiode is probably backwards.");
  else fail("no response to light. Check anode to AIN2, cathode to ground, the 100 k resistor, and the AIN2 wire.");
  endTest();
}

void irAmbient() {
  beginTest("Ambient light (LED off)");
  if (!adsOK) {
    fail("ADS1115 not found");
    endTest();
    return;
  }
  setLed(false);
  Serial.println("  Leave the photodiode uncovered, as it will be in use.");
  countdown("Measuring", 3);
  autoRange(PD_CH);
  float mean, sd;
  sampleStats(PD_CH, 40, mean, sd);
  Serial.print("  ambient: ");
  Serial.print(mean, 3);
  Serial.print(" mV, noise ");
  Serial.print(sd, 3);
  Serial.println(" mV");
  if (mean > 100.0f) warn("strong ambient light. It can hide a weak LED signal. Shade the photodiode.");
  else if (sd > 1.0f) warn("the ambient level flickers. Shade the photodiode, or turn the room lights off for the test.");
  else pass("ambient light is low and steady");
  endTest();
}

void ledSteady() {
  beginTest("LED steady for 10 seconds");
  Serial.println("  Point a phone REAR camera at the LED. IR looks faintly white or purple.");
  setLed(true);
  delay(150);
  if (adsOK) autoRange(PD_CH);
  for (int s = 1; s <= 10; s++) {
    delay(1000);
    Serial.print("  ");
    Serial.print(s);
    Serial.print(" s");
    if (adsOK) {
      float mean, sd;
      sampleStats(PD_CH, 4, mean, sd);
      Serial.print(": photodiode ");
      Serial.print(mean, 3);
      Serial.print(" mV");
    }
    Serial.println();
  }
  setLed(false);
  Serial.println("  LED off.");
  endTest();
}

// ---------- coil tests ----------
void sweepOnce(double s, double st, int n, float* out) {
  for (int i = 0; i < n; i++) {
    setFreq(s + i * st);
    delay(settleMs);
    out[i] = readDetectorMV();
  }
}

void sweepAvg(double s, double st, int n, int avg, float* out) {
  for (int i = 0; i < n; i++) out[i] = 0;
  for (int k = 0; k < avg; k++) {
    sweepOnce(s, st, n, tmpBuf);
    for (int i = 0; i < n; i++) out[i] += tmpBuf[i];
  }
  for (int i = 0; i < n; i++) out[i] /= avg;
  muteOutput();
}

Peak analyzeRange(const float* mv, int n, double s, double st) {
  Peak p = { 0, 0, 0, 0, 0 };
  int imax = 0;
  float fl = mv[0];
  for (int i = 1; i < n; i++) {
    if (mv[i] > mv[imax]) imax = i;
    if (mv[i] < fl) fl = mv[i];
  }
  p.idx = imax;
  p.mv = mv[imax];
  p.floorMV = fl;
  double f0 = s + imax * st;
  p.freq = f0;
  if (imax > 0 && imax < n - 1) {
    float y1 = mv[imax - 1], y2 = mv[imax], y3 = mv[imax + 1];
    float denom = y1 - 2.0f * y2 + y3;
    if (fabsf(denom) > 1e-6f) p.freq = f0 + 0.5f * (y1 - y3) / denom * st;
  }
  float half = fl + (p.mv - fl) / 2.0f;
  double left = NAN, right = NAN;
  for (int i = imax; i > 0; i--) {
    if (mv[i - 1] < half && mv[i] >= half) {
      left = s + (i - 1) * st + (half - mv[i - 1]) / (mv[i] - mv[i - 1]) * st;
      break;
    }
  }
  for (int i = imax; i < n - 1; i++) {
    if (mv[i + 1] < half && mv[i] >= half) {
      right = s + i * st + (mv[i] - half) / (mv[i] - mv[i + 1]) * st;
      break;
    }
  }
  if (!isnan(left) && !isnan(right)) p.fwhm = right - left;
  return p;
}

void meanSd(const float* v, int n, float &mean, float &sd) {
  double s = 0, sq = 0;
  for (int i = 0; i < n; i++) {
    s += v[i];
    sq += (double)v[i] * v[i];
  }
  mean = s / n;
  double var = sq / n - (double)mean * mean;
  sd = var > 0 ? sqrt(var) : 0;
}

double inductanceUH(double f0) {
  double w = 2.0 * PI * f0;
  return 1.0 / (w * w * capPF * 1e-12) * 1e6;
}

double expectedHz() {
  return 1.0 / (2.0 * PI * sqrt(assumedL_uH * 1e-6 * capPF * 1e-12));
}

void setWideRange(double a, double b) {
  double step = (b - a) / (MAXPTS - 1);
  if (step < 2000.0) step = 2000.0;
  step = ceil(step / 1000.0) * 1000.0;
  WIDE_S = a;
  WIDE_STEP = step;
  WIDE_N = (int)((b - a) / step + 0.5) + 1;
  if (WIDE_N > MAXPTS) WIDE_N = MAXPTS;
  located = false;
}

bool locate(bool verbose) {
  muteOutput();
  delay(100);
  double sum = 0, sq = 0;
  const int N = 30;
  for (int i = 0; i < N; i++) {
    float v = readDetectorMV();
    sum += v;
    sq += (double)v * v;
  }
  float nMean = sum / N;
  double var = sq / N - (double)nMean * nMean;
  float nSd = var > 0 ? sqrt(var) : 0;
  if (verbose) {
    Serial.print("  detector with the output muted: ");
    Serial.print(nMean, 3);
    Serial.print(" mV, noise ");
    Serial.print(nSd, 3);
    Serial.println(" mV (this should be close to 0)");
    Serial.print("  wide scan ");
    Serial.print(WIDE_S / 1e6, 3);
    Serial.print("-");
    Serial.print((WIDE_S + (WIDE_N - 1) * WIDE_STEP) / 1e6, 3);
    Serial.print(" MHz, ");
    Serial.print(WIDE_STEP / 1e3, 0);
    Serial.println(" kHz steps ...");
  }
  sweepAvg(WIDE_S, WIDE_STEP, WIDE_N, 2, wideBuf);
  Peak wp = analyzeRange(wideBuf, WIDE_N, WIDE_S, WIDE_STEP);
  float contrast = wp.mv - wp.floorMV;
  float need = fmaxf(1.0f, 10.0f * nSd);
  if (verbose) {
    Serial.print("  strongest response near ");
    Serial.print(wp.freq / 1e6, 3);
    Serial.print(" MHz, ");
    Serial.print(contrast, 2);
    Serial.print(" mV above the floor (need at least ");
    Serial.print(need, 2);
    Serial.println(" mV)");
  }
  if (contrast < need) {
    fail("no clear resonance in the scanned range");
    Serial.println("    Check: diode direction (stripe = cathode), coupling capacitor, coil leads");
    Serial.println("    in the node X row, the capacitor bank, grounds, and the detector wire.");
    return false;
  }
  if (wp.idx <= 2 || wp.idx >= WIDE_N - 3) {
    fail("the strongest point is at the edge of the scan, so there is no real peak in range.");
    Serial.println("    The resonance may be outside the scanned range (try RANGE,<a>,<b> in MHz).");
    return false;
  }
  if (verbose) pass("a resonance peak is present");
  fineS = wp.freq - FINE_SPAN;
  if (fineS < 200000.0) fineS = 200000.0;
  sweepAvg(fineS, FINE_STEP, FINE_N, 3, fineBuf);
  located = true;
  return true;
}

void coilFull() {
  beginTest("Coil test");
  Serial.print("  tank capacitor assumed: ");
  Serial.print(capPF, 0);
  Serial.println(" pF   (change with CAP,<pF>)");
  Serial.print("  detector: ");
  Serial.println(adsOK ? "ADS1115 AIN0" : "Uno A1 (ADS1115 not found)");
  Serial.println("[1] Find the resonance");
  if (!locate(true)) {
    endTest();
    return;
  }
  Peak fp = analyzeRange(fineBuf, FINE_N, fineS, FINE_STEP);
  double f0 = fp.freq;
  Serial.println("[2] Resonance, inductance and Q");
  Serial.print("  resonance: ");
  Serial.print(f0 / 1e6, 4);
  Serial.println(" MHz");
  Serial.print("  peak height: ");
  Serial.print(fp.mv, 2);
  Serial.print(" mV, floor ");
  Serial.print(fp.floorMV, 2);
  Serial.println(" mV");
  double L = inductanceUH(f0);
  Serial.print("  inductance (measured from the peak): ");
  Serial.print(L, 2);
  Serial.println(" uH, assuming the tank capacitor above with no stray capacitance (an upper estimate)");
  if (L >= 2.5 && L <= 4.5) pass("inductance is close to the 3.3 uH expected for 6 turns on a 60 mm bobbin");
  else if (L >= 1.5 && L <= 7.0) warn("inductance is a bit off from 3.3 uH. Check the turn count and the capacitor value.");
  else fail("inductance is far from 3.3 uH. Check the turn count, the capacitor value, and that the right coil is connected.");
  if (fp.fwhm > 0) {
    double q = f0 / fp.fwhm;
    Serial.print("  peak width: ");
    Serial.print(fp.fwhm / 1e3, 1);
    Serial.print(" kHz   loaded Q: ");
    Serial.println(q, 1);
    if (q >= 10.0) pass("peak is sharp enough");
    else if (q >= 5.0) warn("peak is broad. Look for metal near the coil.");
    else fail("peak is very broad. Possible causes: metal near the coil, shorted turns, a poor joint.");
  } else {
    warn("could not measure the peak width.");
  }
  double ratio = f0 / targetHz;
  double dC = capPF * (ratio * ratio - 1.0);
  Serial.print("  to reach ");
  Serial.print(targetHz / 1e6, 2);
  Serial.print(" MHz, change the capacitance by about ");
  Serial.print(dC, 0);
  Serial.print(" pF (");
  Serial.print(fabs(dC) / 100.0, 1);
  Serial.println(dC > 0 ? " x 100 pF parts to ADD)" : " x 100 pF parts to REMOVE)");
  Serial.println("[3] Steadiness: 10 sweeps, do not touch the coil");
  float fr[10], pk[10];
  for (int k = 0; k < 10; k++) {
    sweepAvg(fineS, FINE_STEP, FINE_N, 1, tmpBuf);
    Peak p = analyzeRange(tmpBuf, FINE_N, fineS, FINE_STEP);
    fr[k] = p.freq;
    pk[k] = p.mv;
  }
  float fMean, fSd, pMean, pSd;
  meanSd(fr, 10, fMean, fSd);
  meanSd(pk, 10, pMean, pSd);
  float rel = pMean > 0 ? 100.0f * pSd / pMean : 0;
  lastRelSd = fmaxf(rel, 0.2f);
  Serial.print("  resonance steadiness: ");
  Serial.print(fSd / 1e3, 2);
  Serial.println(" kHz");
  Serial.print("  peak height steadiness: ");
  Serial.print(rel, 2);
  Serial.println(" % of the peak");
  if (rel < 2.0f && fSd < 2000.0f) pass("steady in air");
  else if (rel < 5.0f) warn("some wander. Warm up for 5 minutes, keep hands and cables still, and re-run.");
  else fail("too unsteady to use. Look for loose wires or a moving cable.");
  endTest();
}

void coilPlacement() {
  beginTest("Coil placement test: 10 placements on the same spot");
  if (!located && !locate(false)) {
    Serial.println("  could not find the resonance. Run COIL,FULL first.");
    endTest();
    return;
  }
  float fr[10], pk[10];
  for (int k = 0; k < 10; k++) {
    Serial.print("  placement ");
    Serial.print(k + 1);
    Serial.println(": lift the coil away and set it back on the same mark, then keep still.");
    countdown("measuring", 6);
    sweepAvg(fineS, FINE_STEP, FINE_N, 2, fineBuf);
    Peak p = analyzeRange(fineBuf, FINE_N, fineS, FINE_STEP);
    fr[k] = p.freq;
    pk[k] = p.mv;
    Serial.print("    resonance ");
    Serial.print(p.freq / 1e6, 4);
    Serial.print(" MHz, peak ");
    Serial.print(p.mv, 2);
    Serial.println(" mV");
  }
  float fMean, fSd, pMean, pSd;
  meanSd(fr, 10, fMean, fSd);
  meanSd(pk, 10, pMean, pSd);
  float rel = pMean > 0 ? 100.0f * pSd / pMean : 0;
  Serial.print("  placement scatter: ");
  Serial.print(rel, 2);
  Serial.print(" % of the peak, resonance ");
  Serial.print(fSd / 1e3, 2);
  Serial.println(" kHz");
  if (rel < 2.0f) pass("placing the coil is repeatable");
  else if (rel < 5.0f) warn("some placement scatter. A spacer ring or a jig will help.");
  else fail("placement scatter is large. Use a fixed spacer ring and jig before trusting small differences.");
  endTest();
}

void coilResponse() {
  beginTest("Coil response test");
  if (!located && !locate(false)) {
    Serial.println("  could not find the resonance. Run COIL,FULL first.");
    endTest();
    return;
  }
  float fr[3], pk[3];
  const char* steps[3] = {
    "Keep the coil still with nothing near it (baseline).",
    "Bring your hand (or a salt-water cup) about 3 cm from the coil face and hold it still.",
    "Take it away again and keep still (recovery)."
  };
  for (int k = 0; k < 3; k++) {
    Serial.print("  ");
    Serial.println(steps[k]);
    countdown("measuring", 6);
    sweepAvg(fineS, FINE_STEP, FINE_N, 3, fineBuf);
    Peak p = analyzeRange(fineBuf, FINE_N, fineS, FINE_STEP);
    fr[k] = p.freq;
    pk[k] = p.mv;
    Serial.print("    resonance ");
    Serial.print(p.freq / 1e6, 4);
    Serial.print(" MHz, peak ");
    Serial.print(p.mv, 2);
    Serial.println(" mV");
  }
  float dPeak = 100.0f * (pk[1] - pk[0]) / pk[0];
  float dRec = 100.0f * (pk[2] - pk[0]) / pk[0];
  float dFreq = (fr[1] - fr[0]) / 1e3;
  Serial.print("  with the object near: peak ");
  Serial.print(dPeak, 1);
  Serial.print(" %, resonance shift ");
  Serial.print(dFreq, 1);
  Serial.println(" kHz");
  Serial.print("  after removing it: peak ");
  Serial.print(dRec, 1);
  Serial.println(" % from baseline");
  float need = fmaxf(3.0f, 5.0f * lastRelSd);
  if (fabsf(dPeak) >= need) pass("the coil responds to a nearby object");
  else fail("no clear response. Bring the object closer, check the coil connection, or try a salt-water cup.");
  if (fabsf(dRec) <= fmaxf(2.0f, 2.0f * lastRelSd)) pass("it returns to baseline");
  else warn("it did not return to baseline. The coil may have moved, or it is drifting.");
  endTest();
}

void coilGuided() {
  double fe = expectedHz();
  Serial.print("Guided scan around the CALCULATED resonance (L = ");
  Serial.print(assumedL_uH, 2);
  Serial.print(" uH assumed, C = ");
  Serial.print(capPF, 0);
  Serial.print(" pF): expected ");
  Serial.print(fe / 1e6, 3);
  Serial.println(" MHz");
  setWideRange(fe * 0.6, fe * 1.4);
  coilFull();
  Serial.println("Any inductance printed above is MEASURED from the peak. The assumed value only aimed the scan.");
}

void dumpScans() {
  Serial.println("#WIDE,freq_hz,mV");
  for (int i = 0; i < WIDE_N; i++) {
    Serial.print(WIDE_S + i * WIDE_STEP, 0);
    Serial.print(',');
    Serial.println(wideBuf[i], 3);
  }
  if (located) {
    Serial.println("#FINE,freq_hz,mV");
    for (int i = 0; i < FINE_N; i++) {
      Serial.print(fineS + i * FINE_STEP, 0);
      Serial.print(',');
      Serial.println(fineBuf[i], 3);
    }
  }
}

void holdFreq(double hz) {
  streaming = false;
  Serial.print("Holding ");
  Serial.print(hz / 1e6, 4);
  Serial.println(" MHz for 10 seconds. Detector reading:");
  setFreq(hz);
  for (int i = 0; i < 20; i++) {
    delay(500);
    Serial.print("  ");
    Serial.print(readDetectorMV(), 3);
    Serial.println(" mV");
  }
  muteOutput();
  Serial.println("Output muted.");
}

// ---------- AD9833 frequency check (jumper AD9833 OUT to Uno A2) ----------
double measureHz(unsigned long windowMs) {
  int lo = 16383, hi = 0;
  unsigned long t0 = millis();
  while (millis() - t0 < 60) {
    int v = analogRead(FREQ_PIN);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi - lo < 200) return -1;
  int mid = (hi + lo) / 2;
  int hyst = (hi - lo) / 6;
  bool below = true;
  long crossings = 0;
  unsigned long firstT = 0, lastT = 0;
  unsigned long end = micros() + windowMs * 1000UL;
  while ((long)(end - micros()) > 0) {
    int v = analogRead(FREQ_PIN);
    if (below && v > mid + hyst) {
      below = false;
      unsigned long t = micros();
      if (crossings == 0) firstT = t;
      lastT = t;
      crossings++;
    } else if (!below && v < mid - hyst) {
      below = true;
    }
  }
  if (crossings < 4) return 0;
  return (crossings - 1) * 1000000.0 / (double)(lastT - firstT);
}

void freqCheck() {
  beginTest("AD9833 frequency check");
  Serial.println("  Jumper AD9833 OUT to Uno A2 (and remove it afterwards).");
  const double tests[4] = { 200.0, 500.0, 1000.0, 2000.0 };
  double mclkEst[4];
  int ok = 0;
  for (int i = 0; i < 4; i++) {
    setFreq(tests[i]);
    delay(200);
    double m = measureHz(1000);
    Serial.print("  ");
    Serial.print(tests[i], 0);
    Serial.print(" Hz -> ");
    if (m < 0) {
      Serial.println("no signal on A2");
    } else if (m == 0) {
      Serial.println("too few cycles counted");
    } else {
      Serial.print(m, 1);
      Serial.print(" Hz (ratio ");
      Serial.print(m / tests[i], 3);
      Serial.println(")");
      mclkEst[ok++] = mclkHz * m / tests[i];
    }
  }
  muteOutput();
  if (ok == 0) {
    fail("no usable signal. Check the jumper from AD9833 OUT to A2, the AD9833 power and ground, and the SPI wires.");
    endTest();
    return;
  }
  double s = 0;
  for (int i = 0; i < ok; i++) s += mclkEst[i];
  double avg = s / ok;
  double spread = 0;
  for (int i = 0; i < ok; i++) {
    double d = fabs(mclkEst[i] - avg) / avg;
    if (d > spread) spread = d;
  }
  Serial.print("  implied oscillator frequency: ");
  Serial.print(avg / 1e6, 3);
  Serial.print(" MHz (spread ");
  Serial.print(spread * 100.0, 1);
  Serial.println(" %)");
  if (ok < 3 || spread > 0.05) {
    fail("the output does NOT follow the commanded frequency consistently. Check D13, D11 and D10.");
  } else if (fabs(avg - mclkHz) / mclkHz < 0.03) {
    pass("the oscillator matches the MCLK setting and the frequency follows the commands");
  } else {
    fail("the oscillator is not what the MCLK setting says.");
    Serial.print("  Send  MCLK,");
    Serial.println((long)(avg + 0.5));
  }
  endTest();
}

void runAll() {
  selfTest();
  irPhotodiodeOnly();
  irBlink();
  gyroNoise();
  Serial.println();
  Serial.println("ALL done. Coil tests are separate: COIL,FULL or COIL,GUIDED.");
}

// ===================== commands =====================
String field(const String& s, int idx) {
  int start = 0;
  for (int i = 0; i < idx; i++) {
    start = s.indexOf(',', start);
    if (start < 0) return "";
    start++;
  }
  int end = s.indexOf(',', start);
  String f = (end < 0) ? s.substring(start) : s.substring(start, end);
  f.trim();
  return f;
}

void printHelp() {
  Serial.println("#HELP  Commands (case does not matter):");
  Serial.println("#HELP   Live data:   READ | STREAM,<ms> | STOP | STATUS | ZERO | CALGYRO");
  Serial.println("#HELP   LED:         LED,<0|1> | BLINK,<count>,<ms>");
  Serial.println("#HELP   Tests:       SELFTEST | ALL | VREF | FREQCHECK");
  Serial.println("#HELP   Gyro:        GYRO,NOISE | GYRO,90 | GYRO,BACK | GYRO,SPIN");
  Serial.println("#HELP   IR:          IR,BLINK | IR,PD | IR,AMBIENT | IR,STEADY");
  Serial.println("#HELP   Coil:        COIL,FULL | COIL,PLACE | COIL,RESP | COIL,GUIDED | COIL,DUMP");
  Serial.println("#HELP   Coil setup:  CAP,<pF> | LASSUME,<uH> | TARGET,<MHz> | MCLK,<Hz> | RANGE,<a>,<b> | FREQ,<MHz>");
  Serial.println("#HELP   Data line:   D,millis,a0_mV,gnd_mV,temp_C,gx,gy,gz,gyro_dps,ax,ay,az,accel_g,tilt_deg,pd_mV,led");
}

void printStatus() {
  Serial.println("#STATUS");
  Serial.print("  ADS1115: ");
  Serial.println(adsOK ? "found at 0x48" : "NOT found");
  Serial.print("  GY-521: ");
  if (mpuAddr) {
    Serial.print("found at 0x");
    Serial.println(mpuAddr, HEX);
  } else {
    Serial.println("NOT found");
  }
  Serial.print("  tank capacitor: ");
  Serial.print(capPF, 0);
  Serial.println(" pF");
  Serial.print("  assumed (calculated) inductance: ");
  Serial.print(assumedL_uH, 2);
  Serial.print(" uH, expected resonance ");
  Serial.print(expectedHz() / 1e6, 3);
  Serial.println(" MHz");
  Serial.print("  AD9833 oscillator setting: ");
  Serial.print(mclkHz, 0);
  Serial.println(" Hz");
  Serial.print("  gyro offset (deg/s): ");
  Serial.print(biasX, 2);
  Serial.print(", ");
  Serial.print(biasY, 2);
  Serial.print(", ");
  Serial.println(biasZ, 2);
  Serial.print("  streaming: ");
  Serial.println(streaming ? "on" : "off");
}

void handleCommand(String line) {
  line.trim();
  if (line.length() == 0) return;
  String cmd = field(line, 0);
  cmd.toUpperCase();
  String a1 = field(line, 1);
  String a2 = field(line, 2);
  String u1 = a1;
  u1.toUpperCase();

  if (cmd == "HELP" || cmd == "?") {
    printHelp();
  } else if (cmd == "PING") {
    Serial.println("#PONG");
  } else if (cmd == "STATUS") {
    printStatus();
  } else if (cmd == "READ") {
    sendData();
  } else if (cmd == "STREAM") {
    long ms = a1.toInt();
    streamMs = (ms >= 50) ? (unsigned long)ms : 200UL;
    streaming = true;
    lastStream = 0;
    Serial.println("#OK,streaming");
  } else if (cmd == "STOP") {
    streaming = false;
    Serial.println("#OK,stopped");
  } else if (cmd == "LED") {
    blinkLeft = 0;
    setLed(a1.toInt() != 0);
    Serial.println("#OK");
  } else if (cmd == "BLINK") {
    int n = a1.toInt();
    long ms = a2.toInt();
    if (n < 1) n = 3;
    if (ms < 50) ms = 250;
    startBlink(n, (unsigned long)ms);
    Serial.println("#OK");
  } else if (cmd == "ZERO") {
    double sx = 0, sy = 0, sz = 0;
    int got = 0;
    for (int i = 0; i < 50; i++) {
      if (readAll()) {
        sx += ax;
        sy += ay;
        sz += az;
        got++;
      }
      delay(5);
    }
    if (got > 0) {
      refX = sx / got;
      refY = sy / got;
      refZ = sz / got;
      haveRef = true;
      Serial.println("#OK,tilt reference stored");
    } else {
      Serial.println("#ERR,GY-521 not available");
    }
  } else if (cmd == "CALGYRO") {
    bool wasStreaming = streaming;
    streaming = false;
    Serial.println("#INFO,keep the board still...");
    if (calibrate(2000)) {
      Serial.print("#OK,gyro offset ");
      Serial.print(biasX, 2);
      Serial.print(' ');
      Serial.print(biasY, 2);
      Serial.print(' ');
      Serial.println(biasZ, 2);
    } else {
      Serial.println("#ERR,could not read the gyro");
    }
    streaming = wasStreaming;
  } else if (cmd == "SELFTEST") {
    selfTest();
  } else if (cmd == "ALL") {
    runAll();
  } else if (cmd == "VREF") {
    vrefTest();
  } else if (cmd == "FREQCHECK") {
    freqCheck();
  } else if (cmd == "GYRO") {
    if (u1 == "NOISE") gyroNoise();
    else if (u1 == "90") gyro90();
    else if (u1 == "BACK") gyroBack();
    else if (u1 == "SPIN") gyroSpin();
    else Serial.println("#ERR,use GYRO,NOISE or 90 or BACK or SPIN");
  } else if (cmd == "IR") {
    if (u1 == "BLINK") irBlink();
    else if (u1 == "PD") irPhotodiodeOnly();
    else if (u1 == "AMBIENT") irAmbient();
    else if (u1 == "STEADY") ledSteady();
    else Serial.println("#ERR,use IR,BLINK or PD or AMBIENT or STEADY");
  } else if (cmd == "COIL") {
    if (u1 == "FULL") coilFull();
    else if (u1 == "PLACE") coilPlacement();
    else if (u1 == "RESP") coilResponse();
    else if (u1 == "GUIDED") coilGuided();
    else if (u1 == "DUMP") dumpScans();
    else Serial.println("#ERR,use COIL,FULL or PLACE or RESP or GUIDED or DUMP");
  } else if (cmd == "FREQ") {
    holdFreq(a1.toFloat() * 1e6);
  } else if (cmd == "CAP") {
    capPF = a1.toFloat();
    located = false;
    Serial.print("#OK,tank capacitor ");
    Serial.print(capPF, 0);
    Serial.println(" pF");
  } else if (cmd == "LASSUME") {
    assumedL_uH = a1.toFloat();
    Serial.print("#OK,assumed (calculated) inductance ");
    Serial.print(assumedL_uH, 2);
    Serial.print(" uH, expected resonance ");
    Serial.print(expectedHz() / 1e6, 3);
    Serial.println(" MHz");
  } else if (cmd == "TARGET") {
    targetHz = a1.toFloat() * 1e6;
    Serial.println("#OK");
  } else if (cmd == "MCLK") {
    mclkHz = a1.toFloat();
    located = false;
    Serial.println("#OK");
  } else if (cmd == "RANGE") {
    double a = a1.toFloat() * 1e6;
    double b = a2.toFloat() * 1e6;
    if (a > 0 && b > a) {
      setWideRange(a, b);
      Serial.print("#OK,wide scan ");
      Serial.print(WIDE_S / 1e6, 3);
      Serial.print("-");
      Serial.print((WIDE_S + (WIDE_N - 1) * WIDE_STEP) / 1e6, 3);
      Serial.print(" MHz, ");
      Serial.print(WIDE_STEP / 1e3, 0);
      Serial.println(" kHz steps");
    } else {
      Serial.println("#ERR,use RANGE,<start_MHz>,<stop_MHz>");
    }
  } else {
    Serial.println("#ERR,unknown command. Type HELP");
  }
}

// ===================== setup and loop =====================
void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 4000) { }

  pinMode(FSYNC_PIN, OUTPUT);
  digitalWrite(FSYNC_PIN, HIGH);
  pinMode(LED_PIN, OUTPUT);
  setLed(false);
  analogReadResolution(14);
  SPI.begin();
  Wire.begin();
  Wire.setClock(400000);

  adsOK = ads.begin(ADS_ADDR, &Wire);
  if (adsOK) setGainIdx(0);
  if (initMPU()) {
    Serial.println("#INFO,keep the board still for 2 seconds (gyro offset)...");
    calibrate(2000);
  }
  muteOutput();

  Serial.println("#READY,lucid_hardware_test");
  Serial.print("#INFO,ADS1115 ");
  Serial.print(adsOK ? "found" : "NOT found");
  Serial.print(", GY-521 ");
  Serial.println(mpuAddr ? "found" : "NOT found");
  Serial.println("#INFO,type HELP for commands");
}

void loop() {
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    handleCommand(line);
  }
  serviceBlink();
  if (streaming && millis() - lastStream >= streamMs) {
    lastStream = millis();
    sendData();
  }
}
