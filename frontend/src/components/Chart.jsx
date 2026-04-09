import React, { useEffect, useRef } from 'react';
import { createChart } from 'lightweight-charts';

const Chart = ({ latestPrice }) => {
  const chartContainerRef = useRef();
  const lineSeriesRef = useRef();

  useEffect(() => {
    const chart = createChart(chartContainerRef.current, {
      layout: { background: { color: '#131722' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: '#2B2B43' }, horzLines: { color: '#2B2B43' } },
      width: chartContainerRef.current.clientWidth,
      height: 400,
    });

    lineSeriesRef.current = chart.addAreaSeries({
      lineColor: '#2962ff',
      topColor: '#2962ff',
      bottomColor: 'rgba(41, 98, 255, 0.28)',
    });

    return () => chart.remove();
  }, []);

  useEffect(() => {
    if (latestPrice && lineSeriesRef.current) {
      lineSeriesRef.current.update({
        time: Math.floor(Date.now() / 1000),
        value: parseFloat(latestPrice),
      });
    }
  }, [latestPrice]);

  return <div ref={chartContainerRef} className="w-full" />;
};

export default Chart;