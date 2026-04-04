"""
Prophet-based price forecasting microservice.
Deployed on Railway; called by the Next.js API route /api/cards/forecast.

v1: Basic Prophet (original)
v2: Ensemble of Enhanced Prophet + Ridge Regression + EMA Decay
"""

import os
import logging
from typing import List, Optional

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from prophet import Prophet
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
logging.getLogger("prophet").setLevel(logging.WARNING)
logging.getLogger("cmdstanpy").setLevel(logging.WARNING)

app = FastAPI(title="Card Price Forecast Service")

# Allow calls from the Vercel deployment and local dev
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["POST"],
    allow_headers=["*"],
)

# Optional shared secret so only your Next.js backend can call this
API_SECRET = os.getenv("FORECAST_API_SECRET", "")


# ── Request / Response models ─────────────────────────────────────────────────

class PricePoint(BaseModel):
    date: str   # ISO-8601 string e.g. "2026-01-15T00:00:00.000Z"
    price: float


class ForecastRequest(BaseModel):
    points:        List[PricePoint]
    horizon:       int              # days ahead to forecast: 7 | 30 | 90 | 180
    secret:        str = ""
    model_version: str = "v2"      # "v1" for original Prophet, "v2" for ensemble


class ForecastPoint(BaseModel):
    date:  str
    yhat:  float
    lower: float
    upper: float


class ChangePoint(BaseModel):
    date:  str
    delta: float   # magnitude of the trend change (positive = price rising faster)


class ForecastResponse(BaseModel):
    forecast:     List[ForecastPoint]   # future horizon only
    fitted:       List[ForecastPoint]   # historical fitted values (for chart overlay)
    changepoints: List[ChangePoint]     # detected structural breaks
    model_info:   dict


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


# ── Forecast endpoint ─────────────────────────────────────────────────────────

@app.post("/forecast", response_model=ForecastResponse)
def forecast(req: ForecastRequest):
    # Optional auth check
    if API_SECRET and req.secret != API_SECRET:
        raise HTTPException(status_code=401, detail="Invalid secret")

    if len(req.points) < 10:
        raise HTTPException(
            status_code=422,
            detail=f"Need at least 10 data points; got {len(req.points)}"
        )

    # Build Prophet DataFrame (ds = date, y = price)
    df = pd.DataFrame([
        {"ds": pd.to_datetime(p.date).normalize(), "y": p.price}
        for p in req.points
    ]).sort_values("ds").drop_duplicates("ds").reset_index(drop=True)

    horizon = max(7, min(req.horizon, 365))

    version = req.model_version.lower().strip()
    if version == "v1":
        return forecast_v1(df, horizon)
    else:
        return forecast_v2(df, horizon)


# ── v1: Original Prophet logic ────────────────────────────────────────────────

def forecast_v1(df: pd.DataFrame, horizon: int) -> ForecastResponse:
    """Original basic Prophet forecast (unchanged from v1)."""

    model = Prophet(
        changepoint_prior_scale=0.10,
        seasonality_prior_scale=10.0,
        seasonality_mode="additive",
        yearly_seasonality=False,
        weekly_seasonality=(len(df) >= 14),
        daily_seasonality=False,
        interval_width=0.80,
    )
    model.fit(df)

    future = model.make_future_dataframe(periods=horizon, freq="D")
    forecast_df = model.predict(future)

    last_actual_date = df["ds"].max()

    cp_dates  = model.changepoints
    raw_delta = np.array(model.params["delta"])
    cp_deltas = raw_delta.mean(axis=0) if raw_delta.ndim == 2 else raw_delta

    changepoints = [
        ChangePoint(date=str(ts.date()), delta=round(float(d), 4))
        for ts, d in zip(cp_dates, cp_deltas)
        if abs(d) > 0.005
    ]
    changepoints.sort(key=lambda c: abs(c.delta), reverse=True)

    def row_to_point(row) -> ForecastPoint:
        return ForecastPoint(
            date=row["ds"].strftime("%Y-%m-%d"),
            yhat=round(float(row["yhat"]), 2),
            lower=round(float(row["yhat_lower"]), 2),
            upper=round(float(row["yhat_upper"]), 2),
        )

    fitted   = [row_to_point(row) for _, row in forecast_df[forecast_df["ds"] <= last_actual_date].iterrows()]
    forecast = [row_to_point(row) for _, row in forecast_df[forecast_df["ds"] >  last_actual_date].iterrows()]

    model_info = {
        "model_version":    "v1",
        "n_input_points":   len(df),
        "horizon_days":     horizon,
        "n_changepoints":   len(changepoints),
        "weekly_seasonality": len(df) >= 14,
    }

    logger.info("v1 Forecast complete: %d input pts, %d horizon, %d changepoints",
                len(df), horizon, len(changepoints))

    return ForecastResponse(
        forecast=forecast,
        fitted=fitted,
        changepoints=changepoints,
        model_info=model_info,
    )


