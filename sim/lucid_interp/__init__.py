"""Lucid signal interpretation: raw probe frames -> clean holds, Fourier components, layer fit, L/R screening flag."""
from .layers import Calibration, Interpretation, interpret, invert_coil
from .locate import PRIORS, BleedPrior, Location, locate
from .segment import Contact, coil_loss, find_contacts, mark_clean
from .spectral import Band, Decomposition, decompose, default_bands, flicker_alias_hz

__all__ = [
    "Band", "BleedPrior", "Calibration", "Contact", "Decomposition", "Interpretation", "coil_loss", "decompose", "default_bands",
    "find_contacts", "flicker_alias_hz", "interpret", "invert_coil", "Location", "locate",
    "mark_clean", "PRIORS",
]
