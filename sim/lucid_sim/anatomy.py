"""Head geometry, scan spots, tissue presets, bleeds and simulated subjects.

Head frame (mm, origin at the head centre): +x toward the right ear, +y toward the
nose, +z toward the crown. The head is a sphere; good enough for left/right pairing.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

HEAD_RADIUS_MM = 90.0

# Scan regions as (azimuth from the nose toward the ear, elevation above the ear line), degrees.
REGIONS = {
    "frontal": (30.0, 35.0),
    "frontotemporal": (60.0, 15.0),
    "temporal": (90.0, 10.0),
    "parietal": (100.0, 50.0),
    "occipital": (155.0, 15.0),
}
SIDES = ("L", "R")


def direction(side: str, az_deg: float, el_deg: float) -> np.ndarray:
    """Unit vector from the head centre to a point on the scalp."""
    az = np.radians(az_deg) * (1.0 if side == "R" else -1.0)
    el = np.radians(el_deg)
    return np.array([np.sin(az) * np.cos(el), np.cos(az) * np.cos(el), np.sin(el)])


@dataclass(frozen=True)
class Spot:
    side: str
    region: str

    def __post_init__(self):
        if self.side not in SIDES or self.region not in REGIONS:
            raise ValueError(f"unknown spot {self.side}-{self.region}")

    @property
    def id(self) -> str:
        return f"{self.side}-{self.region}"

    @property
    def direction(self) -> np.ndarray:
        return direction(self.side, *REGIONS[self.region])

    @property
    def mirror(self) -> "Spot":
        return Spot("R" if self.side == "L" else "L", self.region)

    @classmethod
    def parse(cls, spot: "Spot | str") -> "Spot":
        if isinstance(spot, Spot):
            return spot
        side, _, region = spot.partition("-")
        return cls(side.upper(), region.lower())

    def __str__(self) -> str:
        return self.id


# 5 left/right pairs, scanned left then right.
DEFAULT_SPOTS = tuple(Spot(side, region) for region in REGIONS for side in SIDES)


@dataclass(frozen=True)
class Medium:
    """What the probe is pressed against. Numbers are set by the bench calibration (README)."""

    name: str
    sigma_tissue: float  # S/m the coil sees under a normal spot
    sigma_bleed: float  # S/m inside the bleed (or the balloon)
    outer_layer_mm: float  # scalp + skull, or the phantom shell: the shallowest a bleed can sit
    hair_mm: dict  # mean hair thickness under the probe, per region
    reflectance: float  # share of LED light returned from clean skin at contact
    bleed_od: float  # extra 800 nm optical density over a fully overlapping bleed
    region_sigma_sd: float  # region-to-region conductivity spread (shared by L and R)
    side_sigma_sd: float  # natural left/right asymmetry, per spot
    hair_od_per_mm: float
    pulse_frac: float  # cardiac pulsation depth on the optical channel
    posture: str  # default posture: "supine" (nose up) or "upright"


HUMAN = Medium(
    name="human",
    sigma_tissue=0.25,
    sigma_bleed=0.6,
    outer_layer_mm=12.0,
    hair_mm={"frontal": 0.0, "frontotemporal": 0.5, "temporal": 1.0, "parietal": 2.0, "occipital": 2.0},
    reflectance=0.5,
    bleed_od=0.25,
    region_sigma_sd=0.04,
    side_sigma_sd=0.01,
    hair_od_per_mm=0.15,
    pulse_frac=0.01,
    posture="supine",
)

# Weak saline in a head-shaped shell, with a stronger salt-water balloon as the "bleed".
SALINE_PHANTOM = Medium(
    name="phantom",
    sigma_tissue=0.3,
    sigma_bleed=1.5,
    outer_layer_mm=4.0,
    hair_mm={region: 0.0 for region in REGIONS},
    reflectance=0.35,
    bleed_od=0.03,
    region_sigma_sd=0.01,
    side_sigma_sd=0.005,
    hair_od_per_mm=0.0,
    pulse_frac=0.0,
    posture="upright",
)

MEDIA = {"human": HUMAN, "phantom": SALINE_PHANTOM}

BLEED_KINDS = ("subdural", "epidural", "intracerebral", "balloon")


@dataclass(frozen=True)
class Bleed:
    """A bleed modelled as a slab under the scalp: depth to its near edge, thickness, lateral spread."""

    at: Spot | str
    volume_ml: float = 30.0
    kind: str = "subdural"
    depth_mm: float | None = None  # to the near edge, from the outer surface
    offset_deg: tuple[float, float] = (0.0, 0.0)  # nudge from the region centre (azimuth, elevation)

    def __post_init__(self):
        object.__setattr__(self, "at", Spot.parse(self.at))
        if self.kind not in BLEED_KINDS:
            raise ValueError(f"unknown bleed kind {self.kind!r}, expected one of {BLEED_KINDS}")

    def geometry(self, medium: Medium) -> tuple[np.ndarray, float, float, float]:
        """(centre direction, depth to near edge mm, thickness mm, lateral radius mm)."""
        az, el = REGIONS[self.at.region]
        centre = direction(self.at.side, az + self.offset_deg[0], el + self.offset_deg[1])
        vol_mm3 = self.volume_ml * 1000.0
        if self.kind in ("subdural", "epidural"):
            base = 10.0 if self.kind == "subdural" else 15.0
            thickness = base * (self.volume_ml / 30.0) ** (1 / 3)
            spread = np.sqrt(vol_mm3 / thickness / np.pi)
            default_depth = medium.outer_layer_mm
        else:
            radius = (3 * vol_mm3 / (4 * np.pi)) ** (1 / 3)
            thickness, spread = 2 * radius, radius
            default_depth = 25.0 if self.kind == "intracerebral" else medium.outer_layer_mm + 5.0
        depth = default_depth if self.depth_mm is None else self.depth_mm
        return centre, depth, thickness, spread

    def overlap(self, medium: Medium, dirs: np.ndarray, decay_mm: float, thick_sat_mm: float = 10.0) -> np.ndarray:
        """How much of a channel's sensitive volume the bleed fills, 0 to 1, for probe directions (N, 3)."""
        centre, depth, thickness, spread = self.geometry(medium)
        angle = np.arccos(np.clip(np.asarray(dirs) @ centre, -1.0, 1.0))
        lateral = np.maximum(HEAD_RADIUS_MM * angle - spread, 0.0)
        dist = np.hypot(lateral, depth)
        return (1 - np.exp(-thickness / thick_sat_mm)) * np.exp(-dist / decay_mm)

    def __str__(self) -> str:
        return f"{self.volume_ml:g} ml {self.kind} at {self.at}"


