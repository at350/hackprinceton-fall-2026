#!/usr/bin/env python3
"""Lucid hardware monitor (draft, untested).

A window that talks to the Arduino running lucid_hardware_test.ino and shows live:
  A0 detector voltage, ground reference voltage, temperature, all gyro and
  accelerometer data, tilt, and the IR sensor (photodiode) voltage.
It can blink the IR LED, run every hardware test, remember locations, and run a
LOCATION TEST that records each location for a number of seconds and compares them.

Install:  pip install pyserial matplotlib      (tkinter comes with Python)
Run:      python lucid_hardware_monitor.py

Wiring note: for the ground reading, jumper ADS1115 A1 to GND. Without the jumper
that column floats and shows random values.
"""
import csv
import math
import os
import queue
import sys
import threading
import time
from datetime import datetime

import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext

try:
    import serial
    import serial.tools.list_ports
except ImportError:
    print("Install pyserial first:  pip install pyserial")
    sys.exit(1)

NAN = float("nan")
BAUD = 115200
FIELDS = ["millis", "a0_mV", "gnd_mV", "temp_C", "gx", "gy", "gz", "gyro_dps",
          "ax", "ay", "az", "accel_g", "tilt_deg", "pd_mV", "led"]

DEFAULT_LOCATIONS = ["L frontal", "R frontal", "L temporal", "R temporal",
                     "L parietal", "R parietal", "L occipital", "R occipital",
                     "L vertex", "R vertex"]

LIVE_ROWS = [
    ("A0 detector (mV)", "a0_mV", 3),
    ("Ground reference (mV)", "gnd_mV", 3),
    ("A0 minus ground (mV)", "a0_corr", 3),
    ("Temperature (C)", "temp_C", 2),
    ("Gyro X (deg/s)", "gx", 2),
    ("Gyro Y (deg/s)", "gy", 2),
    ("Gyro Z (deg/s)", "gz", 2),
    ("Gyro magnitude (deg/s)", "gyro_dps", 2),
    ("Accel X (g)", "ax", 3),
    ("Accel Y (g)", "ay", 3),
    ("Accel Z (g)", "az", 3),
    ("Accel magnitude (g)", "accel_g", 3),
    ("Tilt from zero pose (deg)", "tilt_deg", 1),
    ("IR sensor / photodiode (mV)", "pd_mV", 3),
    ("LED (1 = on)", "led", 0),
]

TESTS = [
    ("Self-test", "SELFTEST"),
    ("Run all basics", "ALL"),
    ("Gyro noise", "GYRO,NOISE"),
    ("Gyro 90 degrees", "GYRO,90"),
    ("Gyro there and back", "GYRO,BACK"),
    ("Gyro full spin", "GYRO,SPIN"),
    ("IR blink test", "IR,BLINK"),
    ("IR photodiode only", "IR,PD"),
    ("IR ambient light", "IR,AMBIENT"),
    ("LED steady 10 s", "IR,STEADY"),
    ("Voltage reference", "VREF"),
    ("Coil full test", "COIL,FULL"),
    ("Coil guided scan", "COIL,GUIDED"),
    ("Coil placement", "COIL,PLACE"),
    ("Coil response", "COIL,RESP"),
    ("AD9833 frequency check", "FREQCHECK"),
]


def parse_data(line):
    parts = line.strip().split(",")
    if len(parts) != 16 or parts[0] != "D":
        return None
    d = {}
    for name, text in zip(FIELDS, parts[1:]):
        try:
            d[name] = float(text)
        except ValueError:
            d[name] = NAN
    return d


def fmt(v, nd):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "nan"
    return f"{v:.{nd}f}"


def mean_sd(values):
    vals = [v for v in values if not math.isnan(v)]
    if not vals:
        return NAN, NAN
    m = sum(vals) / len(vals)
    if len(vals) < 2:
        return m, 0.0
    var = sum((v - m) ** 2 for v in vals) / len(vals)
    return m, math.sqrt(var)


class SerialLink:
    def __init__(self):
        self.ser = None
        self.q = queue.Queue()
        self.running = False

    def open(self, port):
        self.ser = serial.Serial(port, BAUD, timeout=0.1)
        time.sleep(2.0)
        self.running = True
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        buf = b""
        while self.running:
            try:
                n = self.ser.in_waiting
                data = self.ser.read(n if n else 1)
            except Exception as e:
                self.q.put(f"#ERR,serial error: {e}")
                break
            if not data:
                continue
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                text = line.decode(errors="ignore").strip()
                if text:
                    self.q.put(text)

    def send(self, cmd):
        if self.ser and self.ser.is_open:
            self.ser.write((cmd + "\n").encode())

    def close(self):
        self.running = False
        time.sleep(0.2)
        if self.ser:
            try:
                self.ser.close()
            except Exception:
                pass
        self.ser = None

    @property
    def connected(self):
        return self.ser is not None and self.ser.is_open


