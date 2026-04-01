"""
Prophet-based price forecasting microservice.
Deployed on Railway; called by the Next.js API route /api/cards/forecast.
"""

import os
import logging
from typing import List

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from prophet import Prophet
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

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
    points:  List[PricePoint]
    horizon: int              # days ahead to forecast: 7 | 30 | 90 | 180
    secret:  str = ""


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

    # ── Fit Prophet ───────────────────────────────────────────────────────────
    # changepoint_prior_scale: higher = more flexible trend (0.05 default)
    # We use 0.1 for card prices which can shift rapidly on set releases
    model = Prophet(
        changepoint_prior_scale=0.10,
        seasonality_prior_scale=10.0,
        seasonality_mode="additive",
        yearly_seasonality=False,
        weekly_seasonality=(len(df) >= 14),   # only if we have 2+ weeks
        daily_seasonality=False,
        interval_width=0.80,                  # 80% confidence interval
    )

    # Suppress Prophet's verbose Stan output
    import sys, io
    with io.StringIO() as buf, open(os.devnull, "w") as devnull:
        model.fit(df, iter=300)

    # ── Future DataFrame & predict ────────────────────────────────────────────
    future = model.make_future_dataframe(periods=horizon, freq="D")
    forecast_df = model.predict(future)

    last_actual_date = df["ds"].max()

    # Changepoints: dates + magnitudes
    cp_dates  = model.changepoints                           # Series of Timestamps
    cp_deltas = model.params["delta"].mean(axis=0)          # posterior mean deltas
    # Filter to significant changepoints (|delta| > 0.005)
    changepoints = [
        ChangePoint(
            date=str(ts.date()),
            delta=round(float(d), 4),
        )
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
        "n_input_points":   len(df),
        "horizon_days":     horizon,
        "n_changepoints":   len(changepoints),
        "weekly_seasonality": len(df) >= 14,
    }

    logger.info("Forecast complete: %d input pts, %d horizon, %d changepoints",
                len(df), horizon, len(changepoints))

    return ForecastResponse(
        forecast=forecast,
        fitted=fitted,
        changepoints=changepoints,
        model_info=model_info,
    )