# ── v2: Ensemble forecast (Enhanced Prophet + Ridge + EMA) ───────────────────

def forecast_v2(df: pd.DataFrame, horizon: int) -> ForecastResponse:
    """
    Quant-grade ensemble: log-space Prophet + momentum Ridge + EMA decay.
    Weights are determined by inverse-RMSE on a pseudo-validation split.
    """
    from sklearn.linear_model import Ridge
    from sklearn.preprocessing import StandardScaler

    last_actual_date = df["ds"].max()

    # ── 1. Log-transform prices ───────────────────────────────────────────────
    # Card prices are log-normal: prevents negative forecasts, handles
    # exponential growth/decay, makes variance more homoscedastic.
    df = df.copy()
    df["y_orig"] = df["y"]
    df["y"] = np.log1p(df["y"])   # log1p handles zero prices gracefully

    # ── 2. Enhanced Prophet ───────────────────────────────────────────────────
    weekly_seasonality   = len(df) >= 14
    monthly_seasonality  = len(df) >= 60
    semi_annual_seasonality = len(df) >= 180
    n_changepoints = min(25, len(df) // 4)

    model = Prophet(
        changepoint_prior_scale=0.15,       # more sensitive to sharp TCG price moves
        seasonality_prior_scale=5.0,        # regularize custom seasonalities
        seasonality_mode="multiplicative",  # multiplicative in LOG space = additive in original
        yearly_seasonality=False,           # not enough data yet; enable when >365 days
        weekly_seasonality=weekly_seasonality,
        daily_seasonality=False,
        interval_width=0.85,                # 85% CI — tighter, more actionable
        n_changepoints=n_changepoints,
    )

    # Custom seasonalities for Pokemon TCG
    if monthly_seasonality:
        # Monthly cycle: grades return, paydays, tournament dates cluster monthly
        model.add_seasonality(name="monthly", period=30.5, fourier_order=5)

    if semi_annual_seasonality:
        # 6-month set release cycle: Pokemon releases major sets every ~6 months
        model.add_seasonality(name="semi_annual", period=182.5, fourier_order=3)

    model.fit(df)
    future = model.make_future_dataframe(periods=horizon, freq="D")
    fc = model.predict(future)

    # Back-transform from log space
    fc["yhat"]       = np.expm1(fc["yhat"])
    fc["yhat_lower"] = np.expm1(fc["yhat_lower"])
    fc["yhat_upper"] = np.expm1(fc["yhat_upper"])
    fc["yhat"]       = fc["yhat"].clip(lower=0.01)
    fc["yhat_lower"] = fc["yhat_lower"].clip(lower=0.01)
    fc["yhat_upper"] = fc["yhat_upper"].clip(lower=0.01)

    # ── 3. Ridge regression (momentum) ───────────────────────────────────────
    # Fit on the last 30-60 days of log-prices; captures recent momentum
    # that Prophet may lag on.
    recent_days = min(60, max(14, len(df) // 3))
    recent_df = df.tail(recent_days).copy()
    X = np.arange(len(recent_df)).reshape(-1, 1)
    y_log = recent_df["y"].values  # already log-transformed

    scaler_X = StandardScaler()
    X_scaled = scaler_X.fit_transform(X)

    ridge = Ridge(alpha=1.0)
    ridge.fit(X_scaled, y_log)

    # Project forward
    future_steps = np.arange(len(recent_df), len(recent_df) + horizon).reshape(-1, 1)
    future_scaled = scaler_X.transform(future_steps)
    ridge_preds_log = ridge.predict(future_scaled)
    ridge_preds = np.expm1(ridge_preds_log).clip(min=0.01)

    # ── 4. EMA Decay ─────────────────────────────────────────────────────────
    # EMA of recent prices as a simple baseline/anchor.
    # Decays toward long-run mean — good for mean-reverting cards.
    prices_orig = df["y_orig"].values
    alpha_ema = 2.0 / (min(30, len(df) // 2) + 1)
    ema = prices_orig[-1]
    for p in prices_orig[-20:]:
        ema = alpha_ema * p + (1 - alpha_ema) * ema

    long_run_mean = df["y_orig"].mean()
    decay = 0.95  # 5% per day pull toward mean
    ema_forecast = []
    current_ema = ema
    for _ in range(horizon):
        current_ema = decay * current_ema + (1 - decay) * long_run_mean
        ema_forecast.append(max(0.01, current_ema))

    # ── 5. Ensemble weighting via pseudo-validation ───────────────────────────
    # Use last 20% as pseudo-validation set to compute inverse-RMSE weights.
    split = int(len(df) * 0.8)
    val_df = df.iloc[split:]
    val_dates = val_df["ds"]

    # Prophet's fitted values for val period
    prop_val = fc[fc["ds"].isin(val_dates)]["yhat"].values[:len(val_df)]

    # Ridge predictions for val period (in original space)
    val_X = np.arange(
        len(recent_df) - (len(df) - split),
        len(recent_df) - (len(df) - split) + len(val_df)
    ).reshape(-1, 1)
    # Safer: compute val indices relative to recent_df window
    val_start_in_full = split
    val_end_in_full   = len(df)
    recent_start_in_full = len(df) - recent_days
    val_start_in_recent = val_start_in_full - recent_start_in_full
    val_end_in_recent   = val_end_in_full   - recent_start_in_full
    val_start_in_recent = max(0, val_start_in_recent)

    if val_start_in_recent < val_end_in_recent:
        val_X_local = np.arange(val_start_in_recent, val_end_in_recent).reshape(-1, 1)
        val_X_scaled = scaler_X.transform(val_X_local)
        ridge_val = np.expm1(ridge.predict(val_X_scaled)).clip(min=0.01)[:len(val_df)]
    else:
        # Fallback: use flat last price
        ridge_val = np.full(len(val_df), prices_orig[split])

    # EMA "val" is flat last price before split as baseline
    ema_val = np.full(len(val_df), prices_orig[split])
    actual_val = val_df["y_orig"].values

    def rmse(pred, actual):
        n = min(len(pred), len(actual))
        return np.sqrt(np.mean((pred[:n] - actual[:n]) ** 2)) + 1e-6

    # Guard against empty val arrays
    if len(actual_val) == 0 or len(prop_val) == 0:
        wt_p, wt_r, wt_e = 0.6, 0.2, 0.2
        rmse_prophet = rmse_ridge = rmse_ema = rmse_ens = float("nan")
    else:
        w_prophet = 1.0 / rmse(prop_val, actual_val)
        w_ridge   = 1.0 / rmse(ridge_val, actual_val)
        w_ema     = 1.0 / rmse(ema_val, actual_val)
        total_w   = w_prophet + w_ridge + w_ema

        wt_p = w_prophet / total_w
        wt_r = w_ridge   / total_w
        wt_e = w_ema     / total_w

        rmse_prophet = float(rmse(prop_val, actual_val))
        rmse_ridge   = float(rmse(ridge_val, actual_val))
        rmse_ema     = float(rmse(ema_val, actual_val))

        # Ensemble RMSE on val (approximate — uses same weights)
        ema_val_arr = np.array(ema_val[:len(actual_val)])
        ens_val = (
            wt_p * prop_val[:len(actual_val)] +
            wt_r * ridge_val[:len(actual_val)] +
            wt_e * ema_val_arr
        )
        rmse_ens = float(rmse(ens_val, actual_val))

    # ── 6. Build ensemble forecast ────────────────────────────────────────────
    fc_future = fc[fc["ds"] > last_actual_date].head(horizon)
    prophet_future = fc_future["yhat"].values
    forecast_dates = fc_future["ds"].dt.strftime("%Y-%m-%d").tolist()

    # Pad shorter arrays to horizon length if needed
    ema_arr    = np.array(ema_forecast[:horizon])
    ridge_arr  = ridge_preds[:horizon]
    prophet_arr = prophet_future[:horizon]

    min_len = min(len(prophet_arr), len(ridge_arr), len(ema_arr), horizon)

    ensemble_yhat = (
        wt_p * prophet_arr[:min_len] +
        wt_r * ridge_arr[:min_len] +
        wt_e * ema_arr[:min_len]
    )

    # CI: Prophet's interval width centered on ensemble mean (widen 10% for uncertainty)
    prop_lower = fc_future["yhat_lower"].values[:min_len]
    prop_upper = fc_future["yhat_upper"].values[:min_len]
    half_band  = (prop_upper - prop_lower) / 2

    lower = (ensemble_yhat - half_band * 1.1).clip(min=0.01)
    upper = (ensemble_yhat + half_band * 1.1).clip(min=0.01)

    # ── 7. Changepoints (from Prophet) ───────────────────────────────────────
    cp_dates  = model.changepoints
    raw_delta = np.array(model.params["delta"])
    cp_deltas = raw_delta.mean(axis=0) if raw_delta.ndim == 2 else raw_delta

    changepoints = [
        ChangePoint(date=str(ts.date()), delta=round(float(d), 4))
        for ts, d in zip(cp_dates, cp_deltas)
        if abs(d) > 0.005
    ]
    changepoints.sort(key=lambda c: abs(c.delta), reverse=True)

    # ── 8. Fitted values (historical) using Prophet in log-space ─────────────
    # Back-transform Prophet's fitted history
    fc_hist = fc[fc["ds"] <= last_actual_date].copy()

    def row_to_point_direct(date_str, yhat, lower, upper) -> ForecastPoint:
        return ForecastPoint(
            date=date_str,
            yhat=round(float(yhat), 2),
            lower=round(float(lower), 2),
            upper=round(float(upper), 2),
        )

    fitted = [
        row_to_point_direct(
            row["ds"].strftime("%Y-%m-%d"),
            row["yhat"],
            row["yhat_lower"],
            row["yhat_upper"],
        )
        for _, row in fc_hist.iterrows()
    ]

    forecast_out = [
        row_to_point_direct(
            forecast_dates[i],
            ensemble_yhat[i],
            lower[i],
            upper[i],
        )
        for i in range(min_len)
    ]

    # ── 9. Optional cross-validation ─────────────────────────────────────────
    model_info: dict = {
        "model_version":          "v2",
        "n_input_points":         len(df),
        "horizon_days":           horizon,
        "n_changepoints":         len(changepoints),
        "log_transform":          True,
        "weekly_seasonality":     weekly_seasonality,
        "monthly_seasonality":    monthly_seasonality,
        "semi_annual_seasonality": semi_annual_seasonality,
        "ensemble_weights": {
            "prophet": round(float(wt_p), 4),
            "ridge":   round(float(wt_r), 4),
            "ema":     round(float(wt_e), 4),
        },
        "val_rmse": {
            "prophet":  round(rmse_prophet, 4) if not np.isnan(rmse_prophet) else None,
            "ridge":    round(rmse_ridge, 4)   if not np.isnan(rmse_ridge)   else None,
            "ema":      round(rmse_ema, 4)     if not np.isnan(rmse_ema)     else None,
            "ensemble": round(rmse_ens, 4)     if not np.isnan(rmse_ens)     else None,
        },
    }

    if len(df) >= 60 and horizon <= 30:
        try:
            from prophet.diagnostics import cross_validation, performance_metrics
            cv_df = cross_validation(
                model,
                initial=f"{int(len(df) * 0.6)}d",
                period="14d",
                horizon=f"{horizon}d",
                disable_tqdm=True,
            )
            pm = performance_metrics(cv_df)
            model_info["cv_mae"]  = float(pm["mae"].mean())
            model_info["cv_rmse"] = float(pm["rmse"].mean())
            model_info["cv_mape"] = float(pm["mape"].mean())
        except Exception as e:
            logger.warning(f"CV failed: {e}")

    logger.info(
        "v2 Forecast complete: %d pts, horizon=%d, weights=p%.2f/r%.2f/e%.2f, CPs=%d",
        len(df), horizon, wt_p, wt_r, wt_e, len(changepoints),
    )

    return ForecastResponse(
        forecast=forecast_out,
        fitted=fitted,
        changepoints=changepoints,
        model_info=model_info,
    )