@dataclass
class Subject:
    """One head (or phantom) with its own random anatomy, fixed by the seed."""

    medium: Medium = HUMAN
    bleeds: tuple[Bleed, ...] = ()
    heart_rate_bpm: float = 75.0
    seed: int | None = 0
    _sigma: dict = field(init=False, repr=False)
    _hair: dict = field(init=False, repr=False)
    _reflectance: dict = field(init=False, repr=False)

    def __post_init__(self):
        self.bleeds = tuple(self.bleeds)
        rng = np.random.default_rng(self.seed)
        m = self.medium
        region_offset = {r: rng.normal(0, m.region_sigma_sd) for r in REGIONS}
        # Hair varies a lot between regions and people, but little between the two sides of one head.
        region_hair = {r: m.hair_mm[r] * max(0.0, 1 + 0.3 * rng.normal()) for r in REGIONS}
        self._sigma, self._hair, self._reflectance = {}, {}, {}
        for spot in DEFAULT_SPOTS:
            self._sigma[spot] = m.sigma_tissue + region_offset[spot.region] + rng.normal(0, m.side_sigma_sd)
            self._hair[spot] = max(0.0, region_hair[spot.region] * (1 + 0.08 * rng.normal()))
            self._reflectance[spot] = m.reflectance * rng.lognormal(0, 0.08)

    def sigma(self, spot: Spot) -> float:
        return self._sigma[spot]

    def hair_mm(self, spot: Spot) -> float:
        return self._hair[spot]

    def reflectance(self, spot: Spot) -> float:
        return self._reflectance[spot]

    def bleed_overlap(self, dirs: np.ndarray, decay_mm: float) -> np.ndarray:
        total = np.zeros(len(dirs))
        for bleed in self.bleeds:
            total += bleed.overlap(self.medium, dirs, decay_mm)
        return np.clip(total, 0.0, 1.0)

    def describe(self) -> str:
        bleeds = "; ".join(str(b) for b in self.bleeds) or "no bleed"
        return f"{self.medium.name}, {bleeds}, seed {self.seed}"
