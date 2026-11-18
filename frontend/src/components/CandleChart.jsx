import React, { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { createChart, CrosshairMode } from 'lightweight-charts';
import {
  calculateEma,
  calculateSma,
  INDICATOR_PERIOD,
  isValidCandle,
  mergeCandle,
  normalizeCandles
} from '../lib/chartData.mjs';

const FALLBACK_PALETTE = {
  background: [17, 20, 29],
  text: [154, 163, 184],
  grid: [36, 42, 58],
  border: [54, 62, 84],
  up: [52, 229, 161],
  down: [255, 92, 122],
  indicator: [167, 139, 250]
};

function readTokenTriplet(styles, name, fallback) {
  const raw = styles.getPropertyValue(name).trim();
  if (!raw) return fallback;
  const parts = raw.split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some(value => !Number.isFinite(value))) return fallback;
  return parts;
}

function readPalette() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return FALLBACK_PALETTE;
  const styles = getComputedStyle(document.documentElement);
  return {
    background: readTokenTriplet(styles, '--panel-1', FALLBACK_PALETTE.background),
    text: readTokenTriplet(styles, '--ink-secondary', FALLBACK_PALETTE.text),
    grid: readTokenTriplet(styles, '--line-subtle', FALLBACK_PALETTE.grid),
    border: readTokenTriplet(styles, '--line-strong', FALLBACK_PALETTE.border),
    up: readTokenTriplet(styles, '--positive', FALLBACK_PALETTE.up),
    down: readTokenTriplet(styles, '--negative', FALLBACK_PALETTE.down),
    indicator: readTokenTriplet(styles, '--ultraviolet', FALLBACK_PALETTE.indicator)
  };
}

function rgb(parts) {
  return `rgb(${parts.join(', ')})`;
}

function rgba(parts, alpha) {
  return `rgba(${parts.join(', ')}, ${alpha})`;
}

function toChartPoint(candle) {
  return {
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close
  };
}

function calculateIndicator(candles, indicator) {
  if (indicator === 'EMA') return calculateEma(candles, INDICATOR_PERIOD);
  if (indicator === 'SMA') return calculateSma(candles, INDICATOR_PERIOD);
  return [];
}

