"""1-D regolith heat-conduction model (Hayne et al. 2017, JGR Planets 122).

Vectorised over P points. Absorbed flux = (1-A(i)) * irradiance on the local
surface. Ignores scattered light / IR from surrounding terrain, so permanently
shadowed floors come out colder than reality (~25-40 K vs ~40-60 K).
Merged unchanged from the lunar_sun prototype.
"""
from __future__ import annotations

import numpy as np

SIGMA = 5.670374e-8
EMISS = 0.95
Q_GEO = 0.018                     # W/m^2 geothermal flux
RHO_S, RHO_D, H_RHO = 1100.0, 1800.0, 0.06
K_S, K_D, CHI = 7.4e-4, 3.4e-3, 2.7
A0, A_A, A_B = 0.12, 0.06, 0.25
CP = (-3.6125, 2.7431, 2.3616e-3, -1.2340e-5, 8.9093e-9)
SYNODIC_S = 29.530589 * 86400


def albedo(inc_deg):
    i = np.clip(inc_deg, 0, 90)
    return A0 + A_A * (i / 45) ** 3 + A_B * (i / 90) ** 8


def heat_cap(T):
    return CP[0] + T * (CP[1] + T * (CP[2] + T * (CP[3] + T * CP[4])))


def _grid(dz0=0.004, growth=1.15, depth=1.5):
    dz = [dz0]
    while sum(dz) < depth:
        dz.append(dz[-1] * growth)
    z = np.concatenate([[0], np.cumsum(dz)])
    rho = RHO_D - (RHO_D - RHO_S) * np.exp(-z / H_RHO)
    kc = K_D - (K_D - K_S) * (RHO_D - rho) / (RHO_D - RHO_S)
    return z, np.diff(z), rho, kc


def simulate(q_abs: np.ndarray, dt_s: float, n_spinup: int) -> np.ndarray:
    """q_abs: (P,T) absorbed flux. First n_spinup steps are cycled 3x for
    spin-up, then the full series is run. Returns surface T (P, T-n_spinup)."""
    z, dz, rho, kc = _grid()
    P = q_abs.shape[0]
    q_mean = q_abs[:, :max(n_spinup, 1)].mean(1)
    T = np.repeat(np.maximum((q_mean / (EMISS * SIGMA)) ** 0.25 * 0.85, 40.0)[:, None],
                  len(z), 1)
    dzc = 0.5 * (dz[1:] + dz[:-1])                    # control volumes, interior

    def step(T, q):
        K = kc * (1 + CHI * (T / 350.0) ** 3)
        C = rho * heat_cap(T)
        dt_max = 0.4 * np.min(C[:, :-1] * dz ** 2 / K[:, :-1])
        n = max(1, int(np.ceil(dt_s / dt_max)))
        h = dt_s / n
        for _ in range(n):
            K = kc * (1 + CHI * (T / 350.0) ** 3)
            C = rho * heat_cap(T)
            Kf = 0.5 * (K[:, 1:] + K[:, :-1])
            flux = Kf * (T[:, 1:] - T[:, :-1]) / dz      # (P,L-1)
            T[:, 1:-1] += h * (flux[:, 1:] - flux[:, :-1]) / (C[:, 1:-1] * dzc)
            Ts = T[:, 0]                                  # surface energy balance
            for _ in range(4):
                f = EMISS * SIGMA * Ts ** 4 - q - Kf[:, 0] * (T[:, 1] - Ts) / dz[0]
                Ts = Ts - f / (4 * EMISS * SIGMA * Ts ** 3 + Kf[:, 0] / dz[0])
            T[:, 0] = np.maximum(Ts, 2.0)
            T[:, -1] = T[:, -2] + Q_GEO * dz[-1] / K[:, -1]
        return T

    if n_spinup:
        for _ in range(3):
            for k in range(n_spinup):
                T = step(T, q_abs[:, k])
    out = np.empty((P, q_abs.shape[1] - n_spinup))
    for k in range(q_abs.shape[1]):
        T = step(T, q_abs[:, k])
        if k >= n_spinup:
            out[:, k - n_spinup] = T[:, 0]
    return out
