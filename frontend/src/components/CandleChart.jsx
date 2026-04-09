import React, { useEffect, useRef } from 'react';
import { createChart, CrosshairMode } from 'lightweight-charts';

const CandleChart = ({ initialData, candleData }) => {
  const chartContainerRef = useRef();
  const chartRef = useRef();
  const candleSeriesRef = useRef();

  // 1. Initialize Chart (Runs once on mount)
  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Create the chart with a Pro Dark Theme
    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { color: '#161a1e' }, // Matches your UI
        textColor: '#d1d4dc',
      },
      grid: {
        vertLines: { color: 'rgba(42, 46, 57, 0.5)' },
        horzLines: { color: 'rgba(42, 46, 57, 0.5)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: 'rgba(197, 203, 206, 0.8)',
      },
      timeScale: {
        borderColor: 'rgba(197, 203, 206, 0.8)',
        timeVisible: true,
        secondsVisible: false,
      },
      width: chartContainerRef.current.clientWidth,
      height: 450,
    });

    // Add Candlestick Series
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;

    // Handle Window Resize
    const handleResize = () => {
      chart.applyOptions({ width: chartContainerRef.current.clientWidth });
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, []);

  // 2. Load Historical Data (Runs when you switch assets or load page)
  useEffect(() => {
    if (initialData && initialData.length > 0 && candleSeriesRef.current) {
      candleSeriesRef.current.setData(initialData);
      chartRef.current.timeScale().fitContent(); // Auto-zoom to show all data
    }
  }, [initialData]);

  // 3. Handle Live Ticks (Runs every time a new price comes from Socket.io)
  useEffect(() => {
    if (candleData && candleSeriesRef.current) {
      candleSeriesRef.current.update(candleData);
    }
  }, [candleData]);

  return (
    <div className="relative w-full h-full">
      <div ref={chartContainerRef} className="w-full h-full" />
    </div>
  );
};

export default CandleChart;