export default function CandleChart({
  initialData,
  candleData,
  symbol = '',
  interval = '5m',
  indicator = 'SMA'
}) {
  const wrapperRef = useRef(null);
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const indicatorSeriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const dataRef = useRef([]);
  const paletteRef = useRef(FALLBACK_PALETTE);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const palette = readPalette();
    paletteRef.current = palette;

    const chart = createChart(container, {
      width: container.clientWidth || 320,
      height: container.clientHeight || 360,
      layout: {
        background: { color: rgb(palette.background) },
        textColor: rgb(palette.text),
        fontFamily: '"IBM Plex Mono", "JetBrains Mono", Consolas, ui-monospace, monospace',
        fontSize: 11
      },
      grid: {
        vertLines: { color: rgba(palette.grid, 0.3) },
        horzLines: { color: rgba(palette.grid, 0.3) }
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: rgba(palette.indicator, 0.4), labelBackgroundColor: rgb(palette.indicator) },
        horzLine: { color: rgba(palette.indicator, 0.4), labelBackgroundColor: rgb(palette.indicator) }
      },
      rightPriceScale: {
        borderColor: rgba(palette.border, 0.8),
        scaleMargins: { top: 0.08, bottom: 0.24 }
      },
      timeScale: {
        borderColor: rgba(palette.border, 0.8),
        timeVisible: true,
        secondsVisible: false
      },
      watermark: {
        color: rgba(palette.text, 0.16),
        visible: Boolean(symbol),
        text: symbol ? `${symbol} · ${String(interval).toUpperCase()}` : '',
        fontSize: 26,
        horzAlign: 'center',
        vertAlign: 'center'
      }
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: rgb(palette.up),
      downColor: rgb(palette.down),
      borderUpColor: rgb(palette.up),
      borderDownColor: rgb(palette.down),
      wickUpColor: rgba(palette.up, 0.8),
      wickDownColor: rgba(palette.down, 0.8),
      priceLineColor: rgba(palette.text, 0.35)
    });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    const indicatorLine = chart.addLineSeries({
      color: rgb(palette.indicator),
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      title: ''
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    indicatorSeriesRef.current = indicatorLine;

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width > 0 && height > 0) chart.applyOptions({ width, height });
    };

    let observer = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(resize);
      observer.observe(container);
    } else {
      window.addEventListener('resize', resize);
    }

    return () => {
      if (observer) observer.disconnect();
      else window.removeEventListener('resize', resize);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      indicatorSeriesRef.current = null;
      dataRef.current = [];
    };
  }, []);

  useEffect(() => {
    const candles = normalizeCandles(initialData);
    dataRef.current = candles;

    if (candleSeriesRef.current) {
      candleSeriesRef.current.setData(candles.map(toChartPoint));
    }

    const palette = paletteRef.current;
    if (volumeSeriesRef.current) {
      volumeSeriesRef.current.setData(
        candles
          .filter(candle => candle.volume !== null)
          .map(candle => ({
            time: candle.time,
            value: candle.volume,
            color: candle.close >= candle.open ? rgba(palette.up, 0.35) : rgba(palette.down, 0.35)
          }))
      );
    }

    if (indicatorSeriesRef.current) {
      indicatorSeriesRef.current.applyOptions({
        visible: indicator !== 'NONE',
        title: indicator === 'NONE' ? '' : `${indicator} ${INDICATOR_PERIOD}`
      });
      indicatorSeriesRef.current.setData(calculateIndicator(candles, indicator));
    }

    if (chartRef.current) chartRef.current.timeScale().fitContent();
  }, [initialData, indicator]);

  useEffect(() => {
    if (!candleData || !isValidCandle(candleData)) return;

    const candle = normalizeCandles([candleData])[0];
    if (!candle) return;

    const next = mergeCandle(dataRef.current, candle);
    dataRef.current = next;

    if (candleSeriesRef.current) candleSeriesRef.current.update(toChartPoint(candle));

    const palette = paletteRef.current;
    if (volumeSeriesRef.current && candle.volume !== null) {
      volumeSeriesRef.current.update({
        time: candle.time,
        value: candle.volume,
        color: candle.close >= candle.open ? rgba(palette.up, 0.35) : rgba(palette.down, 0.35)
      });
    }

    if (indicatorSeriesRef.current && indicator !== 'NONE') {
      indicatorSeriesRef.current.setData(calculateIndicator(next, indicator));
    }
  }, [candleData, indicator]);

  useEffect(() => {
    const handleChange = () => setIsFullscreen(document.fullscreenElement === wrapperRef.current);
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  const toggleFullscreen = async () => {
    const element = wrapperRef.current;
    if (!element) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await element.requestFullscreen();
    } catch {
      // Fullscreen can be blocked by the embedding context; keep the inline chart.
    }
  };

  return (
    <div
      ref={wrapperRef}
      className={isFullscreen
        ? 'flex h-[100dvh] w-screen flex-col gap-2 bg-void p-3'
        : 'relative flex h-full w-full flex-col'}
    >
      <div className="flex items-center justify-end gap-2">
        <span className="eyebrow hidden sm:inline">{symbol} · {String(interval).toUpperCase()}</span>
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? 'Exit fullscreen chart' : 'View chart fullscreen'}
          className="rounded-md border border-line-subtle bg-panel-2/70 p-1 text-ink-muted transition-colors hover:border-line-strong hover:text-ink-primary"
        >
          {isFullscreen ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
        </button>
      </div>
      <div ref={containerRef} className="min-h-0 w-full flex-1" />
    </div>
  );
}
