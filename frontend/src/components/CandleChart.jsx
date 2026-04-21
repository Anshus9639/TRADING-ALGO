import React, { useEffect, useRef } from 'react';
import { createChart, CrosshairMode } from 'lightweight-charts';

const CandleChart = ({ initialData, candleData }) => {
  const chartContainerRef = useRef();
  const chartRef = useRef();
  const candleSeriesRef = useRef();

  // 1. Initialize Chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { color: '#161a1e' },
        textColor: '#d1d4dc',
      },
      grid: {
        vertLines: { color: 'rgba(42, 46, 57, 0.1)' },
        horzLines: { color: 'rgba(42, 46, 57, 0.1)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: 'rgba(197, 203, 206, 0.8)',
        autoScale: true, // 🚀 Fixes the "Flat" look by auto-adjusting height
      },
      timeScale: {
        borderColor: 'rgba(197, 203, 206, 0.8)',
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 12, // 🚀 Makes candles thicker and easier to read
        minBarSpacing: 5,
        shiftVisibleRangeOnNewBar: true, // Keeps chart at the live edge
      },
      width: chartContainerRef.current.clientWidth,
      height: 450,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;

    const handleResize = () => {
      chart.applyOptions({ width: chartContainerRef.current.clientWidth });
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, []);

  // 2. Load Historical Data
  useEffect(() => {
    if (initialData && initialData.length > 0 && candleSeriesRef.current) {
      // Sort data by time just in case it arrived out of order
      const sortedData = [...initialData].sort((a, b) => a.time - b.time);
      candleSeriesRef.current.setData(sortedData);
      
      // 🚀 Instead of fitContent (which squishes), we zoom to the end
      chartRef.current.timeScale().scrollToPosition(0, false); 
    }
  }, [initialData]);

  // 3. Handle Live Ticks
  useEffect(() => {
    if (candleData && candleSeriesRef.current) {
      candleSeriesRef.current.update(candleData);
    }
  }, [candleData]);

  return (
    <div className="w-full h-[450px]">
      <div ref={chartContainerRef} className="w-full h-full" />
    </div>
  );
};

export default CandleChart;