class App:
    def __init__(self, root):
        self.root = root
        root.title("Lucid hardware monitor")
        self.link = SerialLink()
        self.latest = {}
        self.vars = {}
        self.location = tk.StringVar(value="(none)")
        self.log_enabled = tk.BooleanVar(value=True)
        self.status_var = tk.StringVar(value="Not connected.")
        self.session_dir = None
        self.raw_file = None
        self.raw_writer = None
        self.visited = {}
        self.sample_count = 0
        self.loctest = None
        self.results = []
        self.build_ui()
        self.refresh_ports()
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.poll()

    # ---------- layout ----------
    def build_ui(self):
        top = ttk.Frame(self.root, padding=6)
        top.grid(row=0, column=0, columnspan=3, sticky="ew")
        ttk.Label(top, text="Port:").pack(side="left")
        self.port_box = ttk.Combobox(top, width=28, state="readonly")
        self.port_box.pack(side="left", padx=4)
        ttk.Button(top, text="Refresh", command=self.refresh_ports).pack(side="left")
        self.connect_btn = ttk.Button(top, text="Connect", command=self.toggle_connect)
        self.connect_btn.pack(side="left", padx=6)
        ttk.Label(top, textvariable=self.status_var, foreground="#444").pack(side="left", padx=10)

        # live values
        live = ttk.LabelFrame(self.root, text="Live values", padding=6)
        live.grid(row=1, column=0, sticky="nsew", padx=6, pady=4)
        for i, (label, key, nd) in enumerate(LIVE_ROWS):
            ttk.Label(live, text=label).grid(row=i, column=0, sticky="w")
            v = tk.StringVar(value="-")
            ttk.Label(live, textvariable=v, width=12, anchor="e",
                      font=("Consolas", 11)).grid(row=i, column=1, sticky="e", padx=8)
            self.vars[key] = (v, nd)

        # controls and locations
        mid = ttk.Frame(self.root)
        mid.grid(row=1, column=1, sticky="nsew", padx=6, pady=4)

        ctl = ttk.LabelFrame(mid, text="Controls", padding=6)
        ctl.pack(fill="x")
        ttk.Button(ctl, text="Start live", command=lambda: self.cmd("STREAM,200")).grid(row=0, column=0, padx=2, pady=2)
        ttk.Button(ctl, text="Stop live", command=lambda: self.cmd("STOP")).grid(row=0, column=1, padx=2, pady=2)
        ttk.Button(ctl, text="LED on", command=lambda: self.cmd("LED,1")).grid(row=1, column=0, padx=2, pady=2)
        ttk.Button(ctl, text="LED off", command=lambda: self.cmd("LED,0")).grid(row=1, column=1, padx=2, pady=2)
        self.blink_n = tk.StringVar(value="5")
        self.blink_ms = tk.StringVar(value="250")
        ttk.Label(ctl, text="Blinks").grid(row=2, column=0, sticky="e")
        ttk.Entry(ctl, textvariable=self.blink_n, width=5).grid(row=2, column=1, sticky="w")
        ttk.Label(ctl, text="ms per phase").grid(row=3, column=0, sticky="e")
        ttk.Entry(ctl, textvariable=self.blink_ms, width=5).grid(row=3, column=1, sticky="w")
        ttk.Button(ctl, text="Blink LED", command=self.blink).grid(row=4, column=0, columnspan=2, pady=2)
        ttk.Button(ctl, text="Zero tilt here", command=lambda: self.cmd("ZERO")).grid(row=5, column=0, padx=2, pady=2)
        ttk.Button(ctl, text="Recalibrate gyro", command=lambda: self.cmd("CALGYRO")).grid(row=5, column=1, padx=2, pady=2)

        locf = ttk.LabelFrame(mid, text="Locations", padding=6)
        locf.pack(fill="both", expand=True, pady=6)
        ttk.Label(locf, text="Current location:").grid(row=0, column=0, sticky="w")
        self.loc_entry = ttk.Entry(locf, width=20)
        self.loc_entry.grid(row=0, column=1, padx=4)
        ttk.Button(locf, text="Set", command=self.set_location_from_entry).grid(row=0, column=2)
        ttk.Label(locf, textvariable=self.location, foreground="#0a5").grid(row=1, column=0, columnspan=3, sticky="w")
        ttk.Checkbutton(locf, text="Log live data to file (tagged with the location)",
                        variable=self.log_enabled).grid(row=2, column=0, columnspan=3, sticky="w")
        self.visit_tree = ttk.Treeview(locf, columns=("n",), height=5)
        self.visit_tree.heading("#0", text="Visited")
        self.visit_tree.heading("n", text="Samples")
        self.visit_tree.column("#0", width=150)
        self.visit_tree.column("n", width=70, anchor="e")
        self.visit_tree.grid(row=3, column=0, columnspan=3, sticky="nsew", pady=4)

        # location test
        lt = ttk.LabelFrame(self.root, text="Location test", padding=6)
        lt.grid(row=1, column=2, sticky="nsew", padx=6, pady=4)
        ttk.Label(lt, text="Locations, one per line:").pack(anchor="w")
        self.loc_text = tk.Text(lt, width=24, height=11)
        self.loc_text.pack()
        self.loc_text.insert("1.0", "\n".join(DEFAULT_LOCATIONS))
        row = ttk.Frame(lt)
        row.pack(fill="x", pady=3)
        ttk.Label(row, text="Seconds each:").pack(side="left")
        self.secs_var = tk.StringVar(value="10")
        ttk.Entry(row, textvariable=self.secs_var, width=5).pack(side="left", padx=4)
        row2 = ttk.Frame(lt)
        row2.pack(fill="x")
        ttk.Label(row2, text="Still below (deg/s):").pack(side="left")
        self.still_var = tk.StringVar(value="5")
        ttk.Entry(row2, textvariable=self.still_var, width=5).pack(side="left", padx=4)
        ttk.Button(lt, text="Start location test", command=self.start_loctest).pack(fill="x", pady=3)
        self.record_btn = ttk.Button(lt, text="Record this location", command=self.record_clicked, state="disabled")
        self.record_btn.pack(fill="x")
        ttk.Button(lt, text="Cancel test", command=self.cancel_loctest).pack(fill="x", pady=2)
        self.test_status = tk.StringVar(value="No location test running.")
        ttk.Label(lt, textvariable=self.test_status, wraplength=210, foreground="#06c").pack(anchor="w", pady=3)

        # results
        res = ttk.LabelFrame(self.root, text="Location test results", padding=6)
        res.grid(row=2, column=0, columnspan=3, sticky="nsew", padx=6, pady=4)
        cols = ("n", "a0", "a0sd", "gnd", "corr", "temp", "gyro", "pd", "tilt")
        heads = ("Samples", "A0 mean mV", "A0 sd", "GND mean mV", "A0-GND mV",
                 "Temp C", "Gyro max", "IR mV", "Tilt deg")
        self.res_tree = ttk.Treeview(res, columns=cols, height=6)
        self.res_tree.heading("#0", text="Location")
        self.res_tree.column("#0", width=130)
        for c, h in zip(cols, heads):
            self.res_tree.heading(c, text=h)
            self.res_tree.column(c, width=92, anchor="e")
        self.res_tree.pack(fill="x")
        btns = ttk.Frame(res)
        btns.pack(fill="x", pady=3)
        ttk.Button(btns, text="Plot results", command=self.plot_results).pack(side="left")
        ttk.Button(btns, text="Open session folder", command=self.open_folder).pack(side="left", padx=6)

        # tests
        tf = ttk.LabelFrame(self.root, text="Hardware tests (follow the prompts in the log)", padding=6)
        tf.grid(row=3, column=0, columnspan=3, sticky="ew", padx=6, pady=4)
        for i, (name, command) in enumerate(TESTS):
            ttk.Button(tf, text=name, command=lambda c=command: self.run_test(c)).grid(
                row=i // 6, column=i % 6, padx=2, pady=2, sticky="ew")

        # log and raw command
        lg = ttk.LabelFrame(self.root, text="Device log", padding=6)
        lg.grid(row=4, column=0, columnspan=3, sticky="nsew", padx=6, pady=4)
        self.log_box = scrolledtext.ScrolledText(lg, width=130, height=12, font=("Consolas", 9))
        self.log_box.pack(fill="both", expand=True)
        cmdrow = ttk.Frame(lg)
        cmdrow.pack(fill="x", pady=3)
        ttk.Label(cmdrow, text="Send command:").pack(side="left")
        self.cmd_entry = ttk.Entry(cmdrow, width=50)
        self.cmd_entry.pack(side="left", padx=4)
        self.cmd_entry.bind("<Return>", lambda e: self.send_raw())
        ttk.Button(cmdrow, text="Send", command=self.send_raw).pack(side="left")
        ttk.Button(cmdrow, text="HELP", command=lambda: self.cmd("HELP")).pack(side="left", padx=4)

    # ---------- connection ----------
    def refresh_ports(self):
        ports = [p.device for p in serial.tools.list_ports.comports()]
        self.port_box["values"] = ports
        if ports and not self.port_box.get():
            self.port_box.set(ports[0])

    def toggle_connect(self):
        if self.link.connected:
            self.disconnect()
            return
        port = self.port_box.get()
        if not port:
            messagebox.showinfo("Port", "Pick a port first. Close the Arduino Serial Monitor if it is open.")
            return
        try:
            self.link.open(port)
        except Exception as e:
            messagebox.showerror("Connection failed", str(e))
            return
        self.connect_btn.config(text="Disconnect")
        self.status_var.set(f"Connected to {port}")
        self.open_session()
        self.cmd("STATUS")

    def disconnect(self):
        if self.link.connected:
            self.link.send("STOP")
        self.link.close()
        self.close_session()
        self.connect_btn.config(text="Connect")
        self.status_var.set("Not connected.")

    def open_session(self):
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.session_dir = os.path.join("lucid_hardware_sessions", stamp)
        os.makedirs(self.session_dir, exist_ok=True)
        self.raw_file = open(os.path.join(self.session_dir, "raw_live.csv"), "w", newline="")
        self.raw_writer = csv.writer(self.raw_file)
        self.raw_writer.writerow(["pc_time", "location"] + FIELDS + ["a0_minus_gnd_mV"])
        self.log(f"Session folder: {self.session_dir}")

    def close_session(self):
        if self.raw_file:
            try:
                self.raw_file.close()
            except Exception:
                pass
        self.raw_file = None
        self.raw_writer = None

    def open_folder(self):
        if not self.session_dir:
            return
        path = os.path.abspath(self.session_dir)
        try:
            if sys.platform.startswith("win"):
                os.startfile(path)
            elif sys.platform == "darwin":
                os.system(f'open "{path}"')
            else:
                os.system(f'xdg-open "{path}"')
        except Exception:
            self.log(f"Session folder: {path}")

    # ---------- commands ----------
    def cmd(self, text):
        if not self.link.connected:
            messagebox.showinfo("Not connected", "Connect to the Arduino first.")
            return
        self.link.send(text)

    def send_raw(self):
        text = self.cmd_entry.get().strip()
        if text:
            self.cmd(text)
            self.log(f"> {text}")
            self.cmd_entry.delete(0, "end")

    def blink(self):
        try:
            n = int(self.blink_n.get())
            ms = int(self.blink_ms.get())
        except ValueError:
            messagebox.showinfo("Blink", "Enter whole numbers for blinks and ms.")
            return
        self.cmd(f"BLINK,{n},{ms}")

    def run_test(self, command):
        if not self.link.connected:
            messagebox.showinfo("Not connected", "Connect to the Arduino first.")
            return
        self.link.send("STOP")
        time.sleep(0.15)
        self.log(f"> {command}   (live data stops during a test; click Start live afterwards)")
        self.link.send(command)

    # ---------- locations ----------
    def set_location(self, name):
        self.location.set(name)
        self.loc_entry.delete(0, "end")
        self.loc_entry.insert(0, name)
        if name not in self.visited:
            self.visited[name] = 0
            self.visit_tree.insert("", "end", iid=name, text=name, values=(0,))

    def set_location_from_entry(self):
        name = self.loc_entry.get().strip()
        if name:
            self.set_location(name)

    # ---------- incoming data ----------
    def poll(self):
        try:
            while True:
                line = self.link.q.get_nowait()
                self.handle_line(line)
        except queue.Empty:
            pass
        self.root.after(40, self.poll)

    def handle_line(self, line):
        d = parse_data(line) if line.startswith("D,") else None
        if d is None:
            self.log(line)
            return
        a0, gnd = d["a0_mV"], d["gnd_mV"]
        d["a0_corr"] = (a0 - gnd) if not (math.isnan(a0) or math.isnan(gnd)) else NAN
        self.latest = d
        for key, (var, nd) in self.vars.items():
            var.set(fmt(d.get(key), nd))
        loc = self.location.get()
        if self.log_enabled.get() and self.raw_writer:
            self.raw_writer.writerow([datetime.now().isoformat(timespec="milliseconds"), loc]
                                     + [d[f] for f in FIELDS] + [d["a0_corr"]])
            if loc in self.visited:
                self.visited[loc] += 1
                self.sample_count += 1
                if self.sample_count % 10 == 0:
                    self.visit_tree.item(loc, values=(self.visited[loc],))
        lt = self.loctest
        if lt and lt["phase"] == "record":
            lt["samples"].append(d)

    def log(self, text):
        self.log_box.insert("end", text + "\n")
        self.log_box.see("end")

    # ---------- location test ----------
    def start_loctest(self):
        if not self.link.connected:
            messagebox.showinfo("Not connected", "Connect to the Arduino first.")
            return
        names = [l.strip() for l in self.loc_text.get("1.0", "end").splitlines() if l.strip()]
        if not names:
            messagebox.showinfo("Locations", "Enter at least one location.")
            return
        try:
            secs = float(self.secs_var.get())
            still = float(self.still_var.get())
        except ValueError:
            messagebox.showinfo("Settings", "Seconds and the still limit must be numbers.")
            return
        self.results = []
        for item in self.res_tree.get_children():
            self.res_tree.delete(item)
        self.loctest = {"names": names, "i": 0, "secs": secs, "still": still,
                        "phase": "prompt", "samples": []}
        self.link.send("STREAM,200")
        self.prompt_location()
        self.root.after(100, self.loctest_tick)

    def prompt_location(self):
        lt = self.loctest
        name = lt["names"][lt["i"]]
        self.set_location(name)
        lt["phase"] = "prompt"
        self.test_status.set(f"Location {lt['i'] + 1} of {len(lt['names'])}: place the device at "
                             f"'{name}', hold it still, then click Record.")
        self.record_btn.config(state="normal")

    def record_clicked(self):
        lt = self.loctest
        if not lt or lt["phase"] != "prompt":
            return
        self.record_btn.config(state="disabled")
        lt["phase"] = "still"
        lt["still_since"] = None
        lt["wait_start"] = time.time()
        lt["samples"] = []
        self.test_status.set("Waiting for the device to be still...")

    def loctest_tick(self):
        lt = self.loctest
        if not lt:
            return
        now = time.time()
        if lt["phase"] == "still":
            g = self.latest.get("gyro_dps", NAN)
            if not math.isnan(g) and g < lt["still"]:
                if lt["still_since"] is None:
                    lt["still_since"] = now
                elif now - lt["still_since"] >= 1.0:
                    self.begin_recording()
            else:
                lt["still_since"] = None
            if lt["phase"] == "still" and now - lt["wait_start"] > 10.0:
                self.log("The device was not still within 10 s. Recording anyway.")
                self.begin_recording()
        elif lt["phase"] == "record":
            elapsed = now - lt["rec_start"]
            name = lt["names"][lt["i"]]
            self.test_status.set(f"Recording '{name}': {elapsed:.0f} of {lt['secs']:.0f} s. Keep still.")
            if elapsed >= lt["secs"]:
                self.finish_location()
        if self.loctest:
            self.root.after(100, self.loctest_tick)

    def begin_recording(self):
        lt = self.loctest
        lt["phase"] = "record"
        lt["rec_start"] = time.time()
        lt["samples"] = []

    def finish_location(self):
        lt = self.loctest
        name = lt["names"][lt["i"]]
        samples = lt["samples"]
        lt["phase"] = "done"
        if not samples:
            self.log(f"No samples were received for '{name}'. Is live data running?")
        a0m, a0s = mean_sd([s["a0_mV"] for s in samples])
        gnm, _ = mean_sd([s["gnd_mV"] for s in samples])
        cm, _ = mean_sd([s["a0_corr"] for s in samples])
        tm, _ = mean_sd([s["temp_C"] for s in samples])
        pm, _ = mean_sd([s["pd_mV"] for s in samples])
        tl, _ = mean_sd([s["tilt_deg"] for s in samples])
        gmax = max([s["gyro_dps"] for s in samples if not math.isnan(s["gyro_dps"])], default=NAN)
        row = {"location": name, "n": len(samples), "a0": a0m, "a0sd": a0s, "gnd": gnm,
               "corr": cm, "temp": tm, "gyro": gmax, "pd": pm, "tilt": tl,
               "time": datetime.now().isoformat(timespec="seconds")}
        self.results.append(row)
        self.res_tree.insert("", "end", text=name, values=(
            row["n"], fmt(a0m, 3), fmt(a0s, 3), fmt(gnm, 3), fmt(cm, 3),
            fmt(tm, 2), fmt(gmax, 2), fmt(pm, 3), fmt(tl, 1)))
        self.save_location_samples(name, samples)
        lt["i"] += 1
        if lt["i"] < len(lt["names"]):
            self.prompt_location()
        else:
            self.finish_loctest()

    def save_location_samples(self, name, samples):
        if not self.session_dir:
            return
        path = os.path.join(self.session_dir, "location_samples.csv")
        new = not os.path.exists(path)
        with open(path, "a", newline="") as fh:
            w = csv.writer(fh)
            if new:
                w.writerow(["location"] + FIELDS + ["a0_minus_gnd_mV"])
            for s in samples:
                w.writerow([name] + [s[f] for f in FIELDS] + [s["a0_corr"]])

    def finish_loctest(self):
        self.loctest = None
        self.record_btn.config(state="disabled")
        self.test_status.set("Location test finished. Results saved in the session folder.")
        self.link.send("STOP")
        path = os.path.join(self.session_dir, "location_summary.csv")
        with open(path, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["location", "samples", "a0_mean_mV", "a0_sd_mV", "gnd_mean_mV",
                        "a0_minus_gnd_mean_mV", "temp_mean_C", "gyro_max_dps", "ir_mean_mV",
                        "tilt_mean_deg", "time"])
            for r in self.results:
                w.writerow([r["location"], r["n"], r["a0"], r["a0sd"], r["gnd"], r["corr"],
                            r["temp"], r["gyro"], r["pd"], r["tilt"], r["time"]])
        self.log(f"Saved {path}")
        self.report_asymmetry()

    def report_asymmetry(self):
        by_name = {r["location"].lower(): r for r in self.results}
        lines = []
        for name, r in by_name.items():
            if name.startswith("l "):
                other = by_name.get("r " + name[2:])
                if other is None:
                    continue
                a, b = r["corr"], other["corr"]
                if math.isnan(a) or math.isnan(b) or (a + b) == 0:
                    continue
                asym = (a - b) / (a + b)
                lines.append((name[2:], asym))
        if not lines:
            return
        self.log("Left/right asymmetry A = (L - R) / (L + R) using A0 minus ground:")
        path = os.path.join(self.session_dir, "asymmetry.csv")
        with open(path, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["pair", "asymmetry"])
            for pair, asym in lines:
                self.log(f"  {pair}: {asym * 100:+.2f} %")
                w.writerow([pair, asym])

    def cancel_loctest(self):
        if self.loctest:
            self.loctest = None
            self.record_btn.config(state="disabled")
            self.test_status.set("Location test cancelled.")
            self.link.send("STOP")

    # ---------- plot ----------
    def plot_results(self):
        if not self.results:
            messagebox.showinfo("Plot", "Run a location test first.")
            return
        from matplotlib.figure import Figure
        from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
        win = tk.Toplevel(self.root)
        win.title("Location test results")
        fig = Figure(figsize=(10, 6))
        names = [r["location"] for r in self.results]
        ax1 = fig.add_subplot(2, 1, 1)
        ax1.bar(names, [r["corr"] for r in self.results], yerr=[r["a0sd"] for r in self.results], capsize=3)
        ax1.set_ylabel("A0 minus ground (mV)")
        ax1.set_title("Detector voltage by location (bars: scatter within the location)")
        ax1.tick_params(axis="x", rotation=30)
        ax2 = fig.add_subplot(2, 1, 2)
        ax2.bar(names, [r["pd"] for r in self.results], color="#c60")
        ax2.set_ylabel("IR sensor (mV)")
        ax2.tick_params(axis="x", rotation=30)
        fig.tight_layout()
        canvas = FigureCanvasTkAgg(fig, master=win)
        canvas.draw()
        canvas.get_tk_widget().pack(fill="both", expand=True)
        if self.session_dir:
            fig.savefig(os.path.join(self.session_dir, "location_plot.png"), dpi=150)

    def on_close(self):
        self.disconnect()
        self.root.destroy()


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
