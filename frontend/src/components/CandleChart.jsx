import React, { useEffect, useRef } from 'react';
import { createChart, CrosshairMode } from 'lightweight-charts';

const CandleChart = ({ initialData, candleData, symbol = "BTC/USDT" }) => {
  const chartContainerRef = useRef();
  const chartRef = useRef();
  const candleSeriesRef = useRef();
  const smaSeriesRef = useRef();

  // Helper: Calculate Simple Moving Average (SMA 20)
  const calculateSMA = (data, period = 20) => {
    const sma = [];
    for (let i = period; i <= data.length; i++) {
      const slice = data.slice(i - period, i);
      const sum = slice.reduce((acc, curr) => acc + curr.close, 0);
      sma.push({ time: data[i - 1].time, value: sum / period });
    }
    return sma;
  };

  useEffect(() => {
    if (!chartContainerRef.current) return;

    // 1. Initialize Chart with Pro Theme
    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { color: '#161a1e' },
        textColor: '#d1d4dc',
        fontFamily: 'monospace',
      },
      grid: {
        vertLines: { color: 'rgba(42, 46, 57, 0.05)' },
        horzLines: { color: 'rgba(42, 46, 57, 0.05)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: 'rgba(197, 203, 206, 0.2)',
        autoScale: true,
      },
      timeScale: {
        borderColor: 'rgba(197, 203, 206, 0.2)',
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 10, // 🚀 Keeps candles thick
        minBarSpacing: 4,
      },
      watermark: {
        color: 'rgba(255, 255, 255, 0.03)',
        visible: true,
        text: 'NEXUSTRADE PRO',
        fontSize: 32,
        horzAlign: 'center',
        vertAlign: 'center',
      },
      width: chartContainerRef.current.clientWidth,
      height: 450,
    });

    // 2. Add Candlestick Series
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
      priceLineVisible: true, // 🚀 Line at current price
    });

    // 3. Add SMA Line (Moving Average)
    const smaSeries = chart.addLineSeries({
      color: 'rgba(243, 156, 18, 0.6)',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'SMA 20',
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    smaSeriesRef.current = smaSeries;

    const handleResize = () => {
      chart.applyOptions({ width: chartContainerRef.current.clientWidth });
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, []);

  // 4. Load History & Calculate Indicators
  useEffect(() => {
    if (initialData && initialData.length > 0 && candleSeriesRef.current) {
      // Ensure data is sorted for indicator calculation
      const sortedData = [...initialData].sort((a, b) => a.time - b.time);
      
      candleSeriesRef.current.setData(sortedData);
      
      // Calculate and set SMA
      const smaData = calculateSMA(sortedData, 20);
      smaSeriesRef.current.setData(smaData);

      // Auto-scroll to the latest candle without squishing
      chartRef.current.timeScale().scrollToPosition(0, false);
    }
  }, [initialData]);

  // 5. Update Live Data
  useEffect(() => {
    if (candleData && candleSeriesRef.current) {
      candleSeriesRef.current.update(candleData);
      // Optional: Logic to update SMA live can be added here
    }
  }, [candleData]);

  return (
    <div className="w-full h-[450px] relative">
      <div ref={chartContainerRef} className="w-full h-full" />
    </div>
  );
};

export default CandleChart;